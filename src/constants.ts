/**
 * Workers do not set a User-Agent on outbound fetch, and unlike browser fetch
 * it is not a forbidden header — so it is on us. MangaDex enforces this, and
 * spoofing a browser UA violates their terms. Spread it into *every* outbound
 * request, including the auth.mangadex.org token calls.
 */
export const USER_AGENT =
  "nabu/1.0 (+https://github.com/Leander-Andersen/Nabu; security@isame12.no)";

/** Chapters per feed page. The endpoint accepts up to 100. */
export const PAGE_SIZE = 50;

/** Hard stop on pagination, so a bad `createdAtSince` can never loop forever. */
export const MAX_PAGES = 10;

/**
 * Re-ask for a minute of already-seen history each run, so a chapter created
 * between the feed request and the `last_run` write can't fall through the
 * crack. The KV dedupe absorbs the overlap.
 */
export const OVERLAP_SECONDS = 60;

/**
 * First run only: how far back to look when seeding the dedupe set. Nothing
 * from this window is emailed — it just primes KV so the first real digest
 * contains only genuinely new chapters.
 */
export const SEED_WINDOW_HOURS = 24;
