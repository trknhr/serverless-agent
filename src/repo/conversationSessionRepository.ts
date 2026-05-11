import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ConversationSessionRecord } from "../shared/contracts";
import { documentClient } from "./documentClient";

function buildPk(workspaceId: string, channelId: string): string {
  return `WORKSPACE#${workspaceId}#CHANNEL#${channelId}`;
}

function buildSk(conversationTs: string): string {
  return `CONVERSATION#${conversationTs}`;
}

export class ConversationSessionRepository {
  constructor(private readonly tableName: string) {}

  async findByConversation(
    workspaceId: string,
    channelId: string,
    conversationTs: string,
  ): Promise<ConversationSessionRecord | null> {
    const response = await documentClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          pk: buildPk(workspaceId, channelId),
          sk: buildSk(conversationTs),
        },
      }),
    );

    if (!response.Item) {
      return null;
    }

    return {
      workspaceId,
      channelId,
      conversationTs,
      agentRuntimeSessionId: response.Item.agent_runtime_session_id,
      memoryStoreId: response.Item.memory_store_id,
      createdAt: response.Item.created_at,
      lastUsedAt: response.Item.last_used_at,
    };
  }

  async save(record: ConversationSessionRecord): Promise<void> {
    await documentClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: buildPk(record.workspaceId, record.channelId),
          sk: buildSk(record.conversationTs),
          agent_runtime_session_id: record.agentRuntimeSessionId,
          memory_store_id: record.memoryStoreId,
          created_at: record.createdAt,
          last_used_at: record.lastUsedAt,
        },
      }),
    );
  }
}
