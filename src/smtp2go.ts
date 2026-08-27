import { USER_AGENT } from "./constants";
import { requireSecret } from "./secrets";
import { getSmtp2goRegion } from "./state";
import type { Smtp2goRegion } from "./state";
import { safeText } from "./util";
import type { Env } from "./types";

/**
 * Regional base URLs. SMTP2GO scopes API keys per region, and "global" routes by
 * proximity to the caller — which for a Worker is wherever the request lands.
 */
const REGION_BASES: Record<Smtp2goRegion, string> = {
  global: "https://api.smtp2go.com",
  us: "https://us-api.smtp2go.com",
  eu: "https://eu-api.smtp2go.com",
  au: "https://au-api.smtp2go.com",
};

interface Smtp2goResponse {
  request_id?: string;
  data?: {
    succeeded?: number;
    failed?: number;
    failures?: unknown[];
    email_id?: string;
    error?: string;
    error_code?: string;
  };
}

/**
 * SMTP2GO's HTTP API rather than SMTP proper: Workers cannot open outbound TCP
 * connections on port 25, so there is no host/port/username/password to speak
 * of — just this endpoint and an API key.
 */
export async function sendViaSmtp2go(
  env: Env,
  subject: string,
  html: string,
  text: string,
  recipients: string[],
): Promise<void> {
  const apiKey = await requireSecret("SMTP2GO_API_KEY", env.SMTP2GO_API_KEY);
  if (recipients.length === 0) throw new Error("no recipients configured");

  const region = await getSmtp2goRegion(env);
  const res = await fetch(`${REGION_BASES[region]}/v3/email/send`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-smtp2go-api-key": apiKey,
      "user-agent": USER_AGENT,
    },
    body: JSON.stringify({
      // Must be an address SMTP2GO has verified for the account.
      sender: env.SENDER_NAME
        ? `${env.SENDER_NAME} <${env.SENDER_ADDRESS}>`
        : env.SENDER_ADDRESS,
      to: recipients,
      subject,
      html_body: html,
      text_body: text,
    }),
  });

  if (!res.ok) {
    const detail = await safeText(res);
    // The single most confusing SMTP2GO failure: keys exist per region, so a
    // valid key hitting the wrong region reads as "key not found".
    const hint =
      detail.includes("api_key") && region === "global"
        ? ' — if your account is in a specific region, set it in the dashboard (SMTP2GO region); "global" routes by proximity and its keyspace differs'
        : "";
    throw new Error(`SMTP2GO (${region}) returned ${res.status}: ${detail}${hint}`);
  }

  // A 200 is not proof of delivery: a rejected recipient or an unverified
  // sender comes back 200 with failed > 0, so the body has to be read.
  const body = (await res.json()) as Smtp2goResponse;
  const failed = body.data?.failed ?? 0;
  const succeeded = body.data?.succeeded ?? 0;

  if (failed > 0 || succeeded === 0) {
    const detail =
      body.data?.error ??
      (body.data?.failures?.length ? JSON.stringify(body.data.failures) : "no detail");
    throw new Error(
      `SMTP2GO (${region}) accepted ${succeeded} and failed ${failed} recipient(s): ${detail}`,
    );
  }
}
