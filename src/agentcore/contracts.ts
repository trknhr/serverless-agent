import { z } from "zod";

const textBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

const imageBlockSchema = z.object({
  type: z.literal("image"),
  source: z.union([
    z.object({
      type: z.literal("base64"),
      media_type: z.string().min(1),
      data: z.string().min(1),
    }),
    z.object({
      type: z.literal("url"),
      url: z.string().min(1),
      media_type: z.string().min(1).optional(),
    }),
  ]),
});

const documentBlockSchema = z.object({
  type: z.literal("document"),
  title: z.string().optional(),
  context: z.string().optional(),
  source: z.union([
    z.object({
      type: z.literal("base64"),
      media_type: z.string().min(1),
      data: z.string().min(1),
    }),
    z.object({
      type: z.literal("text"),
      media_type: z.literal("text/plain"),
      data: z.string(),
    }),
    z.object({
      type: z.literal("url"),
      url: z.string().min(1),
    }),
    z.object({
      type: z.literal("file"),
      file_id: z.string().min(1),
    }),
  ]),
});

export const agentContentBlockSchema = z.union([
  textBlockSchema,
  imageBlockSchema,
  documentBlockSchema,
]);

export const agentRuntimeResourcesSchema = z.object({
  memoryItemsTableName: z.string().min(1),
  scheduledTasksTableName: z.string().min(1),
  tasksTableName: z.string().min(1),
  taskEventsTableName: z.string().min(1),
  recurringTasksTableName: z.string().min(1),
  calendarDraftsTableName: z.string().min(1),
  googleOAuthConnectionsTableName: z.string().min(1),
  googleCalendarSecretId: z.string().min(1),
  googleOAuthStartUrl: z.string().min(1).optional(),
  googleCalendarTimeZone: z.string().min(1),
  schedulerScheduleGroupName: z.string().min(1).optional(),
  schedulerScheduleNamePrefix: z.string().min(1).optional(),
  schedulerDefaultTimeZone: z.string().min(1).optional(),
  schedulerTargetArn: z.string().min(1).optional(),
  schedulerTargetRoleArn: z.string().min(1).optional(),
  defaultResponseLanguage: z.string().min(1).optional(),
  webSearchProvider: z.string().min(1).optional(),
  webSearchApiKeyParameterName: z.string().min(1).optional(),
  webSearchBaseUrl: z.string().min(1).optional(),
  skillsTableName: z.string().min(1).optional(),
});

export const agentToolContextSchema = z.object({
  workspaceId: z.string().min(1),
  userId: z.string().min(1).optional(),
  channelId: z.string().min(1).optional(),
  memoryWritePolicy: z
    .object({
      allowWorkspaceMemory: z.boolean().optional(),
      channelInferredStatus: z.enum(["active", "candidate"]).optional(),
      defaultOrigin: z.enum(["explicit", "inferred", "imported"]).optional(),
    })
    .optional(),
});

export const agentRuntimeRequestSchema = z.object({
  content: z.array(agentContentBlockSchema).min(1),
  context: z
    .object({
      source: z.string().min(1),
      workspaceId: z.string().min(1),
      userId: z.string().min(1).optional(),
      channelId: z.string().min(1).optional(),
      conversationTs: z.string().min(1).optional(),
      taskId: z.string().min(1).optional(),
      sourceId: z.string().min(1).optional(),
    })
    .passthrough(),
  resources: agentRuntimeResourcesSchema.optional(),
  toolContext: agentToolContextSchema.optional(),
  disableTools: z.boolean().optional(),
});

export const agentRuntimeResponseSchema = z.object({
  text: z.string(),
  taskIds: z.array(z.string()).default([]),
  recurringTaskIds: z.array(z.string()).default([]),
  savedMemoryIds: z.array(z.string()).default([]),
  calendarDraftIds: z.array(z.string()).default([]),
});

export type AgentRuntimeRequest = z.infer<typeof agentRuntimeRequestSchema>;
export type AgentRuntimeResources = z.infer<typeof agentRuntimeResourcesSchema>;
export type AgentToolContext = z.infer<typeof agentToolContextSchema>;
export type AgentRuntimeResponse = z.infer<typeof agentRuntimeResponseSchema>;

export interface ToolRuntimeEnvironment {
  MEMORY_ITEMS_TABLE_NAME: string;
  TASK_TABLE_NAME: string;
  TASKS_TABLE_NAME: string;
  TASK_EVENTS_TABLE_NAME: string;
  RECURRING_TASKS_TABLE_NAME: string;
  CALENDAR_DRAFTS_TABLE_NAME: string;
  GOOGLE_OAUTH_CONNECTIONS_TABLE_NAME: string;
  GOOGLE_CALENDAR_SECRET_ID: string;
  GOOGLE_OAUTH_START_URL?: string;
  GOOGLE_CALENDAR_TIME_ZONE: string;
  SCHEDULER_SCHEDULE_GROUP_NAME?: string;
  SCHEDULER_SCHEDULE_NAME_PREFIX?: string;
  SCHEDULER_DEFAULT_TIME_ZONE?: string;
  SCHEDULER_TARGET_ARN?: string;
  SCHEDULER_TARGET_ROLE_ARN?: string;
  DEFAULT_RESPONSE_LANGUAGE?: string;
  WEB_SEARCH_PROVIDER?: string;
  WEB_SEARCH_API_KEY_PARAMETER_NAME?: string;
  WEB_SEARCH_BASE_URL?: string;
  SKILLS_TABLE_NAME?: string;
}

export function buildAgentRuntimeResources(env: ToolRuntimeEnvironment): AgentRuntimeResources {
  return {
    memoryItemsTableName: env.MEMORY_ITEMS_TABLE_NAME,
    scheduledTasksTableName: env.TASK_TABLE_NAME,
    tasksTableName: env.TASKS_TABLE_NAME,
    taskEventsTableName: env.TASK_EVENTS_TABLE_NAME,
    recurringTasksTableName: env.RECURRING_TASKS_TABLE_NAME,
    calendarDraftsTableName: env.CALENDAR_DRAFTS_TABLE_NAME,
    googleOAuthConnectionsTableName: env.GOOGLE_OAUTH_CONNECTIONS_TABLE_NAME,
    googleCalendarSecretId: env.GOOGLE_CALENDAR_SECRET_ID,
    googleOAuthStartUrl: env.GOOGLE_OAUTH_START_URL,
    googleCalendarTimeZone: env.GOOGLE_CALENDAR_TIME_ZONE,
    schedulerScheduleGroupName: env.SCHEDULER_SCHEDULE_GROUP_NAME,
    schedulerScheduleNamePrefix: env.SCHEDULER_SCHEDULE_NAME_PREFIX,
    schedulerDefaultTimeZone: env.SCHEDULER_DEFAULT_TIME_ZONE,
    schedulerTargetArn: env.SCHEDULER_TARGET_ARN,
    schedulerTargetRoleArn: env.SCHEDULER_TARGET_ROLE_ARN,
    defaultResponseLanguage: env.DEFAULT_RESPONSE_LANGUAGE,
    webSearchProvider: env.WEB_SEARCH_PROVIDER,
    webSearchApiKeyParameterName: env.WEB_SEARCH_API_KEY_PARAMETER_NAME,
    webSearchBaseUrl: env.WEB_SEARCH_BASE_URL,
    skillsTableName: env.SKILLS_TABLE_NAME,
  };
}
