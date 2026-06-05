import * as dotenv from "dotenv";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import * as ai from "ai";
import { AgentRuntimeRequest } from "../src/agentcore/contracts";
import { AgentRunnerAi, parseBedrockServiceTier, runAgentTurn } from "../src/agentcore/runAgentTurn";
import { SecretsProvider } from "../src/aws/secretsProvider";
import { FileStateStore, DEFAULT_LOCAL_STATE_PATH } from "../src/local/fileStateStore";
import { createLocalRepositories } from "../src/local/localRepositories";
import { SkillRegistry } from "../src/skills/registry";
import { logger } from "../src/shared/logger";
import { CustomToolExecutor } from "../src/tools/executeCustomTool";
import { OpenMeteoWeatherProvider } from "../src/weather/openMeteo";
import { WebToolsProvider } from "../src/web/webTools";

interface CliOptions {
  text: string;
  workspaceId: string;
  userId: string;
  channelId: string;
  sessionId: string;
  stateFile: string;
  json: boolean;
  disableTools: boolean;
}

dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ quiet: true });

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const region = process.env.BEDROCK_REGION ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "ap-northeast-1";
  const modelId = requireEnv("BEDROCK_MODEL_ID");
  const documentModelId = process.env.BEDROCK_DOCUMENT_MODEL_ID ?? modelId;
  const bedrockServiceTier = parseBedrockServiceTier(process.env.BEDROCK_SERVICE_TIER);
  const stateStore = new FileStateStore(options.stateFile);
  const repositories = createLocalRepositories(stateStore);
  const skillRegistry = new SkillRegistry(repositories.skills);
  const secretsProvider = new SecretsProvider();
  const bedrock = createAmazonBedrock({
    region,
    credentialProvider: defaultProvider(),
  });
  const log = logger.child({
    component: "local-dev-chat",
    sessionId: options.sessionId,
  });
  const request: AgentRuntimeRequest = {
    content: [{ type: "text", text: options.text }],
    context: {
      source: "local_dev_cli",
      workspaceId: options.workspaceId,
      userId: options.userId,
      channelId: options.channelId,
      conversationTs: options.sessionId,
    },
    toolContext: {
      workspaceId: options.workspaceId,
      userId: options.userId,
      channelId: options.channelId,
      memoryWritePolicy: {
        allowWorkspaceMemory: true,
        channelInferredStatus: "active",
        defaultOrigin: "explicit",
      },
    },
    disableTools: options.disableTools,
  };

  let text = "";
  let metadata = {
    taskIds: [] as string[],
    recurringTaskIds: [] as string[],
    savedMemoryIds: [] as string[],
    calendarDraftIds: [] as string[],
  };

  for await (const event of runAgentTurn({
    request,
    sessionId: options.sessionId,
    ai: ai as unknown as AgentRunnerAi,
    modelProvider: bedrock,
    modelId,
    documentModelId,
    bedrockServiceTier,
    log,
    sessionHistoryStore: stateStore,
    useSessionHistory: () => true,
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
          workspaceId: options.workspaceId,
          userId: options.userId,
          channelId: options.channelId,
          conversationId: options.sessionId,
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
  })) {
    if (event.event === "message") {
      const chunk = event.data.text;
      text += chunk;
      if (!options.json) {
        process.stdout.write(chunk);
      }
      continue;
    }
    metadata = event.data;
  }

  if (options.json) {
    console.log(JSON.stringify({ sessionId: options.sessionId, stateFile: stateStore.path, text, ...metadata }, null, 2));
    return;
  }

  process.stdout.write("\n");
  console.log(`session_id: ${options.sessionId}`);
  console.log(`state_file: ${stateStore.path}`);
  printIds("saved_memory_ids", metadata.savedMemoryIds);
  printIds("task_ids", metadata.taskIds);
  printIds("recurring_task_ids", metadata.recurringTaskIds);
  printIds("calendar_draft_ids", metadata.calendarDraftIds);
}

function parseArgs(argv: string[]): CliOptions {
  const options: Partial<CliOptions> = {
    workspaceId: process.env.LOCAL_WORKSPACE_ID ?? "local-workspace",
    userId: process.env.LOCAL_USER_ID ?? "local-user",
    channelId: process.env.LOCAL_CHANNEL_ID ?? "local-channel",
    sessionId: process.env.LOCAL_SESSION_ID ?? "local-default",
    stateFile: process.env.SERVERLESS_AGENT_LOCAL_STATE_PATH ?? DEFAULT_LOCAL_STATE_PATH,
    json: false,
    disableTools: false,
  };
  const messageParts: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    switch (value) {
      case "--workspace-id":
        options.workspaceId = argv[++index];
        break;
      case "--user-id":
        options.userId = argv[++index];
        break;
      case "--channel-id":
        options.channelId = argv[++index];
        break;
      case "--session-id":
        options.sessionId = argv[++index];
        break;
      case "--state-file":
        options.stateFile = argv[++index];
        break;
      case "--json":
        options.json = true;
        break;
      case "--disable-tools":
        options.disableTools = true;
        break;
      case "--help":
        printUsage();
        process.exit(0);
      default:
        if (value.startsWith("--")) {
          throw new Error(`Unknown option: ${value}`);
        }
        messageParts.push(value);
    }
  }

  const text = messageParts.join(" ").trim();
  if (!options.workspaceId || !options.userId || !options.channelId || !options.sessionId || !options.stateFile || !text) {
    printUsage();
    throw new Error("Missing required local chat options");
  }

  return {
    workspaceId: options.workspaceId,
    userId: options.userId,
    channelId: options.channelId,
    sessionId: options.sessionId,
    stateFile: options.stateFile,
    json: options.json ?? false,
    disableTools: options.disableTools ?? false,
    text,
  };
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be set. Copy .env.local.example to .env.local and set ${name}.`);
  }
  return value;
}

function printIds(label: string, ids: string[]): void {
  if (ids.length > 0) {
    console.log(`${label}: ${ids.join(", ")}`);
  }
}

function printUsage(): void {
  console.log([
    "Usage:",
    "  npm run dev:chat -- [options] <message>",
    "",
    "Options:",
    "  --workspace-id <id>   Defaults to local-workspace or LOCAL_WORKSPACE_ID",
    "  --user-id <id>        Defaults to local-user or LOCAL_USER_ID",
    "  --channel-id <id>     Defaults to local-channel or LOCAL_CHANNEL_ID",
    "  --session-id <id>     Defaults to local-default or LOCAL_SESSION_ID",
    "  --state-file <path>   Defaults to .serverless-agent/local-state/state.json",
    "  --disable-tools       Run the model without local tool execution",
    "  --json                Print a JSON response after completion",
    "",
    "Examples:",
    "  npm run dev:chat -- \"Remember that local dev uses file-backed state.\"",
    "  npm run dev:chat -- --session-id local-1 \"What do you remember?\"",
  ].join("\n"));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
