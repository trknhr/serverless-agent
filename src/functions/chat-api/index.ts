import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { AgentCoreRuntimeClient } from "../../agentcore/client";
import { buildAgentRuntimeResources } from "../../agentcore/contracts";
import { chatMessageRequestSchema } from "../../chat/contracts";
import { loadChatApiEnv } from "../../config/env";
import { logger } from "../../shared/logger";

const env = loadChatApiEnv();
const agentClient = new AgentCoreRuntimeClient({
  runtimeArn: env.AGENTCORE_RUNTIME_ARN,
  qualifier: env.AGENTCORE_RUNTIME_QUALIFIER,
});

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = event.requestContext.requestId;
  const log = logger.child({ requestId, component: "chat-api" });

  try {
    if (event.httpMethod === "POST" && event.resource === "/chat/messages") {
      return postMessage(event, log);
    }

    return response(404, { ok: false, error: "not_found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown chat API error";
    log.error("Chat API failed", { error: message });
    return response(500, { ok: false, error: "internal_error", message });
  }
}

async function postMessage(
  event: APIGatewayProxyEvent,
  log: typeof logger,
): Promise<APIGatewayProxyResult> {
  const body = parseJsonBody(event);
  const input = chatMessageRequestSchema.parse(body);
  const completion = await agentClient.invoke({
    sessionId: input.sessionId,
    runtimeUserId: input.userId,
    request: {
      content: [
        {
          type: "text",
          text: input.text,
        },
      ],
      context: {
        source: "direct_chat_api",
        workspaceId: input.workspaceId,
        userId: input.userId,
      },
      resources: buildAgentRuntimeResources(env),
      toolContext: {
        workspaceId: input.workspaceId,
        userId: input.userId,
      },
    },
  });

  return response(200, {
    ok: true,
    sessionId: completion.sessionId,
    text: completion.text,
    taskIds: completion.taskIds,
    savedMemoryIds: completion.savedMemoryIds,
  });
}

function parseJsonBody(event: APIGatewayProxyEvent): unknown {
  const body = event.body ?? "{}";
  const text = event.isBase64Encoded ? Buffer.from(body, "base64").toString("utf-8") : body;
  return JSON.parse(text);
}

function response(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  };
}
