import type { Browser as PlaywrightBrowser, Page } from "playwright-core";
import {
  limitBrowserText,
  normalizeBrowserNavigationUrl,
  resolveBrowserExtractLimit,
  sanitizeBrowserSnapshot,
} from "./safety";
import type {
  BrowserCloseInput,
  BrowserCloseResult,
  BrowserExtractInput,
  BrowserExtractResult,
  BrowserOpenUrlInput,
  BrowserOpenUrlResult,
  BrowserProvider,
  BrowserSnapshotInput,
  BrowserSnapshotResult,
  BrowserStartInput,
  BrowserStartResult,
  BrowserViewport,
} from "./provider";

type DynamicImport = <T = Record<string, unknown>>(specifier: string) => Promise<T>;
type PlaywrightCoreModule = typeof import("playwright-core");
type AgentCoreBrowserModule = {
  Browser: new (config: { region?: string; identifier?: string }) => AgentCoreBrowserClient;
};

interface AgentCoreBrowserClient {
  startSession(params?: {
    sessionName?: string;
    timeout?: number;
    viewport?: BrowserViewport;
  }): Promise<{ sessionId: string; createdAt?: Date }>;
  attachSession(sessionId: string): void;
  stopSession(): Promise<void>;
  generateWebSocketUrl(): Promise<{ url: string; headers: Record<string, string> }>;
}

interface ConnectedBrowser {
  client: AgentCoreBrowserClient;
  browser: PlaywrightBrowser;
  page: Page;
}

export interface AgentCoreBrowserProviderOptions {
  region?: string;
  browserIdentifier?: string;
  defaultTimeoutSeconds?: number;
  defaultViewport?: BrowserViewport;
  navigationTimeoutMs?: number;
}

const dynamicImport = new Function("specifier", "return import(specifier)") as DynamicImport;
const DEFAULT_SESSION_TIMEOUT_SECONDS = 3600;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
const DEFAULT_VIEWPORT: BrowserViewport = { width: 1280, height: 720 };

export class AgentCoreBrowserProvider implements BrowserProvider {
  private readonly connections = new Map<string, Promise<ConnectedBrowser>>();

  constructor(private readonly options: AgentCoreBrowserProviderOptions = {}) {}

  async start(input: BrowserStartInput): Promise<BrowserStartResult> {
    const client = await this.createClient();
    const session = await client.startSession({
      sessionName: input.name,
      timeout: input.timeoutSeconds ?? this.options.defaultTimeoutSeconds ?? DEFAULT_SESSION_TIMEOUT_SECONDS,
      viewport: input.viewport ?? this.options.defaultViewport ?? DEFAULT_VIEWPORT,
    });

    return {
      providerSessionId: session.sessionId,
      createdAt: session.createdAt?.toISOString(),
    };
  }

  async openUrl(input: BrowserOpenUrlInput): Promise<BrowserOpenUrlResult> {
    const url = await normalizeBrowserNavigationUrl(input.url);
    const page = await this.getPage(input.providerSessionId);
    await page.goto(url, {
      waitUntil: input.waitUntil ?? "domcontentloaded",
      timeout: input.timeoutMs ?? this.options.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS,
    });

    return {
      url: page.url(),
      title: normalizeOptionalString(await page.title()),
    };
  }

  async snapshot(input: BrowserSnapshotInput): Promise<BrowserSnapshotResult> {
    const page = await this.getPage(input.providerSessionId);
    return sanitizeBrowserSnapshot(
      {
        url: page.url(),
        title: await page.title(),
        text: await getPageText(page),
      },
      { maxChars: input.maxChars },
    );
  }

  async extract(input: BrowserExtractInput): Promise<BrowserExtractResult> {
    const page = await this.getPage(input.providerSessionId);
    const text = input.selector ? await getElementText(page, input.selector) : await getPageText(page);
    const limited = limitBrowserText(text, resolveBrowserExtractLimit(input.maxChars));

    return {
      url: page.url(),
      title: normalizeOptionalString(await page.title()),
      text: limited.text,
      truncated: limited.truncated,
      originalLength: limited.originalLength,
      maxChars: limited.maxChars,
    };
  }

  async close(input: BrowserCloseInput): Promise<BrowserCloseResult> {
    const connected = this.connections.get(input.providerSessionId);
    this.connections.delete(input.providerSessionId);
    if (connected) {
      try {
        const connection = await connected;
        await connection.browser.close();
      } catch {
        // The backing session is still stopped below.
      }
    }

    const client = await this.createClient();
    client.attachSession(input.providerSessionId);
    await client.stopSession();
    return { closed: true };
  }

  private async getPage(providerSessionId: string): Promise<Page> {
    let connection = this.connections.get(providerSessionId);
    if (!connection) {
      connection = this.connect(providerSessionId);
      this.connections.set(providerSessionId, connection);
    }
    return (await connection).page;
  }

  private async connect(providerSessionId: string): Promise<ConnectedBrowser> {
    const client = await this.createClient();
    client.attachSession(providerSessionId);
    const wsConnection = await client.generateWebSocketUrl();
    const { chromium } = await dynamicImport<PlaywrightCoreModule>("playwright-core");
    const browser = await chromium.connectOverCDP(wsConnection.url, {
      headers: wsConnection.headers,
    });
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());
    return { client, browser, page };
  }

  private async createClient(): Promise<AgentCoreBrowserClient> {
    const { Browser } = await dynamicImport<AgentCoreBrowserModule>("bedrock-agentcore/browser");
    return new Browser({
      region: this.options.region,
      identifier: this.options.browserIdentifier,
    });
  }
}

async function getPageText(page: Page): Promise<string> {
  try {
    return await page.locator("body").innerText({ timeout: 5000 });
  } catch {
    return (await page.textContent("body")) ?? "";
  }
}

async function getElementText(page: Page, selector: string): Promise<string> {
  const element = page.locator(selector).first();
  return await element.innerText({ timeout: 10_000 });
}

function normalizeOptionalString(value?: string): string | undefined {
  const normalized = value?.replace(/[\s\u00a0]+/g, " ").trim();
  return normalized || undefined;
}
