import type { Chapter, Env } from "./types";

const KEY_REFRESH_TOKEN = "refresh_token";
const KEY_LAST_RUN = "last_run";
const seenKey = (chapterId: string) => `seen:${chapterId}`;

/**
 * How long a chapter ID stays in the dedupe set. `createdAtSince` narrows the
 * feed to minutes of history, so a week is a wide margin — it exists to cover
 * a run that dies mid-flight and re-triggers, not to remember the archive.
 */
const SEEN_TTL_SECONDS = 7 * 24 * 60 * 60;

export function getRefreshToken(env: Env): Promise<string | null> {
  return env.NABU_STATE.get(KEY_REFRESH_TOKEN);
}

/**
 * The token endpoint rotates the refresh token on every use, so the new one
 * has to land in KV or auth dies silently once the old one expires.
 */
export function setRefreshToken(env: Env, token: string): Promise<void> {
  return env.NABU_STATE.put(KEY_REFRESH_TOKEN, token);
}

export async function getLastRun(env: Env): Promise<Date | null> {
  const raw = await env.NABU_STATE.get(KEY_LAST_RUN);
  if (raw === null) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function setLastRun(env: Env, at: Date): Promise<void> {
  return env.NABU_STATE.put(KEY_LAST_RUN, at.toISOString());
}

/** Drops chapters already emailed in an earlier run, and in-batch duplicates. */
export async function filterUnseen(env: Env, chapters: Chapter[]): Promise<Chapter[]> {
  const unique = new Map<string, Chapter>();
  for (const chapter of chapters) unique.set(chapter.id, chapter);

  const checked = await Promise.all(
    [...unique.values()].map(async (chapter) => ({
      chapter,
      seen: (await env.NABU_STATE.get(seenKey(chapter.id))) !== null,
    })),
  );
  return checked.filter((entry) => !entry.seen).map((entry) => entry.chapter);
}

export async function markSeen(env: Env, chapterIds: string[]): Promise<void> {
  await Promise.all(
    chapterIds.map((id) =>
      env.NABU_STATE.put(seenKey(id), "1", { expirationTtl: SEEN_TTL_SECONDS }),
    ),
  );
}
