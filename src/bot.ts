import Anthropic from "@anthropic-ai/sdk";
import type { Agenda, NuevaCita } from "./agenda.js";
import { log } from "./log.js";

type Mensaje = Anthropic.Beta.BetaMessageParam;
type Respuesta = Anthropic.Beta.BetaMessage;
type Resultado = Anthropic.Beta.BetaToolResultBlockParam;

const MAX_PASOS = 6; // llamadas al modelo por mensaje del paciente (herramientas incluidas)
const SIN_RESPUESTA = "Disculpa, se me complicó responder eso. ¿Quieres que te comunique con recepción?";
const YA_DERIVADA = "Ya avisé a recepción; una persona te responde por aquí en breve. 🙌";

export const SISTEMA = (documento: string) => `Eres el asistente virtual de WhatsApp de Clínica Dental Sonrisa, en Lima. Atiendes a pacientes en español peruano, de "tú", con mensajes cortos de chat (máximo 4 líneas) y sin formato markdown.

Reglas:
- Responde solo con la información del documento de la clínica. Si algo no está ahí (un precio, un tratamiento, una política), dilo y ofrece pasar con recepción. Nunca inventes precios, horarios ni diagnósticos.
- No des diagnósticos ni indicaciones médicas. Ante dolor fuerte, golpe o sangrado que no para, recomienda venir lo antes posible (o ir a emergencias si está cerrado) y deriva a recepción.
- Para agendar: pregunta qué tratamiento y qué día prefiere, consulta los horarios con la herramienta, ofrece 2 o 3 opciones y, cuando el paciente elija, confirma su nombre completo antes de reservar. Después de reservar, confirma día, hora, dirección y que llegue 10 minutos antes.
- El primer mensaje de cada conversación empieza con datos del sistema entre corchetes (fecha actual, canal, teléfono). Úsalos y no los repitas. Si el canal es WhatsApp ya tienes su teléfono: no se lo pidas. En la web, pide un teléfono de contacto.
- Si el paciente pide hablar con una persona, o es una queja o una urgencia, usa derivar_a_recepcion.

<documento_clinica>
${documento}
</documento_clinica>`;

const texto = (descripcion: string) => ({ type: "string" as const, description: descripcion });

const HERRAMIENTAS: Anthropic.Beta.BetaTool[] = [
  {
    name: "consultar_horarios",
    description: "Horarios libres (bloques de 30 min) de un día. Úsala siempre antes de proponer horarios; no inventes disponibilidad.",
    strict: true,
    input_schema: { type: "object", properties: { fecha: texto("Día en formato AAAA-MM-DD") }, required: ["fecha"], additionalProperties: false },
  },
  {
    name: "agendar_cita",
    description: "Reserva una cita cuando el paciente ya confirmó nombre, tratamiento, fecha y hora. Devuelve ok=false si el horario se ocupó.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        nombre: texto("Nombre completo del paciente"), telefono: texto("Teléfono de contacto"),
        tratamiento: texto("Tratamiento del documento"), fecha: texto("AAAA-MM-DD"), hora: texto("HH:MM, uno de los horarios libres"),
      },
      required: ["nombre", "telefono", "tratamiento", "fecha", "hora"],
      additionalProperties: false,
    },
  },
  {
    name: "derivar_a_recepcion",
    description: "Pasa la conversación a una persona de recepción: urgencias, quejas, preguntas que el documento no responde o cuando el paciente lo pide.",
    strict: true,
    input_schema: { type: "object", properties: { motivo: texto("Resumen de una línea para recepción") }, required: ["motivo"], additionalProperties: false },
  },
];

