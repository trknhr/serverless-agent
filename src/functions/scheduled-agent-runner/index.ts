import type { EventBridgeEvent } from "aws-lambda";
import { AgentCoreRuntimeClient } from "../../agentcore/client";
import { buildAgentRuntimeResources } from "../../agentcore/contracts";
import { SecretsProvider } from "../../aws/secretsProvider";
import { loadSchedulerEnv } from "../../config/env";
import { SessionRepository } from "../../repo/sessionRepository";
import { TaskEventRepository } from "../../repo/taskEventRepository";
import { TaskRepository } from "../../repo/taskRepository";
import { TaskStateRepository } from "../../repo/taskStateRepository";
import { logger } from "../../shared/logger";
import { SlackAuthClient } from "../../slack/authTest";
import { SlackWebClient } from "../../slack/postMessage";
import { ScheduledTask } from "../../tasks/taskDefinition";
import { TaskState } from "../../tasks/taskState";

interface SchedulerPayload {
  taskId?: string;
  workspaceId?: string;
  outputChannelId?: string;
  prompt?: string;
  name?: string;
  persistTask?: boolean;
}

const SCHEDULE_TIMEZONE = "Asia/Tokyo";

const env = loadSchedulerEnv();
const secretsProvider = new SecretsProvider();
const agentClient = new AgentCoreRuntimeClient({
  runtimeArn: env.AGENTCORE_RUNTIME_ARN,
  qualifier: env.AGENTCORE_RUNTIME_QUALIFIER,
});
const slackClient = new SlackWebClient(() =>
  secretsProvider.getSecretString(env.SLACK_BOT_TOKEN_SECRET_ID),
);
const slackAuthClient = new SlackAuthClient(() =>
  secretsProvider.getSecretString(env.SLACK_BOT_TOKEN_SECRET_ID),
);
const taskRepository = new TaskRepository(env.TASK_TABLE_NAME);
const taskEventRepository = new TaskEventRepository(env.TASK_EVENTS_TABLE_NAME);
const taskStateRepository = new TaskStateRepository(env.TASKS_TABLE_NAME);
const sessionRepository = new SessionRepository(env.SESSION_TABLE_NAME);

export async function handler(
  event: EventBridgeEvent<string, SchedulerPayload> | SchedulerPayload,
): Promise<void> {
  const detail = "detail" in event ? event.detail : event;
  const taskId = detail.taskId ?? "daily-summary";
  const scheduledAtIso = resolveScheduledAtIso(event);
  const log = logger.child({ component: "scheduled-agent-runner", taskId });

  let task = await taskRepository.get(taskId);
  if (!task) {
    task = await buildFallbackTask(detail, taskId);
    if (detail.persistTask !== false) {
      await taskRepository.save(task);
      log.info("Persisted fallback scheduled task", {
        outputChannelId: task.outputChannelId,
        workspaceId: task.workspaceId,
      });
    }
  }

  if (!task.enabled) {
    throw new Error(`Scheduled task ${taskId} is disabled`);
  }

  const autoClosedTasks = await autoCloseExpiredTasks(task.workspaceId, scheduledAtIso, log);

  const reusableSessionRecord = task.reuseSession
    ? await sessionRepository.findByThread(task.workspaceId, task.outputChannelId, task.taskId)
    : null;
  const completion = await agentClient.invoke({
    sessionId: reusableSessionRecord?.sessionId,
    request: {
      content: [
        {
          type: "text",
          text: buildScheduledPrompt(task.prompt, scheduledAtIso, autoClosedTasks),
        },
      ],
      context: {
        source: "scheduler",
        workspaceId: task.workspaceId,
        taskId: task.taskId,
      },
      resources: buildAgentRuntimeResources(env),
      toolContext: {
        workspaceId: task.workspaceId,
      },
    },
  });

  await slackClient.postMessage({
    channel: task.outputChannelId,
    text: completion.text,
  });

  const sessionId = completion.sessionId ?? reusableSessionRecord?.sessionId;
  if (task.reuseSession) {
    if (!sessionId) {
      throw new Error("AgentCore did not return a reusable runtime session id");
    }
    const now = new Date().toISOString();
    await sessionRepository.save({
      workspaceId: task.workspaceId,
      channelId: task.outputChannelId,
      threadTs: task.taskId,
      sessionId,
      memoryStoreId: task.memoryStoreId,
      createdAt: reusableSessionRecord?.createdAt ?? now,
      lastUsedAt: now,
    });
  }

  log.info("Scheduled task completed", {
    sessionId,
    status: completion.status,
    autoClosedTaskCount: autoClosedTasks.length,
  });
}

