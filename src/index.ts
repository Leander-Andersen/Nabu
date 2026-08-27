import { OVERLAP_SECONDS, SEED_WINDOW_HOURS } from "./constants";
import { buildHtml, buildSubject, buildText, toDigestItem } from "./digest";
import { assertMailConfig, sendDigest } from "./mail";
import { readSecret } from "./secrets";
import { errorMessage, log } from "./log";
import { fetchFeed, getAccessToken, isReadableOnMangaDex, parseLanguages } from "./mangadex";
import { filterUnseen, getLastRun, markSeen, setLastRun } from "./state";
import type { Env } from "./types";

interface RunSummary {
  trigger: string;
  provider: string;
  seeded: boolean;
  found: number;
  readable: number;
  new: number;
  mailed: boolean;
  durationMs: number;
}

async function run(env: Env, trigger: string): Promise<RunSummary> {
  const startedAt = new Date();
  // Checked before the poll so a config mistake fails fast and legibly.
  const provider = await assertMailConfig(env);
  const lastRun = await getLastRun(env);
  const seeding = lastRun === null;

  const since = seeding
    ? new Date(startedAt.getTime() - SEED_WINDOW_HOURS * 60 * 60 * 1000)
    : new Date(lastRun.getTime() - OVERLAP_SECONDS * 1000);

  const accessToken = await getAccessToken(env);
  const chapters = await fetchFeed(env, accessToken, since);
  const readable = chapters.filter(isReadableOnMangaDex);
  const unseen = await filterUnseen(env, readable);

  let mailed = false;

  if (seeding) {
    // First run: prime the dedupe set and the timestamp, email nothing —
    // otherwise the first digest is the whole window.
    await markSeen(env, unseen.map((chapter) => chapter.id));
    log("seeded", { since: since.toISOString(), chapters: unseen.length });
  } else if (unseen.length > 0) {
    const languages = parseLanguages(env.LANGUAGES);
    const items = unseen.map((chapter) => toDigestItem(chapter, languages));
    // Throws on failure, which leaves last_run and the seen set untouched so
    // the next run retries these same chapters instead of losing them.
    await sendDigest(env, provider, buildSubject(items), buildHtml(items), buildText(items));
    mailed = true;
    await markSeen(env, items.map((item) => item.chapterId));
  }

  await setLastRun(env, startedAt);

  const summary: RunSummary = {
    trigger,
    provider,
    seeded: seeding,
    found: chapters.length,
    readable: readable.length,
    new: unseen.length,
    mailed,
    durationMs: Date.now() - startedAt.getTime(),
  };
  log("run_complete", summary);
  return summary;
}

export default {
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      await run(env, "cron");
    } catch (err) {
      // Rethrow so the failure shows up on the cron trigger, not just in logs.
      log("run_failed", { trigger: "cron", error: errorMessage(err) });
      throw err;
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    // Manual "run now", off unless TRIGGER_SECRET is set.
    const triggerSecret = await readSecret(env.TRIGGER_SECRET).catch(() => "");
    if (!triggerSecret) {
      return new Response("Not found\n", { status: 404 });
    }
    if (request.headers.get("authorization") !== `Bearer ${triggerSecret}`) {
      return new Response("Unauthorized\n", { status: 401 });
    }

    try {
      return Response.json(await run(env, "manual"));
    } catch (err) {
      const message = errorMessage(err);
      log("run_failed", { trigger: "manual", error: message });
      return Response.json({ error: message }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
