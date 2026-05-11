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
import { TaskEventRepository } from "../repo/taskEventRepository";
import { TaskStateRepository } from "../repo/taskStateRepository";
import { UserPreferenceRepository } from "../repo/userPreferenceRepository";
import { Logger } from "../shared/logger";
import { TaskStatus } from "../tasks/taskState";

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
  tasks: TaskStateRepository;
  taskEvents: TaskEventRepository;
  calendarDrafts?: CalendarDraftRepository;
}

interface ToolIntegrations {
  googleCalendar?: GoogleCalendarClient;
  googleCalendarProvider?: () => GoogleCalendarClient | Promise<GoogleCalendarClient>;
  defaultCalendarTimeZone?: string;
}

export interface ToolExecutionSummary {
  savedMemoryIds: string[];
  taskIds: string[];
  calendarDraftIds: string[];
}

export class CustomToolExecutor {
  private readonly savedMemoryIds = new Set<string>();
  private readonly taskIds = new Set<string>();
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
        case "search_memories":
          return await this.searchMemories(input);
        case "save_memory":
          return await this.saveMemory(input);
        case "list_tasks":
          return await this.listTasks(input);
        case "upsert_task":
          return await this.upsertTask(input);
        case "mark_task_done":
          return await this.markTaskDone(input);
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
      calendarDraftIds: [...this.calendarDraftIds],
    };
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

function isDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isRfc3339(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}
