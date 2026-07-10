import { createHash, randomUUID } from "node:crypto";
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ChannelMemoryItem } from "../memory/channelMemoryItem";
import {
  decideExistingChannelMemoryUpsert,
  nextChannelMemoryUpdatedAt,
} from "../memory/channelMemoryUpsertPolicy";
import { documentClient } from "./documentClient";

function buildChannelPk(workspaceId: string, channelId: string): string {
  return `CHANNEL#${workspaceId}#${channelId}`;
}

function buildMemorySk(memoryId: string): string {
  return `MEMORY#${memoryId}`;
}

export class ChannelMemoryRepository {
  constructor(private readonly tableName: string) {}

  async save(
    item: Omit<ChannelMemoryItem, "memoryId" | "createdAt" | "updatedAt"> & { memoryId?: string },
  ): Promise<ChannelMemoryItem> {
    const now = new Date().toISOString();
    const record: ChannelMemoryItem = {
      ...item,
      memoryId: item.memoryId ?? `chanmem_${randomUUID()}`,
      createdAt: now,
      updatedAt: now,
    };

    await documentClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: buildChannelPk(record.workspaceId, record.channelId),
          sk: buildMemorySk(record.memoryId),
          workspaceId: record.workspaceId,
          channelId: record.channelId,
          memoryId: record.memoryId,
          dedupeKey: record.dedupeKey,
          text: record.text,
          entityKey: record.entityKey,
          searchText: buildSearchText(record.text, record.attributes, record.tags),
          attributes: record.attributes,
          tags: record.tags,
          importance: record.importance,
          status: record.status,
          origin: record.origin,
          sourceType: record.sourceType,
          sourceRef: record.sourceRef,
          createdByUserId: record.createdByUserId,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        },
      }),
    );

    return record;
  }

  async upsert(
    item: Omit<ChannelMemoryItem, "memoryId" | "createdAt" | "updatedAt"> & {
      memoryId?: string;
      expectedUpdatedAt?: string;
    },
  ): Promise<ChannelMemoryItem> {
    return this.upsertAttempt(item, 0);
  }

  private async upsertAttempt(
    item: Omit<ChannelMemoryItem, "memoryId" | "createdAt" | "updatedAt"> & {
      memoryId?: string;
      expectedUpdatedAt?: string;
    },
    attempt: number,
  ): Promise<ChannelMemoryItem> {
    const allItems = await this.listAll(item.workspaceId, item.channelId, true);
    const existing = resolveUpsertMatch(allItems, item);
    const { expectedUpdatedAt: _expectedUpdatedAt, ...incoming } = item;

    if (item.memoryId && !existing) {
      throw new Error(`Channel memory ${item.memoryId} was not found in the current channel`);
    }
    if (existing && ["archived", "rejected"].includes(existing.status)) {
      throw new Error(`Channel memory ${existing.memoryId} is ${existing.status} and cannot be reactivated`);
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const incomingDedupeKey = normalizeDedupeKey(item.dedupeKey);
    const conflictingDedupeMemory = incomingDedupeKey
      ? allItems.find(
          (candidate) =>
            normalizeDedupeKey(candidate.dedupeKey) === incomingDedupeKey &&
            candidate.memoryId !== existing?.memoryId &&
            (candidate.status === "active" || candidate.status === "candidate"),
        )
      : undefined;
    if (conflictingDedupeMemory) {
      throw new Error(
        `Channel memory dedupe key ${incomingDedupeKey} is already used by ${conflictingDedupeMemory.memoryId}`,
      );
    }
    if (
      existing?.dedupeKey &&
      incomingDedupeKey &&
      normalizeDedupeKey(existing.dedupeKey) !== incomingDedupeKey
    ) {
      throw new Error(`Channel memory ${existing.memoryId} dedupe key cannot be changed`);
    }

    const memoryId =
      existing?.memoryId ??
      item.memoryId ??
      buildDeterministicMemoryId(item.workspaceId, item.channelId, incomingDedupeKey, item.entityKey, item.text);
    if (!existing && allItems.some((candidate) => candidate.memoryId === memoryId)) {
      throw new Error(`Channel memory ID collision for ${memoryId}`);
    }

    const record: ChannelMemoryItem = {
      ...existing,
      ...incoming,
      memoryId,
      dedupeKey: incomingDedupeKey ?? existing?.dedupeKey,
      entityKey: item.entityKey ?? existing?.entityKey,
      attributes:
        existing?.attributes || item.attributes
          ? { ...(existing?.attributes ?? {}), ...(item.attributes ?? {}) }
          : undefined,
      tags: mergeTags(existing?.tags, item.tags),
      importance: item.importance ?? existing?.importance,
      status: mergeStatus(existing?.status, item.status, item.origin),
      origin: mergeOrigin(existing?.origin, item.origin),
      sourceType: existing?.sourceType ?? item.sourceType,
      sourceRef: existing?.sourceRef ?? item.sourceRef,
      createdByUserId: existing?.createdByUserId ?? item.createdByUserId,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nextChannelMemoryUpdatedAt(existing?.updatedAt, now),
    };

    if (
      existing &&
      decideExistingChannelMemoryUpsert({
        existing,
        next: record,
        incomingOrigin: item.origin,
        requestedMemoryId: item.memoryId,
        expectedUpdatedAt: item.expectedUpdatedAt,
      }) === "noop"
    ) {
      return existing;
    }

    try {
      await this.put(record, existing?.updatedAt);
    } catch (error) {
      if (!isConditionalCheckFailure(error)) {
        throw error;
      }
      if (attempt >= 1) {
        throw new Error(`Channel memory ${record.memoryId} changed while it was being saved`);
      }
      return this.upsertAttempt(item, attempt + 1);
    }
    return record;
  }

  async get(workspaceId: string, channelId: string, memoryId: string): Promise<ChannelMemoryItem | null> {
    const response = await documentClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          pk: buildChannelPk(workspaceId, channelId),
          sk: buildMemorySk(memoryId),
        },
        ConsistentRead: true,
      }),
    );

    if (!response.Item) {
      return null;
    }

    return mapChannelMemoryItem(response.Item);
  }

  async search(input: {
    workspaceId: string;
    channelId: string;
    query: string;
    entityKey?: string;
    limit?: number;
    statuses?: ChannelMemoryItem["status"][];
  }): Promise<ChannelMemoryItem[]> {
    const limit = Math.min(Math.max(input.limit ?? 8, 1), 20);
    const items = await this.listAll(input.workspaceId, input.channelId);

    const terms = normalize(input.query)
      .split(/\s+/)
      .filter(Boolean);
    const statuses = input.statuses ?? ["active"];

    return items
      .filter((item) => statuses.includes(item.status))
      .filter((item) => !input.entityKey || item.entityKey === input.entityKey)
      .filter((item) => matchesSearch(item.searchText ?? "", terms))
      .sort((a, b) => {
        const importanceDiff = (b.importance ?? 0) - (a.importance ?? 0);
        if (importanceDiff !== 0) {
          return importanceDiff;
        }
        return b.updatedAt.localeCompare(a.updatedAt);
      })
      .slice(0, limit)
      .map(({ searchText: _searchText, ...item }) => item);
  }

  private async listAll(
    workspaceId: string,
    channelId: string,
    consistentRead = false,
  ): Promise<Array<ChannelMemoryItem & { searchText?: string }>> {
    const items: Array<ChannelMemoryItem & { searchText?: string }> = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;

    do {
      const response = await documentClient.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: {
            ":pk": buildChannelPk(workspaceId, channelId),
          },
          ExclusiveStartKey: exclusiveStartKey,
          ConsistentRead: consistentRead,
          ScanIndexForward: false,
          Limit: 100,
        }),
      );
      items.push(...(response.Items ?? []).map(mapChannelMemoryItem));
      exclusiveStartKey = response.LastEvaluatedKey;
    } while (exclusiveStartKey);

    return items;
  }

  private async put(record: ChannelMemoryItem, expectedUpdatedAt?: string): Promise<void> {
    await documentClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: buildChannelPk(record.workspaceId, record.channelId),
          sk: buildMemorySk(record.memoryId),
          workspaceId: record.workspaceId,
          channelId: record.channelId,
          memoryId: record.memoryId,
          dedupeKey: record.dedupeKey,
          text: record.text,
          entityKey: record.entityKey,
          searchText: buildSearchText(record.text, record.attributes, record.tags),
          attributes: record.attributes,
          tags: record.tags,
          importance: record.importance,
          status: record.status,
          origin: record.origin,
          sourceType: record.sourceType,
          sourceRef: record.sourceRef,
          createdByUserId: record.createdByUserId,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        },
        ConditionExpression: expectedUpdatedAt
          ? "#updatedAt = :expectedUpdatedAt"
          : "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        ExpressionAttributeNames: expectedUpdatedAt ? { "#updatedAt": "updatedAt" } : undefined,
        ExpressionAttributeValues: expectedUpdatedAt
          ? { ":expectedUpdatedAt": expectedUpdatedAt }
          : undefined,
      }),
    );
  }
}

