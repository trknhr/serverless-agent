import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { AgentRunResult } from "../agent/types";
import { AgentTurnEvent } from "./runAgentTurn";
import {
  AgentRuntimeRequest,
  agentRuntimeResponseSchema,
} from "./contracts";
import { consumeSseBuffer, parseSseDocument } from "../webchat/sse";

export interface AgentCoreRuntimeClientOptions {
  runtimeArn: string;
  qualifier?: string;
  region?: string;
  responseTimeoutMs?: number;
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
    const timeoutMs = this.options.responseTimeoutMs;
    if (!timeoutMs) {
      return this.invokeOnce(input);
    }

    const abortController = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const operation = this.invokeOnce(input, abortController.signal);
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        abortController.abort();
        reject(new Error(`AgentCore runtime response timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([operation, timeoutPromise]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      operation.catch(() => undefined);
    }
  }

  async *invokeStream(input: InvokeAgentInput): AsyncGenerator<AgentTurnEvent> {
    const timeoutMs = this.options.responseTimeoutMs;
    if (!timeoutMs) {
      yield* this.streamOnce(input);
      return;
    }

    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeoutMs);
    const iterator = this.streamOnce(input, abortController.signal);
    const timeout = new Promise<never>((_, reject) => {
      const fail = () => reject(new Error(`AgentCore runtime response timed out after ${timeoutMs}ms`));
      if (abortController.signal.aborted) {
        fail();
        return;
      }
      abortController.signal.addEventListener("abort", fail, { once: true });
    });
    try {
      while (true) {
        const next = await Promise.race([iterator.next(), timeout]);
        if (next.done) {
          break;
        }
        yield next.value;
      }
    } finally {
      clearTimeout(timer);
      await iterator.return(undefined);
    }
  }

  private async *streamOnce(input: InvokeAgentInput, abortSignal?: AbortSignal): AsyncGenerator<AgentTurnEvent> {
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
      abortSignal ? { abortSignal } : undefined,
    );

    let buffer = "";
    let sawMetadata = false;
    for await (const chunk of readUtf8Chunks(response.response)) {
      const consumed = consumeSseBuffer(buffer + chunk);
      buffer = consumed.rest;
      for (const event of consumed.events) {
        const mapped = mapRuntimeSseEvent(event.event, event.data, response.runtimeSessionId);
        if (mapped?.event === "metadata") {
          sawMetadata = true;
        }
        if (mapped?.event === "error") {
          throw new Error(`AgentCore runtime failed: ${mapped.data.message}`);
        }
        if (mapped) {
          yield mapped;
        }
      }
    }
    if (!sawMetadata && response.runtimeSessionId) {
      yield {
        event: "metadata",
        data: {
          taskIds: [],
          recurringTaskIds: [],
          savedMemoryIds: [],
          calendarDraftIds: [],
          runtimeSessionId: response.runtimeSessionId,
        },
      };
    }
  }

  private async invokeOnce(input: InvokeAgentInput, abortSignal?: AbortSignal): Promise<AgentRunResult> {
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
      abortSignal ? { abortSignal } : undefined,
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
  const sseEvents = parseSseDocument(raw);
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

function mapRuntimeSseEvent(
  event: string,
  data: string,
  runtimeSessionId?: string,
): AgentTurnEvent | { event: "error"; data: { message: string } } | undefined {
  const parsed = parseJsonIfPossible(data);
  if (event === "delta" && isRecord(parsed) && typeof parsed.text === "string") {
    return { event: "delta", data: { text: parsed.text } };
  }
  if (event === "status" && isRecord(parsed) && typeof parsed.text === "string") {
    return { event: "status", data: { text: parsed.text } };
  }
  if (event === "message") {
    const text = isRecord(parsed) && typeof parsed.text === "string" ? parsed.text : String(parsed);
    return { event: "message", data: { text } };
  }
  if (event === "metadata" && isRecord(parsed)) {
    return {
      event: "metadata",
      data: {
        taskIds: stringArray(parsed.taskIds),
        recurringTaskIds: stringArray(parsed.recurringTaskIds),
        savedMemoryIds: stringArray(parsed.savedMemoryIds),
        calendarDraftIds: stringArray(parsed.calendarDraftIds),
        traceId: typeof parsed.traceId === "string" ? parsed.traceId : undefined,
        turnId: typeof parsed.turnId === "string" ? parsed.turnId : undefined,
        runtimeSessionId:
          typeof parsed.runtimeSessionId === "string" ? parsed.runtimeSessionId : runtimeSessionId,
      },
    };
  }
  if (event === "error") {
    return { event: "error", data: { message: formatRuntimeError(data) } };
  }
  return undefined;
}

async function* readUtf8Chunks(body: unknown): AsyncGenerator<string> {
  if (!body || typeof body !== "object") {
    return;
  }
  const streamBody = body as {
    transformToWebStream?: () => ReadableStream<Uint8Array>;
    transformToString?: () => Promise<string>;
    [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array | string>;
  };
  if (typeof streamBody.transformToWebStream === "function") {
    const reader = streamBody.transformToWebStream().getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value) {
          yield decoder.decode(value, { stream: true });
        }
      }
    } finally {
      reader.releaseLock();
    }
    const rest = decoder.decode();
    if (rest) {
      yield rest;
    }
    return;
  }
  if (typeof streamBody[Symbol.asyncIterator] === "function") {
    const decoder = new TextDecoder();
    for await (const chunk of streamBody as AsyncIterable<Uint8Array | string>) {
      if (typeof chunk === "string") {
        yield chunk;
        continue;
      }
      yield decoder.decode(chunk, { stream: true });
    }
    const rest = decoder.decode();
    if (rest) {
      yield rest;
    }
    return;
  }
  if (typeof streamBody.transformToString === "function") {
    yield await streamBody.transformToString();
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
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
