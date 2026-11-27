import type { TargetInfo } from "../types.js";

// A page loaded from a `data:` URL has a URL as long as its content, and every answer that lists targets repeats it
// (measured: one window with a 60 KB data URL made electron_attach answer with 181 KB). 4096 is also the longest `url`
// a selector accepts, so every URL that can be used to choose a page is still shown whole.
export const maxUrlChars = 4_096;
const maxTitleChars = 512;

/** Cuts text to `limit` characters; a cut text ends with `…` and comes with its original length. */
export function bounded(text: string, limit: number): { text: string; truncatedFrom?: number } {
  return text.length > limit ? { text: `${text.slice(0, limit)}…`, truncatedFrom: text.length } : { text };
}

/** A target as tool results show it. Selection keeps working on the full values; only the output is cut. */
export function publicTarget(target: TargetInfo): TargetInfo {
  const title = bounded(target.title, maxTitleChars);
  const url = bounded(target.url, maxUrlChars);
  return {
    ...target,
    title: title.text,
    url: url.text,
    ...(title.truncatedFrom !== undefined ? { titleTruncatedFrom: title.truncatedFrom } : {}),
    ...(url.truncatedFrom !== undefined ? { urlTruncatedFrom: url.truncatedFrom } : {}),
  };
}

/** The `url` of a screenshot or snapshot result, cut the same way. */
export function publicUrl(url: string | undefined): { url?: string; urlTruncatedFrom?: number } {
  if (url === undefined) return {};
  const cut = bounded(url, maxUrlChars);
  return { url: cut.text, ...(cut.truncatedFrom !== undefined ? { urlTruncatedFrom: cut.truncatedFrom } : {}) };
}
