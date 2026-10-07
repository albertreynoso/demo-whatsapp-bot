import { readFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import express, { type Request, type Response } from "express";
import { Agenda, JsonAgendaStore, SheetsAgendaStore, type AgendaStore } from "./agenda.js";
import { ClinicaBot, Conversaciones, SISTEMA, contexto } from "./bot.js";
import { log } from "./log.js";
import { WhatsApp, extraerMensajes, type MensajeEntrante, type WhatsAppConfig } from "./whatsapp.js";

type ConCuerpoCrudo = Request & { cuerpoCrudo?: Buffer };

/** Tope de mensajes por IP en la demo web: protege el gasto de la API. */
class Limite {
  private usos = new Map<string, number[]>();

  constructor(private max: number, private ventanaMs: number) {}

  permitir(clave: string): boolean {
    const ahora = Date.now();
    const recientes = (this.usos.get(clave) ?? []).filter((t) => ahora - t < this.ventanaMs);
    if (recientes.length >= this.max) return false;
    this.usos.set(clave, [...recientes, ahora]);
    return true;
  }
}

/** Meta reintenta webhooks: ignora los mensajes ya procesados. */
class Vistos {
  private ids = new Set<string>();

  nuevo(id: string): boolean {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    if (this.ids.size > 2000) this.ids.delete(this.ids.values().next().value!);
    return true;
  }
}

interface AppDeps {
  bot: ClinicaBot;
  wa: WhatsApp | null;
  limite: Limite;
  vistos: Vistos;
}

function chatWeb({ bot, limite }: AppDeps) {
  return async (req: Request, res: Response) => {
    const { sesion, mensaje } = (req.body ?? {}) as { sesion?: unknown; mensaje?: unknown };
    if (typeof sesion !== "string" || !/^[\w-]{8,64}$/.test(sesion)) return void res.status(400).json({ error: "sesion inválida" });
    if (typeof mensaje !== "string" || !mensaje.trim() || mensaje.length > 600) return void res.status(400).json({ error: "mensaje vacío o de más de 600 caracteres" });
    if (!limite.permitir(req.ip ?? "?")) return void res.status(429).json({ error: "Llegaste al límite de la demo. Prueba en una hora." });
    try {
      res.json({ respuesta: await bot.responder(`web:${sesion}`, mensaje.trim(), contexto("web")) });
    } catch (err) {
      log("chat_error", { user_id: `web:${sesion}`, error: String(err) });
      res.status(502).json({ error: "El asistente no está disponible ahora. Intenta de nuevo en un momento." });
    }
  };
}

async function atenderWhatsApp(mensaje: MensajeEntrante, { bot, wa }: AppDeps): Promise<void> {
  const inicio = Date.now();
  try {
    const respuesta = await bot.responder(mensaje.de, mensaje.texto, contexto("WhatsApp", mensaje.de));
    await wa!.enviar(mensaje.de, respuesta);
    log("whatsapp_reply", { user_id: mensaje.de, duration_ms: Date.now() - inicio });
  } catch (err) {
    log("whatsapp_error", { user_id: mensaje.de, duration_ms: Date.now() - inicio, error: String(err) });
  }
}

function webhookEntrante(deps: AppDeps) {
  return (req: ConCuerpoCrudo, res: Response) => {
    if (!deps.wa!.firmaValida(req.cuerpoCrudo ?? Buffer.alloc(0), req.get("x-hub-signature-256"))) {
      log("webhook_bad_signature", { ip: req.ip });
      return void res.sendStatus(401);
    }
    res.sendStatus(200); // Meta espera respuesta rápida; el bot contesta después
    for (const mensaje of extraerMensajes(req.body)) if (deps.vistos.nuevo(mensaje.id)) void atenderWhatsApp(mensaje, deps);
  };
}

function crearApp(deps: AppDeps) {
  const app = express();
  app.set("trust proxy", 1); // detrás del proxy de Render/Railway, para que req.ip sea la IP real
  app.use(express.static("public"));
  app.get("/api/salud", (_req, res) => void res.json({ ok: true }));
  app.post("/api/chat", express.json({ limit: "10kb" }), chatWeb(deps));
  if (!deps.wa) return app;
  const wa = deps.wa;
  app.get("/webhook", (req, res) => {
    const ok = wa.verificarSuscripcion(req.query["hub.mode"], req.query["hub.verify_token"]);
    return ok ? void res.send(String(req.query["hub.challenge"])) : void res.sendStatus(403);
  });
  const conCrudo = express.json({ limit: "1mb", verify: (req, _res, buf) => void ((req as ConCuerpoCrudo).cuerpoCrudo = buf) });
  app.post("/webhook", conCrudo, webhookEntrante(deps));
  return app;
}

function configWhatsApp(): WhatsAppConfig | null {
  const { WHATSAPP_TOKEN: token, WHATSAPP_PHONE_NUMBER_ID: phoneNumberId, WHATSAPP_APP_SECRET: appSecret, WHATSAPP_VERIFY_TOKEN: verifyToken } = process.env;
  if (!token || !phoneNumberId || !appSecret || !verifyToken) return null;
  return { token, phoneNumberId, appSecret, verifyToken, apiVersion: process.env.GRAPH_API_VERSION ?? "v23.0" };
}

/** Aviso a recepción: siempre al log; por WhatsApp si hay número de recepción configurado. */
function derivador(wa: WhatsApp | null) {
  const recepcion = process.env.RECEPCION_WHATSAPP;
  return async (id: string, motivo: string) => {
    log("handoff", { user_id: id, motivo });
    if (!wa || !recepcion || id.startsWith("web:")) return;
    await wa.enviar(recepcion, `Paciente +${id} necesita atención: ${motivo}\nResponder: https://wa.me/${id}`);
  };
}

function cargarEnv(): void {
  try {
    process.loadEnvFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    log("env_file_missing", { hint: "copia .env.example a .env" });
  }
}

async function main(): Promise<void> {
  cargarEnv();
  const store: AgendaStore = process.env.GOOGLE_SHEET_ID ? new SheetsAgendaStore(process.env.GOOGLE_SHEET_ID) : new JsonAgendaStore("data/citas.json");
  const wa = configWhatsApp() ? new WhatsApp(configWhatsApp()!) : null;
  const bot = new ClinicaBot({
    client: new Anthropic(), agenda: new Agenda(store), conversaciones: new Conversaciones(),
    sistema: SISTEMA(await readFile("data/clinica.md", "utf8")), modelo: process.env.CLAUDE_MODEL ?? "claude-opus-5-5", derivar: derivador(wa),
  });
  const port = Number(process.env.PORT ?? 3000);
  crearApp({ bot, wa, limite: new Limite(40, 60 * 60_000), vistos: new Vistos() })
    .listen(port, () => log("server_started", { port, whatsapp: Boolean(wa), agenda: store.constructor.name }));
}

main().catch((err) => {
  log("server_crash", { error: String(err) });
  process.exit(1);
});