async function autoCloseExpiredTasks(
  workspaceId: string,
  scheduledAtIso: string,
  log: ReturnType<typeof logger.child>,
): Promise<TaskState[]> {
  const scheduledAt = new Date(scheduledAtIso);
  const now = Number.isNaN(scheduledAt.getTime()) ? new Date() : scheduledAt;
  const today = formatInTimeZone(now, SCHEDULE_TIMEZONE).date;
  const candidates = await taskStateRepository.list({
    workspaceId,
    statuses: ["open", "in_progress"],
    limit: 50,
  });
  const expiredTasks = candidates.filter((task) => isExpiredTaskDueAt(task.dueAt, now, today));
  const closedTasks: TaskState[] = [];

  for (const task of expiredTasks) {
    const closedTask = await taskStateRepository.upsert({
      ...task,
      status: "cancelled",
      taskId: task.taskId,
      workspaceId: task.workspaceId,
      metadata: {
        ...task.metadata,
        autoClosedReason: "expired",
        autoClosedAt: now.toISOString(),
      },
    });
    closedTasks.push(closedTask);

    await taskEventRepository.save({
      taskId: closedTask.taskId,
      type: "updated",
      payload: {
        status: closedTask.status,
        due_at: closedTask.dueAt,
        auto_closed_reason: "expired",
      },
    });
  }

  if (closedTasks.length > 0) {
    log.info("Auto-closed expired tasks", {
      count: closedTasks.length,
      taskIds: closedTasks.map((task) => task.taskId),
    });
  }

  return closedTasks;
}

function isExpiredTaskDueAt(dueAt: string | undefined, now: Date, today: string): boolean {
  if (!dueAt) {
    return false;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(dueAt)) {
    return dueAt < today;
  }

  const dueDate = new Date(dueAt);
  if (Number.isNaN(dueDate.getTime())) {
    return false;
  }

  return dueDate.getTime() < now.getTime();
}

async function buildFallbackTask(
  detail: SchedulerPayload,
  taskId: string,
): Promise<ScheduledTask> {
  const outputChannelId = resolveOutputChannelId(detail.outputChannelId);
  if (!outputChannelId) {
    throw new Error(
      "Scheduled task is missing and no output channel is configured. Pass outputChannelId in the invoke payload or deploy with -c defaultScheduleChannel=C123.",
    );
  }

  const auth = await slackAuthClient.authTest();
  const workspaceId = detail.workspaceId ?? auth.team_id;
  if (!workspaceId) {
    throw new Error("Unable to resolve workspaceId from Slack auth.test");
  }

  const now = new Date().toISOString();
  return {
    taskId,
    name: detail.name ?? "Daily Summary",
    prompt:
      detail.prompt ??
      "Post a short smoke-test message saying the scheduled runner is working.",
    workspaceId,
    outputChannelId,
    enabled: true,
    reuseSession: false,
    createdAt: now,
    updatedAt: now,
  };
}

function resolveOutputChannelId(payloadChannelId?: string): string | null {
  if (payloadChannelId) {
    return payloadChannelId;
  }

  if (env.DEFAULT_SCHEDULE_CHANNEL && env.DEFAULT_SCHEDULE_CHANNEL !== "C_PLACEHOLDER") {
    return env.DEFAULT_SCHEDULE_CHANNEL;
  }

  return null;
}

function resolveScheduledAtIso(
  event: EventBridgeEvent<string, SchedulerPayload> | SchedulerPayload,
): string {
  if ("time" in event && typeof event.time === "string" && event.time.length > 0) {
    return event.time;
  }

  return new Date().toISOString();
}

function buildScheduledPrompt(
  basePrompt: string,
  scheduledAtIso: string,
  autoClosedTasks: TaskState[] = [],
): string {
  const date = new Date(scheduledAtIso);
  if (Number.isNaN(date.getTime())) {
    return basePrompt;
  }

  const parts = formatInTimeZone(date, SCHEDULE_TIMEZONE);
  const promptParts = [
    "Scheduling context:",
    `- Current scheduled run time: ${parts.date} ${parts.time} (${parts.weekday})`,
    `- Time zone: ${SCHEDULE_TIMEZONE}`,
    "- Interpret relative dates such as today, yesterday, and tomorrow using this time zone, not UTC.",
  ];

  if (autoClosedTasks.length > 0) {
    promptParts.push(
      "- The system already closed these expired tasks before this run. Mention this in one short sentence, and do not list them as current or upcoming tasks.",
      ...autoClosedTasks.map((task) => `  - ${task.title}${task.dueAt ? ` (due: ${task.dueAt})` : ""}`),
    );
  }

  return [...promptParts, "", basePrompt].join("\n");
}

function formatInTimeZone(date: Date, timeZone: string): {
  date: string;
  time: string;
  weekday: string;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "long",
    hourCycle: "h23",
  });

  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
    weekday: parts.weekday,
  };
}
