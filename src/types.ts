/**
 * Bindings, plus the slices of the MangaDex API responses that nabu actually
 * reads. These are deliberately partial — the API returns far more than this.
 */

/**
 * Either a `wrangler secret` / `.dev.vars` string, or a Secrets Store binding.
 * Read it with `readSecret()` from ./secrets — never touch it directly.
 */
export type SecretRef = string | SecretsStoreSecret | undefined;

export interface Env {
  // --- secrets (wrangler secret put ..., or a Secrets Store binding) ---
  /**
   * All four MangaDex values as one JSON object. Takes precedence over the
   * individual MD_* bindings below, which remain as a fallback for `.dev.vars`.
   */
  MD_CREDENTIALS?: SecretRef;
  MD_USERNAME?: SecretRef;
  MD_PASSWORD?: SecretRef;
  MD_CLIENT_ID?: SecretRef;
  MD_CLIENT_SECRET?: SecretRef;

  /** Required when MAIL_PROVIDER is "smtp2go". */
  SMTP2GO_API_KEY?: SecretRef;

  /** Required when MAIL_PROVIDER is "graph". */
  GRAPH_TENANT_ID?: SecretRef;
  GRAPH_CLIENT_ID?: SecretRef;
  GRAPH_CLIENT_SECRET?: SecretRef;

  /**
   * Password for the admin dashboard, and the bearer token for its API.
   * When unset, the Worker serves nothing over HTTP (404) and only the cron
   * can drive it. TRIGGER_SECRET is the older name for the same thing.
   */
  ADMIN_TOKEN?: SecretRef;
  TRIGGER_SECRET?: SecretRef;

  // --- vars (wrangler.toml) ---
  /** "smtp2go" (default) or "graph". */
  MAIL_PROVIDER?: string;
  SENDER_ADDRESS: string;
  /** Optional display name on the From line, e.g. "nabu". */
  SENDER_NAME?: string;
  RECIPIENT_ADDRESS: string;
  LANGUAGES: string;

  // --- bindings ---
  NABU_STATE: KVNamespace;
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_expires_in?: number;
  token_type: string;
}

export interface MangaAttributes {
  title: Record<string, string>;
  altTitles?: Record<string, string>[];
}

export interface Relationship {
  id: string;
  type: string;
  attributes?: MangaAttributes;
}

export interface ChapterAttributes {
  volume: string | null;
  chapter: string | null;
  title: string | null;
  translatedLanguage: string;
  /** Non-null means the chapter lives on a publisher's site, not MangaDex. */
  externalUrl: string | null;
  publishAt: string;
  readableAt: string;
  createdAt: string;
  updatedAt: string;
  pages: number;
}

export interface Chapter {
  id: string;
  type: string;
  attributes: ChapterAttributes;
  relationships: Relationship[];
}

export interface ChapterFeedResponse {
  result: string;
  response: string;
  data: Chapter[];
  limit: number;
  offset: number;
  total: number;
}

/** A chapter flattened into everything the email needs. */
export interface DigestItem {
  chapterId: string;
  seriesId: string;
  seriesTitle: string;
  publishAt: string;
  chapterLabel: string;
  chapterTitle: string | null;
  url: string;
}