function mapChannelMemoryItem(item: Record<string, unknown>): ChannelMemoryItem & { searchText?: string } {
  return {
    workspaceId: item.workspaceId as string,
    channelId: item.channelId as string,
    memoryId: item.memoryId as string,
    dedupeKey: item.dedupeKey as string | undefined,
    text: item.text as string,
    entityKey: item.entityKey as string | undefined,
    attributes: item.attributes as Record<string, unknown> | undefined,
    tags: item.tags as string[] | undefined,
    importance: item.importance as number | undefined,
    status: item.status as ChannelMemoryItem["status"],
    origin: item.origin as ChannelMemoryItem["origin"],
    sourceType: item.sourceType as string | undefined,
    sourceRef: item.sourceRef as string | undefined,
    createdByUserId: item.createdByUserId as string | undefined,
    createdAt: item.createdAt as string,
    updatedAt: item.updatedAt as string,
    searchText: item.searchText as string | undefined,
  };
}

function resolveUpsertMatch(
  items: Array<ChannelMemoryItem & { searchText?: string }>,
  input: Omit<ChannelMemoryItem, "memoryId" | "createdAt" | "updatedAt"> & { memoryId?: string },
): ChannelMemoryItem | undefined {
  if (input.memoryId) {
    return items.find((item) => item.memoryId === input.memoryId);
  }

  const dedupeKey = normalizeDedupeKey(input.dedupeKey);
  const dedupeMatches = dedupeKey
    ? items.filter((item) => normalizeDedupeKey(item.dedupeKey) === dedupeKey)
    : [];
  const allMatches =
    dedupeMatches.length > 0
      ? dedupeMatches
      : items.filter(
          (item) =>
            normalizeComparable(item.entityKey ?? "") === normalizeComparable(input.entityKey ?? "") &&
            normalizeComparable(item.text) === normalizeComparable(input.text),
        );
  const liveMatches = allMatches.filter((item) => item.status === "active" || item.status === "candidate");
  const matches = liveMatches.length > 0 ? liveMatches : allMatches;

  if (matches.length > 1) {
    throw new Error(
      `Multiple channel memories match this fact: ${matches.map((item) => item.memoryId).join(", ")}`,
    );
  }
  return matches[0];
}

