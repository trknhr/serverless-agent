import { z, ZodError } from "zod";
import { AgentRuntimeResources } from "../agentcore/contracts";
import { Logger } from "../shared/logger";
import { bearerMatches } from "./access";
import { formatSse } from "./sse";
import { WebChatAgent, WebChatServerEvent, runWebChatTurn } from "./turn";
import { WebChatStore } from "./types";

const ownerSchema = z.object({
  workspaceId: z.string().min(1).max(200),
  userId: z.string().min(1).max(200),
});

export interface WebChatHttpRequest {
  method: string;
  path: string;
  query: Record<string, string | undefined>;
  headers: Record<string, string | undefined>;
  body: unknown;
}

export interface WebChatHttpDeps {
  store: WebChatStore;
  agent: WebChatAgent;
  accessKey?: string;
  allowUnauthenticated?: boolean;
  authenticatedOwner?: { workspaceId: string; userId: string };
  timeZone?: string;
  resources?: AgentRuntimeResources;
  log?: Logger;
  now?: () => Date;
}

export type WebChatHttpResult =
  | { kind: "json"; status: number; body: unknown }
  | { kind: "sse"; events: AsyncGenerator<WebChatServerEvent> };

export async function routeWebChat(request: WebChatHttpRequest, deps: WebChatHttpDeps): Promise<WebChatHttpResult> {
  try {
    return await routeWebChatUnsafe(request, deps);
  } catch (error) {
    if (error instanceof ZodError) {
      return { kind: "json", status: 400, body: { ok: false, error: "bad_request", message: error.message } };
    }
    throw error;
  }
}

async function routeWebChatUnsafe(request: WebChatHttpRequest, deps: WebChatHttpDeps): Promise<WebChatHttpResult> {
  const method = request.method.toUpperCase();
  if (method === "OPTIONS") {
    return { kind: "json", status: 204, body: {} };
  }

  const auth = authorize(request.headers, deps);
  if (auth) {
    return auth;
  }

  const messagesMatch = request.path.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  if (messagesMatch && method === "GET") {
    return getMessages(messagesMatch[1] ?? "", request, deps);
  }
  if (messagesMatch && method === "POST") {
    return postMessage(messagesMatch[1] ?? "", request, deps);
  }
  if (request.path === "/api/conversations" && method === "GET") {
    return listConversations(request, deps);
  }
  if (request.path === "/api/conversations" && method === "POST") {
    return createConversation(request, deps);
  }
  return { kind: "json", status: 404, body: { ok: false, error: "not_found" } };
}

export async function collectWebChatEvents(events: AsyncIterable<WebChatServerEvent>): Promise<string> {
  let body = "";
  for await (const event of events) {
    body += formatSse(event.event, event.data);
  }
  return body;
}

function authorize(headers: Record<string, string | undefined>, deps: WebChatHttpDeps): WebChatHttpResult | undefined {
  if (deps.authenticatedOwner) {
    return undefined;
  }
  const header = headerValue(headers, "authorization");
  if (!deps.accessKey) {
    if (deps.allowUnauthenticated) {
      return undefined;
    }
    return {
      kind: "json",
      status: 503,
      body: {
        ok: false,
        error: "not_configured",
        message: "Web chat access key is not configured.",
      },
    };
  }
  if (!bearerMatches(header, deps.accessKey)) {
    return {
      kind: "json",
      status: 401,
      body: {
        ok: false,
        error: "unauthorized",
        message: "Provide Authorization: Bearer <web chat access key>.",
      },
    };
  }
  return undefined;
}

async function listConversations(request: WebChatHttpRequest, deps: WebChatHttpDeps): Promise<WebChatHttpResult> {
  const owner = resolveOwner(deps, {
    workspaceId: request.query.workspaceId,
    userId: request.query.userId,
  });
  const conversations = await deps.store.listConversations(owner);
  return { kind: "json", status: 200, body: { ok: true, conversations } };
}

async function createConversation(request: WebChatHttpRequest, deps: WebChatHttpDeps): Promise<WebChatHttpResult> {
  const owner = resolveOwner(deps, request.body ?? {});
  const conversation = await deps.store.createConversation({
    ...owner,
    now: (deps.now ?? (() => new Date()))(),
  });
  return { kind: "json", status: 201, body: { ok: true, conversation } };
}

async function getMessages(
  conversationId: string,
  request: WebChatHttpRequest,
  deps: WebChatHttpDeps,
): Promise<WebChatHttpResult> {
  const owner = resolveOwner(deps, {
    workspaceId: request.query.workspaceId,
    userId: request.query.userId,
  });
  const conversation = await deps.store.getConversation({ ...owner, conversationId });
  if (!conversation) {
    return { kind: "json", status: 404, body: { ok: false, error: "not_found" } };
  }
  const messages = await deps.store.listMessages({ conversationId });
  return { kind: "json", status: 200, body: { ok: true, conversation, messages } };
}

async function postMessage(
  conversationId: string,
  request: WebChatHttpRequest,
  deps: WebChatHttpDeps,
): Promise<WebChatHttpResult> {
  const body = z.object({ text: z.string().trim().min(1).max(20_000) }).passthrough().parse(request.body ?? {});
  const owner = resolveOwner(deps, request.body ?? {});
  const traceId = headerValue(request.headers, "x-request-id") ?? `web_${Date.now()}`;
  return {
    kind: "sse",
    events: runWebChatTurn({
      store: deps.store,
      agent: deps.agent,
      workspaceId: owner.workspaceId,
      userId: owner.userId,
      conversationId,
      text: body.text,
      traceId,
      timeZone: deps.timeZone,
      resources: deps.resources,
      now: deps.now,
      log: deps.log,
    }),
  };
}

function resolveOwner(deps: WebChatHttpDeps, input: unknown): { workspaceId: string; userId: string } {
  return deps.authenticatedOwner ?? ownerSchema.parse(input);
}

function headerValue(headers: Record<string, string | undefined>, name: string): string | undefined {
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  const value = match?.[1]?.trim();
  return value || undefined;
}
