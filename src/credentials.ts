import { readSecret, requireSecret } from "./secrets";
import type { Env } from "./types";

export interface MangaDexCredentials {
  /** Optional: only needed for the initial password grant. See README. */
  username?: string;
  password?: string;
  clientId: string;
  clientSecret: string;
}

/**
 * MangaDex has no standalone API key and no client_credentials flow. A personal
 * client — which their docs describe as working "similarly to an API key" — is
 * a clientId/clientSecret pair, and on its own it cannot authenticate: the
 * follows feed is user-scoped, so the *password grant* needs the account login
 * too.
 *
 * username/password are therefore optional here. Supply them and nabu can
 * bootstrap itself. Omit them and nabu runs refresh-token-only: seed KV once
 * (see README) and no account password is ever stored in the Worker. The cost
 * is that a rejected refresh token cannot self-heal and must be re-seeded.
 *
 * All values can travel together in one Secrets Store item as JSON
 * (MD_CREDENTIALS), or arrive as separate bindings/vars; the bundle wins.
 */
const ALIASES = {
  username: ["username", "user_name", "user"],
  password: ["password", "pass"],
  clientId: ["clientId", "client_id", "clientID"],
  clientSecret: ["clientSecret", "client_secret"],
} satisfies Record<keyof MangaDexCredentials, string[]>;

export async function getMangaDexCredentials(env: Env): Promise<MangaDexCredentials> {
  const bundle = await readSecret(env.MD_CREDENTIALS);
  if (bundle) return parseBundle(bundle);

  return {
    username: (await readSecret(env.MD_USERNAME)) || undefined,
    password: (await readSecret(env.MD_PASSWORD)) || undefined,
    clientId: await requireSecret("MD_CLIENT_ID", env.MD_CLIENT_ID),
    clientSecret: await requireSecret("MD_CLIENT_SECRET", env.MD_CLIENT_SECRET),
  };
}

function parseBundle(raw: string): MangaDexCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Deliberately never echoes the value — it is the secret.
    throw new Error(
      'MD_CREDENTIALS is not valid JSON. Expected {"username":…,"password":…,"clientId":…,"clientSecret":…}',
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("MD_CREDENTIALS must be a JSON object");
  }

  const record = parsed as Record<string, unknown>;
  const found: Partial<MangaDexCredentials> = {};

  for (const [field, aliases] of Object.entries(ALIASES) as [
    keyof MangaDexCredentials,
    string[],
  ][]) {
    const hit = aliases
      .map((alias) => record[alias])
      .find((value): value is string => typeof value === "string" && value.trim() !== "");
    if (hit) found[field] = hit.trim();
  }

  // Only the client identity is mandatory; the login is optional by design.
  const missing = (["clientId", "clientSecret"] as const).filter((field) => !found[field]);
  if (missing.length > 0) {
    throw new Error(`MD_CREDENTIALS is missing: ${missing.join(", ")}`);
  }
  return found as MangaDexCredentials;
}
