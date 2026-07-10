import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { RecurringTask, recurringTaskSchema } from "../tasks/recurringTask";
import { documentClient } from "./documentClient";

function buildWorkspacePk(workspaceId: string): string {
  return `WORKSPACE#${workspaceId}`;
}

function buildRecurringTaskSk(recurringTaskId: string): string {
  return `RECURRING_TASK#${recurringTaskId}`;
}

export class RecurringTaskRepository {
  constructor(private readonly tableName: string) {}

  async get(workspaceId: string, recurringTaskId: string): Promise<RecurringTask | null> {
    const response = await documentClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          pk: buildWorkspacePk(workspaceId),
          sk: buildRecurringTaskSk(recurringTaskId),
        },
      }),
    );

    if (!response.Item) {
      return null;
    }

    return recurringTaskSchema.parse(response.Item);
  }

  async list(input: {
    workspaceId: string;
    enabled?: boolean;
    limit?: number;
  }): Promise<RecurringTask[]> {
    const response = await documentClient.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :skPrefix)",
        ExpressionAttributeValues: {
          ":pk": buildWorkspacePk(input.workspaceId),
          ":skPrefix": "RECURRING_TASK#",
        },
        ScanIndexForward: true,
        Limit: Math.min(Math.max(input.limit ?? 100, 1), 250),
      }),
    );

    return (response.Items ?? [])
      .map((item) => recurringTaskSchema.parse(item))
      .filter((task) => input.enabled === undefined || task.enabled === input.enabled);
  }

  async upsert(
    task: Omit<
      RecurringTask,
      "createdAt" | "updatedAt" | "dueTime" | "timezone" | "enabled" | "leadTimeDays"
    > &
      Partial<Pick<RecurringTask, "dueTime" | "timezone" | "enabled" | "leadTimeDays">>,
  ): Promise<RecurringTask> {
    const existing = await this.get(task.workspaceId, task.recurringTaskId);
    const now = new Date().toISOString();
    const record = recurringTaskSchema.parse({
      ...existing,
      ...task,
      recurrence: {
        ...existing?.recurrence,
        ...task.recurrence,
      },
      leadTimeDays: task.leadTimeDays ?? existing?.leadTimeDays ?? 0,
      dayOfTask: task.dayOfTask ?? existing?.dayOfTask,
      dueTime: task.dueTime ?? existing?.dueTime ?? "23:59",
      timezone: task.timezone ?? existing?.timezone ?? "Asia/Tokyo",
      enabled: task.enabled ?? existing?.enabled ?? true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });

    await documentClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: buildWorkspacePk(record.workspaceId),
          sk: buildRecurringTaskSk(record.recurringTaskId),
          recurringTaskId: record.recurringTaskId,
          workspaceId: record.workspaceId,
          title: record.title,
          description: record.description,
          recurrence: record.recurrence,
          leadTimeDays: record.leadTimeDays,
          dayOfTask: record.dayOfTask,
          dueTime: record.dueTime,
          timezone: record.timezone,
          enabled: record.enabled,
          ownerUserId: record.ownerUserId,
          priority: record.priority,
          sourceType: record.sourceType,
          sourceRef: record.sourceRef,
          metadata: record.metadata,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        },
      }),
    );

    return record;
  }

  async disable(workspaceId: string, recurringTaskId: string): Promise<RecurringTask> {
    const existing = await this.get(workspaceId, recurringTaskId);
    if (!existing) {
      throw new Error(`Recurring task ${recurringTaskId} was not found`);
    }

    return this.upsert({
      ...existing,
      enabled: false,
    });
  }
}
