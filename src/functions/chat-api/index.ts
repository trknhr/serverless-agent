import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { z, ZodError } from "zod";
import { AgentCoreRuntimeClient } from "../../agentcore/client";
import { buildAgentRuntimeResources } from "../../agentcore/contracts";
import { chatMessageRequestSchema } from "../../chat/contracts";
import { loadChatApiEnv } from "../../config/env";
import { buildDirectChatContextBlocks } from "../../conversations/buildDirectChatContextBlocks";
import { logger } from "../../shared/logger";
import { DynamoDbSkillRepository } from "../../skills/dynamoDbSkillRepository";
import { SkillRegistry } from "../../skills/registry";

const env = loadChatApiEnv();
const agentClient = new AgentCoreRuntimeClient({
  runtimeArn: env.AGENTCORE_RUNTIME_ARN,
  qualifier: env.AGENTCORE_RUNTIME_QUALIFIER,
});
const skillRegistry = env.SKILLS_TABLE_NAME
  ? new SkillRegistry(new DynamoDbSkillRepository(env.SKILLS_TABLE_NAME))
  : undefined;

const listBuiltinSkillsPathSchema = z.object({
  workspaceId: z.string().min(1),
});

const updateBuiltinSkillPathSchema = z.object({
  workspaceId: z.string().min(1),
  skillId: z.string().min(1),
});

const updateBuiltinSkillRequestSchema = z.object({
  enabled: z.boolean(),
  actorUserId: z.string().min(1).optional(),
});

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = event.requestContext.requestId;
  const log = logger.child({ requestId, component: "chat-api" });

  try {
    if (event.httpMethod === "POST" && event.resource === "/chat/messages") {
      return await postMessage(event, log);
    }

    if (event.httpMethod === "GET" && event.resource === "/admin/workspaces/{workspaceId}/builtin-skills") {
      return await listBuiltinSkills(event);
    }

    if (event.httpMethod === "PATCH" && event.resource === "/admin/workspaces/{workspaceId}/builtin-skills/{skillId}") {
      return await updateBuiltinSkill(event);
    }

    return response(404, { ok: false, error: "not_found" });
  } catch (error) {
    if (error instanceof ZodError) {
      return response(400, { ok: false, error: "bad_request", message: error.message });
    }
    if (error instanceof Error && error.message.startsWith("Built-in skill was not found:")) {
      return response(404, { ok: false, error: "not_found", message: error.message });
    }
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
    runtimeUserId: buildDirectChatRuntimeUserId(input.workspaceId, input.userId),
    request: {
      content: buildDirectChatContextBlocks({
        currentText: input.text,
        receivedAt: new Date().toISOString(),
        timeZone: env.GOOGLE_CALENDAR_TIME_ZONE,
      }),
      context: {
        source: "direct_chat_api",
        workspaceId: input.workspaceId,
        userId: input.userId,
        traceId: event.requestContext.requestId,
        turnId: event.requestContext.requestId,
        correlationId: event.requestContext.requestId,
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
    recurringTaskIds: completion.recurringTaskIds,
    savedMemoryIds: completion.savedMemoryIds,
    calendarDraftIds: completion.calendarDraftIds,
    traceId: completion.traceId,
    turnId: completion.turnId,
  });
}

function buildDirectChatRuntimeUserId(workspaceId: string, userId: string): string {
  return `${workspaceId}:${userId}`;
}

async function listBuiltinSkills(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const registry = requireSkillRegistry();
  const { workspaceId } = listBuiltinSkillsPathSchema.parse(event.pathParameters ?? {});
  const skills = await registry.listBuiltinSkillAdminSummaries(workspaceId);

  return response(200, {
    ok: true,
    skills,
  });
}

async function updateBuiltinSkill(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const registry = requireSkillRegistry();
  const { workspaceId, skillId } = updateBuiltinSkillPathSchema.parse(event.pathParameters ?? {});
  const input = updateBuiltinSkillRequestSchema.parse(parseJsonBody(event));
  const result = await registry.setBuiltinSkillEnabled(workspaceId, skillId, input.enabled, input.actorUserId);

  return response(200, {
    ok: true,
    skill: result.skill,
    audit: result.audit,
  });
}

function requireSkillRegistry(): SkillRegistry {
  if (!skillRegistry) {
    throw new Error("Skill registry storage is not configured.");
  }
  return skillRegistry;
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
