/** Reads an error body without letting a broken/huge response mask the real failure. */
export async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "<unreadable body>";
  }
}

/** Splits a comma-separated address var into a clean list. */
export function parseAddresses(raw: string): string[] {
  return raw
    .split(",")
    .map((address) => address.trim())
    .filter((address) => address.length > 0);
}
