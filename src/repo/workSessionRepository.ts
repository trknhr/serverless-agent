import { randomUUID } from "node:crypto";
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  WorkSessionKind,
  WorkSessionRecord,
  WorkSessionStatus,
} from "../shared/contracts";
import { documentClient } from "./documentClient";

function buildOwnerPk(workspaceId: string, ownerUserId: string): string {
  return `WORKSPACE#${workspaceId}#OWNER#${ownerUserId}`;
}

function buildWorkSessionSk(kind: WorkSessionKind, workSessionId: string): string {
  return `KIND#${kind}#WORK_SESSION#${workSessionId}`;
}

function buildKindSkPrefix(kind: WorkSessionKind): string {
  return `KIND#${kind}#`;
}

export interface CreateWorkSessionInput {
  workspaceId: string;
  ownerUserId: string;
  kind: WorkSessionKind;
  maxLifetimeSeconds: number;
  now?: Date;
  workSessionId?: string;
  runtimeSessionId?: string;
}

export interface ListActiveWorkSessionsInput {
  workspaceId: string;
  ownerUserId: string;
  kind?: WorkSessionKind;
  now?: Date;
  limit?: number;
}

export interface WorkSessionLifecycleInput {
  workspaceId: string;
  ownerUserId: string;
  kind: WorkSessionKind;
  now?: Date;
}

export class WorkSessionRepository {
  constructor(private readonly tableName: string) {}

