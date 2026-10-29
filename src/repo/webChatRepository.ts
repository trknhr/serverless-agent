import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import {
  NEW_CHAT_TITLE,
  WEB_CHAT_CONVERSATION_LIMIT,
  WEB_CHAT_STORED_MESSAGE_LIMIT,
  WebChatMessage,
  WebChatStore,
  WebConversation,
} from "../webchat/types";
import { documentClient } from "./documentClient";

export class WebChatRepository implements WebChatStore {
  constructor(
    private readonly conversationsTableName: string,
    private readonly messagesTableName: string,
  ) {}

  async listConversations(input: {
    workspaceId: string;
    userId: string;
    limit?: number;
  }): Promise<WebConversation[]> {
    const limit = bound(input.limit, WEB_CHAT_CONVERSATION_LIMIT);
    const response = await documentClient.send(
      new QueryCommand({
        TableName: this.conversationsTableName,
        IndexName: "UpdatedIndex",
        KeyConditionExpression: "ownerKey = :ownerKey",
        ExpressionAttributeValues: {
          ":ownerKey": ownerKey(input.workspaceId, input.userId),
        },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return (response.Items ?? []).map(mapConversation);
  }

  async createConversation(input: { workspaceId: string; userId: string; now: Date }): Promise<WebConversation> {
    const now = input.now.toISOString();
    const conversation: WebConversation = {
      conversationId: `conv_${randomUUID()}`,
      workspaceId: input.workspaceId,
      userId: input.userId,
      title: NEW_CHAT_TITLE,
      createdAt: now,
      updatedAt: now,
      runtimeSessionId: undefined,
    };
    await documentClient.send(
      new PutCommand({
        TableName: this.conversationsTableName,
        Item: toConversationItem(conversation),
      }),
    );
    return conversation;
  }

  async getConversation(input: {
    workspaceId: string;
    userId: string;
    conversationId: string;
  }): Promise<WebConversation | null> {
    const response = await documentClient.send(
      new GetCommand({
        TableName: this.conversationsTableName,
        Key: {
          pk: ownerKey(input.workspaceId, input.userId),
          sk: input.conversationId,
        },
      }),
    );
    if (!response.Item) {
      return null;
    }
    const conversation = mapConversation(response.Item);
    if (conversation.workspaceId !== input.workspaceId || conversation.userId !== input.userId) {
      return null;
    }
    return conversation;
  }

  async updateConversation(input: {
    workspaceId: string;
    userId: string;
    conversationId: string;
    updatedAt: string;
    title?: string;
    preview?: string;
    runtimeSessionId?: string;
  }): Promise<void> {
    const names: Record<string, string> = { "#updatedAt": "updatedAt" };
    const values: Record<string, string> = { ":updatedAt": input.updatedAt };
    const sets = ["#updatedAt = :updatedAt"];
    if (input.title !== undefined) {
      names["#title"] = "title";
      values[":title"] = input.title;
      sets.push("#title = :title");
    }
    if (input.preview !== undefined) {
      names["#preview"] = "preview";
      values[":preview"] = input.preview;
      sets.push("#preview = :preview");
    }
    if (input.runtimeSessionId !== undefined) {
      names["#runtimeSessionId"] = "runtimeSessionId";
      values[":runtimeSessionId"] = input.runtimeSessionId;
      sets.push("#runtimeSessionId = :runtimeSessionId");
    }
    await documentClient.send(
      new UpdateCommand({
        TableName: this.conversationsTableName,
        Key: {
          pk: ownerKey(input.workspaceId, input.userId),
          sk: input.conversationId,
        },
        ConditionExpression: "attribute_exists(pk)",
        UpdateExpression: `SET ${sets.join(", ")}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
  }

  async listMessages(input: { conversationId: string; limit?: number }): Promise<WebChatMessage[]> {
    const limit = bound(input.limit, WEB_CHAT_STORED_MESSAGE_LIMIT);
    const response = await documentClient.send(
      new QueryCommand({
        TableName: this.messagesTableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: {
          ":pk": input.conversationId,
        },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return (response.Items ?? []).map(mapMessage).reverse();
  }

  async appendMessage(input: {
    conversationId: string;
    role: "user" | "assistant";
    text: string;
    now: Date;
  }): Promise<WebChatMessage> {
    const message: WebChatMessage = {
      messageId: `msg_${randomUUID()}`,
      conversationId: input.conversationId,
      role: input.role,
      text: input.text,
      createdAt: input.now.toISOString(),
    };
    await documentClient.send(
      new PutCommand({
        TableName: this.messagesTableName,
        Item: {
          pk: message.conversationId,
          sk: `${message.createdAt}#${message.messageId}`,
          messageId: message.messageId,
          conversationId: message.conversationId,
          role: message.role,
          text: message.text,
          createdAt: message.createdAt,
        },
      }),
    );
    return message;
  }
}

function ownerKey(workspaceId: string, userId: string): string {
  return `OWNER#${workspaceId}#${userId}`;
}

function toConversationItem(conversation: WebConversation): Record<string, string> {
  return {
    pk: ownerKey(conversation.workspaceId, conversation.userId),
    sk: conversation.conversationId,
    ownerKey: ownerKey(conversation.workspaceId, conversation.userId),
    conversationId: conversation.conversationId,
    workspaceId: conversation.workspaceId,
    userId: conversation.userId,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}

function mapConversation(item: Record<string, unknown>): WebConversation {
  return {
    conversationId: String(item.conversationId),
    workspaceId: String(item.workspaceId),
    userId: String(item.userId),
    title: String(item.title ?? NEW_CHAT_TITLE),
    createdAt: String(item.createdAt),
    updatedAt: String(item.updatedAt),
    runtimeSessionId: typeof item.runtimeSessionId === "string" ? item.runtimeSessionId : undefined,
    preview: typeof item.preview === "string" ? item.preview : undefined,
  };
}

function mapMessage(item: Record<string, unknown>): WebChatMessage {
  const role = item.role === "assistant" ? "assistant" : "user";
  return {
    messageId: String(item.messageId),
    conversationId: String(item.conversationId),
    role,
    text: String(item.text ?? ""),
    createdAt: String(item.createdAt),
  };
}

function bound(value: number | undefined, fallback: number): number {
  if (!value || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(value), 1), fallback);
}
