import { describe, expect, it, vi } from "vitest";
import { CustomToolExecutor } from "../src/tools/executeCustomTool";
import type {
  BrowserCloseInput,
  BrowserExtractInput,
  BrowserOpenUrlInput,
  BrowserProvider,
  BrowserSnapshotInput,
  BrowserStartInput,
} from "../src/browser/provider";
import type { WorkSessionRecord } from "../src/shared/contracts";
import { Logger } from "../src/shared/logger";

class FakeBrowserProvider implements BrowserProvider {
  readonly start = vi.fn(async (input: BrowserStartInput) => ({
    providerSessionId: `remote-${this.start.mock.calls.length}`,
    createdAt: "2026-05-25T00:00:00.000Z",
    input,
  }));
  readonly openUrl = vi.fn(async (input: BrowserOpenUrlInput) => ({
    url: input.url,
    title: "Opened page",
  }));
  readonly snapshot = vi.fn(async (_input: BrowserSnapshotInput) => ({
    url: "https://example.com/",
    title: "Snapshot page",
    text: "Visible text",
    truncated: false,
    originalLength: 12,
    maxChars: 4000,
    screenshotIncluded: false as const,
  }));
  readonly extract = vi.fn(async (_input: BrowserExtractInput) => ({
    url: "https://example.com/",
    title: "Extract page",
    text: "Extracted text",
    truncated: false,
    originalLength: 14,
    maxChars: 6000,
  }));
  readonly close = vi.fn(async (_input: BrowserCloseInput) => ({ closed: true }));
}

class InMemoryWorkSessionRepository {
  readonly records: WorkSessionRecord[] = [];

  async create(input: {
    workspaceId: string;
    ownerUserId: string;
    kind: "browser" | "sandbox";
    maxLifetimeSeconds: number;
    runtimeSessionId?: string;
  }): Promise<WorkSessionRecord> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.maxLifetimeSeconds * 1000);
    const record: WorkSessionRecord = {
      workspaceId: input.workspaceId,
      ownerUserId: input.ownerUserId,
      workSessionId: `ws-${this.records.length + 1}`,
      runtimeSessionId: input.runtimeSessionId ?? `remote-${this.records.length + 1}`,
      kind: input.kind,
      status: "active",
      createdAt: now.toISOString(),
      lastUsedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      ttl: Math.floor(expiresAt.getTime() / 1000),
    };
    this.records.push(record);
    return record;
  }

  async get(input: { workSessionId: string }): Promise<WorkSessionRecord | null> {
    return this.records.find((record) => record.workSessionId === input.workSessionId) ?? null;
  }

  async listActiveByOwner(input: { kind?: "browser" | "sandbox"; limit?: number }): Promise<WorkSessionRecord[]> {
    return this.records
      .filter((record) => record.status === "active" && (!input.kind || record.kind === input.kind))
      .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
      .slice(0, input.limit ?? 100);
  }

  async touch(input: { workSessionId: string }): Promise<void> {
    const record = this.records.find((candidate) => candidate.workSessionId === input.workSessionId);
    if (record) {
      record.lastUsedAt = new Date("2026-05-25T00:10:00.000Z").toISOString();
    }
  }

  async markCompleted(input: { workSessionId: string }): Promise<void> {
    const record = this.records.find((candidate) => candidate.workSessionId === input.workSessionId);
    if (record) {
      record.status = "completed";
    }
  }

  async expireIdleSessions(): Promise<WorkSessionRecord[]> {
    return [];
  }

  async enforceActiveLimit(input: { maxActiveSessions: number }): Promise<WorkSessionRecord[]> {
    const active = await this.listActiveByOwner({ kind: "browser" });
    const expired = active.slice(Math.max(input.maxActiveSessions, 0));
    for (const record of expired) {
      record.status = "expired";
    }
    return expired;
  }
}

