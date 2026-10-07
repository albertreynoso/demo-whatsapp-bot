import { createHmac, timingSafeEqual } from "node:crypto";

export interface WhatsAppConfig {
  token: string; // token de acceso de la app de Meta
  phoneNumberId: string; // ID del número que envía
  appSecret: string; // para validar la firma de los webhooks
  verifyToken: string; // el que pones al registrar el webhook en Meta
  apiVersion: string; // versión de la Graph API, p. ej. v23.0
}

export interface MensajeEntrante {
  id: string;
  de: string; // teléfono en formato internacional sin "+"
  texto: string;
}

const MAX_TEXTO = 4096; // límite de WhatsApp por mensaje

export class WhatsApp {
  constructor(private cfg: WhatsAppConfig) {}

  /** Meta firma cada webhook con el App Secret (cabecera X-Hub-Signature-256). */
  firmaValida(cuerpo: Buffer, cabecera: string | undefined): boolean {
    if (!cabecera?.startsWith("sha256=")) return false;
    const esperada = Buffer.from(createHmac("sha256", this.cfg.appSecret).update(cuerpo).digest("hex"));
    const recibida = Buffer.from(cabecera.slice("sha256=".length));
    return esperada.length === recibida.length && timingSafeEqual(esperada, recibida);
  }

  verificarSuscripcion(modo: unknown, token: unknown): boolean {
    return modo === "subscribe" && token === this.cfg.verifyToken;
  }

  async enviar(para: string, texto: string): Promise<void> {
    const url = `https://graph.facebook.com/${this.cfg.apiVersion}/${this.cfg.phoneNumberId}/messages`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: para, type: "text", text: { body: texto.slice(0, MAX_TEXTO) } }),
    });
    if (!res.ok) throw new Error(`WhatsApp respondió ${res.status}: ${await res.text()}`);
  }
}

interface CambioWebhook {
  value?: { messages?: { id: string; from: string; type: string; text?: { body: string } }[] };
}

/** Solo mensajes de texto; los estados de entrega y otros tipos se ignoran. */
export function extraerMensajes(cuerpo: { entry?: { changes?: CambioWebhook[] }[] }): MensajeEntrante[] {
  const mensajes = (cuerpo.entry ?? []).flatMap((e) => e.changes ?? []).flatMap((c) => c.value?.messages ?? []);
  return mensajes
    .filter((m) => m.type === "text" && m.text?.body)
    .map((m) => ({ id: m.id, de: m.from, texto: m.text!.body }));
}
