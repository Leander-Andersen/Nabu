import type { SecretRef } from "./types";

/**
 * A secret reaches the Worker one of two ways:
 *
 *   - `wrangler secret put` / `.dev.vars` — the binding is a plain string.
 *   - Cloudflare Secrets Store — the binding is an object you await `.get()` on.
 *
 * Every read goes through here so either works, and so local `wrangler dev`
 * (which cannot reach production Secrets Store values) can fall back to
 * `.dev.vars` without a code change.
 */
export async function readSecret(value: SecretRef): Promise<string> {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  try {
    return (await value.get()).trim();
  } catch (err) {
    // Secrets Store throws when the secret behind the binding is gone.
    throw new Error(
      `Secrets Store binding could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function requireSecret(name: string, value: SecretRef): Promise<string> {
  const resolved = await readSecret(value);
  if (!resolved) throw new Error(`${name} is not set`);
  return resolved;
}