/** Effort bajo para chat; fallbacks del servidor en los modelos que los aceptan (Haiku 4.5 no acepta ninguno de los dos). */
function extrasDelModelo(modelo: string) {
  if (modelo.startsWith("claude-haiku")) return {};
  const conFallback = /^claude-(opus-5|fable-5|sonnet-5-5)/.test(modelo);
  return {
    output_config: { effort: "low" as const },
    ...(conFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
  };
}

interface Sesion {
  mensajes: Mensaje[]; // solo se agrega al final: editar el historial invalida los bloques de razonamiento
  ultimo: number;
  derivada: boolean;
  cola: Promise<unknown>; // procesa en orden los mensajes que llegan seguidos
}

export class Conversaciones {
  private sesiones = new Map<string, Sesion>();

  constructor(private ttlMs = 30 * 60_000, private reloj: () => number = Date.now) {}

  /** Tras ttlMs sin mensajes, la conversación empieza de cero. */
  abrir(id: string): Sesion {
    const ahora = this.reloj();
    const actual = this.sesiones.get(id);
    if (actual && ahora - actual.ultimo < this.ttlMs) {
      actual.ultimo = ahora;
      return actual;
    }
    // ponytail: memoria del proceso; se pierde al reiniciar. Redis o base de datos si hay varios servidores.
    for (const [clave, sesion] of this.sesiones) if (ahora - sesion.ultimo >= this.ttlMs) this.sesiones.delete(clave);
    const nueva: Sesion = { mensajes: [], ultimo: ahora, derivada: false, cola: Promise.resolve() };
    this.sesiones.set(id, nueva);
    return nueva;
  }
}

export interface BotDeps {
  client: Anthropic;
  agenda: Agenda;
  conversaciones: Conversaciones;
  sistema: string;
  modelo: string;
  derivar: (id: string, motivo: string) => Promise<void>;
}

export class ClinicaBot {
  constructor(private deps: BotDeps) {}

  /** `contexto` se antepone al primer mensaje de la conversación (fecha, canal, teléfono). */
  responder(id: string, mensaje: string, contexto: string): Promise<string> {
    const sesion = this.deps.conversaciones.abrir(id);
    const turno = sesion.cola.then(() => this.turno(sesion, id, mensaje, contexto));
    sesion.cola = turno.catch(() => undefined);
    return turno;
  }

  private async turno(sesion: Sesion, id: string, mensaje: string, contexto: string): Promise<string> {
    if (sesion.derivada) return YA_DERIVADA;
    sesion.mensajes.push({ role: "user", content: sesion.mensajes.length ? mensaje : `${contexto}\n${mensaje}` });
    for (let paso = 0; paso < MAX_PASOS; paso++) {
      const respuesta = await this.pedir(sesion.mensajes, id);
      if (respuesta.stop_reason === "refusal") return SIN_RESPUESTA;
      sesion.mensajes.push({ role: "assistant", content: respuesta.content });
      if (respuesta.stop_reason !== "tool_use") return textoDe(respuesta) || SIN_RESPUESTA;
      sesion.mensajes.push({ role: "user", content: await this.ejecutarHerramientas(respuesta, sesion, id) });
    }
    return SIN_RESPUESTA;
  }

  private async pedir(mensajes: Mensaje[], id: string): Promise<Respuesta> {
    const inicio = Date.now();
    const respuesta = await this.deps.client.beta.messages.create({
      model: this.deps.modelo, max_tokens: 16000, system: this.deps.sistema, tools: HERRAMIENTAS,
      cache_control: { type: "ephemeral" }, messages: mensajes, ...extrasDelModelo(this.deps.modelo),
    });
    const { input_tokens, output_tokens, cache_read_input_tokens } = respuesta.usage;
    log("model_call", { user_id: id, duration_ms: Date.now() - inicio, stop: respuesta.stop_reason, input_tokens, output_tokens, cache_read_input_tokens });
    return respuesta;
  }

  private ejecutarHerramientas(respuesta: Respuesta, sesion: Sesion, id: string): Promise<Resultado[]> {
    const usos = respuesta.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    return Promise.all(usos.map(async (uso) => ({ type: "tool_result" as const, tool_use_id: uso.id, ...(await this.ejecutar(uso, sesion, id)) })));
  }

  private async ejecutar(uso: Anthropic.Beta.BetaToolUseBlock, sesion: Sesion, id: string) {
    const inicio = Date.now();
    try {
      const salida = await this.herramienta(uso.name, uso.input as Record<string, string>, sesion, id);
      log("tool_call", { user_id: id, tool: uso.name, duration_ms: Date.now() - inicio });
      return { content: JSON.stringify(salida) };
    } catch (err) {
      log("tool_error", { user_id: id, tool: uso.name, duration_ms: Date.now() - inicio, error: String(err) });
      return { content: "Error interno de la herramienta. Ofrece pasar con recepción.", is_error: true };
    }
  }

  private async herramienta(nombre: string, entrada: Record<string, string>, sesion: Sesion, id: string): Promise<unknown> {
    const { agenda, derivar } = this.deps;
    if (nombre === "consultar_horarios") {
      const libres = await agenda.libres(entrada.fecha);
      return { fecha: entrada.fecha, libres, nota: libres.length ? undefined : "Sin horarios: cerrado, fecha pasada o lleno" };
    }
    if (nombre === "agendar_cita") {
      const cita = await agenda.agendar(entrada as unknown as NuevaCita);
      return cita ? { ok: true, cita } : { ok: false, motivo: "Ese horario ya no está libre; vuelve a consultar los horarios." };
    }
    if (nombre !== "derivar_a_recepcion") throw new Error(`Herramienta desconocida: ${nombre}`);
    sesion.derivada = true;
    await derivar(id, entrada.motivo);
    return { ok: true };
  }
}

function textoDe(respuesta: Respuesta): string {
  return respuesta.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
}

/** Datos del sistema para el primer mensaje: fecha y hora de Lima, canal y teléfono si se conoce. */
export function contexto(canal: "WhatsApp" | "web", telefono?: string): string {
  const ahora = new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", dateStyle: "full", timeStyle: "short" }).format(new Date());
  return `[Sistema: fecha y hora actual en Lima: ${ahora} · canal: ${canal}${telefono ? ` · teléfono del paciente: +${telefono}` : ""}]`;
}
