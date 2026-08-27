import type { Chapter, DigestItem, MangaAttributes } from "./types";

/** Keep subjects inside what a mail client shows without truncating. */
const MAX_SUBJECT_LENGTH = 78;

export function toDigestItem(chapter: Chapter, languages: string[]): DigestItem {
  return {
    chapterId: chapter.id,
    seriesId: chapter.relationships.find((rel) => rel.type === "manga")?.id ?? "",
    seriesTitle: seriesTitle(chapter, languages),
    publishAt: chapter.attributes.publishAt,
    chapterLabel: chapterLabel(chapter),
    chapterTitle: chapter.attributes.title?.trim() || null,
    url: `https://mangadex.org/chapter/${chapter.id}`,
  };
}

function seriesTitle(chapter: Chapter, languages: string[]): string {
  const manga = chapter.relationships.find((rel) => rel.type === "manga");
  const attributes: MangaAttributes | undefined = manga?.attributes;
  if (!attributes) return "Unknown series";

  const preferences = [...languages, "en", "ja-ro", "ja"];
  const titles = attributes.title ?? {};
  for (const language of preferences) {
    const title = titles[language];
    if (title) return title;
  }

  const anyTitle = Object.values(titles)[0];
  if (anyTitle) return anyTitle;

  for (const alt of attributes.altTitles ?? []) {
    for (const language of preferences) {
      const title = alt[language];
      if (title) return title;
    }
  }

  return "Unknown series";
}

function chapterLabel(chapter: Chapter): string {
  const { volume, chapter: number } = chapter.attributes;
  if (!number) return volume ? `Volume ${volume} (oneshot)` : "Oneshot";
  return volume ? `Vol. ${volume} Ch. ${number}` : `Chapter ${number}`;
}

/**
 * `3 new chapters — Vinland Saga, Frieren`, dropping series names from the end
 * until it fits.
 */
export function buildSubject(items: DigestItem[]): string {
  const count = items.length;
  const noun = count === 1 ? "1 new chapter" : `${count} new chapters`;
  const series = [...new Set(items.map((item) => item.seriesTitle))];

  for (let shown = series.length; shown >= 1; shown--) {
    const hidden = series.length - shown;
    const names = series.slice(0, shown).join(", ") + (hidden > 0 ? ` +${hidden} more` : "");
    const subject = `${noun} — ${names}`;
    if (subject.length <= MAX_SUBJECT_LENGTH) return subject;
  }

  return noun;
}

/** Plain-text alternative. SMTP2GO sends both parts; it helps deliverability. */
export function buildText(items: DigestItem[]): string {
  const lines = items.map((item) => {
    const title = item.chapterTitle ? `: ${item.chapterTitle}` : "";
    return `${item.seriesTitle}\n  ${item.chapterLabel}${title}\n  ${item.url}`;
  });
  return `${lines.join("\n\n")}\n\n--\nSent by nabu.\n`;
}

export function buildHtml(items: DigestItem[]): string {
  const rows = items
    .map((item) => {
      const title = item.chapterTitle ? `: ${escapeHtml(item.chapterTitle)}` : "";
      return [
        '<li style="margin:0 0 10px 0;">',
        `<strong>${escapeHtml(item.seriesTitle)}</strong><br>`,
        `<a href="${escapeHtml(item.url)}" style="color:#ff6740;text-decoration:none;">`,
        `${escapeHtml(item.chapterLabel)}${title}`,
        "</a>",
        "</li>",
      ].join("");
    })
    .join("\n");

  return [
    '<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a;">',
    '<ul style="list-style:none;padding:0;margin:0;">',
    rows,
    "</ul>",
    '<p style="margin-top:24px;font-size:12px;color:#777;">Sent by nabu.</p>',
    "</div>",
  ].join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
