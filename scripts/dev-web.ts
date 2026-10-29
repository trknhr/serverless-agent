import { execFileSync } from "node:child_process";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import * as dotenv from "dotenv";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import * as ai from "ai";
import { AgentRunnerAi, runAgentTurn } from "../src/agentcore/runAgentTurn";
import { SecretsProvider } from "../src/aws/secretsProvider";
import { FileStateStore, DEFAULT_LOCAL_STATE_PATH } from "../src/local/fileStateStore";
import { createLocalRepositories } from "../src/local/localRepositories";
import { SkillRegistry } from "../src/skills/registry";
import { logger } from "../src/shared/logger";
import { CustomToolExecutor } from "../src/tools/executeCustomTool";
import { FileWebChatStore } from "../src/webchat/fileWebChatStore";
import { routeWebChat } from "../src/webchat/http";
import { formatSse } from "../src/webchat/sse";
import { WebChatAgent, buildWebChatAgentRequest } from "../src/webchat/turn";
import { OpenMeteoWeatherProvider } from "../src/weather/openMeteo";
import { WebToolsProvider } from "../src/web/webTools";

dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ quiet: true });

interface DevWebOptions {
  host: string;
  port: number;
  demo: boolean;
  stateFile: string;
  accessKey?: string;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  execFileSync("npx", ["ts-node", "scripts/build-web.ts"], { stdio: "inherit" });
  const stateStore = new FileStateStore(options.stateFile);
  const store = new FileWebChatStore(stateStore);
  const agent = options.demo ? createDemoAgent() : createBedrockAgent(stateStore);
  const server = createServer(async (request, response) => {
    try {
      await handle(request, response, options, store, agent);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Local web chat failed";
      response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: false, error: "internal_error", message }));
    }
  });
  await new Promise<void>((resolve) => server.listen(options.port, options.host, resolve));
  console.log(`Web chat UI: http://${options.host}:${options.port}`);
  console.log(options.demo ? "Mode: demo (no Bedrock calls)" : "Mode: Bedrock agent");
  console.log(options.accessKey ? "Auth: bearer token required" : "Auth: open on this local server");
  console.log(`State file: ${stateStore.path}`);
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  options: DevWebOptions,
  store: FileWebChatStore,
  agent: WebChatAgent,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${options.host}:${options.port}`);
  if (request.method === "OPTIONS") {
    response.writeHead(204, corsHeaders());
    response.end();
    return;
  }
  if (url.pathname === "/config.json") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify({ apiBaseUrl: "", mode: options.demo ? "demo" : "agent" }));
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    const body = await readBody(request);
    const result = await routeWebChat(
      {
        method: request.method ?? "GET",
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        headers: Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value])),
        body,
      },
      {
        store,
        agent,
        accessKey: options.accessKey,
        allowUnauthenticated: !options.accessKey,
        timeZone: process.env.GOOGLE_CALENDAR_TIME_ZONE ?? "Asia/Tokyo",
        log: logger.child({ component: "dev-web" }),
      },
    );
    if (result.kind === "json") {
      response.writeHead(result.status, { ...corsHeaders(), "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(result.body));
      return;
    }
    response.writeHead(200, {
      ...corsHeaders(),
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
    });
    for await (const event of result.events) {
      response.write(formatSse(event.event, event.data));
    }
    response.end();
    return;
  }
  await serveStatic(url.pathname, response);
}

function createDemoAgent(): WebChatAgent {
  return {
    async *run(input) {
      const reply = [
        `You said: ${input.text}`,
        "",
        `This chat already has ${input.history.length} earlier message(s) in its saved history.`,
        "",
        "```ts",
        "console.log(\"streamed\");",
        "```",
        "",
        "See [the README](https://example.com/readme) for how to deploy the UI.",
      ].join("\n");
      yield { event: "status", data: { text: "Searching the web" } };
      await delay(180);
      for (let index = 0; index < reply.length; index += 8) {
        yield { event: "delta", data: { text: reply.slice(index, index + 8) } };
        await delay(18);
      }
      yield {
        event: "message",
        data: { text: reply },
      };
      yield {
        event: "metadata",
        data: { taskIds: [], recurringTaskIds: [], savedMemoryIds: [], calendarDraftIds: [] },
      };
    },
  };
}

