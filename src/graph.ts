import { USER_AGENT } from "./constants";
import { requireSecret } from "./secrets";
import { safeText } from "./util";
import type { Env } from "./types";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const GRAPH_SCOPE = "https://graph.microsoft.com/.default";

/**
 * App-only client credentials against the existing M365 tenant. The app
 * registration holds Mail.Send, narrowed by an application access policy so it
 * can only send as SENDER_ADDRESS.
 */
async function getGraphToken(env: Env): Promise<string> {
  const tenantId = await requireSecret("GRAPH_TENANT_ID", env.GRAPH_TENANT_ID);
  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": USER_AGENT,
    },
    body: new URLSearchParams({
      client_id: await requireSecret("GRAPH_CLIENT_ID", env.GRAPH_CLIENT_ID),
      client_secret: await requireSecret("GRAPH_CLIENT_SECRET", env.GRAPH_CLIENT_SECRET),
      scope: GRAPH_SCOPE,
      grant_type: "client_credentials",
    }),
  });

  if (!res.ok) {
    throw new Error(`Graph token request returned ${res.status}: ${await safeText(res)}`);
  }

  const token = (await res.json()) as { access_token: string };
  return token.access_token;
}

export async function sendViaGraph(
  env: Env,
  subject: string,
  html: string,
  recipients: string[],
): Promise<void> {
  const accessToken = await getGraphToken(env);
  if (recipients.length === 0) throw new Error("no recipients configured");

  const res = await fetch(
    `${GRAPH_BASE}/users/${encodeURIComponent(env.SENDER_ADDRESS)}/sendMail`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "user-agent": USER_AGENT,
      },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: "HTML", content: html },
          toRecipients: recipients.map((address) => ({
            emailAddress: { address },
          })),
        },
        saveToSentItems: false,
      }),
    },
  );

  // sendMail answers 202 Accepted with an empty body on success.
  if (res.status !== 202) {
    throw new Error(`Graph sendMail returned ${res.status}: ${await safeText(res)}`);
  }
}
