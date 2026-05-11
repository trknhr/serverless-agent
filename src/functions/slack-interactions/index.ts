import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { SecretsProvider } from "../../aws/secretsProvider";
import { createUserGoogleCalendarClient } from "../../calendar/userGoogleCalendar";
import { loadSlackInteractionsEnv } from "../../config/env";
import { CalendarDraftRepository } from "../../repo/calendarDraftRepository";
import { GoogleOAuthConnectionRepository } from "../../repo/googleOAuthConnectionRepository";
import { MemoryItemRepository } from "../../repo/memoryItemRepository";
import { TaskEventRepository } from "../../repo/taskEventRepository";
import { TaskStateRepository } from "../../repo/taskStateRepository";
import { logger } from "../../shared/logger";
import { SlackWebClient } from "../../slack/postMessage";
import { verifySlackSignature } from "../../slack/verifySignature";
import { ToolExecutionResult } from "../../agent/types";
import { CustomToolExecutor } from "../../tools/executeCustomTool";

interface SlackInteractionPayload {
  user?: { id?: string };
  channel?: { id?: string };
  message?: { ts?: string };
  actions?: Array<{
    action_id?: string;
    value?: string;
  }>;
}

interface CalendarDraftActionValue {
  action: "approve" | "reject";
  workspaceId: string;
  userId?: string;
  draftId: string;
}

const env = loadSlackInteractionsEnv();
const secretsProvider = new SecretsProvider();
const slackClient = new SlackWebClient(() =>
  secretsProvider.getSecretString(env.SLACK_BOT_TOKEN_SECRET_ID),
);
const calendarDraftRepository = new CalendarDraftRepository(env.CALENDAR_DRAFTS_TABLE_NAME);
const googleOAuthConnectionRepository = new GoogleOAuthConnectionRepository(env.GOOGLE_OAUTH_CONNECTIONS_TABLE_NAME);
const memoryItemRepository = new MemoryItemRepository(env.MEMORY_ITEMS_TABLE_NAME);
const taskEventRepository = new TaskEventRepository(env.TASK_EVENTS_TABLE_NAME);
const taskStateRepository = new TaskStateRepository(env.TASKS_TABLE_NAME);

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = event.requestContext.requestId;
  const log = logger.child({ requestId, component: "slack-interactions" });
  const rawBody = decodeBody(event.body ?? "", event.isBase64Encoded);
  const signingSecret = await secretsProvider.getSecretString(env.SLACK_SIGNING_SECRET_SECRET_ID);
  const signature =
    event.headers["X-Slack-Signature"] ?? event.headers["x-slack-signature"] ?? undefined;
  const timestamp =
    event.headers["X-Slack-Request-Timestamp"] ??
    event.headers["x-slack-request-timestamp"] ??
    undefined;

  if (!verifySlackSignature({ rawBody, signature, timestamp, signingSecret })) {
    log.warn("Slack interaction signature verification failed");
    return response(401, { ok: false, error: "invalid_signature" });
  }

  try {
    const payload = parseInteractionPayload(rawBody);
    const action = payload.actions?.[0];
    if (!action?.value) {
      return response(200, { ok: true, ignored: true });
    }

    const value = JSON.parse(action.value) as CalendarDraftActionValue;
    if (value.userId && payload.user?.id && value.userId !== payload.user.id) {
      await updateInteractionMessage(payload, "この下書きは作成者だけが操作できます。");
      return response(200, { ok: true, rejected: true });
    }

    const result = await executeCalendarDraftAction(value, log);
    await updateInteractionMessage(payload, formatInteractionResult(value, result));

    log.info("Slack calendar draft interaction handled", {
      action: value.action,
      draftId: value.draftId,
      userId: payload.user?.id,
    });
    return response(200, { ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Slack interaction error";
    log.error("Slack interaction failed", { error: message });
    return response(200, { ok: false, error: message });
  }
}

async function executeCalendarDraftAction(
  value: CalendarDraftActionValue,
  log: typeof logger,
): Promise<ToolExecutionResult> {
  const executor = new CustomToolExecutor(
    {
      memoryItems: memoryItemRepository,
      tasks: taskStateRepository,
      taskEvents: taskEventRepository,
      calendarDrafts: calendarDraftRepository,
    },
    {
      workspaceId: value.workspaceId,
      userId: value.userId,
      logger: log,
    },
    {
      googleCalendarProvider: () =>
        createUserGoogleCalendarClient({
          workspaceId: value.workspaceId,
          userId: value.userId,
          defaultTimeZone: env.GOOGLE_CALENDAR_TIME_ZONE,
          googleCalendarSecretId: env.GOOGLE_CALENDAR_SECRET_ID,
          googleOAuthStartUrl: env.GOOGLE_OAUTH_START_URL,
          secretsProvider,
          connections: googleOAuthConnectionRepository,
        }),
      defaultCalendarTimeZone: env.GOOGLE_CALENDAR_TIME_ZONE,
    },
  );

  return executor.execute({
    id: `slack_interaction_${Date.now()}`,
    type: "agent.custom_tool_use",
    name: value.action === "approve" ? "apply_calendar_draft" : "discard_calendar_draft",
    input: {
      draft_id: value.draftId,
    },
  });
}

async function updateInteractionMessage(
  payload: SlackInteractionPayload,
  text: string,
): Promise<void> {
  const channel = payload.channel?.id;
  const ts = payload.message?.ts;
  if (!channel || !ts) {
    return;
  }

  await slackClient.updateMessage({
    channel,
    ts,
    text,
    blocks: [],
  });
}

function formatInteractionResult(
  value: CalendarDraftActionValue,
  result: ToolExecutionResult,
): string {
  const details = result.content
    ?.filter((block): block is { type: "text"; text: string } => block.type === "text" && "text" in block)
    .map((block) => block.text)
    .join("\n")
    .trim();

  if (result.isError) {
    return `カレンダー下書きの${value.action === "approve" ? "承認" : "却下"}に失敗しました。\n${details ?? ""}`.trim();
  }

  return value.action === "approve"
    ? `カレンダー下書きを承認し、予定を作成しました。\n${details ?? ""}`.trim()
    : `カレンダー下書きを却下しました。\n${details ?? ""}`.trim();
}

function parseInteractionPayload(rawBody: string): SlackInteractionPayload {
  const params = new URLSearchParams(rawBody);
  const payload = params.get("payload");
  if (!payload) {
    throw new Error("Missing Slack interaction payload");
  }

  return JSON.parse(payload) as SlackInteractionPayload;
}

function decodeBody(body: string, isBase64Encoded: boolean | undefined): string {
  return isBase64Encoded ? Buffer.from(body, "base64").toString("utf-8") : body;
}

function response(statusCode: number, body: Record<string, unknown>): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  };
}
