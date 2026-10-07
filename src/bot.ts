import { ThinkingLevel, type Content, type FunctionCall, type FunctionDeclaration, type GenerateContentResponse, type GoogleGenAI, type Part } from "@google/genai";
import type { Agenda, NuevaCita } from "./agenda.js";
import { log } from "./log.js";

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

const texto = (descripcion: string) => ({ type: "string", description: descripcion });

const HERRAMIENTAS: FunctionDeclaration[] = [
  {
    name: "consultar_horarios",
    description: "Horarios libres (bloques de 30 min) de un día. Úsala siempre antes de proponer horarios; no inventes disponibilidad.",
    parametersJsonSchema: { type: "object", properties: { fecha: texto("Día en formato AAAA-MM-DD") }, required: ["fecha"] },
  },
  {
    name: "agendar_cita",
    description: "Reserva una cita cuando el paciente ya confirmó nombre, tratamiento, fecha y hora. Devuelve ok=false si el horario se ocupó.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        nombre: texto("Nombre completo del paciente"), telefono: texto("Teléfono de contacto"),
        tratamiento: texto("Tratamiento del documento"), fecha: texto("AAAA-MM-DD"), hora: texto("HH:MM, uno de los horarios libres"),
      },
      required: ["nombre", "telefono", "tratamiento", "fecha", "hora"],
    },
  },
  {
    name: "derivar_a_recepcion",
    description: "Pasa la conversación a una persona de recepción: urgencias, quejas, preguntas que el documento no responde o cuando el paciente lo pide.",
    parametersJsonSchema: { type: "object", properties: { motivo: texto("Resumen de una línea para recepción") }, required: ["motivo"] },
  },
];

interface Sesion {
  mensajes: Content[]; // solo se agrega al final: Gemini exige devolver intactas las firmas de razonamiento (thoughtSignature)
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
  client: GoogleGenAI;
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
    agregarDelUsuario(sesion.mensajes, [{ text: sesion.mensajes.length ? mensaje : `${contexto}\n${mensaje}` }]);
    for (let paso = 0; paso < MAX_PASOS; paso++) {
      const respuesta = await this.pedir(sesion.mensajes, id);
      const contenido = respuesta.candidates?.[0]?.content;
      if (!contenido?.parts?.length) return SIN_RESPUESTA; // bloqueada por seguridad o llamada mal formada
      sesion.mensajes.push(contenido);
      const llamadas = respuesta.functionCalls;
      if (!llamadas?.length) return respuesta.text?.trim() || SIN_RESPUESTA;
      agregarDelUsuario(sesion.mensajes, await this.ejecutarHerramientas(llamadas, sesion, id));
    }
    return SIN_RESPUESTA;
  }

  private async pedir(mensajes: Content[], id: string): Promise<GenerateContentResponse> {
    const inicio = Date.now();
    const respuesta = await this.deps.client.models.generateContent({
      model: this.deps.modelo, contents: mensajes,
      config: {
        systemInstruction: this.deps.sistema, tools: [{ functionDeclarations: HERRAMIENTAS }],
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }, // chat corto: menos latencia y costo
      },
    });
    const uso = respuesta.usageMetadata;
    log("model_call", {
      user_id: id, duration_ms: Date.now() - inicio, stop: respuesta.candidates?.[0]?.finishReason,
      input_tokens: uso?.promptTokenCount, output_tokens: uso?.candidatesTokenCount, cached_tokens: uso?.cachedContentTokenCount,
    });
    return respuesta;
  }

  private ejecutarHerramientas(llamadas: FunctionCall[], sesion: Sesion, id: string): Promise<Part[]> {
    return Promise.all(llamadas.map(async (llamada) => ({
      functionResponse: { id: llamada.id, name: llamada.name, response: await this.ejecutar(llamada, sesion, id) },
    })));
  }

  private async ejecutar(llamada: FunctionCall, sesion: Sesion, id: string): Promise<Record<string, unknown>> {
    const inicio = Date.now();
    const nombre = llamada.name ?? "";
    try {
      const salida = await this.herramienta(nombre, (llamada.args ?? {}) as Record<string, string>, sesion, id);
      log("tool_call", { user_id: id, tool: nombre, duration_ms: Date.now() - inicio });
      return { output: salida };
    } catch (err) {
      log("tool_error", { user_id: id, tool: nombre, duration_ms: Date.now() - inicio, error: String(err) });
      return { error: "Error interno de la herramienta. Ofrece pasar con recepción." };
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

/** Si el último turno ya es del usuario (una respuesta falló o se cortó), suma las partes ahí: los roles deben alternar. */
function agregarDelUsuario(mensajes: Content[], parts: Part[]): void {
  const ultimo = mensajes.at(-1);
  if (ultimo?.role === "user") ultimo.parts = [...(ultimo.parts ?? []), ...parts];
  else mensajes.push({ role: "user", parts });
}

/** Datos del sistema para el primer mensaje: fecha y hora de Lima, canal y teléfono si se conoce. */
export function contexto(canal: "WhatsApp" | "web", telefono?: string): string {
  const ahora = new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", dateStyle: "full", timeStyle: "short" }).format(new Date());
  return `[Sistema: fecha y hora actual en Lima: ${ahora} · canal: ${canal}${telefono ? ` · teléfono del paciente: +${telefono}` : ""}]`;
}
