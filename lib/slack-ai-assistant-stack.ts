import * as cdk from "aws-cdk-lib";
import { Duration, Stack } from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as eventsources from "aws-cdk-lib/aws-lambda-event-sources";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

export class SlackAiAssistantStack extends Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const anthropicAgentId = resolveRequiredConfigValue(
      this,
      "anthropicAgentId",
      "ANTHROPIC_AGENT_ID",
    );
    const anthropicEnvironmentId = resolveRequiredConfigValue(
      this,
      "anthropicEnvironmentId",
      "ANTHROPIC_ENVIRONMENT_ID",
    );
    const anthropicVaultIds =
      resolveOptionalConfigValue(this, "anthropicVaultIds", "ANTHROPIC_VAULT_IDS") ?? "";
    const slackSigningSecretName =
      resolveOptionalConfigValue(this, "slackSigningSecretName", "SLACK_SIGNING_SECRET_NAME") ??
      "/slack-ai-assistant/slack-signing-secret";
    const slackBotTokenSecretName =
      resolveOptionalConfigValue(this, "slackBotTokenSecretName", "SLACK_BOT_TOKEN_SECRET_NAME") ??
      "/slack-ai-assistant/slack-bot-token";
    const anthropicApiKeySecretName =
      resolveOptionalConfigValue(this, "anthropicApiKeySecretName", "ANTHROPIC_API_KEY_SECRET_NAME") ??
      "/slack-ai-assistant/anthropic-api-key";
    const googleCalendarSecretName =
      resolveOptionalConfigValue(this, "googleCalendarSecretName", "GOOGLE_CALENDAR_SECRET_NAME") ??
      "/slack-ai-assistant/google-calendar";
    const googleCalendarTimeZone =
      resolveOptionalConfigValue(this, "googleCalendarTimeZone", "GOOGLE_CALENDAR_TIME_ZONE") ?? "Asia/Tokyo";
    const defaultScheduleChannel =
      resolveOptionalConfigValue(this, "defaultScheduleChannel", "DEFAULT_SCHEDULE_CHANNEL") ??
      "C_PLACEHOLDER";
    const publicBaseUrl = resolveOptionalConfigValue(this, "publicBaseUrl", "PUBLIC_BASE_URL");
    const googleOAuthStartUrl = publicBaseUrl
      ? `${trimTrailingSlash(publicBaseUrl)}/oauth/google/start`
      : undefined;

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

    const userMemoryTable = new dynamodb.Table(this, "UserMemoriesTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
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

    const sourceDocumentsTable = new dynamodb.Table(this, "SourceDocumentsTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
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

    const commonEnvironment = {
      SESSION_TABLE_NAME: sessionTable.tableName,
      CONVERSATION_SESSIONS_TABLE_NAME: conversationSessionsTable.tableName,
      CONVERSATION_TURNS_TABLE_NAME: conversationTurnsTable.tableName,
      USER_MEMORY_TABLE_NAME: userMemoryTable.tableName,
      MEMORY_ITEMS_TABLE_NAME: memoryItemsTable.tableName,
      TASKS_TABLE_NAME: tasksTable.tableName,
      TASK_EVENTS_TABLE_NAME: taskEventsTable.tableName,
      PROCESSED_EVENTS_TABLE_NAME: processedEventsTable.tableName,
      TASK_TABLE_NAME: scheduledTasksTable.tableName,
      SLACK_SIGNING_SECRET_SECRET_ID: slackSigningSecretName,
      SLACK_BOT_TOKEN_SECRET_ID: slackBotTokenSecretName,
      ANTHROPIC_API_KEY_SECRET_ID: anthropicApiKeySecretName,
      ANTHROPIC_AGENT_ID: anthropicAgentId,
      ANTHROPIC_ENVIRONMENT_ID: anthropicEnvironmentId,
      ANTHROPIC_VAULT_IDS: anthropicVaultIds,
      ANTHROPIC_MANAGED_AGENTS_BETA: "managed-agents-2026-04-01",
      ENABLE_USER_MEMORY: "false",
      DEFAULT_SCHEDULE_CHANNEL: defaultScheduleChannel,
      EVENT_DEDUP_TTL_SECONDS: "86400",
      AGENT_RESPONSE_TIMEOUT_MS: "120000",
      TOP_LEVEL_CONTEXT_TURN_LIMIT: "10",
      MAX_SLACK_FILE_BYTES: "10000000",
    };

    const toolEnvironment = {
      CALENDAR_DRAFTS_TABLE_NAME: calendarDraftsTable.tableName,
      GOOGLE_CALENDAR_SECRET_ID: googleCalendarSecretName,
      GOOGLE_OAUTH_CONNECTIONS_TABLE_NAME: googleOAuthConnectionsTable.tableName,
      GOOGLE_CALENDAR_TIME_ZONE: googleCalendarTimeZone,
    };

    const ingress = createGoFunction(this, "SlackEventsIngressFunction", {
      entry: "slack-events-ingress",
      timeout: Duration.seconds(10),
      memorySize: 256,
      environment: {
        ...commonEnvironment,
        SLACK_QUEUE_URL: slackEventsQueue.queueUrl,
      },
    });

    const worker = createGoFunction(this, "SlackEventsWorkerFunction", {
      entry: "slack-events-worker",
      timeout: Duration.minutes(5),
      memorySize: 512,
      environment: {
        ...commonEnvironment,
        ...toolEnvironment,
        SOURCE_DOCUMENTS_TABLE_NAME: sourceDocumentsTable.tableName,
        SLACK_ATTACHMENT_ARCHIVE_BUCKET_NAME: attachmentArchiveBucket.bucketName,
      },
    });

    const documentImportApi = createGoFunction(this, "DocumentImportApiFunction", {
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

    const documentImportWorker = createGoFunction(this, "DocumentImportWorkerFunction", {
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

    const chatApi = createGoFunction(this, "ChatApiFunction", {
      entry: "chat-api",
      timeout: Duration.seconds(29),
      memorySize: 512,
      environment: {
        ...commonEnvironment,
        ...toolEnvironment,
      },
    });

    const scheduledRunner = createGoFunction(this, "ScheduledAgentRunnerFunction", {
      entry: "scheduled-agent-runner",
      timeout: Duration.minutes(5),
      memorySize: 512,
      environment: {
        ...commonEnvironment,
        ...toolEnvironment,
      },
    });

    const slackInteractions = createGoFunction(this, "SlackInteractionsFunction", {
      entry: "slack-interactions",
      timeout: Duration.seconds(30),
      memorySize: 512,
      environment: {
        ...commonEnvironment,
        ...toolEnvironment,
      },
    });

    const googleOAuth = createGoFunction(this, "GoogleOAuthFunction", {
      entry: "google-oauth",
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: {
        ...commonEnvironment,
        GOOGLE_CALENDAR_SECRET_ID: googleCalendarSecretName,
        GOOGLE_OAUTH_CONNECTIONS_TABLE_NAME: googleOAuthConnectionsTable.tableName,
        GOOGLE_CALENDAR_TIME_ZONE: googleCalendarTimeZone,
      },
    });

    worker.addEventSource(
      new eventsources.SqsEventSource(slackEventsQueue, {
        batchSize: 1,
      }),
    );

    documentImportWorker.addEventSource(
      new eventsources.SqsEventSource(documentImportQueue, {
        batchSize: 1,
      }),
    );

    slackEventsQueue.grantSendMessages(ingress);
    documentImportQueue.grantSendMessages(documentImportApi);
    sessionTable.grantReadWriteData(worker);
    sessionTable.grantReadWriteData(scheduledRunner);
    conversationSessionsTable.grantReadWriteData(worker);
    conversationTurnsTable.grantReadWriteData(worker);
    userMemoryTable.grantReadWriteData(worker);
    userMemoryTable.grantReadWriteData(scheduledRunner);
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
    scheduledTasksTable.grantReadWriteData(scheduledRunner);
    userMemoryTable.grantReadWriteData(chatApi);
    memoryItemsTable.grantReadWriteData(slackInteractions);
    attachmentArchiveBucket.grantPut(worker, "raw/private/slack/*");
    attachmentArchiveBucket.grantPut(documentImportApi, "raw/private/imports/*");
    attachmentArchiveBucket.grantPut(documentImportApi, "raw/private/notes/*");
    attachmentArchiveBucket.grantRead(documentImportApi, "raw/private/imports/*");
    attachmentArchiveBucket.grantRead(documentImportApi, "derived/private/extractions/*");
    attachmentArchiveBucket.grantRead(documentImportWorker, "raw/private/imports/*");
    attachmentArchiveBucket.grantRead(documentImportWorker, "raw/private/notes/*");
    attachmentArchiveBucket.grantPut(documentImportWorker, "derived/private/extractions/*");

    const slackSigningSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "SlackSigningSecret",
      slackSigningSecretName,
    );
    const slackBotTokenSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "SlackBotTokenSecret",
      slackBotTokenSecretName,
    );
    const anthropicApiKeySecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "AnthropicApiKeySecret",
      anthropicApiKeySecretName,
    );
    const googleCalendarSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "GoogleCalendarSecret",
      googleCalendarSecretName,
    );

    slackSigningSecret.grantRead(ingress);
    slackSigningSecret.grantRead(slackInteractions);
    slackSigningSecret.grantRead(googleOAuth);
    slackBotTokenSecret.grantRead(worker);
    slackBotTokenSecret.grantRead(scheduledRunner);
    slackBotTokenSecret.grantRead(slackInteractions);
    anthropicApiKeySecret.grantRead(worker);
    anthropicApiKeySecret.grantRead(scheduledRunner);
    anthropicApiKeySecret.grantRead(documentImportWorker);
    anthropicApiKeySecret.grantRead(chatApi);
    googleCalendarSecret.grantRead(worker);
    googleCalendarSecret.grantRead(scheduledRunner);
    googleCalendarSecret.grantRead(documentImportWorker);
    googleCalendarSecret.grantRead(chatApi);
    googleCalendarSecret.grantRead(slackInteractions);
    googleCalendarSecret.grantRead(googleOAuth);

    const api = new apigateway.RestApi(this, "SlackEventsApi", {
      restApiName: "slack-ai-assistant-events",
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
    const oauthResource = api.root.addResource("oauth").addResource("google");
    oauthResource.addResource("start").addMethod("GET", new apigateway.LambdaIntegration(googleOAuth));
    oauthResource.addResource("callback").addMethod("GET", new apigateway.LambdaIntegration(googleOAuth));

    if (googleOAuthStartUrl) {
      worker.addEnvironment("GOOGLE_OAUTH_START_URL", googleOAuthStartUrl);
      scheduledRunner.addEnvironment("GOOGLE_OAUTH_START_URL", googleOAuthStartUrl);
      documentImportWorker.addEnvironment("GOOGLE_OAUTH_START_URL", googleOAuthStartUrl);
      chatApi.addEnvironment("GOOGLE_OAUTH_START_URL", googleOAuthStartUrl);
      slackInteractions.addEnvironment("GOOGLE_OAUTH_START_URL", googleOAuthStartUrl);
    }
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

    const schedulerInvokeRole = new iam.Role(this, "SchedulerInvokeRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
    });
    scheduledRunner.grantInvoke(schedulerInvokeRole);

    new scheduler.CfnSchedule(this, "DailySummarySchedule", {
      flexibleTimeWindow: { mode: "OFF" },
      scheduleExpression: "cron(0 9 * * ? *)",
      scheduleExpressionTimezone: "Asia/Tokyo",
      state: "ENABLED",
      target: {
        arn: scheduledRunner.functionArn,
        roleArn: schedulerInvokeRole.roleArn,
        input: JSON.stringify({
          taskId: "daily-summary",
        }),
      },
    });

    new cdk.CfnOutput(this, "SlackEventsUrl", {
      value: `${api.url}slack/events`,
    });
    new cdk.CfnOutput(this, "SlackEventsQueueUrl", {
      value: slackEventsQueue.queueUrl,
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
    new cdk.CfnOutput(this, "MemoryItemsTableName", {
      value: memoryItemsTable.tableName,
    });
    new cdk.CfnOutput(this, "ConversationSessionsTableName", {
      value: conversationSessionsTable.tableName,
    });
    new cdk.CfnOutput(this, "ConversationTurnsTableName", {
      value: conversationTurnsTable.tableName,
    });
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

interface GoFunctionProps {
  entry: string;
  timeout: Duration;
  memorySize: number;
  environment: Record<string, string>;
}

function createGoFunction(scope: Construct, id: string, props: GoFunctionProps): lambda.Function {
  const projectRoot = join(__dirname, "..");
  const outputBinary = "bootstrap";
  const goBuildArgs = [
    "build",
    "-trimpath",
    "-ldflags=-s -w",
    "-o",
    outputBinary,
    `./cmd/${props.entry}`,
  ];

  return new lambda.Function(scope, id, {
    runtime: lambda.Runtime.PROVIDED_AL2023,
    architecture: lambda.Architecture.X86_64,
    handler: outputBinary,
    timeout: props.timeout,
    memorySize: props.memorySize,
    environment: props.environment,
    code: lambda.Code.fromAsset(projectRoot, {
      bundling: {
        image: cdk.DockerImage.fromRegistry("golang:1.26"),
        local: {
          tryBundle(outputDir: string) {
            const result = spawnSync("./scripts/run-go.sh", [...goBuildArgs.slice(0, 4), join(outputDir, outputBinary), ...goBuildArgs.slice(5)], {
              cwd: projectRoot,
              stdio: "inherit",
              env: {
                ...process.env,
                CGO_ENABLED: "0",
                GOOS: "linux",
                GOARCH: "amd64",
              },
            });
            if (result.status !== 0) {
              throw new Error(`Go bundling failed for ${props.entry}`);
            }
            return true;
          },
        },
        command: [
          "bash",
          "-lc",
          [
            "set -euo pipefail",
            "mkdir -p /asset-output",
            `cd /asset-input && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o /asset-output/${outputBinary} ./cmd/${props.entry}`,
          ].join(" && "),
        ],
      },
    }),
  });
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

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
