import { MAX_PAGES, PAGE_SIZE, USER_AGENT } from "./constants";
import { getMangaDexCredentials } from "./credentials";
import type { MangaDexCredentials } from "./credentials";
import { errorMessage, log } from "./log";
import { getRefreshToken, setRefreshToken } from "./state";
import { safeText } from "./util";
import type { Chapter, ChapterFeedResponse, Env, TokenResponse } from "./types";

const API_BASE = "https://api.mangadex.org";
const TOKEN_ENDPOINT =
  "https://auth.mangadex.org/realms/mangadex/protocol/openid-connect/token";

/**
 * Access tokens live ~15 minutes, which is shorter than the cron interval, so
 * there is nothing worth caching between runs: refresh once per run and use it.
 * Falls back to the password grant when the stored refresh token is missing or
 * has been rejected.
 */
export async function getAccessToken(env: Env): Promise<string> {
  const credentials = await getMangaDexCredentials(env);
  const refreshToken = await getRefreshToken(env);

  if (refreshToken) {
    try {
      return await requestToken(env, credentials, {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      });
    } catch (err) {
      log("md_refresh_failed", { error: errorMessage(err) });
    }
  }

  // Only reached on the very first run, or if the refresh token is rejected.
  if (!credentials.username || !credentials.password) {
    throw new Error(
      refreshToken
        ? "MangaDex refresh token was rejected and no username/password is configured — re-seed refresh_token in KV (see README)"
        : "No MangaDex refresh token in KV and no username/password is configured — seed refresh_token in KV (see README)",
    );
  }

  return await requestToken(env, credentials, {
    grant_type: "password",
    username: credentials.username,
    password: credentials.password,
  });
}

async function requestToken(
  env: Env,
  credentials: MangaDexCredentials,
  grant: Record<string, string>,
): Promise<string> {
  const body = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    ...grant,
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": USER_AGENT,
    },
    body,
  });

  if (!res.ok) {
    throw new Error(
      `MangaDex token endpoint returned ${res.status}: ${await safeText(res)}`,
    );
  }

  const token = (await res.json()) as TokenResponse;
  // Every response rotates the refresh token. Persist it or auth dies weeks later.
  if (token.refresh_token) await setRefreshToken(env, token.refresh_token);
  return token.access_token;
}

/**
 * `createdAtSince` is strict: `YYYY-MM-DDTHH:MM:SS`, UTC, no milliseconds and
 * no trailing Z. Anything else is a 400.
 */
export function formatSince(at: Date): string {
  return at.toISOString().slice(0, 19);
}

export function parseLanguages(raw: string): string[] {
  const languages = raw
    .split(",")
    .map((lang) => lang.trim())
    .filter((lang) => lang.length > 0);
  return languages.length > 0 ? languages : ["en"];
}

/** Pulls every followed-manga chapter created since `since`, following pages. */
export async function fetchFeed(
  env: Env,
  accessToken: string,
  since: Date,
): Promise<Chapter[]> {
  const languages = parseLanguages(env.LANGUAGES);
  const chapters: Chapter[] = [];
  let offset = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(`${API_BASE}/user/follows/manga/feed`);
    for (const language of languages) {
      url.searchParams.append("translatedLanguage[]", language);
    }
    // Without includes[]=manga the chapter carries only a relationship ID, and
    // the series title for the email would cost one extra request per chapter.
    url.searchParams.append("includes[]", "manga");
    url.searchParams.set("order[publishAt]", "desc");
    url.searchParams.set("limit", String(PAGE_SIZE));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("createdAtSince", formatSince(since));

    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "user-agent": USER_AGENT,
      },
    });

    if (!res.ok) {
      throw new Error(`MangaDex feed returned ${res.status}: ${await safeText(res)}`);
    }

    const body = (await res.json()) as ChapterFeedResponse;
    chapters.push(...body.data);
    offset += body.data.length;

    if (body.data.length === 0 || offset >= body.total) break;
    if (page === MAX_PAGES - 1) {
      log("md_feed_truncated", { fetched: chapters.length, total: body.total });
    }
  }

  return chapters;
}

/**
 * Entries with an externalUrl are official publisher links, not something you
 * can read on MangaDex — they'd only clutter the digest.
 */
export function isReadableOnMangaDex(chapter: Chapter): boolean {
  const external = chapter.attributes.externalUrl;
  return external === null || external === undefined || external === "";
}

/**
 * The full followed-series list, used by the dashboard so series with no recent
 * activity still appear. Separate from the chapter feed, which only surfaces a
 * series when it has published something.
 */
export async function fetchFollowedManga(
  accessToken: string,
  languages: string[],
): Promise<{ id: string; title: string }[]> {
  const out: { id: string; title: string }[] = [];
  let offset = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(`${API_BASE}/user/follows/manga`);
    url.searchParams.set("limit", "100");
    url.searchParams.set("offset", String(offset));

    const res = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}`, "user-agent": USER_AGENT },
    });
    if (!res.ok) {
      throw new Error(`MangaDex follows returned ${res.status}: ${await safeText(res)}`);
    }

    const body = (await res.json()) as {
      data: { id: string; attributes?: { title?: Record<string, string> } }[];
      total: number;
    };

    for (const manga of body.data) {
      const titles = manga.attributes?.title ?? {};
      const title =
        [...languages, "en", "ja-ro", "ja"].map((l) => titles[l]).find(Boolean) ??
        Object.values(titles)[0] ??
        "Untitled";
      out.push({ id: manga.id, title });
    }

    offset += body.data.length;
    if (body.data.length === 0 || offset >= body.total) break;
  }

  return out;
}