function toolPayload(result: Awaited<ReturnType<CustomToolExecutor["execute"]>>): Record<string, unknown> {
  expect(result.isError).toBeUndefined();
  const text = result.content?.[0]?.type === "text" ? result.content[0].text : "";
  return JSON.parse(text) as Record<string, unknown>;
}

function createExecutor(options: { userId?: string } = {}) {
  const browserProvider = new FakeBrowserProvider();
  const workSessions = new InMemoryWorkSessionRepository();
  const executor = new CustomToolExecutor(
    {
      memoryItems: {},
      tasks: {},
      taskEvents: {},
      workSessions,
    } as never,
    {
      workspaceId: "T1",
      userId: "userId" in options ? options.userId : "U1",
      logger: new Logger({ test: "browser-tools" }),
      workSessionPolicy: {
        idleTimeoutSeconds: 900,
        maxLifetimeSeconds: 3600,
        maxActivePerOwner: 2,
      },
    },
    {
      browserProvider,
    },
  );
  return { executor, browserProvider, workSessions };
}

describe("browser tools", () => {
  it("starts owner-scoped browser sessions without exposing provider session ids", async () => {
    const { executor, browserProvider, workSessions } = createExecutor();

    const result = await executor.execute({
      id: "tool-1",
      type: "agent.tool_use",
      name: "browser_start",
      input: { width: 1440, height: 900 },
    });

    expect(toolPayload(result)).toMatchObject({
      browser_session_id: "ws-1",
      status: "active",
      viewport: { width: 1440, height: 900 },
    });
    expect(browserProvider.start).toHaveBeenCalledWith({
      name: undefined,
      timeoutSeconds: 3600,
      viewport: { width: 1440, height: 900 },
    });
    expect(workSessions.records[0].runtimeSessionId).toBe("remote-1");
  });

  it("opens, snapshots, extracts, and closes the latest active browser session", async () => {
    const { executor, browserProvider, workSessions } = createExecutor();
    await executor.execute({ id: "tool-1", type: "agent.tool_use", name: "browser_start", input: {} });
    expect(workSessions.records).toHaveLength(1);

    const openResult = await executor.execute({
      id: "tool-2",
      type: "agent.tool_use",
      name: "browser_open_url",
      input: { url: "https://example.com/app" },
    });
    expect(toolPayload(openResult)).toMatchObject({
      browser_session_id: "ws-1",
      url: "https://example.com/app",
      title: "Opened page",
    });
    expect(browserProvider.openUrl).toHaveBeenCalledWith({
      providerSessionId: "remote-1",
      url: "https://example.com/app",
      waitUntil: undefined,
      timeoutMs: undefined,
    });

    expect(toolPayload(await executor.execute({ id: "tool-3", type: "agent.tool_use", name: "browser_snapshot", input: {} })))
      .toMatchObject({
        browser_session_id: "ws-1",
        text: "Visible text",
        screenshot_included: false,
      });
    expect(
      toolPayload(
        await executor.execute({
          id: "tool-4",
          type: "agent.tool_use",
          name: "browser_extract",
          input: { selector: "main", max_chars: 500 },
        }),
      ),
    ).toMatchObject({
      browser_session_id: "ws-1",
      text: "Extracted text",
    });
    expect(browserProvider.extract).toHaveBeenCalledWith({
      providerSessionId: "remote-1",
      selector: "main",
      maxChars: 500,
    });

    expect(toolPayload(await executor.execute({ id: "tool-5", type: "agent.tool_use", name: "browser_close", input: {} })))
      .toMatchObject({
        browser_session_id: "ws-1",
        closed: true,
      });
    expect(workSessions.records[0].status).toBe("completed");
    expect(browserProvider.close).toHaveBeenCalledWith({ providerSessionId: "remote-1" });
  });

  it("requires an owner user id for browser sessions", async () => {
    const { executor } = createExecutor({ userId: undefined });

    const result = await executor.execute({
      id: "tool-1",
      type: "agent.tool_use",
      name: "browser_start",
      input: {},
    });

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.type === "text" ? result.content[0].text : "").toContain("owner user id");
  });
});
