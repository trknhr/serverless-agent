import { createUserGoogleCalendarClient } from "../calendar/userGoogleCalendar";
import { ArchivedAttachmentImageReader } from "../attachments/attachmentImageReader";
import { ModelAttachmentImageAnalyzer } from "../attachments/attachmentImageAnalyzer";
import {
  AgentRuntimeRequest,
  agentRuntimeRequestSchema,
} from "./contracts";
import { parseBedrockServiceTier, runAgentTurn } from "./runAgentTurn";
import { CalendarDraftRepository } from "../repo/calendarDraftRepository";
import { ChannelMemoryRepository } from "../repo/channelMemoryRepository";
import { GoogleOAuthConnectionRepository } from "../repo/googleOAuthConnectionRepository";
import { MemoryItemRepository } from "../repo/memoryItemRepository";
import { RecurringTaskRepository } from "../repo/recurringTaskRepository";
import { SourceDocumentRepository } from "../repo/sourceDocumentRepository";
import { TaskRepository } from "../repo/taskRepository";
import { TaskEventRepository } from "../repo/taskEventRepository";
import { TaskStateRepository } from "../repo/taskStateRepository";
import { WorkSessionRepository } from "../repo/workSessionRepository";
import { EventBridgeScheduledReminderScheduler } from "../scheduler/scheduledReminder";
import { UserPreferenceRepository } from "../repo/userPreferenceRepository";
import { SecretsProvider } from "../aws/secretsProvider";
import { logger } from "../shared/logger";
import { CustomToolExecutor } from "../tools/executeCustomTool";
import { OpenMeteoWeatherProvider } from "../weather/openMeteo";
import { WebToolsProvider } from "../web/webTools";
import { createBrowserProvider } from "../browser/factory";
import { DynamoDbSkillRepository } from "../skills/dynamoDbSkillRepository";
import { SkillRegistry } from "../skills/registry";

type DynamicImport = <T = Record<string, unknown>>(specifier: string) => Promise<T>;

const dynamicImport = new Function("specifier", "return import(specifier)") as DynamicImport;

const region = process.env.BEDROCK_REGION ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "ap-northeast-1";
const modelId = requireEnv("BEDROCK_MODEL_ID");
const documentModelId = process.env.BEDROCK_DOCUMENT_MODEL_ID ?? modelId;
const bedrockServiceTier = parseBedrockServiceTier(process.env.BEDROCK_SERVICE_TIER);
const secretsProvider = new SecretsProvider();

async function main(): Promise<void> {
  const [{ BedrockAgentCoreApp }, { createAmazonBedrock }, { defaultProvider }, ai] = await Promise.all([
    dynamicImport<{ BedrockAgentCoreApp: new (options: unknown) => { run: () => void } }>(
      "bedrock-agentcore/runtime",
    ),
    dynamicImport<{ createAmazonBedrock: (options: unknown) => (modelId: string) => unknown }>(
      "@ai-sdk/amazon-bedrock",
    ),
    dynamicImport<{ defaultProvider: () => unknown }>("@aws-sdk/credential-provider-node"),
    dynamicImport<{
      ToolLoopAgent: new (options: unknown) => { stream: (options: unknown) => Promise<{ fullStream: AsyncIterable<Record<string, unknown>> }> };
      generateText: (options: unknown) => Promise<{ text: string }>;
      jsonSchema: (schema: unknown) => unknown;
      tool: (options: unknown) => unknown;
    }>("ai"),
  ]);

  const bedrock = createAmazonBedrock({
    region,
    credentialProvider: defaultProvider(),
  });
  const app = new BedrockAgentCoreApp({
    invocationHandler: {
      requestSchema: agentRuntimeRequestSchema,
      process: async function* (request: AgentRuntimeRequest, context: { sessionId?: string }) {
        const log = logger.child({
          component: "agentcore-runtime",
          runtimeSessionId: context.sessionId,
          source: request.context.source,
        });
        for await (const event of runAgentTurn({
          request,
          sessionId: context.sessionId,
          ai,
          modelProvider: bedrock,
          modelId,
          documentModelId,
          bedrockServiceTier,
          log,
          createExecutor: (request, log, skillRegistry) =>
            createToolExecutor(request, log, skillRegistry, {
              ai,
              modelProvider: bedrock,
            }),
          createSkillRegistry,
        })) {
          yield event;
        }
      },
    },
  });

  app.run();
}

