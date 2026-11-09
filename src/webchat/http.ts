import { z, ZodError } from "zod";
import { AgentRuntimeResources } from "../agentcore/contracts";
import { Logger } from "../shared/logger";
import { bearerMatches } from "./access";
import { formatSse } from "./sse";
import { WebChatAgent, WebChatServerEvent, runWebChatTurn } from "./turn";
import { WebChatStore } from "./types";
import { Connection, ConnectionAccount } from "../repo/connectionRepository";

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
  connections?: {
    listConnections(workspaceId: string, userId: string): Promise<Connection[]>;
    listAccounts(workspaceId: string, userId: string, connectionId: string): Promise<ConnectionAccount[]>;
    saveConnection(input: Omit<Connection, "createdAt" | "updatedAt">): Promise<Connection>;
    saveAccount(input: Omit<ConnectionAccount, "connectedAt" | "updatedAt">, makeDefault?: boolean): Promise<ConnectionAccount>;
    setDefaultAccount(workspaceId: string, userId: string, connectionId: string, accountId: string): Promise<void>;
    deleteAccount(workspaceId: string, userId: string, connectionId: string, accountId: string): Promise<void>;
  };
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

  const connectionAccountMatch = request.path.match(/^\/api\/connections\/([^/]+)\/accounts\/([^/]+)$/);
  if (connectionAccountMatch && method === "PATCH") {
    return setDefaultConnectionAccount(connectionAccountMatch[1] ?? "", connectionAccountMatch[2] ?? "", request, deps);
  }
  if (connectionAccountMatch && method === "DELETE") {
    return deleteConnectionAccount(connectionAccountMatch[1] ?? "", connectionAccountMatch[2] ?? "", request, deps);
  }
  const connectionAccountsMatch = request.path.match(/^\/api\/connections\/([^/]+)\/accounts$/);
  if (connectionAccountsMatch && method === "POST") {
    return createConnectionAccount(connectionAccountsMatch[1] ?? "", request, deps);
  }
  if (request.path === "/api/connections" && method === "GET") {
    return listConnections(request, deps);
  }
  if (request.path === "/api/connections" && method === "POST") {
    return createConnection(request, deps);
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

function requireConnections(deps: WebChatHttpDeps): NonNullable<WebChatHttpDeps["connections"]> {
  if (!deps.connections) throw new Error("Connection management is not configured");
  return deps.connections;
}

async function listConnections(request: WebChatHttpRequest, deps: WebChatHttpDeps): Promise<WebChatHttpResult> {
  const owner = resolveOwner(deps, { workspaceId: request.query.workspaceId, userId: request.query.userId });
  const repository = requireConnections(deps);
  const connections = await repository.listConnections(owner.workspaceId, owner.userId);
  const result = await Promise.all(connections.map(async (connection) => ({
    ...connection,
    accounts: (await repository.listAccounts(owner.workspaceId, owner.userId, connection.connectionId)).map(publicAccount),
  })));
  return { kind: "json", status: 200, body: { ok: true, connections: result } };
}

async function createConnection(request: WebChatHttpRequest, deps: WebChatHttpDeps): Promise<WebChatHttpResult> {
  const body = z.object({
    workspaceId: z.string().optional(), userId: z.string().optional(),
    connectionId: z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/),
    provider: z.string().trim().min(1).max(100), capability: z.string().trim().min(1).max(100),
    displayName: z.string().trim().min(1).max(200),
  }).parse(request.body ?? {});
  const owner = resolveOwner(deps, body);
  const connection = await requireConnections(deps).saveConnection({ ...body, ...owner, status: "active" });
  return { kind: "json", status: 201, body: { ok: true, connection: { ...connection, accounts: [] } } };
}

async function createConnectionAccount(connectionIdRaw: string, request: WebChatHttpRequest, deps: WebChatHttpDeps): Promise<WebChatHttpResult> {
  const connectionId = decodeURIComponent(connectionIdRaw);
  const body = z.object({
    workspaceId: z.string().optional(), userId: z.string().optional(), accountId: z.string().trim().min(1).max(200),
    displayName: z.string().trim().min(1).max(200), email: z.string().email().optional(), makeDefault: z.boolean().optional(),
  }).parse(request.body ?? {});
  const owner = resolveOwner(deps, body);
  const account = await requireConnections(deps).saveAccount({
    ...owner, connectionId, accountId: body.accountId, displayName: body.displayName, email: body.email,
    status: "active", credentials: {},
  }, body.makeDefault);
  return { kind: "json", status: 201, body: { ok: true, account: publicAccount(account) } };
}

async function setDefaultConnectionAccount(connectionIdRaw: string, accountIdRaw: string, request: WebChatHttpRequest, deps: WebChatHttpDeps): Promise<WebChatHttpResult> {
  const body = z.object({ workspaceId: z.string().optional(), userId: z.string().optional(), makeDefault: z.literal(true) }).parse(request.body ?? {});
  const owner = resolveOwner(deps, body);
  await requireConnections(deps).setDefaultAccount(owner.workspaceId, owner.userId, decodeURIComponent(connectionIdRaw), decodeURIComponent(accountIdRaw));
  return { kind: "json", status: 200, body: { ok: true } };
}

async function deleteConnectionAccount(connectionIdRaw: string, accountIdRaw: string, request: WebChatHttpRequest, deps: WebChatHttpDeps): Promise<WebChatHttpResult> {
  const owner = resolveOwner(deps, { workspaceId: request.query.workspaceId, userId: request.query.userId });
  await requireConnections(deps).deleteAccount(owner.workspaceId, owner.userId, decodeURIComponent(connectionIdRaw), decodeURIComponent(accountIdRaw));
  return { kind: "json", status: 200, body: { ok: true } };
}

function publicAccount(account: ConnectionAccount): Omit<ConnectionAccount, "credentials"> {
  const { credentials: _credentials, ...result } = account;
  return result;
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
