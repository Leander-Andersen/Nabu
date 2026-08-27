import {
  checkPassword,
  clearSessionCookie,
  createSessionCookie,
  dashboardSecret,
  isAuthorized,
} from "./auth";
import { OVERLAP_SECONDS, SEED_WINDOW_HOURS } from "./constants";
import { renderDashboard, renderLogin } from "./dashboard";
import { buildHtml, buildSubject, buildText, toDigestItem } from "./digest";
import { errorMessage, log } from "./log";
import { assertMailConfig, sendDigest } from "./mail";
import {
  fetchFeed,
  fetchFollowedManga,
  getAccessToken,
  isReadableOnMangaDex,
  parseLanguages,
} from "./mangadex";
import {
  appendRunRecord,
  filterUnseen,
  getLastRun,
  getRecipients,
  getRunLog,
  getSeriesIndex,
  markSeen,
  putSeriesIndex,
  recipientsAreDefault,
  setLastRun,
  setRecipients,
} from "./state";
import type { RunRecord, SeriesRecord } from "./state";
import type { DigestItem, Env } from "./types";
import { parseAddresses } from "./util";

interface RunSummary {
  trigger: string;
  provider: string;
  seeded: boolean;
  found: number;
  readable: number;
  new: number;
  mailed: boolean;
  recipients: string[];
  chapters: { series: string; label: string; url: string }[];
  durationMs: number;
}

async function run(env: Env, trigger: string): Promise<RunSummary> {
  const startedAt = new Date();
  // Checked before the poll so a config mistake fails fast and legibly.
  const provider = await assertMailConfig(env);
  const recipients = await getRecipients(env);
  const lastRun = await getLastRun(env);
  const seeding = lastRun === null;

  const since = seeding
    ? new Date(startedAt.getTime() - SEED_WINDOW_HOURS * 60 * 60 * 1000)
    : new Date(lastRun.getTime() - OVERLAP_SECONDS * 1000);

  const accessToken = await getAccessToken(env);
  const chapters = await fetchFeed(env, accessToken, since);
  const readable = chapters.filter(isReadableOnMangaDex);
  const unseen = await filterUnseen(env, readable);

  const languages = parseLanguages(env.LANGUAGES);
  const items = unseen.map((chapter) => toDigestItem(chapter, languages));
  let mailed = false;

  if (seeding) {
    // First run: prime the dedupe set and the timestamp, email nothing —
    // otherwise the first digest is the whole window.
    await markSeen(env, items.map((item) => item.chapterId));
    log("seeded", { since: since.toISOString(), chapters: items.length });
  } else if (items.length > 0) {
    // Throws on failure, which leaves last_run and the seen set untouched so
    // the next run retries these same chapters instead of losing them.
    await sendDigest(
      env,
      provider,
      buildSubject(items),
      buildHtml(items),
      buildText(items),
      recipients,
    );
    mailed = true;
    await markSeen(env, items.map((item) => item.chapterId));
  }

  await recordSeriesActivity(env, items, startedAt);
  await setLastRun(env, startedAt);

  const summary: RunSummary = {
    trigger,
    provider,
    seeded: seeding,
    found: chapters.length,
    readable: readable.length,
    new: items.length,
    mailed,
    recipients,
    chapters: items.map((item) => ({
      series: item.seriesTitle,
      label: item.chapterLabel + (item.chapterTitle ? `: ${item.chapterTitle}` : ""),
      url: item.url,
    })),
    durationMs: Date.now() - startedAt.getTime(),
  };
  log("run_complete", { ...summary, chapters: summary.chapters.length });
  return summary;
}

/** Wraps a run so both outcomes land in the dashboard's history. */
async function runAndRecord(env: Env, trigger: string): Promise<RunSummary> {
  const at = new Date().toISOString();
  try {
    const summary = await run(env, trigger);
    await appendRunRecord(env, { at, ok: true, ...summary });
    return summary;
  } catch (err) {
    const record: RunRecord = { at, trigger, ok: false, error: errorMessage(err) };
    // A failure to write history must not mask the failure that caused it.
    await appendRunRecord(env, record).catch(() => {});
    throw err;
  }
}

async function recordSeriesActivity(
  env: Env,
  items: DigestItem[],
  at: Date,
): Promise<void> {
  if (items.length === 0) return;

  const index = await getSeriesIndex(env);
  for (const item of items) {
    if (!item.seriesId) continue;
    const existing = index[item.seriesId];
    // publishAt can move when an upload is edited, so keep the latest we've seen.
    if (existing?.lastChapterAt && existing.lastChapterAt > item.publishAt) continue;
    index[item.seriesId] = {
      title: item.seriesTitle,
      lastChapterLabel: item.chapterLabel,
      lastChapterUrl: item.url,
      lastChapterAt: item.publishAt,
      lastSeenAt: at.toISOString(),
    };
  }
  await putSeriesIndex(env, index);
}

