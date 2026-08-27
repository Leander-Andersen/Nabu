import { USER_AGENT } from "./constants";
import { requireSecret } from "./secrets";
import { parseAddresses, safeText } from "./util";
import type { Env } from "./types";

const SEND_ENDPOINT = "https://api.smtp2go.com/v3/email/send";

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
): Promise<void> {
  const apiKey = await requireSecret("SMTP2GO_API_KEY", env.SMTP2GO_API_KEY);

  const recipients = parseAddresses(env.RECIPIENT_ADDRESS);
  if (recipients.length === 0) throw new Error("RECIPIENT_ADDRESS is empty");

  const res = await fetch(SEND_ENDPOINT, {
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
    throw new Error(`SMTP2GO returned ${res.status}: ${await safeText(res)}`);
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
      `SMTP2GO accepted ${succeeded} and failed ${failed} recipient(s): ${detail}`,
    );
  }
}
