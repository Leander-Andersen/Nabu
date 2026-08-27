import { readSecret } from "./secrets";
import type { Env, SecretRef } from "./types";

/**
 * Reports the *shape* of each configured secret, never its value. Secrets Store
 * values cannot be read back through the API by design, so when a provider
 * rejects a credential this is the only way to tell "missing" from "truncated"
 * from "wrong kind of credential" without re-pasting it blindly.
 *
 * Deliberately reports no characters of any secret — only length and whether it
 * matches the shape that provider expects.
 */
export interface SecretDiagnostic {
  name: string;
  present: boolean;
  source: "secrets-store" | "string" | "unset";
  length: number;
  looksRight: boolean;
  note: string;
}

async function inspect(
  name: string,
  ref: SecretRef,
  expect: (value: string) => { ok: boolean; note: string },
): Promise<SecretDiagnostic> {
  const source =
    ref === undefined || ref === null ? "unset" : typeof ref === "string" ? "string" : "secrets-store";

  let value = "";
  try {
    value = await readSecret(ref);
  } catch (err) {
    return {
      name,
      present: false,
      source,
      length: 0,
      looksRight: false,
      note: err instanceof Error ? err.message : "could not be read",
    };
  }

  if (!value) {
    return { name, present: false, source, length: 0, looksRight: false, note: "not set" };
  }

  const { ok, note } = expect(value);
  return { name, present: true, source, length: value.length, looksRight: ok, note };
}

export async function collectDiagnostics(env: Env): Promise<SecretDiagnostic[]> {
  return Promise.all([
    inspect("SMTP2GO_API_KEY", env.SMTP2GO_API_KEY, (value) => {
      // Checked before the prefix test: a quoted value starts with a quote, and
      // "does not start with api-" would be a misleading way to say so.
      if (/^["'].*["']$/.test(value)) {
        return {
          ok: false,
          note: "wrapped in quote marks — store the bare key, no quotes around it",
        };
      }
      if (/\s/.test(value)) {
        return { ok: false, note: "contains a space or newline — likely a mangled paste" };
      }
      if (!value.startsWith("api-")) {
        return {
          ok: false,
          note: 'does not start with "api-" — this looks like an SMTP username/password from "SMTP Users", not an API key from "API Keys"',
        };
      }
      if (value.length < 20) {
        return {
          ok: false,
          note: "starts with api- but is too short — the list view masks the key, so copy it from the dialog shown when it is created",
        };
      }
      return { ok: true, note: "looks like an SMTP2GO API key" };
    }),

    inspect("MD_CREDENTIALS", env.MD_CREDENTIALS, (value) => {
      try {
        const parsed = JSON.parse(value) as Record<string, unknown>;
        const fields = Object.keys(parsed);
        const hasClient =
          (parsed.clientId ?? parsed.client_id) && (parsed.clientSecret ?? parsed.client_secret);
        return hasClient
          ? { ok: true, note: `JSON with: ${fields.join(", ")}` }
          : { ok: false, note: `JSON, but missing clientId/clientSecret. Has: ${fields.join(", ")}` };
      } catch {
        return { ok: false, note: "not valid JSON" };
      }
    }),

    inspect("ADMIN_TOKEN", env.ADMIN_TOKEN, (value) =>
      value.length >= 16
        ? { ok: true, note: "set" }
        : { ok: false, note: "shorter than 16 characters — this is a public endpoint" },
    ),
  ]);
}
