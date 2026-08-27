/** One JSON object per line, so `wrangler tail` stays greppable. */
export function log(event: string, fields: object = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