function createBedrockAgent(stateStore: FileStateStore): WebChatAgent {
  const region = process.env.BEDROCK_REGION ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "ap-northeast-1";
  const modelId = requireEnv("BEDROCK_MODEL_ID");
  const documentModelId = process.env.BEDROCK_DOCUMENT_MODEL_ID ?? modelId;
  const repositories = createLocalRepositories(stateStore);
  const skillRegistry = new SkillRegistry(repositories.skills);
  const secretsProvider = new SecretsProvider();
  const bedrock = createAmazonBedrock({ region, credentialProvider: defaultProvider() });
  return {
    async *run(input) {
      const log = logger.child({ component: "dev-web", conversationId: input.conversationId });
      const request = buildWebChatAgentRequest(input);
      yield* runAgentTurn({
        request,
        sessionId: input.sessionId,
        ai: ai as unknown as AgentRunnerAi,
        modelProvider: bedrock,
        modelId,
        documentModelId,
        log,
        useSessionHistory: () => false,
        createSkillRegistry: () => skillRegistry,
        createExecutor: () =>
          new CustomToolExecutor(
            {
              memoryItems: repositories.memoryItems,
              channelMemories: repositories.channelMemories,
              userPreferences: repositories.userPreferences,
              scheduledTasks: repositories.scheduledTasks,
              tasks: repositories.tasks,
              taskEvents: repositories.taskEvents,
              recurringTasks: repositories.recurringTasks,
              calendarDrafts: repositories.calendarDrafts,
              workSessions: repositories.workSessions,
            } as never,
            {
              workspaceId: input.workspaceId,
              userId: input.userId,
              conversationId: input.conversationId,
              logger: log,
              memoryWritePolicy: {
                allowWorkspaceMemory: true,
                channelInferredStatus: "active",
                defaultOrigin: "explicit",
              },
              workSessionPolicy: {
                idleTimeoutSeconds: 900,
                maxLifetimeSeconds: 3600,
                maxActivePerOwner: 2,
              },
            },
            {
              defaultCalendarTimeZone: process.env.GOOGLE_CALENDAR_TIME_ZONE ?? "Asia/Tokyo",
              weatherProvider: new OpenMeteoWeatherProvider(),
              webProvider: new WebToolsProvider({
                searchProvider: process.env.WEB_SEARCH_PROVIDER,
                searchApiKeyProvider: process.env.WEB_SEARCH_API_KEY_PARAMETER_NAME
                  ? () => secretsProvider.getSecretString(process.env.WEB_SEARCH_API_KEY_PARAMETER_NAME!)
                  : undefined,
                searchBaseUrl: process.env.WEB_SEARCH_BASE_URL,
              }),
              skillRegistry,
            },
          ),
      });
    },
  };
}

async function serveStatic(pathname: string, response: ServerResponse): Promise<void> {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const root = normalize("web/dist");
  const filePath = normalize(join(root, relative));
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
    response.writeHead(403);
    response.end();
    return;
  }
  try {
    const body = await readFile(filePath);
    response.writeHead(200, { "content-type": contentType(filePath), "cache-control": "no-store" });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.method === "GET" || request.method === "HEAD") {
    return {};
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) {
      throw new Error("Request body is too large");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization,content-type,x-request-id",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "cache-control": "no-store",
  };
}

function contentType(filePath: string): string {
  switch (extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function parseArgs(argv: string[]): DevWebOptions {
  const options: DevWebOptions = {
    host: "127.0.0.1",
    port: 4173,
    demo: false,
    stateFile: process.env.SERVERLESS_AGENT_LOCAL_STATE_PATH ?? DEFAULT_LOCAL_STATE_PATH,
    accessKey: process.env.WEB_CHAT_ACCESS_KEY,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    switch (value) {
      case "--host":
        options.host = argv[++index] ?? options.host;
        break;
      case "--port":
        options.port = Number(argv[++index] ?? options.port);
        break;
      case "--demo":
        options.demo = true;
        break;
      case "--state-file":
        options.stateFile = argv[++index] ?? options.stateFile;
        break;
      case "--access-key":
        options.accessKey = argv[++index];
        break;
      case "--help":
        console.log([
          "Usage: npm run dev:web -- [options]",
          "",
          "  --demo              Stream a local sample reply instead of calling Bedrock",
          "  --port <port>       Defaults to 4173",
          "  --host <host>       Defaults to 127.0.0.1",
          "  --state-file <path> Defaults to .serverless-agent/local-state/state.json",
          "  --access-key <key>  Require Authorization: Bearer <key>. Defaults to WEB_CHAT_ACCESS_KEY",
        ].join("\n"));
        process.exit(0);
      default:
        throw new Error(`Unknown option: ${value}`);
    }
  }
  return options;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be set, or start with --demo. Copy .env.local.example to .env.local and set ${name}.`);
  }
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