// ---------------------------------------------------------------------------
// HTTP: the admin dashboard and its JSON API. All of it is gated on
// ADMIN_TOKEN; with that unset the Worker serves nothing and only the cron runs.
// ---------------------------------------------------------------------------

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers });

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (!(await dashboardSecret(env))) {
    return new Response("Not found\n", { status: 404 });
  }

  if (path === "/login" && request.method === "POST") {
    const form = await request.formData();
    const password = String(form.get("password") ?? "");
    if (!(await checkPassword(password, env))) {
      return new Response(renderLogin("Wrong password."), {
        status: 401,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response(null, {
      status: 303,
      headers: { location: "/", "set-cookie": await createSessionCookie(env) },
    });
  }

  const authorized = await isAuthorized(request, env);

  if (path === "/" && request.method === "GET") {
    const body = authorized ? renderDashboard() : renderLogin();
    return new Response(body, {
      status: authorized ? 200 : 401,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  if (!authorized) return json({ error: "unauthorized" }, 401);

  if (path === "/logout" && request.method === "POST") {
    return new Response(null, {
      status: 303,
      headers: { location: "/", "set-cookie": clearSessionCookie() },
    });
  }

  if (path === "/api/state" && request.method === "GET") {
    const [runs, series, recipients, usingDefault, lastRun] = await Promise.all([
      getRunLog(env),
      getSeriesIndex(env),
      getRecipients(env),
      recipientsAreDefault(env),
      getLastRun(env),
    ]);
    return json({
      runs,
      series: Object.entries(series)
        .map(([id, record]) => ({ id, ...record }))
        .sort((a, b) => (b.lastChapterAt ?? "").localeCompare(a.lastChapterAt ?? "")),
      recipients,
      recipientsAreDefault: usingDefault,
      config: {
        provider: env.MAIL_PROVIDER ?? "smtp2go",
        sender: env.SENDER_ADDRESS,
        languages: env.LANGUAGES,
        lastRun: lastRun?.toISOString() ?? null,
      },
    });
  }

  if (path === "/api/run" && request.method === "POST") {
    try {
      return json({ ok: true, summary: await runAndRecord(env, "manual") });
    } catch (err) {
      return json({ ok: false, error: errorMessage(err) }, 500);
    }
  }

  if (path === "/api/recipients" && request.method === "PUT") {
    const body = (await request.json().catch(() => null)) as { recipients?: unknown } | null;
    const raw = Array.isArray(body?.recipients) ? body.recipients : null;
    if (!raw) return json({ error: "expected { recipients: string[] }" }, 400);

    // Trim, drop blanks, then dedupe case-insensitively so the same person
    // cannot end up on the digest twice.
    const seen = new Set<string>();
    const cleaned = parseAddresses(raw.filter((v) => typeof v === "string").join(",")).filter(
      (address) => {
        const key = address.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      },
    );
    const invalid = cleaned.filter((address) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address));
    if (invalid.length > 0) {
      return json({ error: `not an email address: ${invalid.join(", ")}` }, 400);
    }
    if (cleaned.length === 0) {
      return json({ error: "at least one recipient is required" }, 400);
    }

    await setRecipients(env, cleaned);
    return json({ ok: true, recipients: cleaned });
  }

  if (path === "/api/series/refresh" && request.method === "POST") {
    try {
      const accessToken = await getAccessToken(env);
      const languages = parseLanguages(env.LANGUAGES);
      const follows = await fetchFollowedManga(accessToken, languages);
      const index = await getSeriesIndex(env);

      for (const manga of follows) {
        const existing: SeriesRecord | undefined = index[manga.id];
        // Keep observed chapter data; only fill in the title and any new series.
        index[manga.id] = { ...existing, title: manga.title };
      }
      await putSeriesIndex(env, index);
      return json({ ok: true, followed: follows.length });
    } catch (err) {
      return json({ ok: false, error: errorMessage(err) }, 500);
    }
  }

  return json({ error: "not found" }, 404);
}

export default {
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      await runAndRecord(env, "cron");
    } catch (err) {
      // Rethrow so the failure shows up on the cron trigger, not just in logs.
      log("run_failed", { trigger: "cron", error: errorMessage(err) });
      throw err;
    }
  },

  fetch: handleRequest,
} satisfies ExportedHandler<Env>;
