import { z } from "zod";

const requiredString = z.string().min(1);

const baseEnvSchema = z.object({
  SESSION_TABLE_NAME: requiredString,
  CONVERSATION_SESSIONS_TABLE_NAME: requiredString,
  CONVERSATION_TURNS_TABLE_NAME: requiredString,
  USER_MEMORY_TABLE_NAME: requiredString,
  MEMORY_ITEMS_TABLE_NAME: requiredString,
  TASKS_TABLE_NAME: requiredString,
  TASK_EVENTS_TABLE_NAME: requiredString,
  PROCESSED_EVENTS_TABLE_NAME: requiredString,
  TASK_TABLE_NAME: requiredString,
  SLACK_SIGNING_SECRET_SECRET_ID: requiredString,
  SLACK_BOT_TOKEN_SECRET_ID: requiredString,
  AGENTCORE_RUNTIME_ARN: requiredString,
  AGENTCORE_RUNTIME_QUALIFIER: z.string().optional().default(""),
  EVENT_DEDUP_TTL_SECONDS: z.coerce.number().int().positive().default(86400),
  AGENT_RESPONSE_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  TOP_LEVEL_CONTEXT_TURN_LIMIT: z.coerce.number().int().positive().default(10),
  MAX_SLACK_FILE_BYTES: z.coerce.number().int().positive().default(10_000_000),
  DEFAULT_SCHEDULE_CHANNEL: requiredString,
});

const ingressEnvSchema = baseEnvSchema.extend({
  SLACK_QUEUE_URL: requiredString,
});

const toolRuntimeEnvSchema = baseEnvSchema.extend({
  CALENDAR_DRAFTS_TABLE_NAME: requiredString,
  GOOGLE_CALENDAR_SECRET_ID: requiredString,
  GOOGLE_OAUTH_CONNECTIONS_TABLE_NAME: requiredString,
  GOOGLE_OAUTH_START_URL: z.string().min(1).optional(),
  GOOGLE_CALENDAR_TIME_ZONE: requiredString.default("Asia/Tokyo"),
});

const googleOAuthEnvSchema = baseEnvSchema.extend({
  GOOGLE_CALENDAR_SECRET_ID: requiredString,
  GOOGLE_OAUTH_CONNECTIONS_TABLE_NAME: requiredString,
  GOOGLE_CALENDAR_TIME_ZONE: requiredString.default("Asia/Tokyo"),
});

const workerEnvSchema = toolRuntimeEnvSchema.extend({
  SOURCE_DOCUMENTS_TABLE_NAME: requiredString,
  SLACK_ATTACHMENT_ARCHIVE_BUCKET_NAME: requiredString,
});

const importApiEnvSchema = baseEnvSchema.extend({
  SOURCE_DOCUMENTS_TABLE_NAME: requiredString,
  DOCUMENT_IMPORT_QUEUE_URL: requiredString,
  DOCUMENT_ARCHIVE_BUCKET_NAME: requiredString,
});

const importWorkerEnvSchema = toolRuntimeEnvSchema.extend({
  SOURCE_DOCUMENTS_TABLE_NAME: requiredString,
  DOCUMENT_ARCHIVE_BUCKET_NAME: requiredString,
});

const chatApiEnvSchema = toolRuntimeEnvSchema;

const schedulerEnvSchema = toolRuntimeEnvSchema;

const slackInteractionsEnvSchema = toolRuntimeEnvSchema;

export type IngressEnv = z.infer<typeof ingressEnvSchema>;
export type WorkerEnv = z.infer<typeof workerEnvSchema>;
export type ImportApiEnv = z.infer<typeof importApiEnvSchema>;
export type ImportWorkerEnv = z.infer<typeof importWorkerEnvSchema>;
export type ChatApiEnv = z.infer<typeof chatApiEnvSchema>;
export type SchedulerEnv = z.infer<typeof schedulerEnvSchema>;
export type SlackInteractionsEnv = z.infer<typeof slackInteractionsEnvSchema>;
export type GoogleOAuthEnv = z.infer<typeof googleOAuthEnvSchema>;

export function loadIngressEnv(): IngressEnv {
  return ingressEnvSchema.parse(process.env);
}

export function loadWorkerEnv(): WorkerEnv {
  return workerEnvSchema.parse(process.env);
}

export function loadImportApiEnv(): ImportApiEnv {
  return importApiEnvSchema.parse(process.env);
}

export function loadImportWorkerEnv(): ImportWorkerEnv {
  return importWorkerEnvSchema.parse(process.env);
}

export function loadChatApiEnv(): ChatApiEnv {
  return chatApiEnvSchema.parse(process.env);
}

export function loadSchedulerEnv(): SchedulerEnv {
  return schedulerEnvSchema.parse(process.env);
}

export function loadSlackInteractionsEnv(): SlackInteractionsEnv {
  return slackInteractionsEnvSchema.parse(process.env);
}

export function loadGoogleOAuthEnv(): GoogleOAuthEnv {
  return googleOAuthEnvSchema.parse(process.env);
}
