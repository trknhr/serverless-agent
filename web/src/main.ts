import { renderMarkdown } from "../../src/webchat/markdown";
import { consumeSseBuffer } from "../../src/webchat/sse";

interface ConversationSummary {
  conversationId: string;
  title: string;
  updatedAt: string;
  preview?: string;
}

interface ChatMessage {
  messageId: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

interface Settings {
  apiBaseUrl: string;
  accessKey: string;
  workspaceId: string;
  userId: string;
}

interface CognitoConfig {
  clientId: string;
  domain: string;
  redirectUri: string;
  identityProvider?: string;
}

const settingsKey = "serverless-agent-web-chat";
const accessKeyName = "serverless-agent-web-chat-key";
const idTokenName = "serverless-agent-web-chat-id-token";
const pkceVerifierName = "serverless-agent-web-chat-pkce-verifier";
const oauthStateName = "serverless-agent-web-chat-oauth-state";

const state: {
  settings: Settings;
  mode: string;
  authMode: "access-key" | "cognito";
  cognito?: CognitoConfig;
  idToken: string;
  conversations: ConversationSummary[];
  activeId?: string;
  messages: ChatMessage[];
  streaming: boolean;
  status: string;
  error: string;
} = {
  settings: loadSettings(),
  mode: "",
  authMode: "access-key",
  idToken: sessionStorage.getItem(idTokenName) ?? "",
  conversations: [],
  messages: [],
  streaming: false,
  status: "",
  error: "",
};

const app = document.querySelector<HTMLElement>("#app");
if (!app) {
  throw new Error("Missing #app");
}

void boot(app);

async function boot(root: HTMLElement): Promise<void> {
  try {
    const response = await fetch("./config.json", { cache: "no-store" });
    if (response.ok) {
      const config = (await response.json()) as {
        apiBaseUrl?: string;
        mode?: string;
        authMode?: "access-key" | "cognito";
        cognito?: CognitoConfig;
      };
      if (!state.settings.apiBaseUrl && config.apiBaseUrl) {
        state.settings.apiBaseUrl = config.apiBaseUrl.replace(/\/$/, "");
      }
      state.mode = config.mode ?? "";
      state.authMode = config.authMode ?? "access-key";
      state.cognito = config.cognito;
      if (state.authMode === "cognito") {
        await completeCognitoSignIn();
      }
    }
  } catch {
    state.error = "Could not load config.json. Start the local server with npm run dev:web.";
  }
  render(root);
  if (state.authMode === "access-key" || state.idToken) {
    await refreshConversations(root);
  }
}

function render(root: HTMLElement): void {
  root.innerHTML = "";
  const shell = el("div", "shell");
  shell.append(renderSidebar(root), renderMain(root));
  root.append(shell);
}

function renderSidebar(root: HTMLElement): HTMLElement {
  const aside = el("aside", "sidebar");
  const brand = el("div", "brand");
  const title = el("h1");
  title.textContent = "serverless-agent";
  brand.append(title);
  if (state.mode) {
    const mode = el("span", "mode");
    mode.textContent = state.mode;
    brand.append(mode);
  }
  const create = el("button", "new-chat") as HTMLButtonElement;
  create.type = "button";
  create.textContent = "New chat";
  create.disabled = state.streaming || !isAuthenticated();
  create.addEventListener("click", () => void startNewChat(root));
  const list = el("div", "conversation-list");
  for (const conversation of state.conversations) {
    const button = el("button", `conversation${conversation.conversationId === state.activeId ? " active" : ""}`) as HTMLButtonElement;
    button.type = "button";
    const label = el("strong");
    label.textContent = conversation.title || "New chat";
    const time = el("span");
    time.textContent = formatTime(conversation.updatedAt);
    button.append(label, time);
    button.addEventListener("click", () => void openConversation(root, conversation.conversationId));
    list.append(button);
  }
  aside.append(brand, create, list, renderSettings(root));
  return aside;
}

function renderSettings(root: HTMLElement): HTMLElement {
  if (state.authMode === "cognito") {
    return renderCognitoAuth(root);
  }
  const form = el("form", "settings") as HTMLFormElement;
  form.append(
    field("Workspace", "workspaceId", state.settings.workspaceId),
    field("User", "userId", state.settings.userId),
    field("Access key", "accessKey", state.settings.accessKey, "password"),
    field("API base URL", "apiBaseUrl", state.settings.apiBaseUrl),
  );
  const hint = el("p");
  hint.textContent = "Deployed chat uses a shared bearer key from SSM. The key stays in this browser tab's saved settings and is not built into the page.";
  const save = el("button") as HTMLButtonElement;
  save.type = "submit";
  save.textContent = "Save connection";
  form.append(hint, save);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    state.settings = {
      workspaceId: String(data.get("workspaceId") ?? "").trim() || "local-workspace",
      userId: String(data.get("userId") ?? "").trim() || "local-user",
      accessKey: String(data.get("accessKey") ?? ""),
      apiBaseUrl: String(data.get("apiBaseUrl") ?? "").trim().replace(/\/$/, ""),
    };
    sessionStorage.setItem(accessKeyName, state.settings.accessKey);
    localStorage.setItem(settingsKey, JSON.stringify({ ...state.settings, accessKey: "" }));
    void refreshConversations(root);
  });
  return form;
}

