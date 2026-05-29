import { z } from "zod";

export const scheduledOutputProviderSchema = z.enum(["slack", "line"]);
export type ScheduledOutputProvider = z.infer<typeof scheduledOutputProviderSchema>;

export const scheduledTaskSchema = z.object({
  taskId: z.string().min(1),
  name: z.string().min(1),
  prompt: z.string().min(1),
  workspaceId: z.string().min(1),
  outputChannelId: z.string().min(1),
  outputProvider: scheduledOutputProviderSchema.optional(),
  outputProviderAccountId: z.string().min(1).optional(),
  outputConversationKey: z.string().min(1).optional(),
  enabled: z.boolean(),
  scheduleName: z.string().min(1).optional(),
  scheduleGroupName: z.string().min(1).optional(),
  scheduleExpression: z.string().min(1).optional(),
  scheduleExpressionTimezone: z.string().min(1).optional(),
  createdByUserId: z.string().min(1).optional(),
  updatedByUserId: z.string().min(1).optional(),
  reuseSession: z.boolean().default(false),
  memoryStoreId: z.string().optional(),
  vaultIds: z.array(z.string().min(1)).optional(),
  agentIdOverride: z.string().optional(),
  environmentIdOverride: z.string().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type ScheduledTask = z.infer<typeof scheduledTaskSchema>;

export function buildScheduledTaskPk(workspaceId: string, taskId: string): string {
  return `WORKSPACE#${workspaceId}#TASK#${taskId}`;
}

export function buildLegacyScheduledTaskPk(taskId: string): string {
  return `TASK#${taskId}`;
}
