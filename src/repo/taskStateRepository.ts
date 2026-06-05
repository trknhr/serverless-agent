import { randomUUID } from "node:crypto";
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { TaskState, TaskStatus } from "../tasks/taskState";
import { documentClient } from "./documentClient";

function buildWorkspacePk(workspaceId: string): string {
  return `WORKSPACE#${workspaceId}`;
}

function buildTaskSk(taskId: string): string {
  return `TASK#${taskId}`;
}

function buildStatusGsiPk(workspaceId: string, status: TaskStatus): string {
  return `WORKSPACE#${workspaceId}#STATUS#${status}`;
}

function buildStatusGsiSk(dueAt: string | undefined, updatedAt: string, taskId: string): string {
  return `DUE#${dueAt ?? "9999-12-31T23:59:59.999Z"}#UPDATED#${updatedAt}#TASK#${taskId}`;
}

export class TaskStateRepository {
  constructor(private readonly tableName: string) {}

  async get(workspaceId: string, taskId: string): Promise<TaskState | null> {
    const response = await documentClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          pk: buildWorkspacePk(workspaceId),
          sk: buildTaskSk(taskId),
        },
      }),
    );

    if (!response.Item) {
      return null;
    }

    return mapTaskState(response.Item);
  }

  async upsert(
    task: Omit<TaskState, "taskId" | "createdAt" | "updatedAt"> & { taskId?: string },
  ): Promise<TaskState> {
    const existing =
      task.taskId && task.workspaceId ? await this.get(task.workspaceId, task.taskId) : null;
    const now = new Date().toISOString();
    const record: TaskState = {
      ...existing,
      ...task,
      taskId: task.taskId ?? `task_${randomUUID()}`,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await documentClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: buildWorkspacePk(record.workspaceId),
          sk: buildTaskSk(record.taskId),
          gsi1pk: buildStatusGsiPk(record.workspaceId, record.status),
          gsi1sk: buildStatusGsiSk(record.dueAt, record.updatedAt, record.taskId),
          workspaceId: record.workspaceId,
          taskId: record.taskId,
          title: record.title,
          description: record.description,
          status: record.status,
          dueAt: record.dueAt,
          priority: record.priority,
          ownerUserId: record.ownerUserId,
          calendarEventId: record.calendarEventId,
          sourceType: record.sourceType,
          sourceRef: record.sourceRef,
          metadata: record.metadata,
          completedAt: record.completedAt,
          completedByUserId: record.completedByUserId,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        },
      }),
    );

    return record;
  }

  async list(input: {
    workspaceId: string;
    statuses?: TaskStatus[];
    limit?: number;
    dueBefore?: string;
    ownerUserId?: string;
  }): Promise<TaskState[]> {
    const statuses = input.statuses && input.statuses.length > 0 ? input.statuses : (["open", "in_progress"] as TaskStatus[]);
    const results: TaskState[] = [];

    for (const status of statuses) {
      const response = await documentClient.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: "StatusIndex",
          KeyConditionExpression: "gsi1pk = :gsi1pk",
          ExpressionAttributeValues: {
            ":gsi1pk": buildStatusGsiPk(input.workspaceId, status),
          },
          ScanIndexForward: true,
          Limit: 50,
        }),
      );

      for (const item of response.Items ?? []) {
        const task = mapTaskState(item);
        if (input.ownerUserId && task.ownerUserId && task.ownerUserId !== input.ownerUserId) {
          continue;
        }
        if (input.dueBefore && task.dueAt && task.dueAt > input.dueBefore) {
          continue;
        }
        results.push(task);
      }
    }

    return results
      .sort((a, b) => {
        const dueA = a.dueAt ?? "9999-12-31T23:59:59.999Z";
        const dueB = b.dueAt ?? "9999-12-31T23:59:59.999Z";
        return dueA.localeCompare(dueB) || b.updatedAt.localeCompare(a.updatedAt);
      })
      .slice(0, Math.min(Math.max(input.limit ?? 10, 1), 50));
  }

  async search(input: {
    workspaceId: string;
    query: string;
    statuses?: TaskStatus[];
    limit?: number;
    dueBefore?: string;
    ownerUserId?: string;
  }): Promise<TaskState[]> {
    const query = input.query.trim();
    if (!query) {
      return [];
    }

    const statuses =
      input.statuses && input.statuses.length > 0
        ? input.statuses
        : (["open", "in_progress", "done", "cancelled"] as TaskStatus[]);
    const candidates = await this.list({
      workspaceId: input.workspaceId,
      statuses,
      dueBefore: input.dueBefore,
      ownerUserId: input.ownerUserId,
      limit: 50,
    });
    const terms = normalizeSearchText(query).split(/\s+/).filter(Boolean);
    const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);

    return candidates
      .filter((task) => matchesTaskSearch(task, terms))
      .slice(0, limit);
  }

  async patch(input: {
    workspaceId: string;
    taskId: string;
    expectedUpdatedAt?: string;
    patch: Partial<Pick<
      TaskState,
      "title" | "description" | "status" | "dueAt" | "priority" | "calendarEventId" | "sourceType" | "sourceRef" | "metadata"
    >>;
  }): Promise<TaskState> {
    const existing = await this.get(input.workspaceId, input.taskId);
    if (!existing) {
      throw new Error(`Task ${input.taskId} was not found`);
    }
    if (input.expectedUpdatedAt && existing.updatedAt !== input.expectedUpdatedAt) {
      throw new Error(`Task ${input.taskId} changed since it was loaded`);
    }

    const now = new Date().toISOString();
    const record: TaskState = {
      ...existing,
      ...stripUndefined(input.patch),
      updatedAt: now,
    };

    await documentClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: buildWorkspacePk(record.workspaceId),
          sk: buildTaskSk(record.taskId),
          gsi1pk: buildStatusGsiPk(record.workspaceId, record.status),
          gsi1sk: buildStatusGsiSk(record.dueAt, record.updatedAt, record.taskId),
          workspaceId: record.workspaceId,
          taskId: record.taskId,
          title: record.title,
          description: record.description,
          status: record.status,
          dueAt: record.dueAt,
          priority: record.priority,
          ownerUserId: record.ownerUserId,
          calendarEventId: record.calendarEventId,
          sourceType: record.sourceType,
          sourceRef: record.sourceRef,
          metadata: record.metadata,
          completedAt: record.completedAt,
          completedByUserId: record.completedByUserId,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        },
      }),
    );

    return record;
  }

  async markDone(input: {
    workspaceId: string;
    taskId: string;
    completedByUserId?: string;
    completedAt?: string;
  }): Promise<TaskState> {
    const existing = await this.get(input.workspaceId, input.taskId);
    if (!existing) {
      throw new Error(`Task ${input.taskId} was not found`);
    }

    const completedAt = input.completedAt ?? new Date().toISOString();
    return this.upsert({
      ...existing,
      status: "done",
      completedAt,
      completedByUserId: input.completedByUserId,
      taskId: existing.taskId,
      workspaceId: existing.workspaceId,
    });
  }
}

