import { z } from "zod";

const requiredString = z.string().min(1);

const runtimeBaseEnvSchema = z.object({
  SESSION_TABLE_NAME: requiredString,
  CONVERSATION_SESSIONS_TABLE_NAME: requiredString,
  WORK_SESSIONS_TABLE_NAME: requiredString,
  CONVERSATION_TURNS_TABLE_NAME: requiredString,
  USER_MEMORY_TABLE_NAME: requiredString,
  MEMORY_ITEMS_TABLE_NAME: requiredString,
  TASKS_TABLE_NAME: requiredString,
  TASK_EVENTS_TABLE_NAME: requiredString,
  RECURRING_TASKS_TABLE_NAME: requiredString,
  PROVIDER_BINDINGS_TABLE_NAME: requiredString,
  PROCESSED_EVENTS_TABLE_NAME: requiredString,
  TASK_TABLE_NAME: requiredString,
  AGENTCORE_RUNTIME_ARN: requiredString,
  AGENTCORE_RUNTIME_QUALIFIER: z.string().optional().default(""),
  EVENT_DEDUP_TTL_SECONDS: z.coerce.number().int().positive().default(86400),
  AGENT_RESPONSE_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  DEFAULT_RESPONSE_LANGUAGE: z.string().min(1).optional(),
  TOP_LEVEL_CONTEXT_TURN_LIMIT: z.coerce.number().int().positive().default(10),
  MAX_SLACK_FILE_BYTES: z.coerce.number().int().positive().default(10_000_000),
  DEFAULT_SCHEDULE_CHANNEL: requiredString,
  SCHEDULER_SCHEDULE_GROUP_NAME: z.string().min(1).optional(),
  SCHEDULER_SCHEDULE_NAME_PREFIX: z.string().min(1).optional(),
  SCHEDULER_DEFAULT_TIME_ZONE: z.string().min(1).optional(),
  SCHEDULER_TARGET_ARN: z.string().min(1).optional(),
  SCHEDULER_TARGET_ROLE_ARN: z.string().min(1).optional(),
  WORK_SESSION_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().min(60).max(28_800).default(900),
  WORK_SESSION_MAX_LIFETIME_SECONDS: z.coerce.number().int().min(60).max(28_800).default(28_800),
  WORK_SESSION_MAX_ACTIVE_PER_OWNER: z.coerce.number().int().positive().default(2),
});

const baseEnvSchema = runtimeBaseEnvSchema.extend({
  SLACK_SIGNING_SECRET_SECRET_ID: requiredString,
  SLACK_BOT_TOKEN_SECRET_ID: requiredString,
});

const ingressEnvSchema = baseEnvSchema.extend({
  SLACK_QUEUE_URL: requiredString,
});

const toolResourceEnvSchema = runtimeBaseEnvSchema.extend({
  CALENDAR_DRAFTS_TABLE_NAME: requiredString,
  GOOGLE_CALENDAR_SECRET_ID: requiredString,
  GOOGLE_OAUTH_CONNECTIONS_TABLE_NAME: requiredString,
  GOOGLE_OAUTH_START_URL: z.string().min(1).optional(),
  GOOGLE_CALENDAR_TIME_ZONE: requiredString.default("Asia/Tokyo"),
  WEB_SEARCH_PROVIDER: z.string().min(1).optional(),
  WEB_SEARCH_API_KEY_PARAMETER_NAME: z.string().min(1).optional(),
  WEB_SEARCH_BASE_URL: z.string().min(1).optional(),
  BROWSER_PROVIDER: z.string().min(1).optional(),
  BROWSER_IDENTIFIER: z.string().min(1).optional(),
  SKILLS_TABLE_NAME: z.string().min(1).optional(),
});

const toolRuntimeEnvSchema = baseEnvSchema.merge(toolResourceEnvSchema);

const lineIngressEnvSchema = runtimeBaseEnvSchema.extend({
  LINE_CHANNEL_SECRET_SECRET_ID: requiredString,
  LINE_QUEUE_URL: requiredString,
});

const lineWorkerEnvSchema = toolResourceEnvSchema.extend({
  LINE_CHANNEL_ACCESS_TOKEN_SECRET_ID: requiredString,
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

const schedulerEnvSchema = toolRuntimeEnvSchema.extend({
  LINE_CHANNEL_ACCESS_TOKEN_SECRET_ID: requiredString,
});

const slackInteractionsEnvSchema = toolRuntimeEnvSchema;

export type IngressEnv = z.infer<typeof ingressEnvSchema>;
export type WorkerEnv = z.infer<typeof workerEnvSchema>;
export type ImportApiEnv = z.infer<typeof importApiEnvSchema>;
export type ImportWorkerEnv = z.infer<typeof importWorkerEnvSchema>;
export type ChatApiEnv = z.infer<typeof chatApiEnvSchema>;
export type SchedulerEnv = z.infer<typeof schedulerEnvSchema>;
export type SlackInteractionsEnv = z.infer<typeof slackInteractionsEnvSchema>;
export type GoogleOAuthEnv = z.infer<typeof googleOAuthEnvSchema>;
export type LineIngressEnv = z.infer<typeof lineIngressEnvSchema>;
export type LineWorkerEnv = z.infer<typeof lineWorkerEnvSchema>;

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

export function loadLineIngressEnv(): LineIngressEnv {
  return lineIngressEnvSchema.parse(process.env);
}

export function loadLineWorkerEnv(): LineWorkerEnv {
  return lineWorkerEnvSchema.parse(process.env);
}
