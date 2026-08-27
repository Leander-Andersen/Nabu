import { sendViaGraph } from "./graph";
import { readSecret } from "./secrets";
import { sendViaSmtp2go } from "./smtp2go";
import type { Env } from "./types";

export type MailProvider = "smtp2go" | "graph";

type MailSecretKey =
  | "SMTP2GO_API_KEY"
  | "GRAPH_TENANT_ID"
  | "GRAPH_CLIENT_ID"
  | "GRAPH_CLIENT_SECRET";

const REQUIRED_SECRETS: Record<MailProvider, MailSecretKey[]> = {
  smtp2go: ["SMTP2GO_API_KEY"],
  graph: ["GRAPH_TENANT_ID", "GRAPH_CLIENT_ID", "GRAPH_CLIENT_SECRET"],
};

export function resolveProvider(env: Env): MailProvider {
  const raw = (env.MAIL_PROVIDER ?? "smtp2go").trim().toLowerCase();
  if (raw === "smtp2go" || raw === "graph") return raw;
  throw new Error(`Unknown MAIL_PROVIDER "${env.MAIL_PROVIDER}" — expected "smtp2go" or "graph"`);
}

/**
 * Fails loudly at the top of a run rather than after the API poll, so a missing
 * secret reads as a config error instead of a surprise 401 an hour later.
 */
export async function assertMailConfig(env: Env): Promise<MailProvider> {
  const provider = resolveProvider(env);

  const missing: string[] = [];
  for (const name of REQUIRED_SECRETS[provider]) {
    if (!(await readSecret(env[name]))) missing.push(name);
  }
  if (missing.length > 0) {
    throw new Error(`MAIL_PROVIDER="${provider}" requires ${missing.join(", ")}`);
  }
  if (!env.SENDER_ADDRESS || env.SENDER_ADDRESS.includes("REPLACE_ME")) {
    throw new Error("SENDER_ADDRESS is not configured");
  }
  return provider;
}

export function sendDigest(
  env: Env,
  provider: MailProvider,
  subject: string,
  html: string,
  text: string,
  recipients: string[],
): Promise<void> {
  return provider === "graph"
    ? sendViaGraph(env, subject, html, recipients)
    : sendViaSmtp2go(env, subject, html, text, recipients);
}
