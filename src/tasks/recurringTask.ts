import { z } from "zod";

const recurringTaskLocalTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

export const recurringTaskWeekdaySchema = z.enum([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);

export const recurringTaskRecurrenceSchema = z
  .object({
    frequency: z.enum(["daily", "weekly", "monthly", "yearly"]),
    interval: z.number().int().min(1).max(12).default(1),
    monthOfYear: z.number().int().min(1).max(12).optional(),
    daysOfWeek: z.array(recurringTaskWeekdaySchema).optional(),
    daysOfMonth: z.array(z.number().int().min(1).max(31)).optional(),
    weekOfMonth: z.union([z.number().int().min(1).max(5), z.literal("last")]).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.frequency !== "yearly") {
      if (value.monthOfYear !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["monthOfYear"],
          message: "monthOfYear is supported only for yearly recurrence",
        });
      }
      return;
    }

    if (value.monthOfYear === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["monthOfYear"],
        message: "yearly recurrence requires monthOfYear",
      });
    }

    const hasFixedDay = Boolean(value.daysOfMonth?.length);
    const hasNthWeekday = Boolean(value.weekOfMonth && value.daysOfWeek?.length);
    if (hasFixedDay === hasNthWeekday) {
      ctx.addIssue({
        code: "custom",
        message: "yearly recurrence requires either one day of month or one nth weekday rule",
      });
    }
    if (value.daysOfMonth && value.daysOfMonth.length !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["daysOfMonth"],
        message: "yearly recurrence requires exactly one day of month",
      });
    }
    const fixedDay = value.daysOfMonth?.[0];
    if (
      value.monthOfYear !== undefined &&
      fixedDay !== undefined &&
      fixedDay > maximumDayOfYearlyMonth(value.monthOfYear)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["daysOfMonth", 0],
        message: `day ${fixedDay} does not exist in month ${value.monthOfYear}`,
      });
    }
    if (hasNthWeekday && value.daysOfWeek?.length !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["daysOfWeek"],
        message: "yearly nth-weekday recurrence requires exactly one weekday",
      });
    }
  });

export const recurringTaskDayOfTaskSchema = z.object({
  enabled: z.boolean().default(true),
  title: z.string().min(1),
  description: z.string().optional(),
  dueTime: recurringTaskLocalTimeSchema.optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
});

export const recurringTaskSchema = z
  .object({
    recurringTaskId: z.string().min(1),
    workspaceId: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    recurrence: recurringTaskRecurrenceSchema,
    leadTimeDays: z.number().int().min(0).max(366).default(0),
    dayOfTask: recurringTaskDayOfTaskSchema.optional(),
    dueTime: recurringTaskLocalTimeSchema.default("23:59"),
    timezone: z.string().min(1).default("Asia/Tokyo"),
    enabled: z.boolean().default(true),
    ownerUserId: z.string().optional(),
    priority: z.enum(["low", "medium", "high"]).optional(),
    sourceType: z.string().optional(),
    sourceRef: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .superRefine((value, ctx) => {
    if (value.dayOfTask?.enabled && value.leadTimeDays === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["dayOfTask"],
        message: "dayOfTask requires leadTimeDays greater than zero",
      });
    }
  });

export type RecurringTaskWeekday = z.infer<typeof recurringTaskWeekdaySchema>;
export type RecurringTaskRecurrence = z.infer<typeof recurringTaskRecurrenceSchema>;
export type RecurringTaskDayOfTask = z.infer<typeof recurringTaskDayOfTaskSchema>;
export type RecurringTask = z.infer<typeof recurringTaskSchema>;

function maximumDayOfYearlyMonth(month: number): number {
  return [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 31;
}
