import { randomUUID } from "node:crypto";
import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ConversationTurnRecord } from "../shared/contracts";
import { documentClient } from "./documentClient";

function buildSessionPk(workspaceId: string, channelId: string, conversationTs: string): string {
  return `WORKSPACE#${workspaceId}#CHANNEL#${channelId}#CONVERSATION#${conversationTs}`;
}

function buildTurnSk(turnTs: string, turnId: string): string {
  return `TURN#${turnTs}#${turnId}`;
}

function buildChannelScopeGsiPk(
  workspaceId: string,
  channelId: string,
  contextScope: ConversationTurnRecord["contextScope"],
): string {
  return `WORKSPACE#${workspaceId}#CHANNEL#${channelId}#SCOPE#${contextScope}`;
}

function buildChannelScopeGsiSk(turnTs: string, conversationTs: string, turnId: string): string {
  return `TURN#${turnTs}#CONVERSATION#${conversationTs}#TURN#${turnId}`;
}

export class ConversationTurnRepository {
  constructor(private readonly tableName: string) {}

  async save(
    turn: Omit<ConversationTurnRecord, "turnId" | "createdAt"> & {
      turnId?: string;
      createdAt?: string;
    },
  ): Promise<ConversationTurnRecord> {
    const now = turn.createdAt ?? new Date().toISOString();
    const record: ConversationTurnRecord = {
      ...turn,
      turnId: turn.turnId ?? `turn_${randomUUID()}`,
      createdAt: now,
    };

    await documentClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: buildSessionPk(record.workspaceId, record.channelId, record.conversationTs),
          sk: buildTurnSk(record.turnTs, record.turnId),
          gsi1pk:
            record.contextScope === "channel_top_level"
              ? buildChannelScopeGsiPk(record.workspaceId, record.channelId, record.contextScope)
              : undefined,
          gsi1sk:
            record.contextScope === "channel_top_level"
              ? buildChannelScopeGsiSk(record.turnTs, record.conversationTs, record.turnId)
              : undefined,
          turn_id: record.turnId,
          workspace_id: record.workspaceId,
          channel_id: record.channelId,
          conversation_ts: record.conversationTs,
          context_scope: record.contextScope,
          role: record.role,
          source: record.source,
          source_event: record.sourceEvent,
          thread_ts: record.threadTs,
          message_ts: record.messageTs,
          turn_ts: record.turnTs,
          user_id: record.userId,
          text: record.text,
          created_at: record.createdAt,
        },
      }),
    );

    return record;
  }

  async listByConversation(
    workspaceId: string,
    channelId: string,
    conversationTs: string,
  ): Promise<ConversationTurnRecord[]> {
    const response = await documentClient.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: {
          ":pk": buildSessionPk(workspaceId, channelId, conversationTs),
        },
        ScanIndexForward: true,
      }),
    );

    return (response.Items ?? []).map((item) => this.mapItem(item));
  }

  async listRecentChannelTopLevelTurns(
    workspaceId: string,
    channelId: string,
    limit: number,
  ): Promise<ConversationTurnRecord[]> {
    const boundedLimit = Math.min(Math.max(limit, 1), 50);
    const fetchLimit = Math.min(Math.max(boundedLimit * 5, boundedLimit), 50);
    const response = await documentClient.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "ChannelScopeIndex",
        KeyConditionExpression: "gsi1pk = :gsi1pk",
        ExpressionAttributeValues: {
          ":gsi1pk": buildChannelScopeGsiPk(workspaceId, channelId, "channel_top_level"),
        },
        ScanIndexForward: false,
        Limit: fetchLimit,
      }),
    );

    return (response.Items ?? [])
      .map((item) => this.mapItem(item))
      .sort(compareTurnsByCreatedAt)
      .slice(-boundedLimit);
  }

  private mapItem(item: Record<string, unknown>): ConversationTurnRecord {
    return {
      turnId: item.turn_id as string,
      workspaceId: item.workspace_id as string,
      channelId: item.channel_id as string,
      conversationTs: item.conversation_ts as string,
      contextScope: item.context_scope as ConversationTurnRecord["contextScope"],
      role: item.role as ConversationTurnRecord["role"],
      source: item.source as ConversationTurnRecord["source"],
      sourceEvent: item.source_event as ConversationTurnRecord["sourceEvent"],
      threadTs: item.thread_ts as string | undefined,
      messageTs: item.message_ts as string,
      turnTs: item.turn_ts as string,
      userId: item.user_id as string | undefined,
      text: item.text as string,
      createdAt: item.created_at as string,
    };
  }
}

function compareTurnsByCreatedAt(left: ConversationTurnRecord, right: ConversationTurnRecord): number {
  const createdCompare = left.createdAt.localeCompare(right.createdAt);
  if (createdCompare !== 0) {
    return createdCompare;
  }
  return left.turnTs.localeCompare(right.turnTs);
}
