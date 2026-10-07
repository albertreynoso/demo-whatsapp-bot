/** Log estructurado en una línea de JSON (stdout): `event` siempre, el resto según el caso. */
export function log(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + "\n");
}
