import * as cdk from "aws-cdk-lib";
import { Duration, Stack } from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as eventsources from "aws-cdk-lib/aws-lambda-event-sources";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import {
  AgentCoreApplication,
  type AgentCoreProjectSpec,
  type DirectoryPath,
  type FilePath,
} from "@aws/agentcore-cdk";
import { Construct } from "constructs";
import { join } from "node:path";

const DEFAULT_PARAMETER_PREFIX = "/example/serverless-agent";

export class SlackAiAssistantStack extends Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const slackSigningParameterName =
      resolveOptionalConfigValue(this, "slackSigningParameterName", "SLACK_SIGNING_PARAMETER_NAME") ??
      `${DEFAULT_PARAMETER_PREFIX}/slack-signing-secret`;
    const slackBotTokenParameterName =
      resolveOptionalConfigValue(this, "slackBotTokenParameterName", "SLACK_BOT_TOKEN_PARAMETER_NAME") ??
      `${DEFAULT_PARAMETER_PREFIX}/slack-bot-token`;
    const lineChannelSecretParameterName =
      resolveOptionalConfigValue(this, "lineChannelSecretParameterName", "LINE_CHANNEL_SECRET_PARAMETER_NAME") ??
      `${DEFAULT_PARAMETER_PREFIX}/line-channel-secret`;
    const lineChannelAccessTokenParameterName =
      resolveOptionalConfigValue(
        this,
        "lineChannelAccessTokenParameterName",
        "LINE_CHANNEL_ACCESS_TOKEN_PARAMETER_NAME",
      ) ??
      `${DEFAULT_PARAMETER_PREFIX}/line-channel-access-token`;
    const googleCalendarParameterName =
      resolveOptionalConfigValue(this, "googleCalendarParameterName", "GOOGLE_CALENDAR_PARAMETER_NAME") ??
      `${DEFAULT_PARAMETER_PREFIX}/google-calendar`;
    const webSearchProvider = resolveOptionalConfigValue(this, "webSearchProvider", "WEB_SEARCH_PROVIDER");
    const webSearchApiKeyParameterName = resolveOptionalConfigValue(
      this,
      "webSearchApiKeyParameterName",
      "WEB_SEARCH_API_KEY_PARAMETER_NAME",
    );
    const webSearchBaseUrl = resolveOptionalConfigValue(this, "webSearchBaseUrl", "WEB_SEARCH_BASE_URL");
    const browserProvider = resolveOptionalConfigValue(this, "browserProvider", "BROWSER_PROVIDER");
    const browserIdentifier = resolveOptionalConfigValue(this, "browserIdentifier", "BROWSER_IDENTIFIER");
    const googleCalendarTimeZone =
      resolveOptionalConfigValue(this, "googleCalendarTimeZone", "GOOGLE_CALENDAR_TIME_ZONE") ?? "Asia/Tokyo";
    const schedulerScheduleGroupName =
      resolveOptionalConfigValue(this, "schedulerScheduleGroupName", "SCHEDULER_SCHEDULE_GROUP_NAME") ??
      "default";
    const schedulerScheduleNamePrefix =
      resolveOptionalConfigValue(this, "schedulerScheduleNamePrefix", "SCHEDULER_SCHEDULE_NAME_PREFIX") ??
      "serverless-agent";
    const schedulerDefaultTimeZone =
      resolveOptionalConfigValue(this, "schedulerDefaultTimeZone", "SCHEDULER_DEFAULT_TIME_ZONE") ??
      googleCalendarTimeZone;
    const workSessionIdleTimeoutSeconds =
      resolveOptionalConfigValue(this, "workSessionIdleTimeoutSeconds", "WORK_SESSION_IDLE_TIMEOUT_SECONDS") ??
      "900";
    const workSessionMaxLifetimeSeconds =
      resolveOptionalConfigValue(this, "workSessionMaxLifetimeSeconds", "WORK_SESSION_MAX_LIFETIME_SECONDS") ??
      "28800";
    const workSessionMaxActivePerOwner =
      resolveOptionalConfigValue(this, "workSessionMaxActivePerOwner", "WORK_SESSION_MAX_ACTIVE_PER_OWNER") ??
      "2";
    const schedulerDailySendLimit =
      resolveOptionalConfigValue(this, "schedulerDailySendLimit", "SCHEDULER_DAILY_SEND_LIMIT") ??
      "5";
    const dailyLimitTTLSeconds =
      resolveOptionalConfigValue(this, "dailyLimitTTLSeconds", "DAILY_LIMIT_TTL_SECONDS") ??
      "259200";
    const defaultResponseLanguage = resolveOptionalConfigValue(
      this,
      "defaultResponseLanguage",
      "DEFAULT_RESPONSE_LANGUAGE",
    );
    const lineWorkspaceResolutionMode =
      resolveOptionalConfigValue(this, "lineWorkspaceResolutionMode", "LINE_WORKSPACE_RESOLUTION_MODE") ??
      "fallback";
    const defaultScheduleChannel =
      resolveOptionalConfigValue(this, "defaultScheduleChannel", "DEFAULT_SCHEDULE_CHANNEL") ??
      "C_PLACEHOLDER";
    const publicBaseUrl = resolveOptionalConfigValue(this, "publicBaseUrl", "PUBLIC_BASE_URL");
    const configuredGoogleOAuthStartUrl = publicBaseUrl
      ? `${trimTrailingSlash(publicBaseUrl)}/oauth/google/start`
      : undefined;
    const agentCoreRuntimeQualifier =
      resolveOptionalConfigValue(this, "agentCoreRuntimeQualifier", "AGENTCORE_RUNTIME_QUALIFIER") ?? "";
    const bedrockModelId = resolveRequiredConfigValue(this, "bedrockModelId", "BEDROCK_MODEL_ID");
    const bedrockRegion = resolveOptionalConfigValue(this, "bedrockRegion", "BEDROCK_REGION");
    const bedrockServiceTier = resolveOptionalConfigValue(this, "bedrockServiceTier", "BEDROCK_SERVICE_TIER");
    const bedrockDocumentModelId =
      resolveOptionalConfigValue(this, "bedrockDocumentModelId", "BEDROCK_DOCUMENT_MODEL_ID") ??
      bedrockModelId;
    const customSystemPrompt = resolveOptionalConfigValue(this, "customSystemPrompt", "CUSTOM_SYSTEM_PROMPT");
    const systemPromptMode =
      resolveOptionalConfigValue(this, "systemPromptMode", "SYSTEM_PROMPT_MODE") ?? "append";
    validateSystemPromptMode(systemPromptMode);

    const sessionTable = new dynamodb.Table(this, "SlackThreadSessionsTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    const conversationSessionsTable = new dynamodb.Table(this, "ConversationSessionsTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    const workSessionsTable = new dynamodb.Table(this, "WorkSessionsTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    const conversationTurnsTable = new dynamodb.Table(this, "ConversationTurnsTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    conversationTurnsTable.addGlobalSecondaryIndex({
      indexName: "ChannelScopeIndex",
      partitionKey: { name: "gsi1pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "gsi1sk", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Turn-trace capture is opt-in: without the flag no table is created and
    // the runtime/workers skip trace writes entirely.
    const agentTurnTracesEnabled =
      (resolveOptionalConfigValue(this, "enableAgentTurnTraces", "ENABLE_AGENT_TURN_TRACES") ?? "")
        .toLowerCase() === "true";
    const agentTurnTracesTable = agentTurnTracesEnabled
      ? new dynamodb.Table(this, "AgentTurnTracesTable", {
          partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
          sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
          billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
          timeToLiveAttribute: "expires_at",
          pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        })
      : undefined;
    agentTurnTracesTable?.addGlobalSecondaryIndex({
      indexName: "TraceIdIndex",
      partitionKey: { name: "gsi1pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "gsi1sk", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const memoryItemsTable = new dynamodb.Table(this, "MemoryItemsTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    memoryItemsTable.addGlobalSecondaryIndex({
      indexName: "EntityIndex",
      partitionKey: { name: "gsi1pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "gsi1sk", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const tasksTable = new dynamodb.Table(this, "TasksTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    tasksTable.addGlobalSecondaryIndex({
      indexName: "StatusIndex",
      partitionKey: { name: "gsi1pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "gsi1sk", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const calendarDraftsTable = new dynamodb.Table(this, "CalendarDraftsTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    const taskEventsTable = new dynamodb.Table(this, "TaskEventsTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    const processedEventsTable = new dynamodb.Table(this, "ProcessedEventsTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    const scheduledTasksTable = new dynamodb.Table(this, "ScheduledTasksTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });
    scheduledTasksTable.addGlobalSecondaryIndex({
      indexName: "WorkspaceIndex",
      partitionKey: { name: "workspaceId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "taskId", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const recurringTasksTable = new dynamodb.Table(this, "RecurringTasksTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    const providerBindingsTable = new dynamodb.Table(this, "ProviderBindingsTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    const skillsTable = new dynamodb.Table(this, "SkillsTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    const sourceDocumentsTable = new dynamodb.Table(this, "SourceDocumentsTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    const googleOAuthConnectionsTable = new dynamodb.Table(this, "GoogleOAuthConnectionsTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    const attachmentArchiveBucket = new s3.Bucket(this, "SlackAttachmentArchiveBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
    });
    attachmentArchiveBucket.addLifecycleRule({
      id: "ExpireRawPrivateLineObjects",
      prefix: "raw/private/line/",
      expiration: Duration.days(1),
    });

    const dlq = new sqs.Queue(this, "SlackEventsDlq", {
      retentionPeriod: Duration.days(14),
    });

    const slackEventsQueue = new sqs.Queue(this, "SlackEventsQueue", {
      visibilityTimeout: Duration.minutes(5),
      deadLetterQueue: {
        queue: dlq,
        maxReceiveCount: 3,
      },
    });

    const lineEventsDlq = new sqs.Queue(this, "LineEventsDlq", {
      retentionPeriod: Duration.days(14),
    });

    const lineEventsQueue = new sqs.Queue(this, "LineEventsQueue", {
      visibilityTimeout: Duration.minutes(5),
      deadLetterQueue: {
        queue: lineEventsDlq,
        maxReceiveCount: 3,
      },
    });

    const documentImportDlq = new sqs.Queue(this, "DocumentImportDlq", {
      retentionPeriod: Duration.days(14),
    });

    const documentImportQueue = new sqs.Queue(this, "DocumentImportQueue", {
      visibilityTimeout: Duration.minutes(5),
      deadLetterQueue: {
        queue: documentImportDlq,
        maxReceiveCount: 3,
      },
    });

    const agentCoreApplication = new AgentCoreApplication(this, "AgentCoreApplication", {
      spec: buildAgentCoreProjectSpec({
        bedrockModelId,
        bedrockRegion,
        bedrockServiceTier,
        bedrockDocumentModelId,
        customSystemPrompt,
        systemPromptMode,
      }),
    });
    const slackAgentRuntime = agentCoreApplication.environments.get("SlackAgent")?.runtime;
    if (!slackAgentRuntime) {
      throw new Error("AgentCore runtime SlackAgent was not created.");
    }

    const commonRuntimeEnvironment = {
      SESSION_TABLE_NAME: sessionTable.tableName,
      CONVERSATION_SESSIONS_TABLE_NAME: conversationSessionsTable.tableName,
      WORK_SESSIONS_TABLE_NAME: workSessionsTable.tableName,
      CONVERSATION_TURNS_TABLE_NAME: conversationTurnsTable.tableName,
      MEMORY_ITEMS_TABLE_NAME: memoryItemsTable.tableName,
      ...(agentTurnTracesTable ? { AGENT_TURN_TRACES_TABLE_NAME: agentTurnTracesTable.tableName } : {}),
      TASKS_TABLE_NAME: tasksTable.tableName,
      TASK_EVENTS_TABLE_NAME: taskEventsTable.tableName,
      RECURRING_TASKS_TABLE_NAME: recurringTasksTable.tableName,
      PROVIDER_BINDINGS_TABLE_NAME: providerBindingsTable.tableName,
      PROCESSED_EVENTS_TABLE_NAME: processedEventsTable.tableName,
      TASK_TABLE_NAME: scheduledTasksTable.tableName,
      SLACK_SIGNING_SECRET_SECRET_ID: slackSigningParameterName,
      SLACK_BOT_TOKEN_SECRET_ID: slackBotTokenParameterName,
      AGENTCORE_RUNTIME_ARN: slackAgentRuntime.runtimeArn,
      AGENTCORE_RUNTIME_QUALIFIER: agentCoreRuntimeQualifier,
      DEFAULT_SCHEDULE_CHANNEL: defaultScheduleChannel,
      SCHEDULER_SCHEDULE_GROUP_NAME: schedulerScheduleGroupName,
      SCHEDULER_SCHEDULE_NAME_PREFIX: schedulerScheduleNamePrefix,
      SCHEDULER_DEFAULT_TIME_ZONE: schedulerDefaultTimeZone,
      SCHEDULER_DAILY_SEND_LIMIT: schedulerDailySendLimit,
      DAILY_LIMIT_TTL_SECONDS: dailyLimitTTLSeconds,
      WORK_SESSION_IDLE_TIMEOUT_SECONDS: workSessionIdleTimeoutSeconds,
      WORK_SESSION_MAX_LIFETIME_SECONDS: workSessionMaxLifetimeSeconds,
      WORK_SESSION_MAX_ACTIVE_PER_OWNER: workSessionMaxActivePerOwner,
      EVENT_DEDUP_TTL_SECONDS: "86400",
      AGENT_RESPONSE_TIMEOUT_MS: "120000",
      ...(defaultResponseLanguage ? { DEFAULT_RESPONSE_LANGUAGE: defaultResponseLanguage } : {}),
      TOP_LEVEL_CONTEXT_TURN_LIMIT: "10",
      MAX_SLACK_FILE_BYTES: "10000000",
    };

    const commonEnvironment = {
      ...commonRuntimeEnvironment,
      SLACK_SIGNING_SECRET_SECRET_ID: slackSigningParameterName,
      SLACK_BOT_TOKEN_SECRET_ID: slackBotTokenParameterName,
    };

    const toolEnvironment = {
      CALENDAR_DRAFTS_TABLE_NAME: calendarDraftsTable.tableName,
      GOOGLE_CALENDAR_SECRET_ID: googleCalendarParameterName,
      GOOGLE_OAUTH_CONNECTIONS_TABLE_NAME: googleOAuthConnectionsTable.tableName,
      GOOGLE_CALENDAR_TIME_ZONE: googleCalendarTimeZone,
      SKILLS_TABLE_NAME: skillsTable.tableName,
      ...(webSearchProvider ? { WEB_SEARCH_PROVIDER: webSearchProvider } : {}),
      ...(webSearchApiKeyParameterName ? { WEB_SEARCH_API_KEY_PARAMETER_NAME: webSearchApiKeyParameterName } : {}),
      ...(webSearchBaseUrl ? { WEB_SEARCH_BASE_URL: webSearchBaseUrl } : {}),
      ...(browserProvider ? { BROWSER_PROVIDER: browserProvider } : {}),
      ...(browserIdentifier ? { BROWSER_IDENTIFIER: browserIdentifier } : {}),
    };

    const ingress = createNodeFunction(this, "SlackEventsIngressFunction", {
      entry: "slack-events-ingress",
      timeout: Duration.seconds(10),
      memorySize: 256,
      environment: {
        ...commonEnvironment,
        SLACK_QUEUE_URL: slackEventsQueue.queueUrl,
      },
    });

    const worker = createNodeFunction(this, "SlackEventsWorkerFunction", {
      entry: "slack-events-worker",
      timeout: Duration.minutes(5),
      memorySize: 2048,
      environment: {
        ...commonEnvironment,
        ...toolEnvironment,
        SOURCE_DOCUMENTS_TABLE_NAME: sourceDocumentsTable.tableName,
        SLACK_ATTACHMENT_ARCHIVE_BUCKET_NAME: attachmentArchiveBucket.bucketName,
      },
    });

    const lineIngress = createNodeFunction(this, "LineEventsIngressFunction", {
      entry: "line-events-ingress",
      timeout: Duration.seconds(10),
      memorySize: 256,
      environment: {
        ...commonRuntimeEnvironment,
        LINE_CHANNEL_SECRET_SECRET_ID: lineChannelSecretParameterName,
        LINE_QUEUE_URL: lineEventsQueue.queueUrl,
        LINE_WORKSPACE_RESOLUTION_MODE: lineWorkspaceResolutionMode,
      },
    });

    const lineWorker = createNodeFunction(this, "LineEventsWorkerFunction", {
      entry: "line-events-worker",
      timeout: Duration.minutes(5),
      memorySize: 512,
      environment: {
        ...commonRuntimeEnvironment,
        ...toolEnvironment,
        LINE_CHANNEL_ACCESS_TOKEN_SECRET_ID: lineChannelAccessTokenParameterName,
        SOURCE_DOCUMENTS_TABLE_NAME: sourceDocumentsTable.tableName,
        LINE_ATTACHMENT_ARCHIVE_BUCKET_NAME: attachmentArchiveBucket.bucketName,
      },
    });

    const documentImportApi = createNodeFunction(this, "DocumentImportApiFunction", {
      entry: "document-import-api",
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: {
        ...commonEnvironment,
        SOURCE_DOCUMENTS_TABLE_NAME: sourceDocumentsTable.tableName,
        DOCUMENT_IMPORT_QUEUE_URL: documentImportQueue.queueUrl,
        DOCUMENT_ARCHIVE_BUCKET_NAME: attachmentArchiveBucket.bucketName,
      },
    });

    const documentImportWorker = createNodeFunction(this, "DocumentImportWorkerFunction", {
      entry: "document-import-worker",
      timeout: Duration.minutes(5),
      memorySize: 512,
      environment: {
        ...commonEnvironment,
        ...toolEnvironment,
        SOURCE_DOCUMENTS_TABLE_NAME: sourceDocumentsTable.tableName,
        DOCUMENT_ARCHIVE_BUCKET_NAME: attachmentArchiveBucket.bucketName,
      },
    });

    const chatApi = createNodeFunction(this, "ChatApiFunction", {
      entry: "chat-api",
      timeout: Duration.seconds(29),
      memorySize: 512,
      environment: {
        ...commonEnvironment,
        ...toolEnvironment,
      },
    });

    const scheduledRunner = createNodeFunction(this, "ScheduledAgentRunnerFunction", {
      entry: "scheduled-agent-runner",
      timeout: Duration.minutes(5),
      memorySize: 512,
      environment: {
        ...commonEnvironment,
        ...toolEnvironment,
        LINE_CHANNEL_ACCESS_TOKEN_SECRET_ID: lineChannelAccessTokenParameterName,
      },
    });

    const slackInteractions = createNodeFunction(this, "SlackInteractionsFunction", {
      entry: "slack-interactions",
      timeout: Duration.seconds(30),
      memorySize: 512,
      environment: {
        ...commonEnvironment,
        ...toolEnvironment,
      },
    });

    const googleOAuth = createNodeFunction(this, "GoogleOAuthFunction", {
      entry: "google-oauth",
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: {
        ...commonEnvironment,
        GOOGLE_CALENDAR_SECRET_ID: googleCalendarParameterName,
        GOOGLE_OAUTH_CONNECTIONS_TABLE_NAME: googleOAuthConnectionsTable.tableName,
        GOOGLE_CALENDAR_TIME_ZONE: googleCalendarTimeZone,
      },
    });

    worker.addEventSource(
      new eventsources.SqsEventSource(slackEventsQueue, {
        batchSize: 1,
      }),
    );

    lineWorker.addEventSource(
      new eventsources.SqsEventSource(lineEventsQueue, {
        batchSize: 1,
      }),
    );

    documentImportWorker.addEventSource(
      new eventsources.SqsEventSource(documentImportQueue, {
        batchSize: 1,
      }),
    );

    slackEventsQueue.grantSendMessages(ingress);
    lineEventsQueue.grantSendMessages(lineIngress);
    documentImportQueue.grantSendMessages(documentImportApi);
    sessionTable.grantReadWriteData(worker);
    sessionTable.grantReadWriteData(scheduledRunner);
    conversationSessionsTable.grantReadWriteData(worker);
    conversationSessionsTable.grantReadWriteData(lineWorker);
    conversationSessionsTable.grantReadWriteData(scheduledRunner);
    conversationTurnsTable.grantReadWriteData(worker);
    conversationTurnsTable.grantReadWriteData(lineWorker);
    conversationTurnsTable.grantReadWriteData(scheduledRunner);
    memoryItemsTable.grantReadWriteData(worker);
    memoryItemsTable.grantReadWriteData(scheduledRunner);
    memoryItemsTable.grantReadWriteData(documentImportWorker);
    memoryItemsTable.grantReadWriteData(chatApi);
    googleOAuthConnectionsTable.grantReadWriteData(worker);
    googleOAuthConnectionsTable.grantReadWriteData(scheduledRunner);
    googleOAuthConnectionsTable.grantReadWriteData(documentImportWorker);
    googleOAuthConnectionsTable.grantReadWriteData(chatApi);
    googleOAuthConnectionsTable.grantReadWriteData(slackInteractions);
    googleOAuthConnectionsTable.grantReadWriteData(googleOAuth);
    sourceDocumentsTable.grantReadWriteData(worker);
    sourceDocumentsTable.grantReadWriteData(lineWorker);
    sourceDocumentsTable.grantReadWriteData(documentImportApi);
    sourceDocumentsTable.grantReadWriteData(documentImportWorker);
    tasksTable.grantReadWriteData(worker);
    tasksTable.grantReadWriteData(scheduledRunner);
    tasksTable.grantReadWriteData(documentImportWorker);
    tasksTable.grantReadWriteData(chatApi);
    tasksTable.grantReadWriteData(slackInteractions);
    calendarDraftsTable.grantReadWriteData(worker);
    calendarDraftsTable.grantReadWriteData(scheduledRunner);
    calendarDraftsTable.grantReadWriteData(documentImportWorker);
    calendarDraftsTable.grantReadWriteData(chatApi);
    calendarDraftsTable.grantReadWriteData(slackInteractions);
    taskEventsTable.grantReadWriteData(worker);
    taskEventsTable.grantReadWriteData(scheduledRunner);
    taskEventsTable.grantReadWriteData(documentImportWorker);
    taskEventsTable.grantReadWriteData(chatApi);
    taskEventsTable.grantReadWriteData(slackInteractions);
    processedEventsTable.grantReadWriteData(ingress);
    processedEventsTable.grantReadWriteData(lineIngress);
    processedEventsTable.grantReadWriteData(scheduledRunner);
    skillsTable.grantReadWriteData(chatApi);
    scheduledTasksTable.grantReadWriteData(scheduledRunner);
    recurringTasksTable.grantReadWriteData(scheduledRunner);
    providerBindingsTable.grantReadData(ingress);
    providerBindingsTable.grantReadData(lineIngress);
    memoryItemsTable.grantReadWriteData(slackInteractions);
    workSessionsTable.grantReadWriteData(slackAgentRuntime.role);
    attachmentArchiveBucket.grantPut(worker, "raw/private/slack/*");
    attachmentArchiveBucket.grantRead(worker, "raw/private/slack/*");
    attachmentArchiveBucket.grantPut(lineWorker, "raw/private/line/*");
    attachmentArchiveBucket.grantPut(documentImportApi, "raw/private/imports/*");
    attachmentArchiveBucket.grantPut(documentImportApi, "raw/private/notes/*");
    attachmentArchiveBucket.grantRead(documentImportApi, "raw/private/imports/*");
    attachmentArchiveBucket.grantRead(documentImportApi, "derived/private/extractions/*");
    attachmentArchiveBucket.grantRead(documentImportWorker, "raw/private/imports/*");
    attachmentArchiveBucket.grantRead(documentImportWorker, "raw/private/notes/*");
    attachmentArchiveBucket.grantPut(documentImportWorker, "derived/private/extractions/*");

    grantSecureParameterRead(this, slackSigningParameterName, [ingress, slackInteractions, googleOAuth]);
    grantSecureParameterRead(this, slackBotTokenParameterName, [worker, scheduledRunner, slackInteractions]);
    grantSecureParameterRead(this, lineChannelSecretParameterName, [lineIngress]);
    grantSecureParameterRead(this, lineChannelAccessTokenParameterName, [lineWorker, scheduledRunner]);
    grantSecureParameterRead(this, googleCalendarParameterName, [
      worker,
      scheduledRunner,
      documentImportWorker,
      chatApi,
      slackInteractions,
      googleOAuth,
      slackAgentRuntime.role,
    ]);
    if (webSearchApiKeyParameterName) {
      grantSecureParameterRead(this, webSearchApiKeyParameterName, [slackAgentRuntime.role]);
    }

    memoryItemsTable.grantReadWriteData(slackAgentRuntime.role);
    sourceDocumentsTable.grantReadData(slackAgentRuntime.role);
    scheduledTasksTable.grantReadWriteData(slackAgentRuntime.role);
    tasksTable.grantReadWriteData(slackAgentRuntime.role);
    taskEventsTable.grantReadWriteData(slackAgentRuntime.role);
    recurringTasksTable.grantReadWriteData(slackAgentRuntime.role);
    calendarDraftsTable.grantReadWriteData(slackAgentRuntime.role);
    googleOAuthConnectionsTable.grantReadWriteData(slackAgentRuntime.role);
    skillsTable.grantReadWriteData(slackAgentRuntime.role);
    if (agentTurnTracesTable) {
      agentTurnTracesTable.grantReadWriteData(slackAgentRuntime.role);
      agentTurnTracesTable.grantReadWriteData(worker);
      agentTurnTracesTable.grantReadWriteData(lineWorker);
      agentTurnTracesTable.grantReadWriteData(scheduledRunner);
    }
    attachmentArchiveBucket.grantRead(slackAgentRuntime.role, "raw/private/line/*");
    slackAgentRuntime.addToPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        resources: ["*"],
      }),
    );
    slackAgentRuntime.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "bedrock-agentcore:ConnectBrowserAutomationStream",
          "bedrock-agentcore:GetBrowserSession",
          "bedrock-agentcore:ListBrowserSessions",
          "bedrock-agentcore:StartBrowserSession",
          "bedrock-agentcore:StopBrowserSession",
          "bedrock-agentcore:UpdateBrowserStream",
        ],
        resources: ["*"],
      }),
    );
    slackAgentRuntime.grantInvoke(worker);
    slackAgentRuntime.grantInvoke(lineWorker);
    slackAgentRuntime.grantInvoke(scheduledRunner);
    slackAgentRuntime.grantInvoke(documentImportWorker);
    slackAgentRuntime.grantInvoke(chatApi);
    for (const agentInvoker of [worker, lineWorker, scheduledRunner, documentImportWorker, chatApi]) {
      agentInvoker.addToRolePolicy(
        new iam.PolicyStatement({
          actions: [
            "bedrock-agentcore:InvokeAgentRuntime",
            "bedrock-agentcore:InvokeAgentRuntimeForUser",
          ],
          resources: [
            slackAgentRuntime.runtimeArn,
            cdk.Fn.join("", [slackAgentRuntime.runtimeArn, "/runtime-endpoint/*"]),
          ],
        }),
      );
    }

    const api = new apigateway.RestApi(this, "SlackEventsApi", {
      restApiName: "serverless-agent-events",
      deployOptions: {
        stageName: "prod",
      },
    });

    const slackEventsResource = api.root.addResource("slack").addResource("events");
    slackEventsResource.addMethod("POST", new apigateway.LambdaIntegration(ingress));
    api.root
      .getResource("slack")!
      .addResource("interactions")
      .addMethod("POST", new apigateway.LambdaIntegration(slackInteractions));
    api.root
      .addResource("line")
      .addResource("webhook")
      .addMethod("POST", new apigateway.LambdaIntegration(lineIngress));
    const oauthResource = api.root.addResource("oauth").addResource("google");
    oauthResource.addResource("start").addMethod("GET", new apigateway.LambdaIntegration(googleOAuth));
    oauthResource.addResource("callback").addMethod("GET", new apigateway.LambdaIntegration(googleOAuth));

    const googleOAuthStartUrl =
      configuredGoogleOAuthStartUrl ??
      cdk.Fn.sub("https://${RestApiId}.execute-api.${AWS::Region}.${AWS::URLSuffix}/prod/oauth/google/start", {
        RestApiId: api.restApiId,
      });
    worker.addEnvironment("GOOGLE_OAUTH_START_URL", googleOAuthStartUrl);
    scheduledRunner.addEnvironment("GOOGLE_OAUTH_START_URL", googleOAuthStartUrl);
    lineWorker.addEnvironment("GOOGLE_OAUTH_START_URL", googleOAuthStartUrl);
    documentImportWorker.addEnvironment("GOOGLE_OAUTH_START_URL", googleOAuthStartUrl);
    chatApi.addEnvironment("GOOGLE_OAUTH_START_URL", googleOAuthStartUrl);
    slackInteractions.addEnvironment("GOOGLE_OAUTH_START_URL", googleOAuthStartUrl);
    const importsResource = api.root.addResource("imports");
    importsResource.addResource("uploads").addMethod("POST", new apigateway.LambdaIntegration(documentImportApi), {
      authorizationType: apigateway.AuthorizationType.IAM,
    });
    importsResource.addResource("documents").addMethod("POST", new apigateway.LambdaIntegration(documentImportApi), {
      authorizationType: apigateway.AuthorizationType.IAM,
    });
    importsResource.addResource("markdown").addMethod("POST", new apigateway.LambdaIntegration(documentImportApi), {
      authorizationType: apigateway.AuthorizationType.IAM,
    });
    importsResource
      .addResource("extractions")
      .addResource("markdown")
      .addMethod("POST", new apigateway.LambdaIntegration(documentImportApi), {
        authorizationType: apigateway.AuthorizationType.IAM,
      });
    const importSourceResource = importsResource
      .addResource("workspaces")
      .addResource("{workspaceId}")
      .addResource("sources")
      .addResource("{sourceId}");
    importSourceResource.addMethod("GET", new apigateway.LambdaIntegration(documentImportApi), {
      authorizationType: apigateway.AuthorizationType.IAM,
    });
    importSourceResource.addResource("markdown").addMethod("GET", new apigateway.LambdaIntegration(documentImportApi), {
      authorizationType: apigateway.AuthorizationType.IAM,
    });
    api.root
      .addResource("chat")
      .addResource("messages")
      .addMethod("POST", new apigateway.LambdaIntegration(chatApi), {
        authorizationType: apigateway.AuthorizationType.IAM,
      });
    const adminBuiltinSkillsResource = api.root
      .addResource("admin")
      .addResource("workspaces")
      .addResource("{workspaceId}")
      .addResource("builtin-skills");
    adminBuiltinSkillsResource.addMethod("GET", new apigateway.LambdaIntegration(chatApi), {
      authorizationType: apigateway.AuthorizationType.IAM,
    });
    adminBuiltinSkillsResource.addResource("{skillId}").addMethod("PATCH", new apigateway.LambdaIntegration(chatApi), {
      authorizationType: apigateway.AuthorizationType.IAM,
    });

    const schedulerInvokeRole = new iam.Role(this, "SchedulerInvokeRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
    });
    scheduledRunner.grantInvoke(schedulerInvokeRole);
    const scheduledReminderScheduleGroup =
      schedulerScheduleGroupName === "default"
        ? undefined
        : new scheduler.CfnScheduleGroup(this, "ScheduledReminderScheduleGroup", {
            name: schedulerScheduleGroupName,
          });
    for (const agentInvoker of [worker, lineWorker, documentImportWorker, chatApi]) {
      agentInvoker.addEnvironment("SCHEDULER_TARGET_ARN", scheduledRunner.functionArn);
      agentInvoker.addEnvironment("SCHEDULER_TARGET_ROLE_ARN", schedulerInvokeRole.roleArn);
    }
    const scheduledReminderArnPattern = this.formatArn({
      service: "scheduler",
      resource: "schedule",
      resourceName: `${schedulerScheduleGroupName}/${schedulerScheduleNamePrefix}-*`,
    });
    slackAgentRuntime.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "scheduler:CreateSchedule",
          "scheduler:DeleteSchedule",
          "scheduler:GetSchedule",
          "scheduler:UpdateSchedule",
        ],
        resources: [scheduledReminderArnPattern],
      }),
    );
    slackAgentRuntime.addToPolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [schedulerInvokeRole.roleArn],
        conditions: {
          StringEquals: {
            "iam:PassedToService": "scheduler.amazonaws.com",
          },
        },
      }),
    );

    if (scheduledReminderScheduleGroup) {
      scheduledRunner.node.addDependency(scheduledReminderScheduleGroup);
    }

    new cdk.CfnOutput(this, "SlackEventsUrl", {
      value: `${api.url}slack/events`,
    });
    new cdk.CfnOutput(this, "SlackEventsQueueUrl", {
      value: slackEventsQueue.queueUrl,
    });
    new cdk.CfnOutput(this, "LineWebhookUrl", {
      value: `${api.url}line/webhook`,
    });
    new cdk.CfnOutput(this, "LineEventsQueueUrl", {
      value: lineEventsQueue.queueUrl,
    });
    new cdk.CfnOutput(this, "DocumentImportApiFunctionName", {
      value: documentImportApi.functionName,
    });
    new cdk.CfnOutput(this, "ChatApiFunctionName", {
      value: chatApi.functionName,
    });
    new cdk.CfnOutput(this, "DocumentImportWorkerFunctionName", {
      value: documentImportWorker.functionName,
    });
    new cdk.CfnOutput(this, "DocumentImportQueueUrl", {
      value: documentImportQueue.queueUrl,
    });
    new cdk.CfnOutput(this, "ScheduledAgentRunnerFunctionName", {
      value: scheduledRunner.functionName,
    });
    new cdk.CfnOutput(this, "SlackEventsIngressFunctionName", {
      value: ingress.functionName,
    });
    new cdk.CfnOutput(this, "SlackEventsWorkerFunctionName", {
      value: worker.functionName,
    });
    new cdk.CfnOutput(this, "LineEventsIngressFunctionName", {
      value: lineIngress.functionName,
    });
    new cdk.CfnOutput(this, "LineEventsWorkerFunctionName", {
      value: lineWorker.functionName,
    });
    new cdk.CfnOutput(this, "SlackInteractionsUrl", {
      value: `${api.url}slack/interactions`,
    });
    new cdk.CfnOutput(this, "SlackInteractionsFunctionName", {
      value: slackInteractions.functionName,
    });
    new cdk.CfnOutput(this, "GoogleOAuthStartUrl", {
      value: `${api.url}oauth/google/start`,
    });
    new cdk.CfnOutput(this, "GoogleOAuthCallbackUrl", {
      value: `${api.url}oauth/google/callback`,
    });
    new cdk.CfnOutput(this, "GoogleOAuthFunctionName", {
      value: googleOAuth.functionName,
    });
    new cdk.CfnOutput(this, "ScheduledTasksTableName", {
      value: scheduledTasksTable.tableName,
    });
    new cdk.CfnOutput(this, "RecurringTasksTableName", {
      value: recurringTasksTable.tableName,
    });
    new cdk.CfnOutput(this, "ProviderBindingsTableName", {
      value: providerBindingsTable.tableName,
    });
    new cdk.CfnOutput(this, "MemoryItemsTableName", {
      value: memoryItemsTable.tableName,
    });
    new cdk.CfnOutput(this, "ConversationSessionsTableName", {
      value: conversationSessionsTable.tableName,
    });
    new cdk.CfnOutput(this, "WorkSessionsTableName", {
      value: workSessionsTable.tableName,
    });
    new cdk.CfnOutput(this, "ConversationTurnsTableName", {
      value: conversationTurnsTable.tableName,
    });
    if (agentTurnTracesTable) {
      new cdk.CfnOutput(this, "AgentTurnTracesTableName", {
        value: agentTurnTracesTable.tableName,
      });
    }
    new cdk.CfnOutput(this, "SourceDocumentsTableName", {
      value: sourceDocumentsTable.tableName,
    });
    new cdk.CfnOutput(this, "TasksTableName", {
      value: tasksTable.tableName,
    });
    new cdk.CfnOutput(this, "TaskEventsTableName", {
      value: taskEventsTable.tableName,
    });
    new cdk.CfnOutput(this, "CalendarDraftsTableName", {
      value: calendarDraftsTable.tableName,
    });
    new cdk.CfnOutput(this, "GoogleOAuthConnectionsTableName", {
      value: googleOAuthConnectionsTable.tableName,
    });
    new cdk.CfnOutput(this, "SkillsTableName", {
      value: skillsTable.tableName,
    });
    new cdk.CfnOutput(this, "SlackAttachmentArchiveBucketName", {
      value: attachmentArchiveBucket.bucketName,
    });
  }
}

function resolveRequiredConfigValue(stack: Stack, contextKey: string, envVarName: string): string {
  const value = resolveOptionalConfigValue(stack, contextKey, envVarName);
  if (!value) {
    throw new Error(
      `Missing required CDK config '${contextKey}'. Set it via 'cdk deploy -c ${contextKey}=...' or ${envVarName} in .env/.env.local.`,
    );
  }

  return value;
}

function resolveOptionalConfigValue(stack: Stack, contextKey: string, envVarName: string): string | undefined {
  const contextValue = normalizeConfigValue(stack.node.tryGetContext(contextKey));
  if (contextValue) {
    return contextValue;
  }

  const envValue = normalizeConfigValue(process.env[envVarName]);
  if (envValue) {
    return envValue;
  }

  return undefined;
}

interface NodeFunctionProps {
  entry: string;
  timeout: Duration;
  memorySize: number;
  environment: Record<string, string>;
}

function createNodeFunction(scope: Construct, id: string, props: NodeFunctionProps): nodejs.NodejsFunction {
  return new nodejs.NodejsFunction(scope, id, {
    runtime: lambda.Runtime.NODEJS_20_X,
    entry: join(__dirname, `../src/functions/${props.entry}/index.ts`),
    handler: "handler",
    timeout: props.timeout,
    memorySize: props.memorySize,
    environment: props.environment,
    bundling: {
      target: "node20",
    },
  });
}

function buildAgentCoreProjectSpec(input: {
  bedrockModelId: string;
  bedrockRegion?: string;
  bedrockServiceTier?: string;
  bedrockDocumentModelId: string;
  customSystemPrompt?: string;
  systemPromptMode: string;
}): AgentCoreProjectSpec {
  return {
    name: "SlackAiAssistant",
    version: 1,
    managedBy: "CDK",
    tags: {
      "agentcore:created-by": "cdk",
      "agentcore:project-name": "SlackAiAssistant",
    },
    runtimes: [
      {
        name: "SlackAgent",
        build: "Container",
        entrypoint: "src/agentcore/runtime.ts" as FilePath,
        codeLocation: "app/SlackAgent/" as DirectoryPath,
        dockerfile: "Dockerfile",
        runtimeVersion: "NODE_22",
        networkMode: "PUBLIC",
        protocol: "HTTP",
        envVars: [
          {
            name: "BEDROCK_MODEL_ID",
            value: input.bedrockModelId,
          },
          ...(input.bedrockRegion
            ? [
                {
                  name: "BEDROCK_REGION",
                  value: input.bedrockRegion,
                },
              ]
            : []),
          ...(input.bedrockServiceTier
            ? [
                {
                  name: "BEDROCK_SERVICE_TIER",
                  value: input.bedrockServiceTier,
                },
              ]
            : []),
          {
            name: "BEDROCK_DOCUMENT_MODEL_ID",
            value: input.bedrockDocumentModelId,
          },
          ...(input.customSystemPrompt
            ? [
                {
                  name: "CUSTOM_SYSTEM_PROMPT",
                  value: input.customSystemPrompt,
                },
                {
                  name: "SYSTEM_PROMPT_MODE",
                  value: input.systemPromptMode,
                },
              ]
            : []),
        ],
      },
    ],
    memories: [],
    credentials: [],
    evaluators: [],
    onlineEvalConfigs: [],
    agentCoreGateways: [],
    policyEngines: [],
    configBundles: [],
  };
}

function grantSecureParameterRead(scope: Stack, parameterName: string, grantees: iam.IGrantable[]): void {
  const parameterArn = parameterName.startsWith("arn:")
    ? parameterName
    : scope.formatArn({
        service: "ssm",
        resource: "parameter",
        resourceName: trimLeadingSlash(parameterName),
      });

  for (const grantee of grantees) {
    grantee.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [parameterArn],
      }),
    );
    grantee.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["kms:Decrypt"],
        resources: ["*"],
        conditions: {
          StringEquals: {
            "kms:ViaService": `ssm.${scope.region}.amazonaws.com`,
          },
        },
      }),
    );
  }
}

function normalizeConfigValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean);
    return parts.length > 0 ? parts.join(",") : undefined;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }

  if (normalized === "agent_placeholder" || normalized === "env_placeholder") {
    return undefined;
  }

  return normalized;
}

function validateSystemPromptMode(value: string): void {
  if (value !== "append" && value !== "replace") {
    throw new Error("Invalid systemPromptMode. Expected one of: append, replace");
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function trimLeadingSlash(value: string): string {
  return value.replace(/^\/+/, "");
}
