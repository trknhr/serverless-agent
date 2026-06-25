import { createHash } from "node:crypto";
import type { EventBridgeEvent } from "aws-lambda";
import { AgentCoreRuntimeClient } from "../../agentcore/client";
import { buildAgentRuntimeResources } from "../../agentcore/contracts";
import { SecretsProvider } from "../../aws/secretsProvider";
import { loadSchedulerEnv } from "../../config/env";
import { AgentTurnDisplayedOutput, hashTraceIdentifier } from "../../eval/agentTurnTrace";
import { LineMessagingClient } from "../../line/postMessage";
import { AgentTurnTraceRepository } from "../../repo/agentTurnTraceRepository";
import { ConversationSessionRepository } from "../../repo/conversationSessionRepository";
import { ConversationTurnRepository } from "../../repo/conversationTurnRepository";
import { DailyLimitRepository } from "../../repo/dailyLimitRepository";
import { SessionRepository } from "../../repo/sessionRepository";
import { RecurringTaskRepository } from "../../repo/recurringTaskRepository";
import { TaskEventRepository } from "../../repo/taskEventRepository";
import { TaskRepository } from "../../repo/taskRepository";
import { TaskStateRepository } from "../../repo/taskStateRepository";
import { logger } from "../../shared/logger";
import { SlackAuthClient } from "../../slack/authTest";
import { SlackWebClient } from "../../slack/postMessage";
import { RecurringTask, RecurringTaskWeekday } from "../../tasks/recurringTask";
import { resolveScheduledOutputTarget, ScheduledOutputTarget } from "../../tasks/scheduledOutput";
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
const RECURRING_TASK_LOOKAHEAD_DAYS = 7;
const SCHEDULER_SEND_LIMIT_KIND = "scheduler_send";
const WEEKDAYS: RecurringTaskWeekday[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

const env = loadSchedulerEnv();
const secretsProvider = new SecretsProvider();
const agentClient = new AgentCoreRuntimeClient({
  runtimeArn: env.AGENTCORE_RUNTIME_ARN,
  qualifier: env.AGENTCORE_RUNTIME_QUALIFIER,
});
const slackClient = new SlackWebClient(() =>
  secretsProvider.getSecretString(env.SLACK_BOT_TOKEN_SECRET_ID),
);
const lineClient = new LineMessagingClient(() =>
  secretsProvider.getSecretString(env.LINE_CHANNEL_ACCESS_TOKEN_SECRET_ID),
);
const slackAuthClient = new SlackAuthClient(() =>
  secretsProvider.getSecretString(env.SLACK_BOT_TOKEN_SECRET_ID),
);
const taskRepository = new TaskRepository(env.TASK_TABLE_NAME);
const recurringTaskRepository = new RecurringTaskRepository(env.RECURRING_TASKS_TABLE_NAME);
const taskEventRepository = new TaskEventRepository(env.TASK_EVENTS_TABLE_NAME);
const taskStateRepository = new TaskStateRepository(env.TASKS_TABLE_NAME);
const sessionRepository = new SessionRepository(env.SESSION_TABLE_NAME);
const conversationSessionRepository = new ConversationSessionRepository(env.CONVERSATION_SESSIONS_TABLE_NAME);
const conversationTurnRepository = new ConversationTurnRepository(env.CONVERSATION_TURNS_TABLE_NAME);
const dailyLimitRepository = new DailyLimitRepository(env.PROCESSED_EVENTS_TABLE_NAME);
const agentTurnTraceRepository = env.AGENT_TURN_TRACES_TABLE_NAME
  ? new AgentTurnTraceRepository(env.AGENT_TURN_TRACES_TABLE_NAME)
  : null;

export async function handler(
  event: EventBridgeEvent<string, SchedulerPayload> | SchedulerPayload,
): Promise<void> {
  const detail = "detail" in event ? event.detail : event;
  const taskId = detail.taskId ?? "daily-summary";
  const scheduledAtIso = resolveScheduledAtIso(event);
  const log = logger.child({ component: "scheduled-agent-runner", taskId });

  let task = detail.workspaceId
    ? await taskRepository.get(detail.workspaceId, taskId)
    : await taskRepository.getLegacy(taskId);
  if (!task) {
    if (taskId !== "daily-summary" && !detail.prompt && !detail.outputChannelId) {
      log.warn("Scheduled task definition was not found; skipping run");
      return;
    }

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
    log.info("Scheduled task is disabled; skipping run");
    return;
  }

  const outputTarget = resolveScheduledOutputTarget(task);
  const autoClosedTasks = await autoCloseExpiredTasks(task.workspaceId, scheduledAtIso, log);
  const materializedRecurringTasks = await materializeRecurringTasks(task.workspaceId, scheduledAtIso, log);

  const reusableSessionRecord = task.reuseSession
    ? await sessionRepository.findByThread(task.workspaceId, outputTarget.channelId, task.taskId)
    : null;
  const traceId = buildScheduledTraceId(task.workspaceId, task.taskId, scheduledAtIso);
  const turnId = `scheduled:${task.taskId}:${scheduledAtIso}`;
  const scheduledUserId = task.createdByUserId ?? task.updatedByUserId;
  const completion = await agentClient.invoke({
    sessionId: reusableSessionRecord?.sessionId,
    runtimeUserId: scheduledUserId,
    request: {
      content: [
        {
          type: "text",
          text: buildScheduledPrompt(
            task.prompt,
            scheduledAtIso,
            outputTarget.provider,
            autoClosedTasks,
            materializedRecurringTasks,
          ),
        },
      ],
      context: {
        source: "scheduler",
        workspaceId: task.workspaceId,
        userId: scheduledUserId,
        taskId: task.taskId,
        traceId,
        turnId,
      },
      resources: buildAgentRuntimeResources(env),
      toolContext: {
        workspaceId: task.workspaceId,
        userId: scheduledUserId,
      },
    },
  });

  const postedMessage = await postScheduledMessage(outputTarget, task, completion.text);
  await updateScheduledDisplayedOutputTrace({
    traceId: completion.traceId ?? traceId,
    turnId: completion.turnId ?? turnId,
    channelId: postedMessage.channelId,
    messageTs: postedMessage.provider === "slack" ? postedMessage.messageTs : undefined,
    text: postedMessage.text,
    log,
  });
  if (postedMessage.provider === "slack" && postedMessage.messageTs) {
    try {
      await persistScheduledSlackThreadContext({
        workspaceId: task.workspaceId,
        channelId: postedMessage.channelId,
        messageTs: postedMessage.messageTs,
        text: postedMessage.text,
      });
    } catch (error) {
      log.warn("Failed to save scheduled Slack reminder as thread context", {
        error: error instanceof Error ? error.message : "Unknown conversation context error",
        channelId: postedMessage.channelId,
        messageTs: postedMessage.messageTs,
      });
    }
  }

  const sessionId = completion.sessionId ?? reusableSessionRecord?.sessionId;
  if (task.reuseSession) {
    if (!sessionId) {
      throw new Error("AgentCore did not return a reusable runtime session id");
    }
    const now = new Date().toISOString();
    await sessionRepository.save({
      workspaceId: task.workspaceId,
      channelId: outputTarget.channelId,
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
    materializedRecurringTaskCount: materializedRecurringTasks.length,
  });
}

async function materializeRecurringTasks(
  workspaceId: string,
  scheduledAtIso: string,
  log: ReturnType<typeof logger.child>,
): Promise<TaskState[]> {
  const scheduledAt = new Date(scheduledAtIso);
  const now = Number.isNaN(scheduledAt.getTime()) ? new Date() : scheduledAt;
  const recurringTasks = await recurringTaskRepository.list({
    workspaceId,
    enabled: true,
    limit: 250,
  });
  const createdTasks: TaskState[] = [];

  for (const recurringTask of recurringTasks) {
    const occurrenceDates = enumerateOccurrenceDates(recurringTask, now, RECURRING_TASK_LOOKAHEAD_DAYS);
    for (const occurrenceDate of occurrenceDates) {
      const taskId = buildRecurringOccurrenceTaskId(recurringTask, occurrenceDate);
      const existing = await taskStateRepository.get(workspaceId, taskId);
      if (existing) {
        continue;
      }

      const task = await taskStateRepository.upsert({
        workspaceId,
        taskId,
        title: recurringTask.title,
        description: recurringTask.description,
        status: "open",
        dueAt: buildOccurrenceDueAt(occurrenceDate, recurringTask.dueTime, recurringTask.timezone),
        priority: recurringTask.priority,
        ownerUserId: recurringTask.ownerUserId,
        sourceType: "recurring_task",
        sourceRef: recurringTask.sourceRef ?? recurringTask.recurringTaskId,
        metadata: {
          ...recurringTask.metadata,
          recurringTaskId: recurringTask.recurringTaskId,
          occurrenceDate,
        },
      });
      createdTasks.push(task);

      await taskEventRepository.save({
        taskId: task.taskId,
        type: "created",
        payload: {
          title: task.title,
          status: task.status,
          due_at: task.dueAt,
          recurring_task_id: recurringTask.recurringTaskId,
          occurrence_date: occurrenceDate,
        },
      });
    }
  }

  if (createdTasks.length > 0) {
    log.info("Materialized recurring tasks", {
      count: createdTasks.length,
      taskIds: createdTasks.map((task) => task.taskId),
    });
  }

  return createdTasks;
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

function enumerateOccurrenceDates(
  recurringTask: RecurringTask,
  now: Date,
  lookaheadDays: number,
): string[] {
  const startDate = formatInTimeZone(now, recurringTask.timezone).date;
  const dates: string[] = [];

  for (let offset = 0; offset <= lookaheadDays; offset += 1) {
    const dateOnly = addDays(startDate, offset);
    if (isRecurringTaskOccurrenceDate(recurringTask, dateOnly)) {
      dates.push(dateOnly);
    }
  }

  return dates;
}

function isRecurringTaskOccurrenceDate(
  recurringTask: RecurringTask,
  dateOnly: string,
): boolean {
  const startDate = formatInTimeZone(new Date(recurringTask.createdAt), recurringTask.timezone).date;
  const interval = recurringTask.recurrence.interval ?? 1;

  if (recurringTask.recurrence.frequency === "daily") {
    const days = daysBetween(startDate, dateOnly);
    return days >= 0 && days % interval === 0;
  }

  if (recurringTask.recurrence.frequency === "weekly") {
    const days = daysBetween(startDate, dateOnly);
    if (days < 0 || Math.floor(days / 7) % interval !== 0) {
      return false;
    }
    const weekdays = recurringTask.recurrence.daysOfWeek ?? [weekdayForDate(startDate)];
    return weekdays.includes(weekdayForDate(dateOnly));
  }

  if (recurringTask.recurrence.frequency === "monthly") {
    const months = monthsBetween(startDate, dateOnly);
    if (months < 0 || months % interval !== 0) {
      return false;
    }

    const dayOfMonth = parseDateOnly(dateOnly).day;
    if (recurringTask.recurrence.daysOfMonth?.includes(dayOfMonth)) {
      return true;
    }

    if (recurringTask.recurrence.weekOfMonth && recurringTask.recurrence.daysOfWeek?.length) {
      return recurringTask.recurrence.daysOfWeek.some((weekday) =>
        isNthWeekdayOfMonth(dateOnly, weekday, recurringTask.recurrence.weekOfMonth!),
      );
    }

    return dayOfMonth === parseDateOnly(startDate).day;
  }

  return false;
}

function buildRecurringOccurrenceTaskId(recurringTask: RecurringTask, occurrenceDate: string): string {
  const hash = createHash("sha256")
    .update(`${recurringTask.workspaceId}:${recurringTask.recurringTaskId}:${occurrenceDate}`)
    .digest("hex")
    .slice(0, 16);
  return `task_rec_${hash}_${occurrenceDate.replace(/-/g, "")}`;
}

function buildOccurrenceDueAt(dateOnly: string, dueTime: string, timeZone: string): string {
  return `${dateOnly}T${dueTime}:00${timeZoneOffsetForDate(dateOnly, timeZone)}`;
}

function addDays(dateOnly: string, days: number): string {
  const { year, month, day } = parseDateOnly(dateOnly);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return formatUtcDateOnly(date);
}

function daysBetween(startDate: string, endDate: string): number {
  const start = parseDateOnly(startDate);
  const end = parseDateOnly(endDate);
  const startMs = Date.UTC(start.year, start.month - 1, start.day);
  const endMs = Date.UTC(end.year, end.month - 1, end.day);
  return Math.floor((endMs - startMs) / (24 * 60 * 60 * 1000));
}

function monthsBetween(startDate: string, endDate: string): number {
  const start = parseDateOnly(startDate);
  const end = parseDateOnly(endDate);
  return (end.year - start.year) * 12 + (end.month - start.month);
}

function weekdayForDate(dateOnly: string): RecurringTaskWeekday {
  const { year, month, day } = parseDateOnly(dateOnly);
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

function isNthWeekdayOfMonth(
  dateOnly: string,
  weekday: RecurringTaskWeekday,
  weekOfMonth: number | "last",
): boolean {
  if (weekdayForDate(dateOnly) !== weekday) {
    return false;
  }

  const { day } = parseDateOnly(dateOnly);
  if (weekOfMonth === "last") {
    return parseDateOnly(addDays(dateOnly, 7)).month !== parseDateOnly(dateOnly).month;
  }

  return Math.floor((day - 1) / 7) + 1 === weekOfMonth;
}

function parseDateOnly(dateOnly: string): { year: number; month: number; day: number } {
  const [year, month, day] = dateOnly.split("-").map((part) => Number.parseInt(part, 10));
  return { year, month, day };
}

function formatUtcDateOnly(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function timeZoneOffsetForDate(dateOnly: string, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "shortOffset",
  });
  const timeZoneName = formatter
    .formatToParts(new Date(`${dateOnly}T12:00:00Z`))
    .find((part) => part.type === "timeZoneName")?.value;
  const match = timeZoneName?.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) {
    return "+00:00";
  }

  const [, sign, rawHour, rawMinute] = match;
  const hour = rawHour.padStart(2, "0");
  const minute = rawMinute ?? "00";
  return `${sign}${hour}:${minute}`;
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
  outputProvider: ScheduledOutputTarget["provider"],
  autoClosedTasks: TaskState[] = [],
  materializedRecurringTasks: TaskState[] = [],
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
    outputProvider === "line"
      ? "- Format the final answer as LINE plain text: use short labels and bullets, but do not use Markdown tables or Slack-specific mrkdwn."
      : "- Format the final answer for Slack mrkdwn: use bold labels and bullets, but do not use Markdown headings, horizontal rules, or tables.",
    "- Do not narrate tool calls, failed attempts, or intermediate reasoning; post only the final useful reminder content.",
    "- Only include facts, reminders, dates, tasks, events, and notes that are present in tool results, the scheduling context, or the scheduled reminder prompt.",
    "- Do not invent or infer extra memo items, calendar events, reminders, deadlines, or family notes that were not returned by tools.",
    "- If the prompt asks for a memo or note and no grounded item is available, omit that section or say there is no note to add.",
  ];
  if (env.DEFAULT_RESPONSE_LANGUAGE) {
    promptParts.push(`- Reply language: ${env.DEFAULT_RESPONSE_LANGUAGE}.`);
  }

  if (autoClosedTasks.length > 0) {
    promptParts.push(
      "- The system already closed these expired tasks before this run. Mention this in one short sentence, and do not list them as current or upcoming tasks.",
      ...autoClosedTasks.map((task) => `  - ${task.title}${task.dueAt ? ` (due: ${task.dueAt})` : ""}`),
    );
  }

  if (materializedRecurringTasks.length > 0) {
    promptParts.push(
      "- The system already created current upcoming task instances from recurring task definitions. search_context task list results include them.",
    );
  }

  return [...promptParts, "", basePrompt].join("\n");
}

async function postScheduledMessage(
  outputTarget: ScheduledOutputTarget,
  task: ScheduledTask,
  text: string,
): Promise<
  | { provider: "slack"; channelId: string; messageTs?: string; text: string }
  | { provider: "line"; channelId: string; text: string }
> {
  const allowed = await dailyLimitRepository.consume({
    workspaceId: task.workspaceId,
    kind: SCHEDULER_SEND_LIMIT_KIND,
    limit: env.SCHEDULER_DAILY_SEND_LIMIT,
    ttlSeconds: env.DAILY_LIMIT_TTL_SECONDS,
  });
  if (!allowed) {
    logger.warn("Scheduler daily send limit exceeded", {
      component: "scheduled-agent-runner",
      workspaceId: task.workspaceId,
      taskId: task.taskId,
      provider: outputTarget.provider,
      limit: env.SCHEDULER_DAILY_SEND_LIMIT,
    });
    if (outputTarget.provider === "line") {
      return {
        provider: "line",
        channelId: outputTarget.channelId,
        text: buildScheduledLineMessage(task, text),
      };
    }
    return {
      provider: "slack",
      channelId: outputTarget.channelId,
      text: buildScheduledSlackMessage(task, text),
    };
  }

  if (outputTarget.provider === "line") {
    const messageText = buildScheduledLineMessage(task, text);
    await lineClient.pushText(outputTarget.targetId, messageText);
    return { provider: "line", channelId: outputTarget.channelId, text: messageText };
  }

  const messageText = buildScheduledSlackMessage(task, text);
  const message = await slackClient.postMessage({
    channel: outputTarget.channelId,
    text: messageText,
  });
  return {
    provider: "slack",
    channelId: outputTarget.channelId,
    messageTs: message?.ts,
    text: messageText,
  };
}

function buildScheduledTraceId(workspaceId: string, taskId: string, scheduledAtIso: string): string {
  const hash = createHash("sha256")
    .update(`${workspaceId}:${taskId}:${scheduledAtIso}`, "utf8")
    .digest("hex")
    .slice(0, 24);
  return `scheduled_${hash}`;
}

async function updateScheduledDisplayedOutputTrace(input: {
  traceId: string;
  turnId: string;
  channelId: string;
  messageTs?: string;
  text: string;
  log: ReturnType<typeof logger.child>;
}): Promise<void> {
  if (!agentTurnTraceRepository) {
    return;
  }

  const displayedOutput: AgentTurnDisplayedOutput = {
    surface: "scheduler",
    text: input.text,
    messageTs: input.messageTs,
    channelIdHash: hashTraceIdentifier(input.channelId),
    postedAt: new Date().toISOString(),
  };

  try {
    const updated = await agentTurnTraceRepository.updateDisplayedOutput({
      traceId: input.traceId,
      turnId: input.turnId,
      displayedOutput,
    });
    if (!updated) {
      input.log.warn("Scheduled agent trace was not found for displayed output update", {
        traceId: input.traceId,
        turnId: input.turnId,
      });
    }
  } catch (error) {
    input.log.warn("Failed to update scheduled displayed output trace", {
      traceId: input.traceId,
      turnId: input.turnId,
      error: error instanceof Error ? error.message : "Unknown trace update error",
    });
  }
}

async function persistScheduledSlackThreadContext(input: {
  workspaceId: string;
  channelId: string;
  messageTs: string;
  text: string;
}): Promise<void> {
  const now = new Date().toISOString();
  await conversationSessionRepository.save({
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    conversationTs: input.messageTs,
    createdAt: now,
    lastUsedAt: now,
  });
  await conversationTurnRepository.save({
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    conversationTs: input.messageTs,
    contextScope: "thread",
    role: "assistant",
    source: "slack",
    sourceEvent: "scheduled_reminder",
    threadTs: input.messageTs,
    messageTs: input.messageTs,
    turnTs: input.messageTs,
    text: input.text,
  });
}

function buildScheduledSlackMessage(task: ScheduledTask, text: string): string {
  const reminderName = escapeSlackText(task.name.trim() || task.taskId);
  const body = text.trim();
  return [`*リマインダー:* ${reminderName}`, body].filter(Boolean).join("\n\n");
}

function buildScheduledLineMessage(task: ScheduledTask, text: string): string {
  const reminderName = task.name.trim() || task.taskId;
  const body = text.trim();
  return [`リマインダー: ${reminderName}`, body].filter(Boolean).join("\n\n");
}

function escapeSlackText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
