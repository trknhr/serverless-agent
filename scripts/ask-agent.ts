import { chatMessageResponseSchema } from "../src/chat/contracts";
import { inferRegionFromApiBaseUrl, parseJsonResponse, signedJsonRequest } from "./apiClient";

interface CliOptions {
  apiBaseUrl: string;
  region: string;
  workspaceId: string;
  userId: string;
  sessionId?: string;
  json: boolean;
  text: string;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const response = await postMessage(options);

  if (options.json) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }

  console.log(`session_id: ${response.sessionId}`);
  if (response.savedMemoryIds.length > 0) {
    console.log(`saved_memory_ids: ${response.savedMemoryIds.join(", ")}`);
  }
  if (response.taskIds.length > 0) {
    console.log(`task_ids: ${response.taskIds.join(", ")}`);
  }
  if (response.recurringTaskIds.length > 0) {
    console.log(`recurring_task_ids: ${response.recurringTaskIds.join(", ")}`);
  }
  console.log("");
  console.log(response.text);
}

async function postMessage(options: CliOptions) {
  const response = await signedJsonRequest(
    { region: options.region },
    `${options.apiBaseUrl}/chat/messages`,
    "POST",
    {
      workspaceId: options.workspaceId,
      userId: options.userId,
      text: options.text,
      sessionId: options.sessionId,
    },
  );
  const payload = await parseJsonResponse<unknown>(response);
  return chatMessageResponseSchema.parse(payload);
}

function parseArgs(argv: string[]): CliOptions {
  const options: Partial<CliOptions> = {
    apiBaseUrl: process.env.IMPORTS_API_BASE_URL,
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,
    workspaceId: process.env.SLACK_WORKSPACE_ID,
    userId: process.env.SLACK_USER_ID,
    json: false,
    text: "",
  };
  const messageParts: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    switch (value) {
      case "--api-base-url":
        options.apiBaseUrl = argv[++index];
        break;
      case "--workspace-id":
        options.workspaceId = argv[++index];
        break;
      case "--region":
        options.region = argv[++index];
        break;
      case "--user-id":
        options.userId = argv[++index];
        break;
      case "--session-id":
        options.sessionId = argv[++index];
        break;
      case "--json":
        options.json = true;
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

  options.text = messageParts.join(" ").trim();
  const inferredRegion = options.region ?? inferRegionFromApiBaseUrl(options.apiBaseUrl);

  if (!options.apiBaseUrl || !inferredRegion || !options.workspaceId || !options.userId || !options.text) {
    printUsage();
    throw new Error("Missing required options");
  }

  return {
    apiBaseUrl: options.apiBaseUrl.replace(/\/+$/, ""),
    region: inferredRegion,
    workspaceId: options.workspaceId,
    userId: options.userId,
    sessionId: options.sessionId,
    json: options.json ?? false,
    text: options.text,
  };
}

function printUsage(): void {
  console.log([
    "Usage:",
    "  ts-node scripts/ask-agent.ts --api-base-url https://.../prod --workspace-id T... --user-id U... [--region ap-northeast-1] [--session-id sess_...] [--json] <message>",
    "",
    "Examples:",
    "  ts-node scripts/ask-agent.ts --api-base-url https://.../prod --workspace-id T... --user-id local-user \"What should I do today?\"",
    "  ts-node scripts/ask-agent.ts --api-base-url https://.../prod --workspace-id T... --user-id local-user --session-id sess_... \"Show only the items due tonight.\"",
    "",
    "AWS credentials with execute-api:Invoke are required.",
  ].join("\n"));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
