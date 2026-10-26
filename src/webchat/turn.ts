import { AgentTurnEvent } from "../agentcore/runAgentTurn";
import { AgentRuntimeRequest, AgentRuntimeResources } from "../agentcore/contracts";
import { buildDirectChatContextBlocks } from "../conversations/buildDirectChatContextBlocks";
import { Logger } from "../shared/logger";
import {
  NEW_CHAT_TITLE,
  WEB_CHAT_MODEL_HISTORY_LIMIT,
  WEB_CHAT_STORED_MESSAGE_LIMIT,
  WebChatStore,
} from "./types";

export interface WebChatTurnInput {
  workspaceId: string;
  userId: string;
  conversationId: string;
  text: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  sessionId: string;
  traceId?: string;
  timeZone?: string;
  resources?: AgentRuntimeResources;
}

export interface WebChatAgent {
  run(input: WebChatTurnInput): AsyncIterable<AgentTurnEvent>;
}

export type WebChatServerEvent =
  | { event: "delta"; data: { text: string } }
  | { event: "status"; data: { text: string } }
  | { event: "message"; data: { text: string } }
  | { event: "metadata"; data: Record<string, unknown> }
  | { event: "error"; data: { message: string } };

export function buildWebChatAgentRequest(input: WebChatTurnInput, now = new Date()): AgentRuntimeRequest {
  return {
    content: buildDirectChatContextBlocks({
      currentText: input.text,
      receivedAt: now.toISOString(),
      timeZone: input.timeZone,
    }),
    history: input.history,
    context: {
      source: "web_chat",
      workspaceId: input.workspaceId,
      userId: input.userId,
      conversationTs: input.conversationId,
      traceId: input.traceId,
      turnId: input.traceId,
      correlationId: input.traceId,
    },
    resources: input.resources,
    toolContext: {
      workspaceId: input.workspaceId,
      userId: input.userId,
    },
  };
}

export async function* runWebChatTurn(input: {
  store: WebChatStore;
  agent: WebChatAgent;
  workspaceId: string;
  userId: string;
  conversationId: string;
  text: string;
  traceId?: string;
  timeZone?: string;
  resources?: AgentRuntimeResources;
  now?: () => Date;
  log?: Logger;
}): AsyncGenerator<WebChatServerEvent> {
  const now = input.now ?? (() => new Date());
  const conversation = await input.store.getConversation({
    workspaceId: input.workspaceId,
    userId: input.userId,
    conversationId: input.conversationId,
  });
  if (!conversation) {
    yield { event: "error", data: { message: "Conversation was not found." } };
    return;
  }

  const startedAt = now();
  const prior = await input.store.listMessages({
    conversationId: conversation.conversationId,
    limit: WEB_CHAT_STORED_MESSAGE_LIMIT,
  });
  const history = prior.slice(-WEB_CHAT_MODEL_HISTORY_LIMIT).map((message) => ({
    role: message.role,
    content: message.text,
  }));
  await input.store.appendMessage({
    conversationId: conversation.conversationId,
    role: "user",
    text: input.text,
    now: startedAt,
  });
  const title = conversation.title === NEW_CHAT_TITLE ? titleFromText(input.text) : conversation.title;
  await input.store.updateConversation({
    workspaceId: input.workspaceId,
    userId: input.userId,
    conversationId: conversation.conversationId,
    updatedAt: startedAt.toISOString(),
    title,
    preview: previewFromText(input.text),
    runtimeSessionId: conversation.runtimeSessionId ?? conversation.conversationId,
  });

  yield { event: "status", data: { text: "Starting" } };

  let assistantText = "";
  let runtimeSessionId = conversation.runtimeSessionId ?? conversation.conversationId;
  try {
    for await (const event of input.agent.run({
      workspaceId: input.workspaceId,
      userId: input.userId,
      conversationId: conversation.conversationId,
      text: input.text,
      history,
      sessionId: runtimeSessionId,
      traceId: input.traceId,
      timeZone: input.timeZone,
      resources: input.resources,
    })) {
      if (event.event === "delta") {
        assistantText += event.data.text;
        yield event;
        continue;
      }
      if (event.event === "message") {
        assistantText = event.data.text;
        yield event;
        continue;
      }
      if (event.event === "metadata") {
        const sessionId = event.data.runtimeSessionId;
        if (typeof sessionId === "string" && sessionId.length > 0) {
          runtimeSessionId = sessionId;
        }
        yield { event: "metadata", data: event.data };
        continue;
      }
      if (event.event === "status") {
        yield event;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "The assistant failed before finishing.";
    input.log?.error("Web chat turn failed", { error: message, conversationId: conversation.conversationId });
    yield { event: "error", data: { message } };
  } finally {
    let finishedAt = now();
    if (finishedAt.getTime() <= startedAt.getTime()) {
      finishedAt = new Date(startedAt.getTime() + 1);
    }
    if (assistantText.trim()) {
      await input.store.appendMessage({
        conversationId: conversation.conversationId,
        role: "assistant",
        text: assistantText,
        now: finishedAt,
      });
    }
    await input.store.updateConversation({
      workspaceId: input.workspaceId,
      userId: input.userId,
      conversationId: conversation.conversationId,
      updatedAt: finishedAt.toISOString(),
      title,
      preview: previewFromText(assistantText || input.text),
      runtimeSessionId,
    });
  }
}

export function titleFromText(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return NEW_CHAT_TITLE;
  }
  return collapsed.length > 60 ? `${collapsed.slice(0, 57)}...` : collapsed;
}

function previewFromText(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 80 ? `${collapsed.slice(0, 77)}...` : collapsed;
}
