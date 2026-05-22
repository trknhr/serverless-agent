import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

export interface WebSearchInput {
  query: string;
  limit?: number;
  country?: string;
  language?: string;
  freshness?: "day" | "week" | "month" | "year";
  domains?: string[];
}

export interface WebSearchResult {
  title: string;
  url: string;
  description?: string;
  publishedAt?: string;
  sourceName?: string;
  language?: string;
}

export type WebSearchProviderName = "brave" | "searxng";

export interface WebSearchResponse {
  provider: WebSearchProviderName;
  query: string;
  count: number;
  results: WebSearchResult[];
}

export interface WebExtractInput {
  url: string;
  maxChars?: number;
}

export interface WebExtractResult {
  url: string;
  finalUrl: string;
  title?: string;
  contentType?: string;
  text: string;
  truncated: boolean;
}

export interface WebToolProvider {
  search(input: WebSearchInput): Promise<WebSearchResponse>;
  extract(input: WebExtractInput): Promise<WebExtractResult>;
}

interface WebToolsProviderOptions {
  searchProvider?: string;
  searchApiKeyProvider?: () => Promise<string | undefined>;
  searchBaseUrl?: string;
  fetchImpl?: typeof fetch;
  lookupImpl?: LookupImpl;
  timeoutMs?: number;
  maxExtractBytes?: number;
}

interface BraveSearchResponsePayload {
  web?: {
    results?: BraveSearchResultPayload[];
  };
}

interface BraveSearchResultPayload {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
  page_age?: string;
  language?: string;
  profile?: {
    name?: string;
    long_name?: string;
  };
}

interface SearxngSearchResponsePayload {
  results?: SearxngSearchResultPayload[];
}

interface SearxngSearchResultPayload {
  title?: string;
  url?: string;
  content?: string;
  publishedDate?: string;
  engine?: string;
}

type LookupImpl = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: number }>>;

const BRAVE_WEB_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
const SEARXNG_FRESHNESS_VALUES: Record<NonNullable<WebSearchInput["freshness"]>, string> = {
  day: "day",
  week: "week",
  month: "month",
  year: "year",
};
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_EXTRACT_BYTES = 1_000_000;
const DEFAULT_EXTRACT_CHARS = 6000;
const MAX_REDIRECTS = 3;
const USER_AGENT = "slack-ai-assistant/0.1";
const FRESHNESS_VALUES: Record<NonNullable<WebSearchInput["freshness"]>, string> = {
  day: "pd",
  week: "pw",
  month: "pm",
  year: "py",
};