  async get(input: {
    workspaceId: string;
    ownerUserId: string;
    kind: WorkSessionKind;
    workSessionId: string;
  }): Promise<WorkSessionRecord | null> {
    const response = await documentClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          pk: buildOwnerPk(input.workspaceId, input.ownerUserId),
          sk: buildWorkSessionSk(input.kind, input.workSessionId),
        },
      }),
    );

    return response.Item ? mapWorkSession(response.Item) : null;
  }

  async create(input: CreateWorkSessionInput): Promise<WorkSessionRecord> {
    const now = input.now ?? new Date();
    const expiresAt = addSeconds(now, input.maxLifetimeSeconds);
    const record: WorkSessionRecord = {
      workspaceId: input.workspaceId,
      ownerUserId: input.ownerUserId,
      workSessionId: input.workSessionId ?? randomUUID(),
      runtimeSessionId: input.runtimeSessionId ?? randomUUID(),
      kind: input.kind,
      status: "active",
      createdAt: now.toISOString(),
      lastUsedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      ttl: toEpochSeconds(expiresAt),
    };

    await this.save(record);
    return record;
  }

  async save(record: WorkSessionRecord): Promise<void> {
    await documentClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: buildOwnerPk(record.workspaceId, record.ownerUserId),
          sk: buildWorkSessionSk(record.kind, record.workSessionId),
          workspaceId: record.workspaceId,
          ownerUserId: record.ownerUserId,
          workSessionId: record.workSessionId,
          runtimeSessionId: record.runtimeSessionId,
          kind: record.kind,
          status: record.status,
          createdAt: record.createdAt,
          lastUsedAt: record.lastUsedAt,
          expiresAt: record.expiresAt,
          ttl: record.ttl,
        },
      }),
    );
  }

  async listActiveByOwner(input: ListActiveWorkSessionsInput): Promise<WorkSessionRecord[]> {
    const now = input.now ?? new Date();
    const expressionAttributeValues: Record<string, unknown> = {
      ":pk": buildOwnerPk(input.workspaceId, input.ownerUserId),
      ":active": "active",
      ":now": now.toISOString(),
    };
    let keyConditionExpression = "pk = :pk";

    if (input.kind) {
      keyConditionExpression += " AND begins_with(sk, :skPrefix)";
      expressionAttributeValues[":skPrefix"] = buildKindSkPrefix(input.kind);
    }

    const response = await documentClient.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: keyConditionExpression,
        FilterExpression: "#status = :active AND expiresAt > :now",
        ExpressionAttributeNames: {
          "#status": "status",
        },
        ExpressionAttributeValues: expressionAttributeValues,
        Limit: Math.min(Math.max(input.limit ?? 100, 1), 250),
      }),
    );

    return (response.Items ?? [])
      .map(mapWorkSession)
      .filter((record) => record.status === "active" && !hasExpired(record, now))
      .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  }

  async markCompleted(input: WorkSessionLifecycleInput & { workSessionId: string }): Promise<void> {
    await this.markStatus(input, "completed");
  }

  async markExpired(input: WorkSessionLifecycleInput & { workSessionId: string }): Promise<void> {
    await this.markStatus(input, "expired");
  }

  async expireIdleSessions(input: WorkSessionLifecycleInput & { idleTimeoutSeconds: number }): Promise<WorkSessionRecord[]> {
    const now = input.now ?? new Date();
    const activeSessions = await this.listActiveByOwner({
      workspaceId: input.workspaceId,
      ownerUserId: input.ownerUserId,
      kind: input.kind,
      now,
    });
    const idleSessions = activeSessions.filter((record) => isIdle(record, now, input.idleTimeoutSeconds));

    for (const record of idleSessions) {
      await this.markExpired({
        workspaceId: record.workspaceId,
        ownerUserId: record.ownerUserId,
        kind: record.kind,
        workSessionId: record.workSessionId,
        now,
      });
    }

    return idleSessions;
  }

  async enforceActiveLimit(input: WorkSessionLifecycleInput & { maxActiveSessions: number }): Promise<WorkSessionRecord[]> {
    const now = input.now ?? new Date();
    const activeSessions = await this.listActiveByOwner({
      workspaceId: input.workspaceId,
      ownerUserId: input.ownerUserId,
      kind: input.kind,
      now,
    });
    const expiredSessions = activeSessions.slice(Math.max(input.maxActiveSessions, 0));

    for (const record of expiredSessions) {
      await this.markExpired({
        workspaceId: record.workspaceId,
        ownerUserId: record.ownerUserId,
        kind: record.kind,
        workSessionId: record.workSessionId,
        now,
      });
    }

    return expiredSessions;
  }

  private async markStatus(
    input: WorkSessionLifecycleInput & { workSessionId: string },
    status: WorkSessionStatus,
  ): Promise<void> {
    const now = input.now ?? new Date();
    await documentClient.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: {
          pk: buildOwnerPk(input.workspaceId, input.ownerUserId),
          sk: buildWorkSessionSk(input.kind, input.workSessionId),
        },
        UpdateExpression: "SET #status = :status, lastUsedAt = :lastUsedAt",
        ConditionExpression: "attribute_exists(pk) AND attribute_exists(sk)",
        ExpressionAttributeNames: {
          "#status": "status",
        },
        ExpressionAttributeValues: {
          ":status": status,
          ":lastUsedAt": now.toISOString(),
        },
      }),
    );
  }
}

function mapWorkSession(item: Record<string, unknown>): WorkSessionRecord {
  return {
    workspaceId: item.workspaceId as string,
    ownerUserId: item.ownerUserId as string,
    workSessionId: item.workSessionId as string,
    runtimeSessionId: item.runtimeSessionId as string,
    kind: item.kind as WorkSessionKind,
    status: item.status as WorkSessionStatus,
    createdAt: item.createdAt as string,
    lastUsedAt: item.lastUsedAt as string,
    expiresAt: item.expiresAt as string,
    ttl: item.ttl as number,
  };
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

function toEpochSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

function hasExpired(record: WorkSessionRecord, now: Date): boolean {
  return Date.parse(record.expiresAt) <= now.getTime();
}

function isIdle(record: WorkSessionRecord, now: Date, idleTimeoutSeconds: number): boolean {
  return Date.parse(record.lastUsedAt) + idleTimeoutSeconds * 1000 <= now.getTime();
}
