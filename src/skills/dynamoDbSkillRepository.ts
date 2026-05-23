import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient } from "../repo/documentClient";
import {
  BuiltinSkillOverride,
  GeneratedSkillRecord,
  SkillConstraints,
  SkillStatus,
  skillConstraintsSchema,
  skillStatusSchema,
} from "./types";

const GENERATED_SKILL_PREFIX = "SKILL#";
const BUILTIN_OVERRIDE_PREFIX = "BUILTIN_SKILL#";

function buildWorkspacePk(workspaceId: string): string {
  return `WORKSPACE#${workspaceId}`;
}

function buildGeneratedSkillSk(skillId: string): string {
  return `${GENERATED_SKILL_PREFIX}${skillId}`;
}

function buildBuiltinOverrideSk(skillId: string): string {
  return `${BUILTIN_OVERRIDE_PREFIX}${skillId}`;
}

export class DynamoDbSkillRepository {
  constructor(private readonly tableName: string) {}

  async listGeneratedSkills(workspaceId: string): Promise<GeneratedSkillRecord[]> {
    const response = await documentClient.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
        ExpressionAttributeValues: {
          ":pk": buildWorkspacePk(workspaceId),
          ":sk": GENERATED_SKILL_PREFIX,
        },
      }),
    );

    return (response.Items ?? []).map(mapGeneratedSkill);
  }

  async getGeneratedSkill(workspaceId: string, skillId: string): Promise<GeneratedSkillRecord | null> {
    const response = await documentClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          pk: buildWorkspacePk(workspaceId),
          sk: buildGeneratedSkillSk(skillId),
        },
      }),
    );

    return response.Item ? mapGeneratedSkill(response.Item) : null;
  }

  async putGeneratedSkill(
    record: Omit<GeneratedSkillRecord, "createdAt" | "updatedAt"> & {
      createdAt?: string;
      updatedAt?: string;
    },
  ): Promise<GeneratedSkillRecord> {
    const now = new Date().toISOString();
    const item: GeneratedSkillRecord = {
      ...record,
      createdAt: record.createdAt ?? now,
      updatedAt: record.updatedAt ?? now,
    };

    await documentClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: buildWorkspacePk(item.workspaceId),
          sk: buildGeneratedSkillSk(item.skillId),
          kind: "generated",
          workspaceId: item.workspaceId,
          skillId: item.skillId,
          status: item.status,
          version: item.version,
          title: item.title,
          description: item.description,
          triggerHints: item.triggerHints,
          toolAllowlist: item.toolAllowlist,
          constraints: item.constraints,
          body: item.body,
          createdFromConversationId: item.createdFromConversationId,
          createdByUserId: item.createdByUserId,
          approvedByUserId: item.approvedByUserId,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        },
      }),
    );

    return item;
  }

  async listBuiltinSkillOverrides(workspaceId: string): Promise<BuiltinSkillOverride[]> {
    const response = await documentClient.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
        ExpressionAttributeValues: {
          ":pk": buildWorkspacePk(workspaceId),
          ":sk": BUILTIN_OVERRIDE_PREFIX,
        },
      }),
    );

    return (response.Items ?? []).map(mapBuiltinOverride);
  }

  async getBuiltinSkillOverride(workspaceId: string, skillId: string): Promise<BuiltinSkillOverride | null> {
    const response = await documentClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          pk: buildWorkspacePk(workspaceId),
          sk: buildBuiltinOverrideSk(skillId),
        },
      }),
    );

    return response.Item ? mapBuiltinOverride(response.Item) : null;
  }

  async putBuiltinSkillOverride(
    record: Omit<BuiltinSkillOverride, "updatedAt"> & { updatedAt?: string },
  ): Promise<BuiltinSkillOverride> {
    const item: BuiltinSkillOverride = {
      ...record,
      updatedAt: record.updatedAt ?? new Date().toISOString(),
    };

    await documentClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: buildWorkspacePk(item.workspaceId),
          sk: buildBuiltinOverrideSk(item.skillId),
          kind: "builtin_override",
          workspaceId: item.workspaceId,
          skillId: item.skillId,
          enabled: item.enabled,
          version: item.version,
          config: item.config,
          updatedAt: item.updatedAt,
        },
      }),
    );

    return item;
  }
}

function mapGeneratedSkill(item: Record<string, unknown>): GeneratedSkillRecord {
  return {
    workspaceId: requireString(item.workspaceId, "workspaceId"),
    skillId: requireString(item.skillId, "skillId"),
    status: parseStatus(item.status),
    version: requireString(item.version, "version"),
    title: requireString(item.title, "title"),
    description: requireString(item.description, "description"),
    triggerHints: parseStringArray(item.triggerHints),
    toolAllowlist: parseStringArray(item.toolAllowlist),
    constraints: parseConstraints(item.constraints),
    body: requireString(item.body, "body"),
    createdFromConversationId: optionalString(item.createdFromConversationId),
    createdByUserId: optionalString(item.createdByUserId),
    approvedByUserId: optionalString(item.approvedByUserId),
    createdAt: requireString(item.createdAt, "createdAt"),
    updatedAt: requireString(item.updatedAt, "updatedAt"),
  };
}

function mapBuiltinOverride(item: Record<string, unknown>): BuiltinSkillOverride {
  return {
    workspaceId: requireString(item.workspaceId, "workspaceId"),
    skillId: requireString(item.skillId, "skillId"),
    enabled: item.enabled === true,
    version: optionalString(item.version),
    config: parseRecord(item.config),
    updatedAt: requireString(item.updatedAt, "updatedAt"),
  };
}

function parseStatus(value: unknown): SkillStatus {
  return skillStatusSchema.parse(value);
}

function parseConstraints(value: unknown): SkillConstraints {
  return skillConstraintsSchema.parse(parseRecord(value) ?? {});
}

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Skill record is missing ${field}.`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
