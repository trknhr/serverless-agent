import { z } from "zod";

export const chatMessageRequestSchema = z.object({
  workspaceId: z.string().min(1),
  userId: z.string().min(1),
  text: z.string().min(1),
  sessionId: z.string().min(1).optional(),
});

export const chatMessageResponseSchema = z.object({
  ok: z.literal(true),
  sessionId: z.string().min(1),
  text: z.string(),
  taskIds: z.array(z.string()).default([]),
  recurringTaskIds: z.array(z.string()).default([]),
  savedMemoryIds: z.array(z.string()).default([]),
  calendarDraftIds: z.array(z.string()).default([]),
  traceId: z.string().optional(),
  turnId: z.string().optional(),
});

export type ChatMessageRequest = z.infer<typeof chatMessageRequestSchema>;
export type ChatMessageResponse = z.infer<typeof chatMessageResponseSchema>;
