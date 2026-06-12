import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { AgentRunResult } from "../agent/types";
import {
  AgentRuntimeRequest,
  agentRuntimeResponseSchema,
} from "./contracts";

export interface AgentCoreRuntimeClientOptions {
  runtimeArn: string;
  qualifier?: string;
  region?: string;
}

export interface InvokeAgentInput {
  sessionId?: string;
  runtimeUserId?: string;
  request: AgentRuntimeRequest;
}

export class AgentCoreRuntimeClient {
  private readonly client: BedrockAgentCoreClient;

  constructor(private readonly options: AgentCoreRuntimeClientOptions) {
    this.client = new BedrockAgentCoreClient({
      region: options.region,
    });
  }

  async invoke(input: InvokeAgentInput): Promise<AgentRunResult> {
    const response = await this.client.send(
      new InvokeAgentRuntimeCommand({
        agentRuntimeArn: this.options.runtimeArn,
        qualifier: this.options.qualifier || undefined,
        runtimeSessionId: input.sessionId,
        runtimeUserId: input.runtimeUserId,
        contentType: "application/json",
        accept: "text/event-stream, application/json",
        payload: Buffer.from(JSON.stringify(input.request), "utf-8"),
      }),
    );

    const raw = response.response ? await response.response.transformToString() : "";
    const parsed = parseRuntimeResponse(raw);
    return {
      text: parsed.text,
      sessionId: response.runtimeSessionId ?? input.sessionId,
      status: "completed",
      taskIds: parsed.taskIds,
      recurringTaskIds: parsed.recurringTaskIds,
      savedMemoryIds: parsed.savedMemoryIds,
      calendarDraftIds: parsed.calendarDraftIds,
      traceId: parsed.traceId,
      turnId: parsed.turnId,
    };
  }
}

function parseRuntimeResponse(raw: string) {
  const sseEvents = parseSseEvents(raw);
  if (sseEvents.length > 0) {
    const errorEvent = sseEvents.find((event) => event.event === "error");
    if (errorEvent) {
      throw new Error(`AgentCore runtime failed: ${formatRuntimeError(errorEvent.data)}`);
    }

    const text = sseEvents
      .filter((event) => event.event === "message")
      .map((event) => event.data)
      .map(parseJsonIfPossible)
      .map((data) => (isRecord(data) && typeof data.text === "string" ? data.text : String(data)))
      .join("");
    const metadata = sseEvents
      .filter((event) => event.event === "metadata")
      .map((event) => parseJsonIfPossible(event.data))
      .find(isRecord);
    return agentRuntimeResponseSchema.parse({
      text: text.trim() || "(No text response returned)",
      taskIds: Array.isArray(metadata?.taskIds) ? metadata.taskIds : [],
      recurringTaskIds: Array.isArray(metadata?.recurringTaskIds) ? metadata.recurringTaskIds : [],
      savedMemoryIds: Array.isArray(metadata?.savedMemoryIds) ? metadata.savedMemoryIds : [],
      calendarDraftIds: Array.isArray(metadata?.calendarDraftIds) ? metadata.calendarDraftIds : [],
      traceId: typeof metadata?.traceId === "string" ? metadata.traceId : undefined,
      turnId: typeof metadata?.turnId === "string" ? metadata.turnId : undefined,
    });
  }

  const json = parseJsonIfPossible(raw);
  if (isRecord(json)) {
    return agentRuntimeResponseSchema.parse(json);
  }

  return agentRuntimeResponseSchema.parse({
    text: raw.trim() || "(No text response returned)",
  });
}

function formatRuntimeError(data: string): string {
  const parsed = parseJsonIfPossible(data);
  if (isRecord(parsed)) {
    if (typeof parsed.error === "string") {
      return parsed.error;
    }
    if (typeof parsed.message === "string") {
      return parsed.message;
    }
  }

  return String(parsed).trim() || "Unknown runtime error";
}

function parseSseEvents(raw: string): Array<{ event: string; data: string }> {
  const chunks = raw.split(/\n\n+/);
  const events: Array<{ event: string; data: string }> = [];

  for (const chunk of chunks) {
    const lines = chunk.split(/\r?\n/);
    const event = lines
      .find((line) => line.startsWith("event:"))
      ?.slice("event:".length)
      .trim();
    const dataLines = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart());

    if (event && dataLines.length > 0) {
      events.push({ event, data: dataLines.join("\n") });
    }
  }

  return events;
}

function parseJsonIfPossible(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
