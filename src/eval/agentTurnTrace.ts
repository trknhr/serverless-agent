import { createHash } from "node:crypto";
import { AgentContentBlock } from "../agent/types";

const MAX_TEXT_CHARS = 24_000;
const MAX_FIELD_CHARS = 4_000;
const DEFAULT_TRACE_RETENTION_DAYS = 90;

export type AgentTurnTraceStatus = "completed" | "failed";

export interface AgentTurnTraceContentBlock {
  type: AgentContentBlock["type"];
  text?: string;
  title?: string;
  mediaType?: string;
  sourceType?: string;
  url?: string;
  sizeChars?: number;
  truncated?: boolean;
}

export interface AgentTurnToolCallTrace {
  toolCallId: string;
  name: string;
  input: unknown;
  output?: unknown;
  isError: boolean;
  error?: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export type AgentTurnDisplayedOutputSurface =
  | "slack"
  | "line"
  | "direct_chat_api"
  | "scheduler"
  | "document_import";

export interface AgentTurnDisplayedOutput {
  surface: AgentTurnDisplayedOutputSurface;
  text: string;
  messageTs?: string;
  threadTs?: string;
  channelIdHash?: string;
  postedAt: string;
}

export interface AgentTurnTraceRecord {
  traceId: string;
  turnId: string;
  workspaceId: string;
  source: string;
  status: AgentTurnTraceStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: number;
  modelId?: string;
  bedrockRegion?: string;
  bedrockServiceTier?: string;
  runtimeSessionId?: string;
  userIdHash?: string;
  channelIdHash?: string;
  conversationId?: string;
  taskId?: string;
  sourceId?: string;
  input: {
    text: string;
    blocks: AgentTurnTraceContentBlock[];
  };
  output?: {
    text: string;
  };
  modelOutput?: {
    text: string;
  };
  displayedOutput?: AgentTurnDisplayedOutput;
  toolCalls: AgentTurnToolCallTrace[];
  summary: {
    taskIds: string[];
    recurringTaskIds: string[];
    savedMemoryIds: string[];
    calendarDraftIds: string[];
  };
  error?: string;
  latencyMs: number;
}

export function summarizeAgentContentBlocks(blocks: AgentContentBlock[]): AgentTurnTraceRecord["input"] {
  const summarizedBlocks = blocks.map(summarizeAgentContentBlock);
  return {
    text: truncateText(
      summarizedBlocks
        .map((block) => block.text ?? `[${block.type}${block.title ? `: ${block.title}` : ""}]`)
        .join("\n\n"),
      MAX_TEXT_CHARS,
    ).text,
    blocks: summarizedBlocks,
  };
}

export function buildTraceExpiresAt(
  createdAt: string,
  retentionDays = DEFAULT_TRACE_RETENTION_DAYS,
): number {
  const createdAtMs = new Date(createdAt).getTime();
  const baseMs = Number.isNaN(createdAtMs) ? Date.now() : createdAtMs;
  return Math.floor(baseMs / 1000) + retentionDays * 24 * 60 * 60;
}

export function sanitizeTraceValue(value: unknown, maxChars = MAX_FIELD_CHARS): unknown {
  if (typeof value === "string") {
    return truncateText(maskSensitiveText(value), maxChars).text;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeTraceValue(item, maxChars));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 50);
    return Object.fromEntries(
      entries.map(([key, item]) => [
        key,
        isSensitiveKey(key) ? "[redacted]" : sanitizeTraceValue(item, maxChars),
      ]),
    );
  }
  return String(value);
}

export function hashTraceIdentifier(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);
}

export function truncateTraceText(value: string, maxChars = MAX_TEXT_CHARS): string {
  return truncateText(maskSensitiveText(value), maxChars).text;
}

function summarizeAgentContentBlock(block: AgentContentBlock): AgentTurnTraceContentBlock {
  if (block.type === "text") {
    const text = truncateText(maskSensitiveText(block.text), MAX_TEXT_CHARS);
    return {
      type: "text",
      text: text.text,
      sizeChars: block.text.length,
      truncated: text.truncated || undefined,
    };
  }

  if (block.type === "image") {
    return {
      type: "image",
      sourceType: block.source.type,
      mediaType: "media_type" in block.source ? block.source.media_type : undefined,
      url: block.source.type === "url" ? redactUrl(block.source.url) : undefined,
      sizeChars: block.source.type === "base64" ? block.source.data.length : undefined,
    };
  }

  if (block.source.type === "text") {
    const text = truncateText(maskSensitiveText(block.source.data), MAX_TEXT_CHARS);
    return {
      type: "document",
      title: block.title,
      sourceType: "text",
      mediaType: block.source.media_type,
      text: text.text,
      sizeChars: block.source.data.length,
      truncated: text.truncated || undefined,
    };
  }

  return {
    type: "document",
    title: block.title,
    sourceType: block.source.type,
    mediaType: "media_type" in block.source ? block.source.media_type : undefined,
    url: block.source.type === "url" ? redactUrl(block.source.url) : undefined,
    sizeChars: block.source.type === "base64" ? block.source.data.length : undefined,
  };
}

function truncateText(value: string, maxChars: number): { text: string; truncated?: boolean } {
  if (value.length <= maxChars) {
    return { text: value };
  }
  return {
    text: `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`,
    truncated: true,
  };
}

function maskSensitiveText(value: string): string {
  return value
    .replace(/xox[baprs]-[A-Za-z0-9-]+/g, "[redacted-slack-token]")
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "[redacted-api-key]")
    .replace(/AKIA[0-9A-Z]{16}/g, "[redacted-aws-access-key]");
}

function isSensitiveKey(key: string): boolean {
  return /token|secret|password|api[_-]?key|authorization|cookie/i.test(key);
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[url]";
  }
}