function renderCognitoAuth(root: HTMLElement): HTMLElement {
  const panel = el("div", "settings");
  const hint = el("p");
  hint.textContent = state.idToken ? "Signed in with Cognito." : "Sign in to access your conversations.";
  const button = el("button") as HTMLButtonElement;
  button.type = "button";
  button.textContent = state.idToken ? "Sign out" : "Sign in";
  button.addEventListener("click", () => {
    if (state.idToken) {
      signOut();
    } else {
      void startCognitoSignIn();
    }
    render(root);
  });
  panel.append(hint, button);
  return panel;
}

function renderMain(root: HTMLElement): HTMLElement {
  const authenticated = isAuthenticated();
  const main = el("main", "main");
  const top = el("header", "topbar");
  const heading = el("h2");
  heading.textContent = state.conversations.find((item) => item.conversationId === state.activeId)?.title ?? "New chat";
  top.append(heading);

  const thread = el("div", "thread");
  const column = el("div", "column");
  if (state.messages.length === 0) {
    const empty = el("div", "empty");
    const prompt = el("h2");
    prompt.textContent = authenticated ? "How can I help?" : "Sign in to continue";
    const sub = el("p");
    sub.textContent = authenticated
      ? "Ask a question. Replies stream as the model writes them."
      : "Use the Sign in button to access your conversations.";
    empty.append(prompt, sub);
    column.append(empty);
  } else {
    for (const message of state.messages) {
      column.append(renderMessage(message, false));
    }
  }
  if (state.streaming) {
    const live = column.querySelector(".message.assistant:last-child");
    live?.classList.add("caret");
  }
  thread.append(column);

  const wrap = el("div", "composer-wrap");
  if (state.error) {
    const error = el("div", "error");
    error.textContent = state.error;
    wrap.append(error);
  }
  if (state.status) {
    const status = el("div", "status");
    status.textContent = state.status;
    wrap.append(status);
  }
  const form = el("form", "composer") as HTMLFormElement;
  const input = document.createElement("textarea");
  input.name = "text";
  input.rows = 1;
  input.placeholder = "Message the assistant";
  input.disabled = state.streaming || !authenticated;
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  const send = el("button", "send") as HTMLButtonElement;
  send.type = "submit";
  send.textContent = "Send";
  send.disabled = state.streaming || !authenticated;
  form.append(input, send);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) {
      return;
    }
    input.value = "";
    void sendMessage(root, text);
  });
  wrap.append(form);
  main.append(top, thread, wrap);
  queueMicrotask(() => {
    thread.scrollTop = thread.scrollHeight;
  });
  return main;
}

function isAuthenticated(): boolean {
  return state.authMode !== "cognito" || Boolean(state.idToken);
}

function renderMessage(message: ChatMessage, streaming: boolean): HTMLElement {
  const node = el("article", `message ${message.role}`);
  if (message.role === "assistant") {
    const body = el("div", "markdown");
    body.innerHTML = renderMarkdown(message.text);
    node.append(body);
    if (streaming) {
      node.classList.add("caret");
    }
  } else {
    node.textContent = message.text;
  }
  return node;
}

