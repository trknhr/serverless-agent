import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { CalendarDraft, CalendarDraftCandidate, CalendarDraftStatus } from "../calendar/calendarDraft";
import {
  GoogleCalendarAccessRole,
  GoogleCalendarClient,
  GoogleCalendarListEntry,
} from "../calendar/googleCalendarClient";
import { AgentToolUseEvent, ToolExecutionResult } from "../agent/types";
import { CalendarDraftRepository } from "../repo/calendarDraftRepository";
import { ChannelMemoryRepository } from "../repo/channelMemoryRepository";
import { MemoryItemRepository } from "../repo/memoryItemRepository";
import { RecurringTaskRepository } from "../repo/recurringTaskRepository";
import { TaskRepository } from "../repo/taskRepository";
import { TaskEventRepository } from "../repo/taskEventRepository";
import { TaskStateRepository } from "../repo/taskStateRepository";
import { UserPreferenceRepository } from "../repo/userPreferenceRepository";
import { WorkSessionRepository } from "../repo/workSessionRepository";
import {
  ScheduledReminderScheduler,
  buildScheduleExpressionFromRecurrence,
  extractDailyCronTime,
} from "../scheduler/scheduledReminder";
import { Logger } from "../shared/logger";
import { RecurringTaskRecurrence, recurringTaskWeekdaySchema } from "../tasks/recurringTask";
import { ScheduledTask } from "../tasks/taskDefinition";
import { TaskStatus } from "../tasks/taskState";
import { WeatherForecastProvider } from "../weather/openMeteo";
import { WebToolProvider } from "../web/webTools";
import type { SkillRegistry } from "../skills/registry";
import { skillConstraintsSchema, skillStatusSchema, type GeneratedSkillRecord } from "../skills/types";

const loadSkillSchema = z.object({
  skill_id: z.string().min(1).max(128),
});

const proposeSkillSchema = z.object({
  skill_markdown: z.string().min(1).max(50_000),
  trigger_hints: z.array(z.string().min(1)).max(12).optional(),
  tool_allowlist: z.array(z.string().min(1)).max(20).optional(),
  constraints: skillConstraintsSchema.optional(),
  version: z.string().min(1).optional(),
});

const approveSkillSchema = z.object({
  skill_id: z.string().min(1).max(128),
});

const listSkillsSchema = z.object({
  source: z.enum(["builtin", "generated", "all"]).optional(),
  statuses: z.array(skillStatusSchema).optional(),
});

const disableSkillSchema = z.object({
  skill_id: z.string().min(1).max(128),
});

const searchMemoriesSchema = z.object({
  query: z.string().min(1),
  entity_key: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(20).optional(),
  scope: z.enum(["all", "channel", "user_preference", "workspace"]).optional(),
});

const saveMemorySchema = z.object({
  text: z.string().min(1),
  scope: z.enum(["channel", "user_preference", "workspace"]).optional(),
  origin: z.enum(["explicit", "inferred", "imported"]).optional(),
  entity_key: z.string().min(1).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string().min(1)).optional(),
  importance: z.number().min(0).max(1).optional(),
  preference_key: z.string().min(1).optional(),
});

const promoteMemoryToWorkspaceSchema = z.object({
  memory_id: z.string().min(1).max(128),
  entity_key: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).optional(),
  importance: z.number().min(0).max(1).optional(),
});

const webSearchSchema = z.object({
  query: z.string().min(1).max(400),
  limit: z.number().int().min(1).max(10).optional(),
  country: z.string().regex(/^[A-Za-z]{2}$/).optional(),
  language: z.string().regex(/^[A-Za-z]{2,3}$/).optional(),
  freshness: z.enum(["day", "week", "month", "year"]).optional(),
  domains: z.array(z.string().min(1)).max(5).optional(),
});

const webExtractSchema = z.object({
  url: z.string().url(),
  max_chars: z.number().int().min(500).max(20_000).optional(),
});

