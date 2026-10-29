import { randomUUID } from "node:crypto";
import { FileStateStore } from "../local/fileStateStore";
import {
  NEW_CHAT_TITLE,
  WEB_CHAT_CONVERSATION_LIMIT,
  WEB_CHAT_STORED_MESSAGE_LIMIT,
  WebChatMessage,
  WebChatStore,
  WebConversation,
} from "./types";

export class FileWebChatStore implements WebChatStore {
  constructor(private readonly state: FileStateStore) {}

  async listConversations(input: {
    workspaceId: string;
    userId: string;
    limit?: number;
  }): Promise<WebConversation[]> {
    const limit = input.limit ?? WEB_CHAT_CONVERSATION_LIMIT;
    const state = await this.state.load();
    return state.webConversations
      .filter((conversation) => conversation.workspaceId === input.workspaceId && conversation.userId === input.userId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit);
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
    };
    await this.state.update((state) => {
      state.webConversations.push(conversation);
    });
    return conversation;
  }

  async getConversation(input: {
    workspaceId: string;
    userId: string;
    conversationId: string;
  }): Promise<WebConversation | null> {
    const state = await this.state.load();
    return (
      state.webConversations.find(
        (conversation) =>
          conversation.conversationId === input.conversationId &&
          conversation.workspaceId === input.workspaceId &&
          conversation.userId === input.userId,
      ) ?? null
    );
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
    await this.state.update((state) => {
      const conversation = state.webConversations.find(
        (item) =>
          item.conversationId === input.conversationId &&
          item.workspaceId === input.workspaceId &&
          item.userId === input.userId,
      );
      if (!conversation) {
        throw new Error(`Web conversation was not found: ${input.conversationId}`);
      }
      conversation.updatedAt = input.updatedAt;
      if (input.title !== undefined) {
        conversation.title = input.title;
      }
      if (input.preview !== undefined) {
        conversation.preview = input.preview;
      }
      if (input.runtimeSessionId !== undefined) {
        conversation.runtimeSessionId = input.runtimeSessionId;
      }
    });
  }

  async listMessages(input: { conversationId: string; limit?: number }): Promise<WebChatMessage[]> {
    const limit = input.limit ?? WEB_CHAT_STORED_MESSAGE_LIMIT;
    const state = await this.state.load();
    const messages = state.webMessages
      .filter((message) => message.conversationId === input.conversationId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.messageId.localeCompare(right.messageId));
    return messages.slice(-limit);
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
    await this.state.update((state) => {
      state.webMessages.push(message);
    });
    return message;
  }
}