async function startNewChat(root: HTMLElement): Promise<void> {
  state.error = "";
  try {
    const response = await api("/api/conversations", { method: "POST", body: ownerBody() });
    const payload = (await readJson(response)) as { conversation?: ConversationSummary; message?: string };
    if (!response.ok || !payload.conversation) {
      state.error = payload.message ?? "Could not start a chat.";
      render(root);
      return;
    }
    state.activeId = payload.conversation.conversationId;
    state.messages = [];
    await refreshConversations(root);
  } catch (error) {
    state.error = error instanceof Error ? error.message : "Could not start a chat.";
    render(root);
  }
}

async function openConversation(root: HTMLElement, conversationId: string): Promise<void> {
  if (state.streaming) {
    return;
  }
  state.error = "";
  state.activeId = conversationId;
  try {
    const response = await api(`/api/conversations/${encodeURIComponent(conversationId)}/messages?${ownerQuery()}`);
    const payload = (await readJson(response)) as { messages?: ChatMessage[]; message?: string };
    if (!response.ok) {
      state.error = payload.message ?? "Could not open that chat.";
      render(root);
      return;
    }
    state.messages = payload.messages ?? [];
    render(root);
  } catch (error) {
    state.error = error instanceof Error ? error.message : "Could not open that chat.";
    render(root);
  }
}

async function sendMessage(root: HTMLElement, text: string): Promise<void> {
  state.error = "";
  state.status = "";
  if (!state.activeId) {
    await startNewChat(root);
    if (!state.activeId) {
      return;
    }
  }
  const conversationId = state.activeId;
  state.messages = [...state.messages, { messageId: "pending-user", role: "user", text, createdAt: new Date().toISOString() }];
  const assistant: ChatMessage = {
    messageId: "pending-assistant",
    role: "assistant",
    text: "",
    createdAt: new Date().toISOString(),
  };
  state.messages = [...state.messages, assistant];
  state.streaming = true;
  render(root);
  const live = root.querySelector<HTMLElement>(".message.assistant:last-child .markdown");
  const statusNode = () => root.querySelector<HTMLElement>(".status");
  const thread = root.querySelector<HTMLElement>(".thread");

  try {
    const response = await api(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ ...owner(), text }),
    });
    if (!response.ok || !response.body) {
      const payload = (await readJson(response)) as { message?: string };
      state.error = payload.message ?? `Request failed (${response.status}).`;
      state.messages = state.messages.filter((message) => message.messageId !== "pending-assistant");
      state.streaming = false;
      render(root);
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const consumed = consumeSseBuffer(buffer);
      buffer = consumed.rest;
      for (const event of consumed.events) {
        applyEvent(assistant, event.event, event.data);
      }
      if (live) {
        live.innerHTML = renderMarkdown(assistant.text);
        live.parentElement?.classList.add("caret");
      }
      const status = statusNode();
      if (status) {
        status.textContent = state.status;
      } else if (state.status) {
        const node = el("div", "status");
        node.textContent = state.status;
        root.querySelector(".composer-wrap")?.prepend(node);
      }
      if (state.error) {
        let errorNode = root.querySelector<HTMLElement>(".error");
        if (!errorNode) {
          errorNode = el("div", "error");
          root.querySelector(".composer-wrap")?.prepend(errorNode);
        }
        errorNode.textContent = state.error;
      }
      if (thread) {
        thread.scrollTop = thread.scrollHeight;
      }
    }
  } catch (error) {
    state.error = error instanceof Error ? error.message : "The stream failed.";
  } finally {
    state.streaming = false;
    state.status = "";
    await refreshConversations(root);
    if (state.activeId) {
      await openConversation(root, state.activeId);
    }
  }
}

function applyEvent(assistant: ChatMessage, event: string, data: string): void {
  const parsed = parseData(data);
  if (event === "delta" && typeof parsed.text === "string") {
    assistant.text += parsed.text;
    return;
  }
  if (event === "message" && typeof parsed.text === "string") {
    assistant.text = parsed.text;
    return;
  }
  if (event === "status" && typeof parsed.text === "string") {
    state.status = parsed.text;
    return;
  }
  if (event === "error") {
    state.error = typeof parsed.message === "string" ? parsed.message : "The assistant failed.";
  }
}