const listTasksSchema = z.object({
  statuses: z.array(z.enum(["open", "in_progress", "done", "cancelled"])).optional(),
  due_before: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

const upsertTaskSchema = z.object({
  task_id: z.string().min(1).optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  status: z.enum(["open", "in_progress", "done", "cancelled"]).optional(),
  due_at: z.string().optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  calendar_event_id: z.string().optional(),
  source_type: z.string().optional(),
  source_ref: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const markTaskDoneSchema = z.object({
  task_id: z.string().min(1),
  completed_at: z.string().optional(),
});

const recurringTaskRecurrenceInputSchema = z.object({
  frequency: z.enum(["daily", "weekly", "monthly"]),
  interval: z.number().int().min(1).max(12).optional(),
  days_of_week: z.array(recurringTaskWeekdaySchema).optional(),
  days_of_month: z.array(z.number().int().min(1).max(31)).optional(),
  week_of_month: z.union([z.number().int().min(1).max(5), z.literal("last")]).optional(),
});

const listRecurringTasksSchema = z.object({
  enabled: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const upsertRecurringTaskSchema = z.object({
  recurring_task_id: z.string().min(1).optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  recurrence: recurringTaskRecurrenceInputSchema,
  due_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  timezone: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  owner_user_id: z.string().min(1).optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  source_type: z.string().optional(),
  source_ref: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const disableRecurringTaskSchema = z.object({
  recurring_task_id: z.string().min(1),
});

const scheduledReminderRecurrenceInputSchema = z.object({
  frequency: z.enum(["daily", "weekly", "monthly"]),
  time: z.string().regex(/^\d{1,2}:\d{2}$/),
  days_of_week: z.array(recurringTaskWeekdaySchema).optional(),
  days_of_month: z.array(z.number().int().min(1).max(31)).optional(),
});

const listScheduledRemindersSchema = z.object({
  enabled: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const createScheduledReminderSchema = z
  .object({
    scheduled_task_id: z.string().min(1).optional(),
    name: z.string().min(1),
    prompt: z.string().min(1),
    recurrence: scheduledReminderRecurrenceInputSchema.optional(),
    schedule_expression: z.string().min(1).optional(),
    timezone: z.string().min(1).optional(),
    output_channel_id: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.recurrence && !value.schedule_expression) {
      ctx.addIssue({
        code: "custom",
        path: ["recurrence"],
        message: "A recurrence or schedule_expression is required.",
      });
    }
  });

const updateScheduledReminderSchema = z.object({
  scheduled_task_id: z.string().min(1),
  name: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  recurrence: scheduledReminderRecurrenceInputSchema.optional(),
  schedule_expression: z.string().min(1).optional(),
  timezone: z.string().min(1).optional(),
  output_channel_id: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});

const deleteScheduledReminderSchema = z.object({
  scheduled_task_id: z.string().min(1),
});

const getWeatherForecastSchema = z.object({
  location: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  timezone: z.string().min(1).optional(),
});

const listCalendarEventsSchema = z.object({
  calendar_id: z.string().min(1).optional(),
  calendar_name: z.string().min(1).optional(),
  time_min: z.string().min(1).optional(),
  time_max: z.string().min(1).optional(),
  time_zone: z.string().min(1).optional(),
  query: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

const listGoogleCalendarsSchema = z.object({
  min_access_role: z.enum(["freeBusyReader", "reader", "writer", "owner"]).optional(),
  query: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const findFreeBusySchema = z.object({
  calendar_ids: z.array(z.string().min(1)).optional(),
  calendar_names: z.array(z.string().min(1)).optional(),
  time_min: z.string().min(1),
  time_max: z.string().min(1),
  time_zone: z.string().min(1).optional(),
});

const calendarDraftCandidateSchema = z
  .object({
    candidate_id: z.string().min(1).optional(),
    summary: z.string().min(1),
    description: z.string().optional(),
    location: z.string().optional(),
    all_day: z.boolean().optional(),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
    start_at: z.string().optional(),
    end_at: z.string().optional(),
    time_zone: z.string().optional(),
    source_text: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
    dedupe_key: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    const hasDateOnly = Boolean(value.all_day || value.start_date || value.end_date);
    const hasDateTime = Boolean(value.start_at || value.end_at);

    if (hasDateOnly && hasDateTime) {
      ctx.addIssue({
        code: "custom",
        message: "Use either start_date/end_date for an all-day event or start_at/end_at for a timed event, not both.",
      });
      return;
    }

    if (hasDateOnly) {
      if (!value.start_date || !isDateOnly(value.start_date)) {
        ctx.addIssue({
          code: "custom",
          message: "All-day events require start_date in YYYY-MM-DD format.",
          path: ["start_date"],
        });
      }
      if (value.end_date && !isDateOnly(value.end_date)) {
        ctx.addIssue({
          code: "custom",
          message: "end_date must be in YYYY-MM-DD format.",
          path: ["end_date"],
        });
      }
      if (value.start_date && value.end_date && value.end_date < value.start_date) {
        ctx.addIssue({
          code: "custom",
          message: "end_date must be on or after start_date.",
          path: ["end_date"],
        });
      }
      return;
    }

    if (!value.start_at || !isRfc3339(value.start_at)) {
      ctx.addIssue({
        code: "custom",
        message: "Timed events require start_at as an RFC3339 timestamp.",
        path: ["start_at"],
      });
    }
    if (!value.end_at || !isRfc3339(value.end_at)) {
      ctx.addIssue({
        code: "custom",
        message: "Timed events require end_at as an RFC3339 timestamp.",
        path: ["end_at"],
      });
    }
    if (
      value.start_at &&
      value.end_at &&
      isRfc3339(value.start_at) &&
      isRfc3339(value.end_at) &&
      Date.parse(value.end_at) <= Date.parse(value.start_at)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "end_at must be after start_at.",
        path: ["end_at"],
      });
    }
  });

const createCalendarDraftSchema = z.object({
  title: z.string().min(1).optional(),
  notes: z.string().optional(),
  source_id: z.string().min(1).optional(),
  source_ref: z.string().min(1).optional(),
  calendar_id: z.string().min(1).optional(),
  calendar_name: z.string().min(1).optional(),
  candidates: z.array(calendarDraftCandidateSchema).min(1).max(50),
});

const listCalendarDraftsSchema = z.object({
  statuses: z.array(z.enum(["pending", "approved", "applied", "rejected"])).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

const applyCalendarDraftSchema = z.object({
  draft_id: z.string().min(1),
  calendar_id: z.string().min(1).optional(),
  calendar_name: z.string().min(1).optional(),
  candidate_ids: z.array(z.string().min(1)).optional(),
});

const discardCalendarDraftSchema = z.object({
  draft_id: z.string().min(1),
  candidate_ids: z.array(z.string().min(1)).optional(),
});

type CalendarDraftCandidateInput = z.infer<typeof calendarDraftCandidateSchema>;
type RecurringTaskRecurrenceInput = z.infer<typeof recurringTaskRecurrenceInputSchema>;
type ScheduledReminderRecurrenceInput = z.infer<typeof scheduledReminderRecurrenceInputSchema>;

const DEFAULT_CALENDAR_TIME_ZONE = "Asia/Tokyo";
const CALENDAR_PRIVATE_PROPERTY_KEYS = {
  draftId: "slackai_draft",
  candidateId: "slackai_candidate",
  dedupeKey: "slackai_dedupe",
  workspaceId: "slackai_workspace",
  sourceId: "slackai_source",
} as const;
const CALENDAR_TOOL_NAMES = new Set([
  "list_google_calendars",
  "list_calendar_events",
  "find_free_busy",
  "create_calendar_draft",
  "apply_calendar_draft",
]);

export interface ToolExecutionContext {
  workspaceId: string;
  userId?: string;
  channelId?: string;
  conversationId?: string;
  logger: Logger;
  memoryWritePolicy?: {
    allowWorkspaceMemory?: boolean;
    channelInferredStatus?: "active" | "candidate";
    defaultOrigin?: "explicit" | "inferred" | "imported";
  };
}

interface ToolRepositories {
  memoryItems: MemoryItemRepository;
  channelMemories?: ChannelMemoryRepository;
  userPreferences?: UserPreferenceRepository;
  scheduledTasks?: TaskRepository;
  tasks: TaskStateRepository;
  taskEvents: TaskEventRepository;
  recurringTasks?: RecurringTaskRepository;
  calendarDrafts?: CalendarDraftRepository;
  workSessions?: WorkSessionRepository;
}

interface ToolIntegrations {
  googleCalendar?: GoogleCalendarClient;
  googleCalendarProvider?: () => GoogleCalendarClient | Promise<GoogleCalendarClient>;
  defaultCalendarTimeZone?: string;
  scheduledReminderScheduler?: ScheduledReminderScheduler;
  weatherProvider?: WeatherForecastProvider;
  webProvider?: WebToolProvider;
  skillRegistry?: SkillRegistry;
}

export interface ToolExecutionSummary {
  savedMemoryIds: string[];
  taskIds: string[];
  recurringTaskIds: string[];
  calendarDraftIds: string[];
}

export class CustomToolExecutor {
  private readonly savedMemoryIds = new Set<string>();
  private readonly taskIds = new Set<string>();
  private readonly recurringTaskIds = new Set<string>();
  private readonly calendarDraftIds = new Set<string>();

  constructor(
    private readonly repositories: ToolRepositories,
    private readonly context: ToolExecutionContext,
    private readonly integrations: ToolIntegrations = {},
  ) {}

  async execute(toolUseEvent: AgentToolUseEvent): Promise<ToolExecutionResult> {
    const toolName = typeof toolUseEvent.name === "string" ? toolUseEvent.name : "";
    const input =
      toolUseEvent.input && typeof toolUseEvent.input === "object"
        ? (toolUseEvent.input as Record<string, unknown>)
        : {};

    this.context.logger.info("Executing custom tool", {
      toolName,
      toolEventId: toolUseEvent.id,
    });

    try {
      switch (toolName) {
        case "load_skill":
          return await this.loadSkill(input);
        case "propose_skill":
          return await this.proposeSkill(input);
        case "approve_skill":
          return await this.approveSkill(input);
        case "list_skills":
          return await this.listSkills(input);
        case "disable_skill":
          return await this.disableSkill(input);
        case "search_memories":
          return await this.searchMemories(input);
        case "save_memory":
          return await this.saveMemory(input);
        case "promote_memory_to_workspace":
          return await this.promoteMemoryToWorkspace(input);
        case "web_search":
          return await this.webSearch(input);
        case "web_extract":
          return await this.webExtract(input);
        case "list_tasks":
          return await this.listTasks(input);
        case "upsert_task":
          return await this.upsertTask(input);
        case "mark_task_done":
          return await this.markTaskDone(input);
        case "list_recurring_tasks":
          return await this.listRecurringTasks(input);
        case "upsert_recurring_task":
          return await this.upsertRecurringTask(input);
        case "disable_recurring_task":
          return await this.disableRecurringTask(input);
        case "list_scheduled_reminders":
          return await this.listScheduledReminders(input);
        case "create_scheduled_reminder":
          return await this.createScheduledReminder(input);
        case "update_scheduled_reminder":
          return await this.updateScheduledReminder(input);
        case "delete_scheduled_reminder":
          return await this.deleteScheduledReminder(input);
        case "get_weather_forecast":
          return await this.getWeatherForecast(input);
        case "list_google_calendars":
          return await this.listGoogleCalendars(input);
        case "list_calendar_events":
          return await this.listCalendarEvents(input);
        case "find_free_busy":
          return await this.findFreeBusy(input);
        case "create_calendar_draft":
          return await this.createCalendarDraft(input);
        case "list_calendar_drafts":
          return await this.listCalendarDrafts(input);
        case "apply_calendar_draft":
          return await this.applyCalendarDraft(input);
        case "discard_calendar_draft":
          return await this.discardCalendarDraft(input);
        default:
          return errorResult(`Unknown custom tool: ${toolName}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown tool execution error";
      this.context.logger.warn("Custom tool execution failed", {
        toolName,
        toolEventId: toolUseEvent.id,
        error: message,
      });
      if (CALENDAR_TOOL_NAMES.has(toolName)) {
        return errorResult(
          `Google Calendar is unavailable. Skip calendar-dependent work for this request and continue without calendar data. Details: ${message}`,
        );
      }
      return errorResult(message);
    }
  }

  getSummary(): ToolExecutionSummary {
    return {
      savedMemoryIds: [...this.savedMemoryIds],
      taskIds: [...this.taskIds],
      recurringTaskIds: [...this.recurringTaskIds],
      calendarDraftIds: [...this.calendarDraftIds],
    };
  }

  private async loadSkill(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const parsed = loadSkillSchema.parse(input);
    const registry = this.requireSkillRegistry();
    const skill = await registry.loadSkill(this.context.workspaceId, parsed.skill_id);
    if (!skill) {
      return errorResult(`Skill is not available or not enabled for this workspace: ${parsed.skill_id}`);
    }

    return jsonResult({
      skill_id: skill.skillId,
      source: skill.source,
      version: skill.version,
      title: skill.title,
      description: skill.description,
      tool_allowlist: skill.toolAllowlist,
      constraints: skill.constraints,
      instructions: skill.body,
    });
  }

  private async proposeSkill(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const parsed = proposeSkillSchema.parse(input);
    const registry = this.requireSkillRegistry();
    const skill = await registry.proposeSkill(this.context.workspaceId, {
      skillMarkdown: parsed.skill_markdown,
      triggerHints: parsed.trigger_hints,
      toolAllowlist: parsed.tool_allowlist,
      constraints: parsed.constraints,
      version: parsed.version,
      createdFromConversationId: this.context.conversationId,
      createdByUserId: this.context.userId,
    });

    return jsonResult({
      proposed: true,
      skill: serializeGeneratedSkill(skill),
      next_step: "Ask the user to review this draft. Call approve_skill only after explicit approval.",
    });
  }

  private async approveSkill(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const parsed = approveSkillSchema.parse(input);
    const registry = this.requireSkillRegistry();
    const skill = await registry.approveSkill(this.context.workspaceId, parsed.skill_id, this.context.userId);

    return jsonResult({
      approved: true,
      skill: serializeGeneratedSkill(skill),
    });
  }

  private async listSkills(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const parsed = listSkillsSchema.parse(input);
    const registry = this.requireSkillRegistry();
    const skills = await registry.listSkills(this.context.workspaceId, {
      source: parsed.source,
      statuses: parsed.statuses,
    });

    return jsonResult({
      count: skills.length,
      skills,
    });
  }

  private async disableSkill(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const parsed = disableSkillSchema.parse(input);
    const registry = this.requireSkillRegistry();
    const skill = await registry.disableSkill(this.context.workspaceId, parsed.skill_id);

    return jsonResult({
      disabled: true,
      skill: serializeGeneratedSkill(skill),
    });
  }

  private async searchMemories(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const parsed = searchMemoriesSchema.parse(input);
    const scope = parsed.scope ?? inferSearchScope(this.context);
    const limit = parsed.limit;
    const results: Array<Record<string, unknown>> = [];

    if ((scope === "all" || scope === "channel") && this.context.channelId && this.repositories.channelMemories) {
      const memories = await this.repositories.channelMemories.search({
        workspaceId: this.context.workspaceId,
        channelId: this.context.channelId,
        query: parsed.query,
        entityKey: parsed.entity_key,
        limit,
      });
      results.push(
        ...memories.map((memory) => ({
          scope: "channel",
          memory_id: memory.memoryId,
          entity_key: memory.entityKey,
          text: memory.text,
          attributes: memory.attributes ?? {},
          tags: memory.tags ?? [],
          importance: memory.importance ?? 0,
          updated_at: memory.updatedAt,
          status: memory.status,
        })),
      );
    }

    if (
      (scope === "all" || scope === "user_preference") &&
      this.context.userId &&
      this.repositories.userPreferences
    ) {
      const preferences = await this.repositories.userPreferences.search({
        workspaceId: this.context.workspaceId,
        userId: this.context.userId,
        query: parsed.query,
        entityKey: parsed.entity_key,
        limit,
      });
      results.push(
        ...preferences.map((preference) => ({
          scope: "user_preference",
          memory_id: preference.preferenceId,
          preference_key: preference.preferenceKey,
          entity_key: preference.entityKey,
          text: preference.text,
          attributes: preference.attributes ?? {},
          tags: preference.tags ?? [],
          importance: preference.importance ?? 0,
          updated_at: preference.updatedAt,
        })),
      );
    }

    if (scope === "workspace" || (scope === "all" && results.length === 0)) {
      const memories = await this.repositories.memoryItems.search({
        workspaceId: this.context.workspaceId,
        query: parsed.query,
        entityKey: parsed.entity_key,
        limit,
      });
      results.push(
        ...memories.map((memory) => ({
          scope: "workspace",
          memory_id: memory.memoryId,
          entity_key: memory.entityKey,
          text: memory.text,
          attributes: memory.attributes ?? {},
          tags: memory.tags ?? [],
          importance: memory.importance ?? 0,
          updated_at: memory.updatedAt,
        })),
      );
    }

    return jsonResult({
      count: results.length,
      memories: results.slice(0, limit ?? 20),
    });
  }

  private async saveMemory(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const parsed = saveMemorySchema.parse(input);
    const scope = parsed.scope ?? inferSaveScope(this.context);
    const origin = parsed.origin ?? this.context.memoryWritePolicy?.defaultOrigin ?? "explicit";
    const entityKey = normalizeEntityKey(parsed.entity_key);
    const tags = normalizeTags(parsed.tags);

    if (scope === "channel") {
      if (!this.context.channelId || !this.repositories.channelMemories) {
        return errorResult("Channel-scoped memory is unavailable in this context.");
      }

      const status =
        origin === "explicit"
          ? "active"
          : this.context.memoryWritePolicy?.channelInferredStatus ?? "active";
      const memory = await this.repositories.channelMemories.save({
        workspaceId: this.context.workspaceId,
        channelId: this.context.channelId,
        entityKey,
        text: parsed.text,
        attributes: parsed.attributes,
        tags,
        importance: parsed.importance,
        status,
        origin,
        sourceType: "agent",
        createdByUserId: this.context.userId,
      });
      this.savedMemoryIds.add(memory.memoryId);

      return jsonResult({
        saved: true,
        scope: "channel",
        memory_id: memory.memoryId,
        entity_key: memory.entityKey,
        text: memory.text,
        tags: memory.tags ?? [],
        status: memory.status,
        origin: memory.origin,
        approval_required: memory.status === "candidate",
        updated_at: memory.updatedAt,
      });
    }

    if (scope === "user_preference") {
      if (!this.context.userId || !this.repositories.userPreferences) {
        return errorResult("User preference memory is unavailable in this context.");
      }

      const preference = await this.repositories.userPreferences.save({
        workspaceId: this.context.workspaceId,
        userId: this.context.userId,
        preferenceKey: normalizeOptionalString(parsed.preference_key),
        entityKey,
        text: parsed.text,
        attributes: parsed.attributes,
        tags,
        importance: parsed.importance,
        origin: origin === "imported" ? "inferred" : origin,
        sourceType: "agent",
        createdByUserId: this.context.userId,
      });
      this.savedMemoryIds.add(preference.preferenceId);

      return jsonResult({
        saved: true,
        scope: "user_preference",
        memory_id: preference.preferenceId,
        preference_key: preference.preferenceKey,
        entity_key: preference.entityKey,
        text: preference.text,
        tags: preference.tags ?? [],
        updated_at: preference.updatedAt,
      });
    }

    if (this.context.memoryWritePolicy?.allowWorkspaceMemory === false) {
      return errorResult(
        "Workspace-scoped memory cannot be saved from this context. Use channel or user_preference memory instead.",
      );
    }

    const memory = await this.repositories.memoryItems.save({
      workspaceId: this.context.workspaceId,
      entityKey,
      text: parsed.text,
      attributes: parsed.attributes,
      tags,
      importance: parsed.importance,
      sourceType: "agent",
      createdByUserId: this.context.userId,
    });
    this.savedMemoryIds.add(memory.memoryId);

    return jsonResult({
      saved: true,
      scope: "workspace",
      memory_id: memory.memoryId,
      entity_key: memory.entityKey,
      text: memory.text,
      tags: memory.tags ?? [],
      updated_at: memory.updatedAt,
    });
  }

  private async promoteMemoryToWorkspace(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const parsed = promoteMemoryToWorkspaceSchema.parse(input);
    if (!this.context.channelId || !this.repositories.channelMemories) {
      return errorResult("Channel memory promotion is unavailable outside a channel context.");
    }

    const source = await this.repositories.channelMemories.get(
      this.context.workspaceId,
      this.context.channelId,
      parsed.memory_id,
    );
    if (!source) {
      return errorResult(`Channel memory was not found: ${parsed.memory_id}`);
    }
    if (source.status === "rejected" || source.status === "archived") {
      return errorResult(`Channel memory ${parsed.memory_id} is ${source.status} and cannot be promoted.`);
    }

    const tags = normalizeTags([...(source.tags ?? []), ...(parsed.tags ?? []), "promoted"]);
    const memory = await this.repositories.memoryItems.save({
      workspaceId: this.context.workspaceId,
      entityKey: normalizeEntityKey(parsed.entity_key ?? source.entityKey),
      text: source.text,
      attributes: {
        ...(source.attributes ?? {}),
        promotedFrom: {
          scope: "channel",
          workspaceId: source.workspaceId,
          channelId: source.channelId,
          memoryId: source.memoryId,
          status: source.status,
          origin: source.origin,
          promotedByUserId: this.context.userId,
          promotedAt: new Date().toISOString(),
        },
      },
      tags,
      importance: parsed.importance ?? source.importance,
      sourceType: "channel_memory_promotion",
      sourceRef: `channel:${source.channelId}/memory:${source.memoryId}`,
      createdByUserId: this.context.userId,
    });
    this.savedMemoryIds.add(memory.memoryId);

    return jsonResult({
      promoted: true,
      source: {
        scope: "channel",
        memory_id: source.memoryId,
        channel_id: source.channelId,
        status: source.status,
      },
      workspace_memory: {
        scope: "workspace",
        memory_id: memory.memoryId,
        entity_key: memory.entityKey,
        text: memory.text,
        tags: memory.tags ?? [],
        updated_at: memory.updatedAt,
      },
    });
  }

  private async webSearch(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const parsed = webSearchSchema.parse(input);
    const result = await this.requireWebProvider().search({
      query: parsed.query,
      limit: parsed.limit,
      country: parsed.country,
      language: parsed.language,
      freshness: parsed.freshness,
      domains: parsed.domains,
    });

    return jsonResult({
      provider: result.provider,
      query: result.query,
      count: result.count,
      results: result.results.map((entry) => ({
        title: entry.title,
        url: entry.url,
        description: entry.description,
        published_at: entry.publishedAt,
        source_name: entry.sourceName,
        language: entry.language,
      })),
    });
  }

  private async webExtract(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const parsed = webExtractSchema.parse(input);
    const result = await this.requireWebProvider().extract({
      url: parsed.url,
      maxChars: parsed.max_chars,
    });

    return jsonResult({
      url: result.url,
      final_url: result.finalUrl,
      title: result.title,
      content_type: result.contentType,
      text: result.text,
      truncated: result.truncated,
    });
  }

  private async listTasks(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const parsed = listTasksSchema.parse(input);
    const tasks = await this.repositories.tasks.list({
      workspaceId: this.context.workspaceId,
      statuses: parsed.statuses as TaskStatus[] | undefined,
      dueBefore: parsed.due_before,
      limit: parsed.limit,
      ownerUserId: this.context.userId,
    });

    return jsonResult({
      count: tasks.length,
      tasks: tasks.map((task) => ({
        task_id: task.taskId,
        title: task.title,
        description: task.description,
        status: task.status,
        due_at: task.dueAt,
        priority: task.priority,
        calendar_event_id: task.calendarEventId,
        updated_at: task.updatedAt,
        completed_at: task.completedAt,
      })),
    });
  }

  private async upsertTask(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const parsed = upsertTaskSchema.parse(input);
    const existing = parsed.task_id
      ? await this.repositories.tasks.get(this.context.workspaceId, parsed.task_id)
      : null;
    const task = await this.repositories.tasks.upsert({
      workspaceId: this.context.workspaceId,
      taskId: parsed.task_id,
      title: parsed.title,
      description: parsed.description,
      status: parsed.status ?? existing?.status ?? "open",
      dueAt: parsed.due_at,
      priority: parsed.priority,
      ownerUserId: existing?.ownerUserId ?? this.context.userId,
      calendarEventId: parsed.calendar_event_id,
      sourceType: parsed.source_type ?? "agent",
      sourceRef: parsed.source_ref,
      metadata: parsed.metadata,
      completedAt: parsed.status === "done" ? existing?.completedAt ?? new Date().toISOString() : undefined,
      completedByUserId: parsed.status === "done" ? this.context.userId : undefined,
    });
    this.taskIds.add(task.taskId);

    await this.repositories.taskEvents.save({
      taskId: task.taskId,
      type: existing ? "updated" : "created",
      payload: {
        title: task.title,
        status: task.status,
        due_at: task.dueAt,
      },
    });

    return jsonResult({
      saved: true,
      task_id: task.taskId,
      title: task.title,
      status: task.status,
      due_at: task.dueAt,
      calendar_event_id: task.calendarEventId,
      updated_at: task.updatedAt,
    });
  }

  private async markTaskDone(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const parsed = markTaskDoneSchema.parse(input);
    const task = await this.repositories.tasks.markDone({
      workspaceId: this.context.workspaceId,
      taskId: parsed.task_id,
      completedByUserId: this.context.userId,
      completedAt: parsed.completed_at,
    });
    this.taskIds.add(task.taskId);

    await this.repositories.taskEvents.save({
      taskId: task.taskId,
      type: "marked_done",
      payload: {
        completed_at: task.completedAt,
        completed_by_user_id: task.completedByUserId,
      },
    });

    return jsonResult({
      saved: true,
      task_id: task.taskId,
      status: task.status,
      completed_at: task.completedAt,
    });
  }

  private async listRecurringTasks(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const parsed = listRecurringTasksSchema.parse(input);
    const repository = this.requireRecurringTaskRepository();
    const tasks = await repository.list({
      workspaceId: this.context.workspaceId,
      enabled: parsed.enabled,
      limit: parsed.limit,
    });

    return jsonResult({
      count: tasks.length,
      recurring_tasks: tasks.map((task) => ({
        recurring_task_id: task.recurringTaskId,
        title: task.title,
        description: task.description,
        recurrence: serializeRecurringTaskRecurrence(task.recurrence),
        due_time: task.dueTime,
        timezone: task.timezone,
        enabled: task.enabled,
        owner_user_id: task.ownerUserId,
        priority: task.priority,
        source_type: task.sourceType,
        source_ref: task.sourceRef,
        updated_at: task.updatedAt,
      })),
    });
  }

  private async upsertRecurringTask(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const parsed = upsertRecurringTaskSchema.parse(input);
    const repository = this.requireRecurringTaskRepository();
    const recurrence = normalizeRecurringTaskRecurrence(parsed.recurrence);
    const recurringTaskId =
      normalizeOptionalString(parsed.recurring_task_id) ??
      buildRecurringTaskId(parsed.title, recurrence, parsed.due_time);
    const task = await repository.upsert({
      recurringTaskId,
      workspaceId: this.context.workspaceId,
      title: parsed.title,
      description: parsed.description,
      recurrence,
      dueTime: parsed.due_time ?? "23:59",
      timezone: parsed.timezone ?? this.getDefaultCalendarTimeZone(),
      enabled: parsed.enabled,
      ownerUserId: parsed.owner_user_id ?? this.context.userId,
      priority: parsed.priority,
      sourceType: parsed.source_type ?? "agent",
      sourceRef: parsed.source_ref,
      metadata: parsed.metadata,
    });
    this.recurringTaskIds.add(task.recurringTaskId);

    return jsonResult({
      saved: true,
      recurring_task_id: task.recurringTaskId,
      title: task.title,
      recurrence: serializeRecurringTaskRecurrence(task.recurrence),
      due_time: task.dueTime,
      timezone: task.timezone,
      enabled: task.enabled,
      updated_at: task.updatedAt,
    });
  }

  private async disableRecurringTask(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const parsed = disableRecurringTaskSchema.parse(input);
    const repository = this.requireRecurringTaskRepository();
    const task = await repository.disable(this.context.workspaceId, parsed.recurring_task_id);
    this.recurringTaskIds.add(task.recurringTaskId);

    return jsonResult({
      disabled: true,
      recurring_task_id: task.recurringTaskId,
      title: task.title,
      updated_at: task.updatedAt,
    });
  }

  private async listScheduledReminders(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const parsed = listScheduledRemindersSchema.parse(input);
    const repository = this.requireScheduledTaskRepository();
    const tasks = await repository.list({
      workspaceId: this.context.workspaceId,
      enabled: parsed.enabled,
      limit: parsed.limit,
    });

    return jsonResult({
      count: tasks.length,
      scheduled_reminders: tasks.map(serializeScheduledReminder),
    });
  }

  private async createScheduledReminder(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const parsed = createScheduledReminderSchema.parse(input);
    const repository = this.requireScheduledTaskRepository();
    const scheduler = this.requireScheduledReminderScheduler();
    const now = new Date().toISOString();
    const taskId = normalizeOptionalString(parsed.scheduled_task_id) ?? `sched_${randomUUID().slice(0, 8)}`;
    const existing = await repository.get(this.context.workspaceId, taskId);
    if (existing) {
      throw new Error(
        `Scheduled reminder ${taskId} already exists in this workspace. Use update_scheduled_reminder to change it.`,
      );
    }
    const outputChannelId = parsed.output_channel_id ?? this.context.channelId;
    if (!outputChannelId) {
      return errorResult("A Slack output channel is required to create a scheduled reminder.");
    }

    const scheduleExpression = resolveScheduledReminderExpression({
      recurrence: parsed.recurrence,
      scheduleExpression: parsed.schedule_expression,
    });
    const task: ScheduledTask = {
      taskId,
      name: parsed.name,
      prompt: parsed.prompt,
      workspaceId: this.context.workspaceId,
      outputChannelId,
      enabled: parsed.enabled ?? true,
      scheduleName: scheduler.buildScheduleName(this.context.workspaceId, taskId),
      scheduleExpression,
      scheduleExpressionTimezone: parsed.timezone ?? this.getDefaultCalendarTimeZone(),
      createdByUserId: this.context.userId,
      updatedByUserId: this.context.userId,
      reuseSession: false,
      createdAt: now,
      updatedAt: now,
    };

    const schedule = await scheduler.put(task);
    const savedTask = {
      ...task,
      scheduleName: schedule.scheduleName,
      scheduleGroupName: schedule.scheduleGroupName,
    };
    await repository.save(savedTask);

    return jsonResult({
      saved: true,
      scheduled_reminder: serializeScheduledReminder(savedTask),
    });
  }

  private async updateScheduledReminder(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const parsed = updateScheduledReminderSchema.parse(input);
    const repository = this.requireScheduledTaskRepository();
    const scheduler = this.requireScheduledReminderScheduler();
    const existing = await repository.get(this.context.workspaceId, parsed.scheduled_task_id);
    if (!existing || existing.workspaceId !== this.context.workspaceId) {
      throw new Error(`Scheduled reminder ${parsed.scheduled_task_id} was not found`);
    }

    const scheduleExpression =
      parsed.recurrence || parsed.schedule_expression
        ? resolveScheduledReminderExpression({
            recurrence: parsed.recurrence,
            scheduleExpression: parsed.schedule_expression,
          })
        : existing.scheduleExpression;
    if (!scheduleExpression) {
      throw new Error(`Scheduled reminder ${existing.taskId} does not have a schedule expression`);
    }

    const updated: ScheduledTask = {
      ...existing,
      name: parsed.name ?? existing.name,
      prompt: parsed.prompt ?? existing.prompt,
      outputChannelId: parsed.output_channel_id ?? existing.outputChannelId,
      enabled: parsed.enabled ?? existing.enabled,
      scheduleName: existing.scheduleName ?? scheduler.buildScheduleName(existing.workspaceId, existing.taskId),
      scheduleExpression,
      scheduleExpressionTimezone:
        parsed.timezone ?? existing.scheduleExpressionTimezone ?? this.getDefaultCalendarTimeZone(),
      updatedByUserId: this.context.userId,
      updatedAt: new Date().toISOString(),
    };

    const schedule = await scheduler.put(updated);
    const savedTask = {
      ...updated,
      scheduleName: schedule.scheduleName,
      scheduleGroupName: schedule.scheduleGroupName,
    };
    await repository.save(savedTask);

    return jsonResult({
      updated: true,
      scheduled_reminder: serializeScheduledReminder(savedTask),
    });
  }

  private async deleteScheduledReminder(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const parsed = deleteScheduledReminderSchema.parse(input);
    const repository = this.requireScheduledTaskRepository();
    const scheduler = this.requireScheduledReminderScheduler();
    const existing = await repository.get(this.context.workspaceId, parsed.scheduled_task_id);
    if (!existing || existing.workspaceId !== this.context.workspaceId) {
      throw new Error(`Scheduled reminder ${parsed.scheduled_task_id} was not found`);
    }

    await scheduler.delete(existing);
    await repository.delete(existing.workspaceId, existing.taskId);

    return jsonResult({
      deleted: true,
      scheduled_task_id: existing.taskId,
      name: existing.name,
    });
  }

  private async getWeatherForecast(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const parsed = getWeatherForecastSchema.parse(input);
    const forecast = await this.requireWeatherProvider().getForecast({
      location: parsed.location,
      date: parsed.date,
      timezone: parsed.timezone ?? this.getDefaultCalendarTimeZone(),
    });

    return jsonResult({
      location: {
        name: forecast.locationName,
        country: forecast.country,
        admin1: forecast.admin1,
        latitude: forecast.latitude,
        longitude: forecast.longitude,
      },
      date: forecast.date,
      timezone: forecast.timezone,
      weather_code: forecast.weatherCode,
      weather: forecast.weatherDescription,
      temperature_max_c: forecast.temperatureMaxC,
      temperature_min_c: forecast.temperatureMinC,
      precipitation_probability_max_pct: forecast.precipitationProbabilityMaxPct,
      precipitation_mm: forecast.precipitationMm,
      wind_speed_max_kmh: forecast.windSpeedMaxKmh,
      umbrella_note: forecast.umbrellaNote,
      summary: forecast.summary,
    });
  }

  private async listGoogleCalendars(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const parsed = listGoogleCalendarsSchema.parse(input);
    const calendar = await this.requireGoogleCalendar();
    const result = await calendar.listCalendars({
      minAccessRole: parsed.min_access_role,
      maxResults: parsed.limit,
    });
    const query = parsed.query ? normalizeSearchText(parsed.query) : undefined;
    const calendars = query
      ? result.calendars.filter((entry) => calendarMatchesQuery(entry, query))
      : result.calendars;

    return jsonResult({
      count: calendars.length,
      calendars: calendars.map(serializeGoogleCalendarListEntry),
    });
  }

  private async listCalendarEvents(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const parsed = listCalendarEventsSchema.parse(input);
    const calendar = await this.requireGoogleCalendar();
    const timeMin = parsed.time_min ?? new Date().toISOString();
    const timeMax = parsed.time_max ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const calendarId = await this.resolveCalendarId({
      calendar,
      calendarId: parsed.calendar_id,
      calendarName: parsed.calendar_name,
      minAccessRole: "reader",
    });

    const result = await calendar.listEvents({
      calendarId,
      timeMin,
      timeMax,
      timeZone: parsed.time_zone ?? this.getDefaultCalendarTimeZone(),
      query: parsed.query,
      maxResults: parsed.limit,
    });

    return jsonResult({
      count: result.events.length,
      calendar_id: result.calendarId,
      time_zone: result.timeZone,
      events: result.events.map((event) => ({
        event_id: event.id,
        status: event.status,
        summary: event.summary,
        description: event.description,
        location: event.location,
        start: serializeGoogleEventTime(event.start),
        end: serializeGoogleEventTime(event.end),
        private_properties: event.extendedProperties?.private ?? {},
        html_link: event.htmlLink,
        updated_at: event.updated,
      })),
    });
  }

  private async findFreeBusy(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const parsed = findFreeBusySchema.parse(input);
    const calendar = await this.requireGoogleCalendar();
    const resolvedCalendarIds = await this.resolveCalendarIds({
      calendar,
      calendarIds: parsed.calendar_ids,
      calendarNames: parsed.calendar_names,
      minAccessRole: "freeBusyReader",
    });
    const result = await calendar.queryFreeBusy({
      calendarIds: resolvedCalendarIds,
      timeMin: parsed.time_min,
      timeMax: parsed.time_max,
      timeZone: parsed.time_zone ?? this.getDefaultCalendarTimeZone(),
    });

    return jsonResult({
      time_min: result.timeMin,
      time_max: result.timeMax,
      time_zone: result.timeZone,
      calendars: result.calendars,
    });
  }

  private async createCalendarDraft(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const parsed = createCalendarDraftSchema.parse(input);
    const draftRepository = this.requireCalendarDraftRepository();
    const now = new Date().toISOString();
    const draftId = `caldraft_${randomUUID()}`;
    const candidates = parsed.candidates.map((candidate) =>
      normalizeCalendarDraftCandidate(candidate, {
        defaultTimeZone: this.getDefaultCalendarTimeZone(),
        sourceId: parsed.source_id,
        sourceRef: parsed.source_ref,
      }),
    );
    const calendarId = await this.resolveCalendarId({
      calendar: parsed.calendar_name ? await this.requireGoogleCalendar() : undefined,
      calendarId: parsed.calendar_id,
      calendarName: parsed.calendar_name,
      minAccessRole: "writer",
    });

    const draft: CalendarDraft = {
      draftId,
      workspaceId: this.context.workspaceId,
      userId: this.context.userId,
      title: parsed.title?.trim() || parsed.source_ref || parsed.source_id || "Calendar draft",
      notes: normalizeOptionalString(parsed.notes),
      sourceId: normalizeOptionalString(parsed.source_id),
      sourceRef: normalizeOptionalString(parsed.source_ref),
      calendarId: normalizeOptionalString(calendarId),
      status: "pending",
      candidates,
      createdAt: now,
      updatedAt: now,
    };

    await draftRepository.save(draft);
    this.calendarDraftIds.add(draft.draftId);

    return jsonResult({
      saved: true,
      draft_id: draft.draftId,
      title: draft.title,
      status: draft.status,
      calendar_id: draft.calendarId,
      candidate_count: draft.candidates.length,
      candidates: draft.candidates.map(serializeCalendarDraftCandidate),
      next_step: "Show this draft to the user and wait for explicit approval before apply_calendar_draft.",
    });
  }

  private async listCalendarDrafts(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const parsed = listCalendarDraftsSchema.parse(input);
    const draftRepository = this.requireCalendarDraftRepository();
    const drafts = await draftRepository.list({
      workspaceId: this.context.workspaceId,
      userId: this.context.userId,
      statuses: parsed.statuses as CalendarDraftStatus[] | undefined,
      limit: parsed.limit,
    });

    return jsonResult({
      count: drafts.length,
      drafts: drafts.map((draft) => ({
        draft_id: draft.draftId,
        title: draft.title,
        status: draft.status,
        calendar_id: draft.calendarId,
        source_id: draft.sourceId,
        source_ref: draft.sourceRef,
        created_at: draft.createdAt,
        updated_at: draft.updatedAt,
        candidate_count: draft.candidates.length,
        candidates: draft.candidates.map(serializeCalendarDraftCandidate),
      })),
    });
  }

  private async applyCalendarDraft(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const parsed = applyCalendarDraftSchema.parse(input);
    const draftRepository = this.requireCalendarDraftRepository();
    const calendar = await this.requireGoogleCalendar();
    const draft = await draftRepository.get(this.context.workspaceId, this.context.userId, parsed.draft_id);
    if (!draft) {
      throw new Error(`Calendar draft ${parsed.draft_id} was not found`);
    }

    const requestedIds = parsed.candidate_ids ? new Set(parsed.candidate_ids) : null;
    const selectedCandidates = draft.candidates.filter((candidate) =>
      requestedIds ? requestedIds.has(candidate.candidateId) : candidate.status === "pending",
    );
    if (requestedIds && selectedCandidates.length !== requestedIds.size) {
      throw new Error(`Some candidate_ids were not found in draft ${draft.draftId}`);
    }
    if (selectedCandidates.length === 0) {
      throw new Error("No calendar draft candidates are ready to apply");
    }
    if (selectedCandidates.some((candidate) => candidate.status === "rejected")) {
      throw new Error("Rejected calendar draft candidates cannot be applied");
    }

    const calendarId = await this.resolveCalendarId({
      calendar,
      calendarId: parsed.calendar_id ?? draft.calendarId,
      calendarName: parsed.calendar_name,
      minAccessRole: "writer",
    });
    const appliedAt = new Date().toISOString();
    const results: Array<{
      candidate_id: string;
      operation: "created" | "updated";
      event_id: string;
      html_link?: string;
      summary: string;
    }> = [];

    const candidateIds = new Set(selectedCandidates.map((candidate) => candidate.candidateId));
    const updatedCandidates: CalendarDraftCandidate[] = [];

    for (const candidate of draft.candidates) {
      if (!candidateIds.has(candidate.candidateId)) {
        updatedCandidates.push(candidate);
        continue;
      }

      const privateProperties = buildCalendarPrivateProperties(this.context.workspaceId, draft, candidate);
      const existingEvent = await calendar.findEventByPrivateProperties({
        calendarId,
        privateProperties: {
          [CALENDAR_PRIVATE_PROPERTY_KEYS.dedupeKey]: privateProperties[CALENDAR_PRIVATE_PROPERTY_KEYS.dedupeKey],
          [CALENDAR_PRIVATE_PROPERTY_KEYS.candidateId]: privateProperties[CALENDAR_PRIVATE_PROPERTY_KEYS.candidateId],
        },
      });
      const body = buildGoogleCalendarEventBody(candidate, privateProperties, this.getDefaultCalendarTimeZone());
      const appliedEvent = existingEvent?.id
        ? await calendar.patchEvent({
            calendarId,
            eventId: existingEvent.id,
            body,
          })
        : await calendar.createEvent({
            calendarId,
            body,
          });

      const operation: "created" | "updated" = existingEvent?.id ? "updated" : "created";
      updatedCandidates.push({
        ...candidate,
        status: "applied",
        calendarEventId: appliedEvent.id,
        calendarEventHtmlLink: appliedEvent.htmlLink,
        appliedAt,
      });
      results.push({
        candidate_id: candidate.candidateId,
        operation,
        event_id: appliedEvent.id,
        html_link: appliedEvent.htmlLink,
        summary: appliedEvent.summary ?? candidate.summary,
      });
    }

    const updatedDraft: CalendarDraft = {
      ...draft,
      calendarId,
      status: resolveCalendarDraftStatus(updatedCandidates),
      candidates: updatedCandidates,
      approvedAt: draft.approvedAt ?? appliedAt,
      lastAppliedAt: appliedAt,
      updatedAt: appliedAt,
      rejectedAt:
        updatedCandidates.every((candidate) => candidate.status === "rejected")
          ? draft.rejectedAt ?? appliedAt
          : draft.rejectedAt,
    };
    await draftRepository.save(updatedDraft);

    return jsonResult({
      applied: true,
      draft_id: updatedDraft.draftId,
      status: updatedDraft.status,
      calendar_id: updatedDraft.calendarId,
      event_count: results.length,
      events: results,
      remaining_pending_candidate_ids: updatedDraft.candidates
        .filter((candidate) => candidate.status === "pending")
        .map((candidate) => candidate.candidateId),
    });
  }

  private async discardCalendarDraft(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const parsed = discardCalendarDraftSchema.parse(input);
    const draftRepository = this.requireCalendarDraftRepository();
    const draft = await draftRepository.get(this.context.workspaceId, this.context.userId, parsed.draft_id);
    if (!draft) {
      throw new Error(`Calendar draft ${parsed.draft_id} was not found`);
    }

    const requestedIds = parsed.candidate_ids ? new Set(parsed.candidate_ids) : null;
    const candidateIds = new Set(
      draft.candidates
        .filter((candidate) => (requestedIds ? requestedIds.has(candidate.candidateId) : candidate.status === "pending"))
        .map((candidate) => candidate.candidateId),
    );
    if (requestedIds && candidateIds.size !== requestedIds.size) {
      throw new Error(`Some candidate_ids were not found in draft ${draft.draftId}`);
    }
    if (candidateIds.size === 0) {
      throw new Error("No calendar draft candidates are ready to discard");
    }

    const rejectedAt = new Date().toISOString();
    const rejectedCandidateIds: string[] = [];
    const skippedCandidateIds: string[] = [];

    const updatedCandidates = draft.candidates.map((candidate) => {
      if (!candidateIds.has(candidate.candidateId)) {
        return candidate;
      }
      if (candidate.status === "applied") {
        skippedCandidateIds.push(candidate.candidateId);
        return candidate;
      }
      rejectedCandidateIds.push(candidate.candidateId);
      return {
        ...candidate,
        status: "rejected" as const,
        rejectedAt,
      };
    });

    const updatedDraft: CalendarDraft = {
      ...draft,
      status: resolveCalendarDraftStatus(updatedCandidates),
      candidates: updatedCandidates,
      rejectedAt:
        updatedCandidates.every((candidate) => candidate.status === "rejected") || rejectedCandidateIds.length > 0
          ? draft.rejectedAt ?? rejectedAt
          : draft.rejectedAt,
      updatedAt: rejectedAt,
    };
    await draftRepository.save(updatedDraft);

    return jsonResult({
      discarded: true,
      draft_id: updatedDraft.draftId,
      status: updatedDraft.status,
      rejected_candidate_ids: rejectedCandidateIds,
      skipped_candidate_ids: skippedCandidateIds,
      remaining_pending_candidate_ids: updatedDraft.candidates
        .filter((candidate) => candidate.status === "pending")
        .map((candidate) => candidate.candidateId),
    });
  }

  private async requireGoogleCalendar(): Promise<GoogleCalendarClient> {
    if (this.integrations.googleCalendarProvider) {
      return this.integrations.googleCalendarProvider();
    }
    if (!this.integrations.googleCalendar) {
      throw new Error("Google Calendar integration is not configured");
    }
    return this.integrations.googleCalendar;
  }

  private requireCalendarDraftRepository(): CalendarDraftRepository {
    if (!this.repositories.calendarDrafts) {
      throw new Error("Calendar draft storage is not configured");
    }
    return this.repositories.calendarDrafts;
  }

  private requireRecurringTaskRepository(): RecurringTaskRepository {
    if (!this.repositories.recurringTasks) {
      throw new Error("Recurring task storage is not configured");
    }
    return this.repositories.recurringTasks;
  }

  private requireScheduledTaskRepository(): TaskRepository {
    if (!this.repositories.scheduledTasks) {
      throw new Error("Scheduled reminder storage is not configured");
    }
    return this.repositories.scheduledTasks;
  }

  private requireScheduledReminderScheduler(): ScheduledReminderScheduler {
    if (!this.integrations.scheduledReminderScheduler) {
      throw new Error("Scheduled reminder schedule management is not configured");
    }
    return this.integrations.scheduledReminderScheduler;
  }

  private requireWeatherProvider(): WeatherForecastProvider {
    if (!this.integrations.weatherProvider) {
      throw new Error("Weather forecast integration is not configured");
    }
    return this.integrations.weatherProvider;
  }

  private requireWebProvider(): WebToolProvider {
    if (!this.integrations.webProvider) {
      throw new Error("Web tools integration is not configured");
    }
    return this.integrations.webProvider;
  }

  private requireSkillRegistry(): SkillRegistry {
    if (!this.integrations.skillRegistry) {
      throw new Error("Skill registry is not configured");
    }
    return this.integrations.skillRegistry;
  }

  private getDefaultCalendarTimeZone(): string {
    return this.integrations.defaultCalendarTimeZone ?? DEFAULT_CALENDAR_TIME_ZONE;
  }

  private async resolveCalendarIds(input: {
    calendar: GoogleCalendarClient;
    calendarIds?: string[];
    calendarNames?: string[];
    minAccessRole: GoogleCalendarAccessRole;
  }): Promise<string[] | undefined> {
    const resolved = [...(input.calendarIds ?? [])];
    for (const calendarName of input.calendarNames ?? []) {
      const calendarId = await this.resolveCalendarId({
        calendar: input.calendar,
        calendarName,
        minAccessRole: input.minAccessRole,
      });
      if (calendarId) {
        resolved.push(calendarId);
      }
    }

    return resolved.length > 0 ? [...new Set(resolved)] : undefined;
  }

  private async resolveCalendarId(input: {
    calendar?: GoogleCalendarClient;
    calendarId?: string;
    calendarName?: string;
    minAccessRole: GoogleCalendarAccessRole;
  }): Promise<string | undefined> {
    if (input.calendarId) {
      return input.calendarId;
    }
    if (!input.calendarName) {
      return undefined;
    }
    if (!input.calendar) {
      throw new Error("Google Calendar is required to resolve a calendar name");
    }

    const result = await input.calendar.listCalendars({
      minAccessRole: input.minAccessRole,
      maxResults: 250,
    });
    const matched = findCalendarByName(result.calendars, input.calendarName);
    if (!matched) {
      throw new Error(
        `Google Calendar named '${input.calendarName}' was not found with ${input.minAccessRole} access or higher.`,
      );
    }

    return matched.id;
  }
}

function jsonResult(payload: unknown): ToolExecutionResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function errorResult(message: string): ToolExecutionResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: message,
      },
    ],
  };
}

function normalizeEntityKey(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase().replace(/\s+/g, "-");
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeTags(tags?: string[]): string[] | undefined {
  if (!tags || tags.length === 0) {
    return undefined;
  }

  const normalized = [...new Set(tags.map((tag) => tag.trim().toLowerCase().replace(/\s+/g, "_")).filter(Boolean))];
  return normalized.length > 0 ? normalized : undefined;
}

function inferSearchScope(context: ToolExecutionContext): "all" | "workspace" {
  if (context.channelId || context.userId) {
    return "all";
  }

  return "workspace";
}

function inferSaveScope(context: ToolExecutionContext): "channel" | "user_preference" | "workspace" {
  if (context.channelId) {
    return "channel";
  }
  if (context.userId) {
    return "user_preference";
  }

  return "workspace";
}

function serializeGoogleCalendarListEntry(entry: GoogleCalendarListEntry): Record<string, unknown> {
  return {
    calendar_id: entry.id,
    summary: entry.summary,
    summary_override: entry.summaryOverride,
    description: entry.description,
    time_zone: entry.timeZone,
    access_role: entry.accessRole,
    primary: entry.primary,
    selected: entry.selected,
    hidden: entry.hidden,
  };
}

function findCalendarByName(
  calendars: GoogleCalendarListEntry[],
  calendarName: string,
): GoogleCalendarListEntry | null {
  const query = normalizeSearchText(calendarName);
  const exactMatches = calendars.filter((entry) => calendarNameCandidates(entry).some((candidate) => candidate === query));
  if (exactMatches.length === 1) {
    return exactMatches[0];
  }
  if (exactMatches.length > 1) {
    throw new Error(
      `Google Calendar name '${calendarName}' matched multiple calendars: ${exactMatches
        .map((entry) => entry.summary ?? entry.id)
        .join(", ")}`,
    );
  }

  const partialMatches = calendars.filter((entry) => calendarMatchesQuery(entry, query));
  if (partialMatches.length === 1) {
    return partialMatches[0];
  }
  if (partialMatches.length > 1) {
    throw new Error(
      `Google Calendar name '${calendarName}' matched multiple calendars: ${partialMatches
        .map((entry) => entry.summary ?? entry.id)
        .join(", ")}`,
    );
  }

  return null;
}

function calendarMatchesQuery(entry: GoogleCalendarListEntry, query: string): boolean {
  return calendarNameCandidates(entry).some((candidate) => candidate.includes(query));
}

function calendarNameCandidates(entry: GoogleCalendarListEntry): string[] {
  return [entry.id, entry.summary, entry.summaryOverride].map((value) => normalizeSearchText(value)).filter(Boolean);
}

function normalizeSearchText(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function normalizeCalendarDraftCandidate(
  input: CalendarDraftCandidateInput,
  context: {
    defaultTimeZone: string;
    sourceId?: string;
    sourceRef?: string;
  },
): CalendarDraftCandidate {
  const candidateId = normalizeOptionalString(input.candidate_id) ?? `calcand_${randomUUID()}`;
  const summary = input.summary.trim();
  const description = normalizeOptionalString(input.description);
  const location = normalizeOptionalString(input.location);
  const sourceText = normalizeOptionalString(input.source_text);
  const timeZone = normalizeOptionalString(input.time_zone) ?? context.defaultTimeZone;
  const allDay = Boolean(input.all_day || input.start_date || input.end_date);

  if (allDay) {
    const startDate = input.start_date!.trim();
    const endDate = normalizeOptionalString(input.end_date) ?? startDate;
    return {
      candidateId,
      summary,
      description,
      location,
      allDay: true,
      startDate,
      endDate,
      timeZone,
      sourceText,
      confidence: input.confidence,
      dedupeKey:
        normalizeOptionalString(input.dedupe_key) ??
        buildCalendarCandidateDedupeKey({
          summary,
          location,
          allDay: true,
          startDate,
          endDate,
          sourceId: context.sourceId,
          sourceRef: context.sourceRef,
        }),
      status: "pending",
    };
  }

  return {
    candidateId,
    summary,
    description,
    location,
    allDay: false,
    startAt: input.start_at!.trim(),
    endAt: input.end_at!.trim(),
    timeZone,
    sourceText,
    confidence: input.confidence,
    dedupeKey:
      normalizeOptionalString(input.dedupe_key) ??
      buildCalendarCandidateDedupeKey({
        summary,
        location,
        allDay: false,
        startAt: input.start_at!.trim(),
        endAt: input.end_at!.trim(),
        timeZone,
        sourceId: context.sourceId,
        sourceRef: context.sourceRef,
      }),
    status: "pending",
  };
}

function buildCalendarCandidateDedupeKey(input: Record<string, unknown>): string {
  const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  return `dedupe_${hash.slice(0, 24)}`;
}

function buildCalendarPrivateProperties(
  workspaceId: string,
  draft: CalendarDraft,
  candidate: CalendarDraftCandidate,
): Record<string, string> {
  return {
    [CALENDAR_PRIVATE_PROPERTY_KEYS.draftId]: draft.draftId,
    [CALENDAR_PRIVATE_PROPERTY_KEYS.candidateId]: candidate.candidateId,
    [CALENDAR_PRIVATE_PROPERTY_KEYS.dedupeKey]: candidate.dedupeKey ?? candidate.candidateId,
    [CALENDAR_PRIVATE_PROPERTY_KEYS.workspaceId]: workspaceId,
    ...(draft.sourceId ? { [CALENDAR_PRIVATE_PROPERTY_KEYS.sourceId]: draft.sourceId } : {}),
  };
}

function buildGoogleCalendarEventBody(
  candidate: CalendarDraftCandidate,
  privateProperties: Record<string, string>,
  defaultTimeZone: string,
): Record<string, unknown> {
  return {
    summary: candidate.summary,
    description: candidate.description,
    location: candidate.location,
    start: candidate.allDay
      ? {
          date: candidate.startDate,
        }
      : {
          dateTime: candidate.startAt,
          timeZone: candidate.timeZone ?? defaultTimeZone,
        },
    end: candidate.allDay
      ? {
          date: buildExclusiveEndDate(candidate.startDate!, candidate.endDate),
        }
      : {
          dateTime: candidate.endAt,
          timeZone: candidate.timeZone ?? defaultTimeZone,
        },
    extendedProperties: {
      private: privateProperties,
    },
  };
}

function buildExclusiveEndDate(startDate: string, endDate?: string): string {
  const inclusiveEnd = endDate ?? startDate;
  const date = new Date(`${inclusiveEnd}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function resolveCalendarDraftStatus(candidates: CalendarDraftCandidate[]): CalendarDraftStatus {
  if (candidates.every((candidate) => candidate.status === "rejected")) {
    return "rejected";
  }
  if (candidates.some((candidate) => candidate.status === "pending")) {
    return candidates.some((candidate) => candidate.status === "applied") ? "approved" : "pending";
  }
  return "applied";
}

function serializeCalendarDraftCandidate(candidate: CalendarDraftCandidate): Record<string, unknown> {
  return {
    candidate_id: candidate.candidateId,
    summary: candidate.summary,
    description: candidate.description,
    location: candidate.location,
    all_day: candidate.allDay,
    start_date: candidate.startDate,
    end_date: candidate.endDate,
    start_at: candidate.startAt,
    end_at: candidate.endAt,
    time_zone: candidate.timeZone,
    source_text: candidate.sourceText,
    confidence: candidate.confidence,
    dedupe_key: candidate.dedupeKey,
    status: candidate.status,
    calendar_event_id: candidate.calendarEventId,
    calendar_event_html_link: candidate.calendarEventHtmlLink,
    applied_at: candidate.appliedAt,
    rejected_at: candidate.rejectedAt,
  };
}

function serializeGoogleEventTime(
  value?: { date?: string; dateTime?: string; timeZone?: string },
): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }

  return {
    date: value.date,
    date_time: value.dateTime,
    time_zone: value.timeZone,
  };
}

function normalizeOptionalString(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function resolveScheduledReminderExpression(input: {
  recurrence?: ScheduledReminderRecurrenceInput;
  scheduleExpression?: string;
}): string {
  const scheduleExpression = normalizeOptionalString(input.scheduleExpression);
  if (scheduleExpression) {
    return scheduleExpression;
  }
  if (!input.recurrence) {
    throw new Error("A recurrence or schedule_expression is required for scheduled reminders.");
  }
  return buildScheduleExpressionFromRecurrence({
    frequency: input.recurrence.frequency,
    time: input.recurrence.time,
    daysOfWeek: input.recurrence.days_of_week,
    daysOfMonth: input.recurrence.days_of_month,
  });
}

function serializeScheduledReminder(task: ScheduledTask): Record<string, unknown> {
  return {
    scheduled_task_id: task.taskId,
    name: task.name,
    prompt: task.prompt,
    output_channel_id: task.outputChannelId,
    enabled: task.enabled,
    schedule_name: task.scheduleName,
    schedule_group_name: task.scheduleGroupName,
    schedule_expression: task.scheduleExpression,
    timezone: task.scheduleExpressionTimezone,
    time: extractDailyCronTime(task.scheduleExpression),
    created_by_user_id: task.createdByUserId,
    updated_by_user_id: task.updatedByUserId,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  };
}

function serializeGeneratedSkill(skill: GeneratedSkillRecord): Record<string, unknown> {
  return {
    skill_id: skill.skillId,
    status: skill.status,
    version: skill.version,
    title: skill.title,
    description: skill.description,
    trigger_hints: skill.triggerHints,
    tool_allowlist: skill.toolAllowlist,
    constraints: skill.constraints,
    created_from_conversation_id: skill.createdFromConversationId,
    created_by_user_id: skill.createdByUserId,
    approved_by_user_id: skill.approvedByUserId,
    created_at: skill.createdAt,
    updated_at: skill.updatedAt,
  };
}

function normalizeRecurringTaskRecurrence(
  input: RecurringTaskRecurrenceInput,
): RecurringTaskRecurrence {
  return {
    frequency: input.frequency,
    interval: input.interval ?? 1,
    daysOfWeek: input.days_of_week && input.days_of_week.length > 0 ? [...new Set(input.days_of_week)] : undefined,
    daysOfMonth: input.days_of_month && input.days_of_month.length > 0 ? [...new Set(input.days_of_month)] : undefined,
    weekOfMonth: input.week_of_month,
  };
}

function serializeRecurringTaskRecurrence(
  recurrence: RecurringTaskRecurrence,
): Record<string, unknown> {
  return {
    frequency: recurrence.frequency,
    interval: recurrence.interval,
    days_of_week: recurrence.daysOfWeek,
    days_of_month: recurrence.daysOfMonth,
    week_of_month: recurrence.weekOfMonth,
  };
}

function buildRecurringTaskId(
  title: string,
  recurrence: RecurringTaskRecurrence,
  dueTime?: string,
): string {
  const hash = createHash("sha256")
    .update(JSON.stringify({
      title: title.trim().toLowerCase(),
      recurrence,
      dueTime: dueTime ?? "23:59",
    }))
    .digest("hex")
    .slice(0, 16);
  return `rt_${hash}`;
}

function isDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isRfc3339(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}
