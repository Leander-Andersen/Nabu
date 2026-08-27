import { parseAddresses } from "./util";
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

// ---------------------------------------------------------------------------
// Dashboard state: run history, per-series activity, and the recipient list.
// All three live in KV because the dashboard has to be able to read and (for
// recipients) write them at runtime — a wrangler.toml var is fixed at deploy.
// ---------------------------------------------------------------------------

const KEY_RUN_LOG = "run_log";
const KEY_SERIES = "series_index";
const KEY_RECIPIENTS = "recipients";

/** Runs kept in the log. Enough to see a pattern, small enough for one KV value. */
const RUN_LOG_LIMIT = 50;

export interface RunRecord {
  at: string;
  trigger: string;
  provider?: string;
  ok: boolean;
  error?: string;
  seeded?: boolean;
  found?: number;
  readable?: number;
  new?: number;
  mailed?: boolean;
  durationMs?: number;
  recipients?: string[];
  chapters?: { series: string; label: string; url: string }[];
}

export interface SeriesRecord {
  title: string;
  lastChapterLabel?: string;
  lastChapterUrl?: string;
  /** When MangaDex published the most recent chapter nabu has seen. */
  lastChapterAt?: string;
  /** When nabu last observed a new chapter for this series. */
  lastSeenAt?: string;
}

export async function getRunLog(env: Env): Promise<RunRecord[]> {
  return (await env.NABU_STATE.get<RunRecord[]>(KEY_RUN_LOG, "json")) ?? [];
}

export async function appendRunRecord(env: Env, record: RunRecord): Promise<void> {
  const log = await getRunLog(env);
  log.unshift(record);
  await env.NABU_STATE.put(KEY_RUN_LOG, JSON.stringify(log.slice(0, RUN_LOG_LIMIT)));
}

export async function getSeriesIndex(env: Env): Promise<Record<string, SeriesRecord>> {
  return (await env.NABU_STATE.get<Record<string, SeriesRecord>>(KEY_SERIES, "json")) ?? {};
}

export async function putSeriesIndex(
  env: Env,
  index: Record<string, SeriesRecord>,
): Promise<void> {
  await env.NABU_STATE.put(KEY_SERIES, JSON.stringify(index));
}

/**
 * The recipient list, from KV when the dashboard has set one, otherwise seeded
 * from the RECIPIENT_ADDRESS var so a fresh deploy still mails somewhere.
 */
export async function getRecipients(env: Env): Promise<string[]> {
  const stored = await env.NABU_STATE.get<string[]>(KEY_RECIPIENTS, "json");
  if (Array.isArray(stored) && stored.length > 0) return stored;
  return parseAddresses(env.RECIPIENT_ADDRESS ?? "");
}

export async function setRecipients(env: Env, recipients: string[]): Promise<void> {
  await env.NABU_STATE.put(KEY_RECIPIENTS, JSON.stringify(recipients));
}

/** True when the list is coming from the var rather than a dashboard edit. */
export async function recipientsAreDefault(env: Env): Promise<boolean> {
  const stored = await env.NABU_STATE.get<string[]>(KEY_RECIPIENTS, "json");
  return !Array.isArray(stored) || stored.length === 0;
}
