export interface WebConversation {
  conversationId: string;
  workspaceId: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  runtimeSessionId?: string;
  preview?: string;
}

export interface WebChatMessage {
  messageId: string;
  conversationId: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

export interface WebChatStore {
  listConversations(input: { workspaceId: string; userId: string; limit?: number }): Promise<WebConversation[]>;
  createConversation(input: { workspaceId: string; userId: string; now: Date }): Promise<WebConversation>;
  getConversation(input: {
    workspaceId: string;
    userId: string;
    conversationId: string;
  }): Promise<WebConversation | null>;
  updateConversation(input: {
    workspaceId: string;
    userId: string;
    conversationId: string;
    updatedAt: string;
    title?: string;
    preview?: string;
    runtimeSessionId?: string;
  }): Promise<void>;
  listMessages(input: { conversationId: string; limit?: number }): Promise<WebChatMessage[]>;
  appendMessage(input: {
    conversationId: string;
    role: "user" | "assistant";
    text: string;
    now: Date;
  }): Promise<WebChatMessage>;
}

export const WEB_CHAT_MODEL_HISTORY_LIMIT = 20;
export const WEB_CHAT_STORED_MESSAGE_LIMIT = 200;
export const WEB_CHAT_CONVERSATION_LIMIT = 50;
export const NEW_CHAT_TITLE = "New chat";
