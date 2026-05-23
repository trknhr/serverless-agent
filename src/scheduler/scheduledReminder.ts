import { createHash } from "node:crypto";
import {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
  SchedulerClient,
  UpdateScheduleCommand,
  type GetScheduleOutput,
} from "@aws-sdk/client-scheduler";
import { ScheduledTask } from "../tasks/taskDefinition";

export interface ScheduledReminderSchedulerConfig {
  scheduleGroupName: string;
  scheduleNamePrefix: string;
  defaultTimeZone: string;
  targetArn: string;
  targetRoleArn: string;
}

export interface ScheduledReminderSnapshot {
  scheduleName: string;
  scheduleGroupName: string;
  scheduleExpression: string;
  timezone: string;
  time?: string;
  state?: string;
}

export interface ScheduledReminderScheduler {
  buildScheduleName(workspaceId: string, taskId: string): string;
  put(task: ScheduledTask): Promise<ScheduledReminderSnapshot>;
  delete(task: Pick<ScheduledTask, "workspaceId" | "scheduleName" | "scheduleGroupName" | "taskId">): Promise<void>;
}

export class EventBridgeScheduledReminderScheduler implements ScheduledReminderScheduler {
  private readonly scheduler: SchedulerClient;

  constructor(
    private readonly config: ScheduledReminderSchedulerConfig,
    scheduler?: SchedulerClient,
  ) {
    this.scheduler = scheduler ?? new SchedulerClient({});
  }

  buildScheduleName(workspaceId: string, taskId: string): string {
    return buildScheduleName(this.config.scheduleNamePrefix, workspaceId, taskId);
  }

  async put(task: ScheduledTask): Promise<ScheduledReminderSnapshot> {
    const scheduleName = task.scheduleName ?? this.buildScheduleName(task.workspaceId, task.taskId);
    const scheduleGroupName = task.scheduleGroupName ?? this.config.scheduleGroupName;
    const scheduleExpression = task.scheduleExpression;
    if (!scheduleExpression) {
      throw new Error(`Scheduled task ${task.taskId} does not have a schedule expression`);
    }

    const timezone = task.scheduleExpressionTimezone ?? this.config.defaultTimeZone;
    const target = {
      Arn: this.config.targetArn,
      RoleArn: this.config.targetRoleArn,
      Input: JSON.stringify({ workspaceId: task.workspaceId, taskId: task.taskId }),
    };
    const existing = await this.getSchedule(scheduleName, scheduleGroupName);
    const state = task.enabled ? "ENABLED" as const : "DISABLED" as const;

    if (existing) {
      await this.scheduler.send(
        new UpdateScheduleCommand({
          Name: scheduleName,
          GroupName: scheduleGroupName,
          ScheduleExpression: scheduleExpression,
          ScheduleExpressionTimezone: timezone,
          FlexibleTimeWindow: existing.FlexibleTimeWindow ?? { Mode: "OFF" },
          State: state,
          Target: target,
          Description: task.name,
        }),
      );
    } else {
      await this.scheduler.send(
        new CreateScheduleCommand({
          Name: scheduleName,
          GroupName: scheduleGroupName,
          ScheduleExpression: scheduleExpression,
          ScheduleExpressionTimezone: timezone,
          FlexibleTimeWindow: { Mode: "OFF" },
          State: state,
          Target: target,
          Description: task.name,
        }),
      );
    }

    return {
      scheduleName,
      scheduleGroupName,
      scheduleExpression,
      timezone,
      time: extractDailyCronTime(scheduleExpression),
      state,
    };
  }

  async delete(task: Pick<ScheduledTask, "workspaceId" | "scheduleName" | "scheduleGroupName" | "taskId">): Promise<void> {
    const scheduleName = task.scheduleName ?? this.buildScheduleName(task.workspaceId, task.taskId);
    const scheduleGroupName = task.scheduleGroupName ?? this.config.scheduleGroupName;

    try {
      await this.scheduler.send(
        new DeleteScheduleCommand({
          Name: scheduleName,
          GroupName: scheduleGroupName,
        }),
      );
    } catch (error) {
      if (isNotFoundError(error)) {
        return;
      }
      throw error;
    }
  }

  private async getSchedule(scheduleName: string, scheduleGroupName: string): Promise<GetScheduleOutput | null> {
    try {
      return await this.scheduler.send(
        new GetScheduleCommand({
          Name: scheduleName,
          GroupName: scheduleGroupName,
        }),
      );
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }
}

export type ScheduledReminderWeekday =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

export interface ScheduledReminderRecurrence {
  frequency: "daily" | "weekly" | "monthly";
  time: string;
  daysOfWeek?: ScheduledReminderWeekday[];
  daysOfMonth?: number[];
}

const WEEKDAY_TO_CRON: Record<ScheduledReminderWeekday, string> = {
  sunday: "SUN",
  monday: "MON",
  tuesday: "TUE",
  wednesday: "WED",
  thursday: "THU",
  friday: "FRI",
  saturday: "SAT",
};

export function buildScheduleExpressionFromRecurrence(recurrence: ScheduledReminderRecurrence): string {
  const time = normalizeDailyReminderTime(recurrence.time);
  const [hour, minute] = time.split(":").map(Number);

  if (recurrence.frequency === "daily") {
    return `cron(${minute} ${hour} * * ? *)`;
  }

  if (recurrence.frequency === "weekly") {
    const daysOfWeek = recurrence.daysOfWeek ?? [];
    if (daysOfWeek.length === 0) {
      throw new Error("Weekly scheduled reminders require at least one day_of_week.");
    }
    return `cron(${minute} ${hour} ? * ${daysOfWeek.map((day) => WEEKDAY_TO_CRON[day]).join(",")} *)`;
  }

  const daysOfMonth = recurrence.daysOfMonth ?? [];
  if (daysOfMonth.length === 0) {
    throw new Error("Monthly scheduled reminders require at least one day_of_month.");
  }
  const normalizedDays = daysOfMonth.map((day) => {
    if (!Number.isInteger(day) || day < 1 || day > 31) {
      throw new Error("Monthly scheduled reminder days must be between 1 and 31.");
    }
    return day;
  });
  return `cron(${minute} ${hour} ${normalizedDays.join(",")} * ? *)`;
}

export function normalizeDailyReminderTime(value: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) {
    throw new Error("Reminder time must be in HH:mm format, for example 08:00.");
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error("Reminder time must be a valid local time between 00:00 and 23:59.");
  }

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function extractDailyCronTime(scheduleExpression: string | undefined): string | undefined {
  if (!scheduleExpression) {
    return undefined;
  }

  const match = /^cron\((\d{1,2}) (\d{1,2}) \* \* \? \*\)$/.exec(scheduleExpression.trim());
  if (!match) {
    return undefined;
  }

  return normalizeDailyReminderTime(`${match[2]}:${match[1].padStart(2, "0")}`);
}

export function buildScheduleName(prefix: string, workspaceId: string, taskId: string): string {
  const normalizedPrefix = normalizeScheduleNamePart(prefix) || "serverless-agent";
  const normalizedTaskId = normalizeScheduleNamePart(taskId) || "scheduled-reminder";
  const hash = createHash("sha256").update(`${workspaceId}:${taskId}`).digest("hex").slice(0, 10);
  const suffixBudget = 64 - normalizedPrefix.length - hash.length - 2;
  const suffix = normalizedTaskId.slice(0, Math.max(8, suffixBudget));
  return `${normalizedPrefix}-${suffix}-${hash}`.slice(0, 64);
}

function normalizeScheduleNamePart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: string }).name === "ResourceNotFoundException"
  );
}