function buildDeterministicMemoryId(
  workspaceId: string,
  channelId: string,
  dedupeKey: string | undefined,
  entityKey: string | undefined,
  text: string,
): string {
  const identity = dedupeKey ?? `exact:${normalizeComparable(entityKey ?? "")}:${normalizeComparable(text)}`;
  const hash = createHash("sha256")
    .update(`${workspaceId}\0${channelId}\0${identity}`)
    .digest("hex")
    .slice(0, 32);
  return `chanmem_${hash}`;
}

function normalizeDedupeKey(value?: string): string | undefined {
  const normalized = value?.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, "-");
  return normalized || undefined;
}

function normalizeComparable(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

function mergeTags(existing?: string[], incoming?: string[]): string[] | undefined {
  const merged = [...new Set([...(existing ?? []), ...(incoming ?? [])])];
  return merged.length > 0 ? merged : undefined;
}

function mergeStatus(
  existing: ChannelMemoryItem["status"] | undefined,
  incoming: ChannelMemoryItem["status"],
  incomingOrigin: ChannelMemoryItem["origin"],
): ChannelMemoryItem["status"] {
  if (existing === "active") {
    return "active";
  }
  if (existing === "candidate" && incomingOrigin === "explicit") {
    return "active";
  }
  return incoming;
}

function mergeOrigin(
  existing: ChannelMemoryItem["origin"] | undefined,
  incoming: ChannelMemoryItem["origin"],
): ChannelMemoryItem["origin"] {
  if (existing === "explicit") {
    return "explicit";
  }
  return incoming;
}

function isConditionalCheckFailure(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "name" in error &&
      error.name === "ConditionalCheckFailedException",
  );
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function buildSearchText(
  text: string,
  attributes?: Record<string, unknown>,
  tags?: string[],
): string {
  return normalize(
    [text, JSON.stringify(attributes ?? {}), (tags ?? []).join(" ")]
      .filter(Boolean)
      .join(" "),
  );
}

function matchesSearch(searchText: string, terms: string[]): boolean {
  if (terms.length === 0) {
    return true;
  }

  return terms.every((term) => searchText.includes(term));
}
