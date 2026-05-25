import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type PublicUrlLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: number }>>;

export interface PublicUrlSafetyContext {
  actionLabel: string;
  urlLabel: string;
}

export interface PublicUrlSafetyOptions {
  context?: PublicUrlSafetyContext;
  lookupImpl?: PublicUrlLookup;
}

const DEFAULT_CONTEXT: PublicUrlSafetyContext = {
  actionLabel: "Public URL fetch",
  urlLabel: "Public URL",
};
const defaultLookup: PublicUrlLookup = (hostname, options) =>
  lookup(hostname, options) as Promise<Array<{ address: string; family: number }>>;

export function normalizeHttpUrl(value: string, context: PublicUrlSafetyContext = DEFAULT_CONTEXT): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${context.urlLabel} must be a valid absolute URL.`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${context.actionLabel} only supports http and https URLs.`);
  }
  if (url.username || url.password) {
    throw new Error(`${pluralizeUrlLabel(context.urlLabel)} must not include credentials.`);
  }

  return url;
}

export async function normalizePublicHttpUrl(
  value: string,
  options: PublicUrlSafetyOptions = {},
): Promise<URL> {
  const context = options.context ?? DEFAULT_CONTEXT;
  const url = normalizeHttpUrl(value, context);
  await assertPublicHttpUrl(url, options);
  return url;
}

export async function assertPublicHttpUrl(
  url: URL,
  options: PublicUrlSafetyOptions = {},
): Promise<void> {
  const context = options.context ?? DEFAULT_CONTEXT;
  const lookupImpl = options.lookupImpl ?? defaultLookup;
  const hostname = normalizeHostname(url.hostname);
  if (isBlockedHostname(hostname)) {
    throw new Error(`${context.actionLabel} blocked non-public host: ${hostname}`);
  }

  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new Error(`${context.actionLabel} blocked private IP address: ${hostname}`);
    }
    return;
  }

  const records = await lookupImpl(hostname, { all: true, verbatim: true });
  if (records.length === 0) {
    throw new Error(`${context.actionLabel} could not resolve host: ${hostname}`);
  }
  for (const record of records) {
    if (isPrivateAddress(record.address)) {
      throw new Error(`${context.actionLabel} blocked private resolved address for ${hostname}`);
    }
  }
}

export function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, "");
}

export function isBlockedHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "metadata.google.internal"
  );
}

export function isPrivateAddress(address: string): boolean {
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

function pluralizeUrlLabel(value: string): string {
  return value.endsWith("URL") ? `${value}s` : `${value} URLs`;
}
