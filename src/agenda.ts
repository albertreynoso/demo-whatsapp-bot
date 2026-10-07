import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { auth, sheets } from "@googleapis/sheets";

export interface NuevaCita {
  nombre: string;
  telefono: string;
  tratamiento: string;
  fecha: string; // AAAA-MM-DD, hora de Lima
  hora: string; // HH:MM
}

export interface Cita extends NuevaCita {
  id: string;
  creada: string;
}

export interface AgendaStore {
  listar(fecha: string): Promise<Cita[]>;
  guardar(cita: Cita): Promise<void>;
}

const ZONA = "America/Lima";
const SLOT_MIN = 30;
// Turnos por día de la semana (0 = domingo), en minutos desde las 00:00. Debe coincidir con data/clinica.md.
const TURNOS: Record<number, [number, number][]> = {
  1: [[540, 780], [900, 1140]],
  2: [[540, 780], [900, 1140]],
  3: [[540, 780], [900, 1140]],
  4: [[540, 780], [900, 1140]],
  5: [[540, 780], [900, 1140]],
  6: [[540, 780]],
};

export function ahoraEnLima(momento: Date): { dia: string; hora: string } {
  const formato = new Intl.DateTimeFormat("en-CA", {
    timeZone: ZONA, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const p = Object.fromEntries(formato.formatToParts(momento).map((x) => [x.type, x.value]));
  return { dia: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour}:${p.minute}` };
}

function fechaValida(fecha: string): boolean {
  const dia = new Date(`${fecha}T12:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(fecha) && !Number.isNaN(dia.getTime()) && dia.toISOString().startsWith(fecha);
}

const aHora = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

export function slotsDelDia(fecha: string): string[] {
  const turnos = TURNOS[new Date(`${fecha}T12:00:00Z`).getUTCDay()] ?? [];
  return turnos.flatMap(([inicio, fin]) =>
    Array.from({ length: (fin - inicio) / SLOT_MIN }, (_, i) => aHora(inicio + i * SLOT_MIN)),
  );
}

export class Agenda {
  constructor(private store: AgendaStore, private reloj: () => Date = () => new Date()) {}

  async libres(fecha: string): Promise<string[]> {
    const ahora = ahoraEnLima(this.reloj());
    if (!fechaValida(fecha) || fecha < ahora.dia) return [];
    const ocupadas = new Set((await this.store.listar(fecha)).map((cita) => cita.hora));
    return slotsDelDia(fecha).filter((hora) => !ocupadas.has(hora) && (fecha > ahora.dia || hora > ahora.hora));
  }

  /** Devuelve null si el horario ya no está libre. */
  async agendar(datos: NuevaCita): Promise<Cita | null> {
    // ponytail: chequeo y guardado no son atómicos; dos reservas simultáneas al mismo horario podrían pasar. Para un negocio real, bloqueo o restricción única en la base de datos.
    if (!(await this.libres(datos.fecha)).includes(datos.hora)) return null;
    const cita: Cita = { ...datos, id: randomUUID().slice(0, 8), creada: this.reloj().toISOString() };
    await this.store.guardar(cita);
    return cita;
  }
}

/** Agenda en un archivo JSON local: para probar sin configurar nada. */
export class JsonAgendaStore implements AgendaStore {
  constructor(private ruta: string) {}

  private async todas(): Promise<Cita[]> {
    try {
      return JSON.parse(await readFile(this.ruta, "utf8")) as Cita[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async listar(fecha: string): Promise<Cita[]> {
    return (await this.todas()).filter((cita) => cita.fecha === fecha);
  }

  async guardar(cita: Cita): Promise<void> {
    await writeFile(this.ruta, JSON.stringify([...(await this.todas()), cita], null, 1));
  }
}

const COLUMNAS = ["id", "fecha", "hora", "nombre", "telefono", "tratamiento", "creada"] as const;

/** Agenda en Google Sheets (pestaña con encabezados = COLUMNAS). Credenciales: GOOGLE_APPLICATION_CREDENTIALS. */
export class SheetsAgendaStore implements AgendaStore {
  private api = sheets({ version: "v4", auth: new auth.GoogleAuth({ scopes: ["https://www.googleapis.com/auth/spreadsheets"] }) });

  constructor(private hojaId: string, private pestana = "Citas") {}

  async listar(fecha: string): Promise<Cita[]> {
    const res = await this.api.spreadsheets.values.get({ spreadsheetId: this.hojaId, range: `${this.pestana}!A2:G` });
    const filas = (res.data.values ?? []) as string[][];
    return filas.map((fila) => Object.fromEntries(COLUMNAS.map((col, i) => [col, fila[i] ?? ""])) as unknown as Cita)
      .filter((cita) => cita.fecha === fecha);
  }

  async guardar(cita: Cita): Promise<void> {
    await this.api.spreadsheets.values.append({
      spreadsheetId: this.hojaId, range: `${this.pestana}!A:G`, valueInputOption: "RAW",
      requestBody: { values: [COLUMNAS.map((col) => cita[col])] },
    });
  }
}
