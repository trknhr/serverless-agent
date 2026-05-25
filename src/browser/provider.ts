export type BrowserProviderName = "agentcore-browser";

export interface BrowserViewport {
  width: number;
  height: number;
}

export interface BrowserStartInput {
  name?: string;
  timeoutSeconds?: number;
  viewport?: BrowserViewport;
}

export interface BrowserStartResult {
  providerSessionId: string;
  createdAt?: string;
}

export interface BrowserOpenUrlInput {
  providerSessionId: string;
  url: string;
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
  timeoutMs?: number;
}

export interface BrowserOpenUrlResult {
  url: string;
  title?: string;
}

export interface BrowserSnapshotInput {
  providerSessionId: string;
  maxChars?: number;
}

export interface BrowserSnapshotResult {
  url: string;
  title?: string;
  text: string;
  truncated: boolean;
  originalLength: number;
  maxChars: number;
  screenshotIncluded: false;
}

export interface BrowserExtractInput {
  providerSessionId: string;
  selector?: string;
  maxChars?: number;
}

export interface BrowserExtractResult {
  url: string;
  title?: string;
  text: string;
  truncated: boolean;
  originalLength: number;
  maxChars: number;
}

export interface BrowserCloseInput {
  providerSessionId: string;
}

export interface BrowserCloseResult {
  closed: boolean;
}

export interface BrowserProvider {
  start(input: BrowserStartInput): Promise<BrowserStartResult>;
  openUrl(input: BrowserOpenUrlInput): Promise<BrowserOpenUrlResult>;
  snapshot(input: BrowserSnapshotInput): Promise<BrowserSnapshotResult>;
  extract(input: BrowserExtractInput): Promise<BrowserExtractResult>;
  close(input: BrowserCloseInput): Promise<BrowserCloseResult>;
}

export function normalizeBrowserProviderName(value: string | undefined): BrowserProviderName | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "agentcore-browser") {
    return normalized;
  }
  throw new Error(`Unsupported BROWSER_PROVIDER '${value}'. Expected agentcore-browser.`);
}
