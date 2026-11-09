import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";
import { afterEach, expect, it, vi } from "vitest";

const script = buildSync({ entryPoints: ["web/src/main.ts"], bundle: true, write: false, format: "iife", platform: "browser" }).outputFiles[0].text;
let dom: JSDOM | undefined;
afterEach(() => dom?.window.close());

async function setup(options: { connectionError?: boolean; mutationError?: boolean; stream?: ReadableStream<Uint8Array> } = {}) {
  dom = new JSDOM('<div id="app"></div>', { url: "http://localhost", runScripts: "outside-only" });
  const window = dom.window;
  Object.assign(window, { Headers, TextDecoder });
  window.confirm = () => true;
  const conversation = { conversationId: "c1", title: "Existing chat", updatedAt: new Date().toISOString() };
  window.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "./config.json") return Response.json({});
    if (url.startsWith("/api/connections")) {
      if (options.mutationError) {
        if (init?.method === "DELETE" || init?.method === "PATCH") return Response.json({ message: "Update denied" }, { status: 403 });
        return Response.json({ connections: [{ connectionId: "test", displayName: "Test", provider: "test", capability: "test", status: "active", accounts: [{ accountId: "work", displayName: "Work", status: "active" }] }] });
      }
      return options.connectionError ? Response.json({ message: "Connection request denied" }, { status: 403 }) : Response.json({ connections: [] });
    }
    if (url.startsWith("/api/conversations/c1/messages")) {
      if (init?.method === "POST") return new Response(options.stream);
      return Response.json({ messages: [] });
    }
    if (init?.method === "POST") return Response.json({ conversation });
    return Response.json({ conversations: [conversation] });
  }) as typeof window.fetch;
  window.eval(script);
  await vi.waitFor(() => expect(window.document.querySelector(".conversation")).toBeTruthy());
  return window.document;
}

function click(document: Document, text: string) {
  const button = [...document.querySelectorAll("button")].find((item) => item.textContent === text);
  expect(button, `button ${text}`).toBeTruthy();
  button!.click();
}

it("shows connection failures and returns to chat on conversation navigation", async () => {
  const document = await setup({ connectionError: true });
  click(document, "Connections");
  await vi.waitFor(() => expect(document.querySelector('.connections-main [role="alert"]')?.textContent).toBe("Connection request denied"));
  document.querySelector<HTMLButtonElement>(".conversation")!.click();
  await vi.waitFor(() => expect(document.querySelector(".thread")).toBeTruthy());
  click(document, "Connections");
  await vi.waitFor(() => expect(document.querySelector(".connections-main")).toBeTruthy());
  click(document, "New chat");
  await vi.waitFor(() => expect(document.querySelector(".thread")).toBeTruthy());
});

it("keeps rendering stream deltas after Chat rerenders and switching views", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const document = await setup({ stream });
  document.querySelector<HTMLButtonElement>(".conversation")!.click();
  await vi.waitFor(() => expect(document.querySelector(".topbar")?.textContent).toBe("Existing chat"));
  const input = document.querySelector<HTMLTextAreaElement>("textarea")!;
  input.value = "Hello";
  document.querySelector(".composer")!.dispatchEvent(new dom!.window.Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(document.querySelector(".message.assistant")).toBeTruthy());
  const delta = (text: string) => controller.enqueue(new TextEncoder().encode(`event: delta\ndata: ${JSON.stringify({ text })}\n\n`));
  click(document, "Chat");
  delta("First");
  await vi.waitFor(() => expect(document.querySelector(".message.assistant")?.textContent).toBe("First"));
  click(document, "Connections");
  await vi.waitFor(() => expect(document.querySelector(".connections-main")).toBeTruthy());
  delta(" second");
  click(document, "Chat");
  delta(" third");
  await vi.waitFor(() => expect(document.querySelector(".message.assistant")?.textContent).toBe("First second third"));
  click(document, "Connections");
  await vi.waitFor(() => expect(document.querySelector(".connections-main")).toBeTruthy());
  controller.close();
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>(".new-chat")?.disabled).toBe(false));
  expect(document.querySelector(".connections-main")).toBeTruthy();
});

it("keeps default and removal failures visible on the Connections screen", async () => {
  const document = await setup({ mutationError: true });
  click(document, "Connections");
  await vi.waitFor(() => expect([...document.querySelectorAll("button")].some((item) => item.textContent === "Make default")).toBe(true));
  click(document, "Make default");
  await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toBe("Update denied"));
  click(document, "Remove");
  await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toBe("Update denied"));
  expect(document.querySelector(".connections-main")).toBeTruthy();
});
