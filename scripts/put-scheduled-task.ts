import { promises as fs } from "node:fs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { normalizeScheduledOutputFields } from "../src/tasks/scheduledOutput";
import type { ScheduledOutputProvider } from "../src/tasks/taskDefinition";
import { buildScheduledTaskPk, scheduledTaskSchema } from "../src/tasks/taskDefinition";

interface CliOptions {
  tableName: string;
  region?: string;
  taskId: string;
  name: string;
  prompt: string;
  workspaceId: string;
  outputChannelId: string;
  outputProvider?: ScheduledOutputProvider;
  outputProviderAccountId?: string;
  outputConversationKey?: string;
  enabled: boolean;
  reuseSession: boolean;
  memoryStoreId?: string;
  vaultIds?: string[];
  agentIdOverride?: string;
  environmentIdOverride?: string;
}

async function main(): Promise<void> {
  const options = await parseArgs(process.argv.slice(2));
  const now = new Date().toISOString();
  const output = normalizeScheduledOutputFields({
    outputChannelId: options.outputChannelId,
    outputProvider: options.outputProvider,
    outputConversationKey: options.outputConversationKey,
  });
  const task = scheduledTaskSchema.parse({
    taskId: options.taskId,
    name: options.name,
    prompt: options.prompt,
    workspaceId: options.workspaceId,
    outputChannelId: output.outputChannelId,
    outputProvider: output.outputProvider,
    outputProviderAccountId: options.outputProviderAccountId,
    outputConversationKey: output.outputConversationKey,
    enabled: options.enabled,
    reuseSession: options.reuseSession,
    memoryStoreId: options.memoryStoreId,
    vaultIds: options.vaultIds,
    agentIdOverride: options.agentIdOverride,
    environmentIdOverride: options.environmentIdOverride,
    createdAt: now,
    updatedAt: now,
  });

  const documentClient = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: options.region }),
    {
      marshallOptions: { removeUndefinedValues: true },
    },
  );

  await documentClient.send(
    new PutCommand({
      TableName: options.tableName,
      Item: {
        pk: buildScheduledTaskPk(task.workspaceId, task.taskId),
        taskId: task.taskId,
        name: task.name,
        prompt: task.prompt,
        workspaceId: task.workspaceId,
        outputChannelId: task.outputChannelId,
        outputProvider: task.outputProvider,
        outputProviderAccountId: task.outputProviderAccountId,
        outputConversationKey: task.outputConversationKey,
        enabled: task.enabled,
        reuseSession: task.reuseSession,
        memoryStoreId: task.memoryStoreId,
        vaultIds: task.vaultIds,
        agentIdOverride: task.agentIdOverride,
        environmentIdOverride: task.environmentIdOverride,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      },
    }),
  );

  console.log(`Saved scheduled task ${task.taskId} to ${options.tableName}`);
  console.log(`pk: ${buildScheduledTaskPk(task.workspaceId, task.taskId)}`);
}

async function parseArgs(argv: string[]): Promise<CliOptions> {
  const options: Partial<CliOptions> = {
    tableName: process.env.SCHEDULED_TASKS_TABLE_NAME ?? process.env.TASK_TABLE_NAME,
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,
    taskId: "daily-summary",
    name: "Daily Summary",
    enabled: true,
    reuseSession: false,
  };
  let promptFile: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    switch (value) {
      case "--table-name":
        options.tableName = argv[++index];
        break;
      case "--region":
        options.region = argv[++index];
        break;
      case "--task-id":
        options.taskId = argv[++index];
        break;
      case "--name":
        options.name = argv[++index];
        break;
      case "--prompt":
        options.prompt = argv[++index];
        break;
      case "--prompt-file":
        promptFile = argv[++index];
        break;
      case "--workspace-id":
        options.workspaceId = argv[++index];
        break;
      case "--output-channel-id":
        options.outputChannelId = argv[++index];
        break;
      case "--output-provider":
        options.outputProvider = parseOutputProvider(argv[++index]);
        break;
      case "--output-provider-account-id":
        options.outputProviderAccountId = argv[++index];
        break;
      case "--output-conversation-key":
        options.outputConversationKey = argv[++index];
        break;
      case "--disabled":
        options.enabled = false;
        break;
      case "--reuse-session":
        options.reuseSession = true;
        break;
      case "--memory-store-id":
        options.memoryStoreId = argv[++index];
        break;
      case "--vault-ids":
        options.vaultIds = splitCsv(argv[++index]);
        break;
      case "--agent-id":
        options.agentIdOverride = argv[++index];
        break;
      case "--environment-id":
        options.environmentIdOverride = argv[++index];
        break;
      case "--help":
        printUsage();
        process.exit(0);
      default:
        throw new Error(`Unknown option: ${value}`);
    }
  }

  if (promptFile) {
    options.prompt = (await fs.readFile(promptFile, "utf-8")).trim();
  }

  if (!options.tableName || !options.taskId || !options.name || !options.prompt || !options.workspaceId || !options.outputChannelId) {
    printUsage();
    throw new Error("Missing required options");
  }

  return {
    tableName: options.tableName,
    region: options.region,
    taskId: options.taskId,
    name: options.name,
    prompt: options.prompt,
    workspaceId: options.workspaceId,
    outputChannelId: options.outputChannelId,
    outputProvider: options.outputProvider,
    outputProviderAccountId: options.outputProviderAccountId,
    outputConversationKey: options.outputConversationKey,
    enabled: options.enabled ?? true,
    reuseSession: options.reuseSession ?? false,
    memoryStoreId: options.memoryStoreId,
    vaultIds: options.vaultIds,
    agentIdOverride: options.agentIdOverride,
    environmentIdOverride: options.environmentIdOverride,
  };
}

function parseOutputProvider(value: string): ScheduledOutputProvider {
  if (value === "slack" || value === "line") {
    return value;
  }

  throw new Error(`Invalid output provider: ${value}`);
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function printUsage(): void {
  console.log([
    "Usage:",
    "  ts-node scripts/put-scheduled-task.ts --table-name TABLE --workspace-id T... --output-channel-id C... --prompt \"...\" [options]",
    "",
    "Options:",
    "  --region ap-northeast-1",
    "  --task-id daily-summary",
    "  --name \"Daily Summary\"",
    "  --output-provider slack|line",
    "  --output-provider-account-id SLACK_TEAM_ID or LINE_BOT_USER_ID",
    "  --output-conversation-key channel:SLACK_CHANNEL_ID or group:LINE_GROUP_ID",
    "  --prompt-file prompt.txt",
    "  --disabled",
    "  --reuse-session",
    "  --memory-store-id mem_...",
    "  --vault-ids vlt_1,vlt_2",
    "  --agent-id agent_...",
    "  --environment-id env_...",
    "",
    "Environment defaults:",
    "  SCHEDULED_TASKS_TABLE_NAME or TASK_TABLE_NAME",
    "  AWS_REGION or AWS_DEFAULT_REGION",
  ].join("\n"));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