export class WebToolsProvider implements WebToolProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly lookupImpl: LookupImpl;
  private readonly timeoutMs: number;
  private readonly maxExtractBytes: number;

  constructor(private readonly options: WebToolsProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.lookupImpl = options.lookupImpl ?? lookup;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxExtractBytes = options.maxExtractBytes ?? DEFAULT_MAX_EXTRACT_BYTES;
  }

  async search(input: WebSearchInput): Promise<WebSearchResponse> {
    const provider = normalizeSearchProvider(this.options.searchProvider);
    if (!provider) {
      throw new Error(
        "Web search is not configured. Set WEB_SEARCH_PROVIDER to a supported provider such as brave or searxng.",
      );
    }

    switch (provider) {
      case "brave":
        return await this.searchBrave(input);
      case "searxng":
        return await this.searchSearxng(input);
      default:
        throw new Error(`Unsupported web search provider: ${provider}`);
    }
  }

  async extract(input: WebExtractInput): Promise<WebExtractResult> {
    const maxChars = clampInteger(input.maxChars ?? DEFAULT_EXTRACT_CHARS, 500, 20_000);
    const { response, finalUrl } = await this.fetchPublicUrl(input.url);
    const contentType = response.headers.get("content-type") ?? undefined;
    const body = await readResponseBody(response, this.maxExtractBytes);
    const rawText = decodeResponseBody(body.bytes, contentType);
    assertReadableContent(contentType, rawText);
    const html = isHtmlContent(contentType, rawText);
    const readable = html ? extractReadableHtml(rawText, finalUrl) : undefined;
    const title = html ? (readable?.title ?? extractTitle(rawText)) : undefined;
    const text = readable?.text ?? (html ? extractTextFromHtml(rawText) : normalizePlainText(rawText));
    const clippedText = text.length > maxChars ? text.slice(0, maxChars).trimEnd() : text;

    return {
      url: input.url,
      finalUrl,
      title,
      contentType,
      text: clippedText,
      truncated: body.truncated || text.length > maxChars,
    };
  }

  private async searchBrave(input: WebSearchInput): Promise<WebSearchResponse> {
    const apiKey = normalizeOptionalString(await this.options.searchApiKeyProvider?.());
    if (!apiKey) {
      throw new Error(
        "Brave web search is not configured. Set WEB_SEARCH_API_KEY_PARAMETER_NAME to an SSM SecureString containing the provider API key.",
      );
    }

    const limit = clampInteger(input.limit ?? 5, 1, 10);
    const url = new URL(BRAVE_WEB_SEARCH_URL);
    url.searchParams.set("q", buildSearchQuery(input.query, input.domains));
    url.searchParams.set("count", String(limit));
    url.searchParams.set("safesearch", "moderate");
    url.searchParams.set("spellcheck", "1");
    url.searchParams.set("text_decorations", "false");
    url.searchParams.set("result_filter", "web");
    if (input.country) {
      url.searchParams.set("country", input.country.toUpperCase());
    }
    if (input.language) {
      url.searchParams.set("search_lang", input.language.toLowerCase());
    }
    if (input.freshness) {
      url.searchParams.set("freshness", FRESHNESS_VALUES[input.freshness]);
    }

    const response = await this.fetchImpl(url.toString(), {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": USER_AGENT,
        "x-subscription-token": apiKey,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Brave web search request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as BraveSearchResponsePayload;
    const results = (payload.web?.results ?? [])
      .map((result) => normalizeBraveResult(result))
      .filter((result): result is WebSearchResult => Boolean(result))
      .slice(0, limit);

    return {
      provider: "brave",
      query: input.query,
      count: results.length,
      results,
    };
  }

  private async searchSearxng(input: WebSearchInput): Promise<WebSearchResponse> {
    const baseUrl = normalizeOptionalString(this.options.searchBaseUrl);
    if (!baseUrl) {
      throw new Error("SearXNG web search is not configured. Set WEB_SEARCH_BASE_URL to a SearXNG instance URL.");
    }

    const limit = clampInteger(input.limit ?? 5, 1, 10);
    const url = buildSearchEndpointUrl(baseUrl, "search");
    url.searchParams.set("q", buildSearchQuery(input.query, input.domains));
    url.searchParams.set("format", "json");
    url.searchParams.set("categories", "general");
    url.searchParams.set("safesearch", "1");
    if (input.language) {
      url.searchParams.set("language", input.language.toLowerCase());
    }
    if (input.freshness) {
      url.searchParams.set("time_range", SEARXNG_FRESHNESS_VALUES[input.freshness]);
    }

    const response = await this.fetchImpl(url.toString(), {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`SearXNG web search request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as SearxngSearchResponsePayload;
    const results = (payload.results ?? [])
      .map((result) => normalizeSearxngResult(result))
      .filter((result): result is WebSearchResult => Boolean(result))
      .slice(0, limit);

    return {
      provider: "searxng",
      query: input.query,
      count: results.length,
      results,
    };
  }

  private async fetchPublicUrl(initialUrl: string): Promise<{ response: Response; finalUrl: string }> {
    let current = normalizeHttpUrl(initialUrl);

    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      await assertPublicUrl(current, this.lookupImpl);
      const response = await this.fetchImpl(current.toString(), {
        method: "GET",
        redirect: "manual",
        headers: {
          accept: "text/html, text/plain;q=0.9, */*;q=0.1",
          "user-agent": USER_AGENT,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (isRedirectStatus(response.status)) {
        const location = response.headers.get("location");
        if (!location) {
          throw new Error(`Web extract redirect from ${current.toString()} did not include a Location header.`);
        }
        current = normalizeHttpUrl(new URL(location, current).toString());
        continue;
      }

      if (!response.ok) {
        throw new Error(`Web extract request failed with status ${response.status}`);
      }

      return { response, finalUrl: current.toString() };
    }

    throw new Error(`Web extract followed too many redirects from ${initialUrl}`);
  }
}

function normalizeBraveResult(result: BraveSearchResultPayload): WebSearchResult | null {
  const title = normalizeOptionalString(decodeHtmlEntities(stripHtml(result.title ?? "")));
  const url = normalizeOptionalString(result.url);
  if (!title || !url) {
    return null;
  }

  return {
    title,
    url,
    description: normalizeOptionalString(decodeHtmlEntities(stripHtml(result.description ?? ""))),
    publishedAt: normalizeOptionalString(result.age ?? result.page_age),
    sourceName: normalizeOptionalString(result.profile?.name ?? result.profile?.long_name),
    language: normalizeOptionalString(result.language),
  };
}

function normalizeSearxngResult(result: SearxngSearchResultPayload): WebSearchResult | null {
  const title = normalizeOptionalString(decodeHtmlEntities(stripHtml(result.title ?? "")));
  const url = normalizeOptionalString(result.url);
  if (!title || !url) {
    return null;
  }

  return {
    title,
    url,
    description: normalizeOptionalString(decodeHtmlEntities(stripHtml(result.content ?? ""))),
    publishedAt: normalizeOptionalString(result.publishedDate),
    sourceName: normalizeOptionalString(result.engine),
  };
}

function buildSearchQuery(query: string, domains?: string[]): string {
  const domainFilters = (domains ?? [])
    .map((domain) => normalizeSearchDomain(domain))
    .filter((domain): domain is string => Boolean(domain))
    .map((domain) => `site:${domain}`);
  return [query.trim(), ...domainFilters].join(" ").trim();
}

function buildSearchEndpointUrl(baseUrl: string, defaultPath: string): URL {
  const url = new URL(baseUrl);
  if (url.pathname === "/" || url.pathname === "") {
    url.pathname = `/${defaultPath}`;
  }
  return url;
}

function normalizeSearchDomain(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }

  let hostname = trimmed;
  try {
    hostname = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }

  if (!/^[a-z0-9.-]+$/.test(hostname) || hostname.includes("..")) {
    return undefined;
  }
  return hostname.replace(/^\.+|\.+$/g, "") || undefined;
}

function normalizeSearchProvider(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function normalizeHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Web extract URL must be a valid absolute URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Web extract only supports http and https URLs.");
  }
  if (url.username || url.password) {
    throw new Error("Web extract URLs must not include credentials.");
  }

  return url;
}

async function assertPublicUrl(url: URL, lookupImpl: LookupImpl): Promise<void> {
  const hostname = normalizeHostname(url.hostname);
  if (isBlockedHostname(hostname)) {
    throw new Error(`Web extract blocked non-public host: ${hostname}`);
  }

  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new Error(`Web extract blocked private IP address: ${hostname}`);
    }
    return;
  }

  const records = await lookupImpl(hostname, { all: true, verbatim: true });
  if (records.length === 0) {
    throw new Error(`Web extract could not resolve host: ${hostname}`);
  }
  for (const record of records) {
    if (isPrivateAddress(record.address)) {
      throw new Error(`Web extract blocked private resolved address for ${hostname}`);
    }
  }
}

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, "");
}

function isBlockedHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "metadata.google.internal"
  );
}

function isPrivateAddress(address: string): boolean {
  if (address.startsWith("::ffff:")) {
    return isPrivateAddress(address.slice("::ffff:".length));
  }

  const version = isIP(address);
  if (version === 4) {
    const parts = address.split(".").map((part) => Number(part));
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }

  if (version === 6) {
    const normalized = address.toLowerCase();
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80") ||
      normalized.startsWith("ff")
    );
  }

  return true;
}

function isRedirectStatus(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

function decodeResponseBody(bytes: Uint8Array, contentType: string | undefined): string {
  const charset = parseCharset(contentType) ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function parseCharset(contentType: string | undefined): string | undefined {
  return contentType
    ?.match(/(?:^|;)\s*charset=([^;]+)/i)?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, "");
}

async function readResponseBody(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    return {
      bytes: buffer.slice(0, maxBytes),
      truncated: buffer.byteLength > maxBytes,
    };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }

    const remaining = maxBytes - total;
    if (value.byteLength > remaining) {
      chunks.push(value.slice(0, remaining));
      total += remaining;
      truncated = true;
      await reader.cancel();
      break;
    }

    chunks.push(value);
    total += value.byteLength;
    if (total >= maxBytes) {
      truncated = true;
      await reader.cancel();
      break;
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { bytes, truncated };
}

function isHtmlContent(contentType: string | undefined, text: string): boolean {
  const normalizedContentType = normalizeContentType(contentType);
  return Boolean(normalizedContentType?.includes("html")) || /<(html|article|main|body)[\s>]/i.test(text);
}

function assertReadableContent(contentType: string | undefined, text: string): void {
  if (!contentType) {
    return;
  }

  const normalizedContentType = normalizeContentType(contentType);
  if (!normalizedContentType) {
    return;
  }

  if (
    normalizedContentType.startsWith("text/") ||
    normalizedContentType === "application/json" ||
    normalizedContentType === "application/ld+json" ||
    normalizedContentType === "application/xml" ||
    normalizedContentType === "application/xhtml+xml" ||
    normalizedContentType === "application/rss+xml" ||
    normalizedContentType === "application/atom+xml"
  ) {
    return;
  }

  if (isHtmlContent(contentType, text)) {
    return;
  }

  throw new Error(`Web extract only supports readable text or HTML content, not ${normalizedContentType}.`);
}

function normalizeContentType(contentType: string | undefined): string | undefined {
  return contentType?.split(";")[0]?.trim().toLowerCase() || undefined;
}

function extractReadableHtml(html: string, url: string): { title?: string; text: string } | undefined {
  let dom: JSDOM | undefined;
  try {
    dom = new JSDOM(html, { url });
    dom.window.document
      .querySelectorAll("script, style, noscript, svg, nav, footer, form")
      .forEach((element) => element.remove());
    const article = new Readability(dom.window.document).parse();
    const text = article?.content
      ? extractTextFromHtml(article.content)
      : normalizePlainText(article?.textContent ?? "");
    if (!text) {
      return undefined;
    }

    return {
      title: normalizeOptionalString(article?.title ?? undefined),
      text,
    };
  } catch {
    return undefined;
  } finally {
    dom?.window.close();
  }
}

function extractTitle(html: string): string | undefined {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return normalizeOptionalString(decodeHtmlEntities(stripHtml(title ?? "")));
}

function extractTextFromHtml(html: string): string {
  const withoutHidden = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ");
  const withBreaks = withoutHidden
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|main|li|tr|h[1-6])>/gi, "\n");
  return normalizePlainText(decodeHtmlEntities(stripHtml(withBreaks)));
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, " ");
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => decodeCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => decodeCodePoint(Number.parseInt(code, 16)));
}

function decodeCodePoint(codePoint: number): string {
  try {
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : "";
  } catch {
    return "";
  }
}

function normalizePlainText(value: string): string {
  return value
    .split("\n")
    .map((line) => line.replace(/[\s\u00a0]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function normalizeOptionalString(value?: string): string | undefined {
  const normalized = value?.replace(/[\s\u00a0]+/g, " ").trim();
  return normalized || undefined;
}