function stripUndefined<T extends Record<string, unknown>>(record: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

function matchesTaskSearch(task: TaskState, terms: string[]): boolean {
  const haystack = normalizeSearchText(
    [
      task.taskId,
      task.title,
      task.description,
      task.sourceType,
      task.sourceRef,
      task.metadata ? JSON.stringify(task.metadata) : undefined,
    ]
      .filter(Boolean)
      .join(" "),
  );

  return terms.every((term) => haystack.includes(term));
}

function normalizeSearchText(value: string): string {
  return value.toLocaleLowerCase();
}

function mapTaskState(item: Record<string, unknown>): TaskState {
  return {
    workspaceId: item.workspaceId as string,
    taskId: item.taskId as string,
    title: item.title as string,
    description: item.description as string | undefined,
    status: item.status as TaskStatus,
    dueAt: item.dueAt as string | undefined,
    priority: item.priority as TaskState["priority"],
    ownerUserId: item.ownerUserId as string | undefined,
    calendarEventId: item.calendarEventId as string | undefined,
    sourceType: item.sourceType as string | undefined,
    sourceRef: item.sourceRef as string | undefined,
    metadata: item.metadata as Record<string, unknown> | undefined,
    completedAt: item.completedAt as string | undefined,
    completedByUserId: item.completedByUserId as string | undefined,
    createdAt: item.createdAt as string,
    updatedAt: item.updatedAt as string,
  };
}