async function refreshConversations(root: HTMLElement): Promise<void> {
  try {
    const response = await api(`/api/conversations?${ownerQuery()}`);
    const payload = (await readJson(response)) as { ok?: boolean; conversations?: ConversationSummary[]; message?: string };
    if (!response.ok || payload.ok === false) {
      state.error = payload.message ?? "Could not load chats.";
      render(root);
      return;
    }
    state.conversations = payload.conversations ?? [];
    render(root);
  } catch (error) {
    state.error = error instanceof Error ? error.message : "Could not load chats.";
    render(root);
  }
}

async function api(path: string, init: { method?: string; body?: string } = {}): Promise<Response> {
  const headers = new Headers({ accept: init.method === "POST" && path.endsWith("/messages") ? "text/event-stream" : "application/json" });
  if (init.body) {
    headers.set("content-type", "application/json");
  }
  if (state.authMode === "cognito" && state.idToken) {
    headers.set("authorization", `Bearer ${state.idToken}`);
  } else if (state.settings.accessKey) {
    headers.set("authorization", `Bearer ${state.settings.accessKey}`);
  }
  return fetch(`${state.settings.apiBaseUrl}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body,
  });
}

async function startCognitoSignIn(): Promise<void> {
  const config = requireCognitoConfig();
  const verifier = randomUrlSafe(64);
  const oauthState = randomUrlSafe(32);
  sessionStorage.setItem(pkceVerifierName, verifier);
  sessionStorage.setItem(oauthStateName, oauthState);
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const query = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: "openid email",
    state: oauthState,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  if (config.identityProvider) {
    query.set("identity_provider", config.identityProvider);
  }
  window.location.assign(`${config.domain}/oauth2/authorize?${query}`);
}

async function completeCognitoSignIn(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  if (!code) {
    return;
  }
  const verifier = sessionStorage.getItem(pkceVerifierName);
  const expectedState = sessionStorage.getItem(oauthStateName);
  if (!verifier || !expectedState || params.get("state") !== expectedState) {
    throw new Error("The sign-in response could not be verified. Please sign in again.");
  }
  const config = requireCognitoConfig();
  const response = await fetch(`${config.domain}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      code,
      code_verifier: verifier,
    }),
  });
  const payload = (await response.json()) as { id_token?: string; error_description?: string };
  if (!response.ok || !payload.id_token) {
    throw new Error(payload.error_description ?? "Cognito sign-in failed.");
  }
  state.idToken = payload.id_token;
  sessionStorage.setItem(idTokenName, payload.id_token);
  sessionStorage.removeItem(pkceVerifierName);
  sessionStorage.removeItem(oauthStateName);
  window.history.replaceState({}, document.title, window.location.pathname);
}

function signOut(): void {
  const config = requireCognitoConfig();
  state.idToken = "";
  state.conversations = [];
  state.messages = [];
  sessionStorage.removeItem(idTokenName);
  const query = new URLSearchParams({ client_id: config.clientId, logout_uri: config.redirectUri });
  window.location.assign(`${config.domain}/logout?${query}`);
}

function requireCognitoConfig(): CognitoConfig {
  if (!state.cognito) {
    throw new Error("Cognito is not configured for this web chat.");
  }
  return state.cognito;
}

function randomUrlSafe(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function owner(): { workspaceId: string; userId: string } {
  return {
    workspaceId: state.settings.workspaceId || "local-workspace",
    userId: state.settings.userId || "local-user",
  };
}

function ownerBody(): string {
  return JSON.stringify(owner());
}

function ownerQuery(): string {
  const value = owner();
  return new URLSearchParams(value).toString();
}

function loadSettings(): Settings {
  try {
    const parsed = JSON.parse(localStorage.getItem(settingsKey) ?? "") as Partial<Settings>;
    return {
      apiBaseUrl: parsed.apiBaseUrl ?? "",
      accessKey: sessionStorage.getItem(accessKeyName) ?? "",
      workspaceId: parsed.workspaceId || "local-workspace",
      userId: parsed.userId || "local-user",
    };
  } catch {
    return { apiBaseUrl: "", accessKey: "", workspaceId: "local-workspace", userId: "local-user" };
  }
}

function field(label: string, name: string, value: string, type = "text"): HTMLElement {
  const wrap = el("label");
  wrap.textContent = label;
  const input = document.createElement("input");
  input.name = name;
  input.type = type;
  input.value = value;
  input.autocomplete = name === "accessKey" ? "off" : "on";
  wrap.append(input);
  return wrap;
}

function el(tag: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  return node;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseData(data: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(data) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
