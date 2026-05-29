import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

type ProviderName = "slack" | "line" | "discord";
type BindingKind = "installation" | "conversation";
type BindingStatus = "active" | "disabled";

interface CliOptions {
  tableName: string;
  region?: string;
  provider: ProviderName;
  providerAccountId: string;
  bindingKind: BindingKind;
  providerConversationKey?: string;
  workspaceId: string;
  conversationId?: string;
  status: BindingStatus;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const now = new Date().toISOString();
  const pk = buildProviderPk(options.provider, options.providerAccountId);
  const sk =
    options.bindingKind === "installation"
      ? "INSTALLATION"
      : `CONVERSATION#${requireConversationKey(options)}`;

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
        pk,
        sk,
        provider: options.provider,
        providerAccountId: options.providerAccountId,
        bindingKind: options.bindingKind,
        providerConversationKey: options.providerConversationKey,
        workspaceId: options.workspaceId,
        conversationId: options.conversationId,
        status: options.status,
        createdAt: now,
        updatedAt: now,
      },
    }),
  );

  console.log(`Saved ${options.provider} ${options.bindingKind} binding to ${options.tableName}`);
  console.log(`pk: ${pk}`);
  console.log(`sk: ${sk}`);
}

function parseArgs(argv: string[]): CliOptions {
  const options: Partial<CliOptions> = {
    tableName: process.env.PROVIDER_BINDINGS_TABLE_NAME,
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,
    status: "active",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    switch (value) {
      case "--table-name":
        options.tableName = argv[++index];
        break;
      case "--region":
        options.region = argv[++index];
        break;
      case "--provider":
        options.provider = parseProvider(argv[++index]);
        break;
      case "--provider-account-id":
        options.providerAccountId = argv[++index];
        break;
      case "--binding-kind":
        options.bindingKind = parseBindingKind(argv[++index]);
        break;
      case "--provider-conversation-key":
        options.providerConversationKey = argv[++index];
        break;
      case "--workspace-id":
        options.workspaceId = argv[++index];
        break;
      case "--conversation-id":
        options.conversationId = argv[++index];
        break;
      case "--status":
        options.status = parseStatus(argv[++index]);
        break;
      case "--disabled":
        options.status = "disabled";
        break;
      case "--help":
        printUsage();
        process.exit(0);
      default:
        throw new Error(`Unknown option: ${value}`);
    }
  }

  if (
    !options.tableName ||
    !options.provider ||
    !options.providerAccountId ||
    !options.bindingKind ||
    !options.workspaceId
  ) {
    printUsage();
    throw new Error("Missing required options");
  }

  if (options.bindingKind === "conversation" && !options.providerConversationKey) {
    printUsage();
    throw new Error("Conversation bindings require --provider-conversation-key");
  }

  return {
    tableName: options.tableName,
    region: options.region,
    provider: options.provider,
    providerAccountId: options.providerAccountId,
    bindingKind: options.bindingKind,
    providerConversationKey: options.providerConversationKey,
    workspaceId: options.workspaceId,
    conversationId: options.conversationId,
    status: options.status ?? "active",
  };
}

function parseProvider(value: string): ProviderName {
  if (value === "slack" || value === "line" || value === "discord") {
    return value;
  }

  throw new Error(`Invalid provider: ${value}`);
}

function parseBindingKind(value: string): BindingKind {
  if (value === "installation" || value === "conversation") {
    return value;
  }

  throw new Error(`Invalid binding kind: ${value}`);
}

function parseStatus(value: string): BindingStatus {
  if (value === "active" || value === "disabled") {
    return value;
  }

  throw new Error(`Invalid status: ${value}`);
}

function requireConversationKey(options: CliOptions): string {
  if (!options.providerConversationKey) {
    throw new Error("Conversation bindings require providerConversationKey.");
  }

  return options.providerConversationKey;
}

function buildProviderPk(provider: ProviderName, providerAccountId: string): string {
  return `PROVIDER#${provider}#ACCOUNT#${providerAccountId}`;
}

function printUsage(): void {
  console.log([
    "Usage:",
    "  ts-node scripts/put-provider-binding.ts --table-name TABLE --provider line --provider-account-id LINE_BOT_USER_ID --binding-kind conversation --provider-conversation-key group:LINE_GROUP_ID --workspace-id WORKSPACE_ID [options]",
    "",
    "Options:",
    "  --region ap-northeast-1",
    "  --binding-kind installation|conversation",
    "  --provider slack|line|discord",
    "  --provider-account-id LINE_BOT_USER_ID",
    "  --provider-conversation-key group:LINE_GROUP_ID",
    "  --workspace-id ws_123",
    "  --conversation-id line:group:G1",
    "  --status active|disabled",
    "  --disabled",
    "",
    "Conversation key examples:",
    "  LINE group: group:G123",
    "  LINE room: room:R123",
    "  LINE user: user:U123",
    "  Slack channel: channel:C123",
    "",
    "Environment defaults:",
    "  PROVIDER_BINDINGS_TABLE_NAME",
    "  AWS_REGION or AWS_DEFAULT_REGION",
  ].join("\n"));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