function createToolExecutor(
  request: AgentRuntimeRequest,
  log: ReturnType<typeof logger.child>,
  skillRegistry?: SkillRegistry,
  deps?: {
    ai: {
      generateText: (options: unknown) => Promise<{ text: string }>;
    };
    modelProvider: (modelId: string) => unknown;
  },
): CustomToolExecutor | null {
  if (!request.resources || !request.toolContext) {
    return null;
  }

  const resources = request.resources;
  const sourceDocuments = resources.sourceDocumentsTableName
    ? new SourceDocumentRepository(resources.sourceDocumentsTableName)
    : undefined;

  return new CustomToolExecutor(
    {
      memoryItems: new MemoryItemRepository(resources.memoryItemsTableName),
      channelMemories: new ChannelMemoryRepository(resources.memoryItemsTableName),
      userPreferences: new UserPreferenceRepository(resources.memoryItemsTableName),
      scheduledTasks: new TaskRepository(resources.scheduledTasksTableName),
      tasks: new TaskStateRepository(resources.tasksTableName),
      taskEvents: new TaskEventRepository(resources.taskEventsTableName),
      recurringTasks: new RecurringTaskRepository(resources.recurringTasksTableName),
      calendarDrafts: new CalendarDraftRepository(resources.calendarDraftsTableName),
      workSessions: new WorkSessionRepository(resources.workSessionsTableName),
    },
    {
      workspaceId: request.toolContext.workspaceId,
      userId: request.toolContext.userId,
      channelId: request.toolContext.channelId,
      conversationId: request.context.conversationTs,
      logger: log,
      attachmentSourceIds: request.toolContext.attachmentSourceIds,
      currentRequestText: extractTextContent(request.content),
      memoryWritePolicy: request.toolContext.memoryWritePolicy,
      workSessionPolicy: {
        idleTimeoutSeconds: resources.workSessionIdleTimeoutSeconds,
        maxLifetimeSeconds: resources.workSessionMaxLifetimeSeconds,
        maxActivePerOwner: resources.workSessionMaxActivePerOwner,
      },
    },
    {
      googleCalendarProvider: () =>
        createUserGoogleCalendarClient({
          workspaceId: request.toolContext!.workspaceId,
          userId: request.toolContext!.userId,
          defaultTimeZone: resources.googleCalendarTimeZone,
          googleCalendarSecretId: resources.googleCalendarSecretId,
          googleOAuthStartUrl: resources.googleOAuthStartUrl,
          secretsProvider,
          connections: new GoogleOAuthConnectionRepository(resources.googleOAuthConnectionsTableName),
        }),
      defaultCalendarTimeZone: resources.googleCalendarTimeZone,
      scheduledReminderScheduler:
        resources.schedulerTargetArn && resources.schedulerTargetRoleArn
          ? new EventBridgeScheduledReminderScheduler({
            scheduleGroupName: resources.schedulerScheduleGroupName ?? "default",
            scheduleNamePrefix: resources.schedulerScheduleNamePrefix ?? "serverless-agent",
            defaultTimeZone: resources.schedulerDefaultTimeZone ?? resources.googleCalendarTimeZone,
            targetArn: resources.schedulerTargetArn,
            targetRoleArn: resources.schedulerTargetRoleArn,
          })
          : undefined,
      weatherProvider: new OpenMeteoWeatherProvider(),
      webProvider: new WebToolsProvider({
        searchProvider: resources.webSearchProvider,
        searchApiKeyProvider: resources.webSearchApiKeyParameterName
          ? () => secretsProvider.getSecretString(resources.webSearchApiKeyParameterName!)
          : undefined,
        searchBaseUrl: resources.webSearchBaseUrl,
      }),
      browserProvider: createBrowserProvider({
        provider: resources.browserProvider,
        region,
        browserIdentifier: resources.browserIdentifier,
      }),
      skillRegistry,
      attachmentImageAnalyzer: sourceDocuments && deps
        ? new ModelAttachmentImageAnalyzer({
            reader: new ArchivedAttachmentImageReader(sourceDocuments),
            ai: deps.ai,
            modelProvider: deps.modelProvider,
            modelId: documentModelId,
            bedrockServiceTier: documentModelId === modelId ? bedrockServiceTier : undefined,
            log,
          })
        : undefined,
    },
  );
}

function extractTextContent(content: AgentRuntimeRequest["content"]): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n\n")
    .trim();
}

function createSkillRegistry(request: AgentRuntimeRequest): SkillRegistry {
  const repository = request.resources?.skillsTableName
    ? new DynamoDbSkillRepository(request.resources.skillsTableName)
    : undefined;
  return new SkillRegistry(repository);
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be set`);
  }
  return value;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
