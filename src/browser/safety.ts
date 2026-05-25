import {
  normalizePublicHttpUrl,
  type PublicUrlLookup,
  type PublicUrlSafetyContext,
} from "../web/publicUrlSafety";

export const BROWSER_EXTRACT_MIN_CHARS = 500;
export const BROWSER_EXTRACT_DEFAULT_CHARS = 6000;
export const BROWSER_EXTRACT_MAX_CHARS = 20_000;
export const BROWSER_SNAPSHOT_DEFAULT_CHARS = 4000;
export const BROWSER_SNAPSHOT_MAX_CHARS = 12_000;

export interface BrowserNavigationSafetyOptions {
  lookupImpl?: PublicUrlLookup;
}

export interface BrowserTextLimit {
  defaultChars: number;
  maxChars: number;
  minChars?: number;
}

export interface BrowserTextResult {
  text: string;
  truncated: boolean;
  originalLength: number;
  maxChars: number;
}

export interface UnsafeBrowserSnapshot {
  url: string;
  title?: string;
  text?: string;
  screenshotBase64?: string;
}

export interface SafeBrowserSnapshot {
  url: string;
  title?: string;
  text: string;
  truncated: boolean;
  originalLength: number;
  maxChars: number;
  screenshotIncluded: false;
}

const BROWSER_NAVIGATION_URL_CONTEXT: PublicUrlSafetyContext = {
  actionLabel: "Browser navigation",
  urlLabel: "Browser navigation URL",
};

export async function normalizeBrowserNavigationUrl(
  value: string,
  options: BrowserNavigationSafetyOptions = {},
): Promise<string> {
  const url = await normalizePublicHttpUrl(value, {
    context: BROWSER_NAVIGATION_URL_CONTEXT,
    lookupImpl: options.lookupImpl,
  });
  return url.toString();
}

export function resolveBrowserExtractLimit(value: number | undefined): number {
  return resolveBrowserTextLimit(value, {
    defaultChars: BROWSER_EXTRACT_DEFAULT_CHARS,
    maxChars: BROWSER_EXTRACT_MAX_CHARS,
    minChars: BROWSER_EXTRACT_MIN_CHARS,
  });
}

export function resolveBrowserSnapshotLimit(value: number | undefined): number {
  return resolveBrowserTextLimit(value, {
    defaultChars: BROWSER_SNAPSHOT_DEFAULT_CHARS,
    maxChars: BROWSER_SNAPSHOT_MAX_CHARS,
    minChars: BROWSER_EXTRACT_MIN_CHARS,
  });
}

export function limitBrowserText(value: string, maxChars: number): BrowserTextResult {
  const text = normalizeBrowserText(value);
  const clippedText = text.length > maxChars ? text.slice(0, maxChars).trimEnd() : text;
  return {
    text: clippedText,
    truncated: text.length > maxChars,
    originalLength: text.length,
    maxChars,
  };
}

export function sanitizeBrowserSnapshot(
  snapshot: UnsafeBrowserSnapshot,
  options: { maxChars?: number } = {},
): SafeBrowserSnapshot {
  const limited = limitBrowserText(snapshot.text ?? "", resolveBrowserSnapshotLimit(options.maxChars));
  return {
    url: snapshot.url,
    title: normalizeOptionalString(snapshot.title),
    text: limited.text,
    truncated: limited.truncated,
    originalLength: limited.originalLength,
    maxChars: limited.maxChars,
    screenshotIncluded: false,
  };
}

function resolveBrowserTextLimit(value: number | undefined, limit: BrowserTextLimit): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return limit.defaultChars;
  }

  const minChars = limit.minChars ?? 1;
  return Math.min(limit.maxChars, Math.max(minChars, Math.trunc(value)));
}

function normalizeBrowserText(value: string): string {
  return value
    .split("\n")
    .map((line) => line.replace(/[\s\u00a0]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function normalizeOptionalString(value?: string): string | undefined {
  const normalized = value?.replace(/[\s\u00a0]+/g, " ").trim();
  return normalized || undefined;
}
