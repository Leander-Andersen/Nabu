import { readSecret } from "./secrets";
import type { Env } from "./types";

const COOKIE_NAME = "nabu_session";
const SESSION_HOURS = 12;

/**
 * The dashboard is a password gate over a signed cookie: ADMIN_TOKEN is the
 * password, and a valid login mints an HMAC-signed token carrying only an
 * expiry. Nothing sensitive rides in the cookie, and it cannot be forged
 * without the secret.
 *
 * For anything beyond a personal tool, put Cloudflare Access in front of the
 * Worker instead — see the README.
 */
export async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  const secret = await dashboardSecret(env);
  if (!secret) return false;

  // Bearer token, for curl and the pre-existing manual trigger.
  const header = request.headers.get("authorization");
  if (header && timingSafeEqual(header, `Bearer ${secret}`)) return true;

  const cookie = readCookie(request, COOKIE_NAME);
  return cookie ? await verifySession(cookie, secret) : false;
}

export async function dashboardSecret(env: Env): Promise<string> {
  // TRIGGER_SECRET is the older name, kept so an existing setup keeps working.
  const admin = await readSecret(env.ADMIN_TOKEN).catch(() => "");
  if (admin) return admin;
  return await readSecret(env.TRIGGER_SECRET).catch(() => "");
}

export async function checkPassword(candidate: string, env: Env): Promise<boolean> {
  const secret = await dashboardSecret(env);
  return secret.length > 0 && timingSafeEqual(candidate, secret);
}

export async function createSessionCookie(env: Env): Promise<string> {
  const secret = await dashboardSecret(env);
  const expires = Date.now() + SESSION_HOURS * 60 * 60 * 1000;
  const payload = base64UrlEncode(JSON.stringify({ exp: expires }));
  const signature = base64UrlEncode(await hmac(secret, payload));
  const maxAge = SESSION_HOURS * 60 * 60;
  return `${COOKIE_NAME}=${payload}.${signature}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

async function verifySession(token: string, secret: string): Promise<boolean> {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;

  const expected = base64UrlEncode(await hmac(secret, payload));
  if (!timingSafeEqual(signature, expected)) return false;

  try {
    const { exp } = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
    return typeof exp === "number" && Date.now() < exp;
  } catch {
    return false;
  }
}

async function hmac(secret: string, data: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
}

/** Length-independent comparison, so a wrong password leaks no timing signal. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function base64UrlEncode(input: string | ArrayBuffer): string {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
