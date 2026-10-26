import type { Context } from "aws-lambda";
import { Writable } from "node:stream";
import { AgentCoreRuntimeClient } from "../../agentcore/client";
import { buildAgentRuntimeResources } from "../../agentcore/contracts";
import { loadChatApiEnv } from "../../config/env";
import { WebChatRepository } from "../../repo/webChatRepository";
import { SecretsProvider } from "../../aws/secretsProvider";
import { logger } from "../../shared/logger";
import { formatSse } from "../../webchat/sse";
import { WebChatAgent, buildWebChatAgentRequest } from "../../webchat/turn";
import { routeWebChat } from "../../webchat/http";
import { z } from "zod";

const webChatExtraEnvSchema = z.object({
  WEB_CONVERSATIONS_TABLE_NAME: z.string().min(1),
  WEB_MESSAGES_TABLE_NAME: z.string().min(1),
  WEB_CHAT_ACCESS_KEY_PARAMETER_NAME: z.string().min(1),
});

interface FunctionUrlEvent {
  rawPath?: string;
  rawQueryString?: string;
  body?: string | null;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined>;
  requestContext?: { http?: { method?: string }; requestId?: string };
}

interface StreamingRuntime {
  streamifyResponse<TEvent>(
    handler: (event: TEvent, responseStream: Writable, context: Context) => Promise<void>,
  ): (event: TEvent, responseStream: Writable, context: Context) => Promise<void>;
  HttpResponseStream: {
    from(writable: Writable, metadata: Record<string, unknown>): Writable;
  };
}

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,content-type,x-request-id",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "cache-control": "no-store",
};

let cachedAccessKey: Promise<string> | undefined;

async function handleWebChatLambda(event: FunctionUrlEvent, responseStream: Writable): Promise<void> {
  const env = loadChatApiEnv();
  const extra = webChatExtraEnvSchema.parse(process.env);
  const log = logger.child({ component: "web-chat", requestId: event.requestContext?.requestId });
  const store = new WebChatRepository(extra.WEB_CONVERSATIONS_TABLE_NAME, extra.WEB_MESSAGES_TABLE_NAME);
  const resources = buildAgentRuntimeResources(env);
  const agent = createStreamingAgent(env);
  let accessKey: string | undefined;
  try {
    accessKey = await loadAccessKey(extra.WEB_CHAT_ACCESS_KEY_PARAMETER_NAME);
  } catch (error) {
    log.error("Web chat access key could not be loaded", {
      error: error instanceof Error ? error.message : "unknown",
    });
    writeJson(responseStream, 503, { ok: false, error: "not_configured", message: "Web chat access key is not configured." });
    return;
  }

  let body: unknown = {};
  try {
    body = parseBody(event);
  } catch {
    writeJson(responseStream, 400, { ok: false, error: "bad_request", message: "Request body must be JSON." });
    return;
  }

  let result;
  try {
    result = await routeWebChat(
      {
        method: event.requestContext?.http?.method ?? "GET",
        path: event.rawPath ?? "/",
        query: Object.fromEntries(new URLSearchParams(event.rawQueryString ?? "").entries()),
        headers: { ...(event.headers ?? {}), "x-request-id": event.requestContext?.requestId },
        body,
      },
      {
        store,
        agent,
        accessKey,
        allowUnauthenticated: false,
        timeZone: env.GOOGLE_CALENDAR_TIME_ZONE,
        resources,
        log,
      },
    );
  } catch (error) {
    log.error("Web chat request failed", { error: error instanceof Error ? error.message : "unknown" });
    writeJson(responseStream, 500, { ok: false, error: "internal_error" });
    return;
  }

  if (result.kind === "json") {
    writeJson(responseStream, result.status, result.body);
    return;
  }

  const stream = openResponse(responseStream, 200, {
    ...corsHeaders,
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no",
  });
  try {
    for await (const chunk of result.events) {
      const payload = formatSse(chunk.event, chunk.data);
      if (!stream.write(payload)) {
        await new Promise((resolve) => stream.once("drain", resolve));
      }
    }
  } finally {
    stream.end();
  }
}

function createStreamingAgent(env: ReturnType<typeof loadChatApiEnv>): WebChatAgent {
  const client = new AgentCoreRuntimeClient({
    runtimeArn: env.AGENTCORE_RUNTIME_ARN,
    qualifier: env.AGENTCORE_RUNTIME_QUALIFIER,
    responseTimeoutMs: env.AGENT_RESPONSE_TIMEOUT_MS,
  });
  return {
    async *run(input) {
      yield* client.invokeStream({
        sessionId: input.sessionId,
        runtimeUserId: `${input.workspaceId}:${input.userId}`,
        request: buildWebChatAgentRequest({
          ...input,
          resources: input.resources,
          timeZone: input.timeZone,
        }),
      });
    },
  };
}

function loadAccessKey(parameterName: string): Promise<string> {
  if (!cachedAccessKey) {
    const secrets = new SecretsProvider();
    cachedAccessKey = secrets.getSecretString(parameterName).catch((error: unknown) => {
      cachedAccessKey = undefined;
      throw error;
    });
  }
  return cachedAccessKey;
}

function parseBody(event: FunctionUrlEvent): unknown {
  if (!event.body) {
    return {};
  }
  const text = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  return JSON.parse(text);
}

function writeJson(responseStream: Writable, statusCode: number, body: unknown): void {
  const stream = openResponse(responseStream, statusCode, {
    ...corsHeaders,
    "content-type": "application/json; charset=utf-8",
  });
  stream.end(JSON.stringify(body));
}

function openResponse(responseStream: Writable, statusCode: number, headers: Record<string, string>): Writable {
  const streaming = (globalThis as unknown as { awslambda?: StreamingRuntime }).awslambda;
  if (!streaming) {
    return responseStream;
  }
  return streaming.HttpResponseStream.from(responseStream, { statusCode, headers });
}

const streamingRuntime = (globalThis as unknown as { awslambda?: StreamingRuntime }).awslambda;
export const handler = streamingRuntime
  ? streamingRuntime.streamifyResponse(handleWebChatLambda)
  : handleWebChatLambda;
