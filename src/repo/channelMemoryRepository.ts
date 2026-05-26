import { randomUUID } from "node:crypto";
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ChannelMemoryItem } from "../memory/channelMemoryItem";
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

  async get(workspaceId: string, channelId: string, memoryId: string): Promise<ChannelMemoryItem | null> {
    const response = await documentClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          pk: buildChannelPk(workspaceId, channelId),
          sk: buildMemorySk(memoryId),
        },
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
    const response = await documentClient.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: {
          ":pk": buildChannelPk(input.workspaceId, input.channelId),
        },
        ScanIndexForward: false,
        Limit: 100,
      }),
    );

    const terms = normalize(input.query)
      .split(/\s+/)
      .filter(Boolean);
    const statuses = input.statuses ?? ["active"];

    return (response.Items ?? [])
      .map(mapChannelMemoryItem)
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
}

function mapChannelMemoryItem(item: Record<string, unknown>): ChannelMemoryItem & { searchText?: string } {
  return {
    workspaceId: item.workspaceId as string,
    channelId: item.channelId as string,
    memoryId: item.memoryId as string,
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
