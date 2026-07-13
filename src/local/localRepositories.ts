import { createHash, randomUUID } from "node:crypto";
import { CalendarDraft, CalendarDraftStatus } from "../calendar/calendarDraft";
import { ChannelMemoryItem } from "../memory/channelMemoryItem";
import {
  decideExistingChannelMemoryUpsert,
  nextChannelMemoryUpdatedAt,
} from "../memory/channelMemoryUpsertPolicy";
import { MemoryItem } from "../memory/memoryItem";
import { UserPreferenceItem } from "../memory/userPreferenceItem";
import {
  CreateWorkSessionInput,
  ListActiveWorkSessionsInput,
  WorkSessionLifecycleInput,
} from "../repo/workSessionRepository";
import { matchesTaskSearch, normalizeSearchText } from "../repo/taskStateRepository";
import { BuiltinSkillOverride, GeneratedSkillRecord, SkillRepository } from "../skills/types";
import { WorkSessionKind, WorkSessionRecord, WorkSessionStatus } from "../shared/contracts";
import { RecurringTask, recurringTaskSchema } from "../tasks/recurringTask";
import { ScheduledTask } from "../tasks/taskDefinition";
import { TaskEventRecord, TaskState, TaskStatus } from "../tasks/taskState";
import { FileStateStore } from "./fileStateStore";

export function createLocalRepositories(store: FileStateStore) {
  const skills = new LocalSkillRepository(store);
  return {
    memoryItems: new LocalMemoryItemRepository(store),
    channelMemories: new LocalChannelMemoryRepository(store),
    userPreferences: new LocalUserPreferenceRepository(store),
    scheduledTasks: new LocalScheduledTaskRepository(store),
    tasks: new LocalTaskStateRepository(store),
    taskEvents: new LocalTaskEventRepository(store),
    recurringTasks: new LocalRecurringTaskRepository(store),
    calendarDrafts: new LocalCalendarDraftRepository(store),
    workSessions: new LocalWorkSessionRepository(store),
    skills,
  };
}

export class LocalMemoryItemRepository {
  constructor(private readonly store: FileStateStore) {}

  async save(item: Omit<MemoryItem, "memoryId" | "createdAt" | "updatedAt"> & { memoryId?: string }): Promise<MemoryItem> {
    return this.store.update((state) => {
      const existing = item.memoryId
        ? state.memoryItems.find((candidate) => candidate.workspaceId === item.workspaceId && candidate.memoryId === item.memoryId)
        : undefined;
      const now = new Date();
      const nowIso = now.toISOString();
      const record: MemoryItem = {
        ...existing,
        ...item,
        memoryId: item.memoryId ?? `mem_${randomUUID()}`,
        createdAt: existing?.createdAt ?? nowIso,
        updatedAt: nextChannelMemoryUpdatedAt(existing?.updatedAt, now),
      };
      upsert(state.memoryItems, record, (candidate) => candidate.workspaceId === record.workspaceId && candidate.memoryId === record.memoryId);
      return record;
    });
  }

  async search(input: {
    workspaceId: string;
    query: string;
    entityKey?: string;
    limit?: number;
  }): Promise<MemoryItem[]> {
    const state = await this.store.load();
    return rankSearchResults(
      state.memoryItems.filter((item) => item.workspaceId === input.workspaceId && (!input.entityKey || item.entityKey === input.entityKey)),
      input.query,
      input.limit,
    );
  }
}

export class LocalChannelMemoryRepository {
  constructor(private readonly store: FileStateStore) {}

  async save(
    item: Omit<ChannelMemoryItem, "memoryId" | "createdAt" | "updatedAt"> & { memoryId?: string },
  ): Promise<ChannelMemoryItem> {
    return this.store.update((state) => {
      const existing = item.memoryId
        ? state.channelMemories.find(
            (candidate) =>
              candidate.workspaceId === item.workspaceId &&
              candidate.channelId === item.channelId &&
              candidate.memoryId === item.memoryId,
          )
        : undefined;
      const now = new Date();
      const nowIso = now.toISOString();
      const record: ChannelMemoryItem = {
        ...existing,
        ...item,
        memoryId: item.memoryId ?? `chanmem_${randomUUID()}`,
        createdAt: existing?.createdAt ?? nowIso,
        updatedAt: nextChannelMemoryUpdatedAt(existing?.updatedAt, now),
      };
      upsert(
        state.channelMemories,
        record,
        (candidate) =>
          candidate.workspaceId === record.workspaceId &&
          candidate.channelId === record.channelId &&
          candidate.memoryId === record.memoryId,
      );
      return record;
    });
  }

  async upsert(
    item: Omit<ChannelMemoryItem, "memoryId" | "createdAt" | "updatedAt"> & {
      memoryId?: string;
      expectedUpdatedAt?: string;
    },
  ): Promise<ChannelMemoryItem> {
    return this.store.update((state) => {
      const scoped = state.channelMemories.filter(
        (candidate) => candidate.workspaceId === item.workspaceId && candidate.channelId === item.channelId,
      );
      const dedupeKey = normalizeLocalDedupeKey(item.dedupeKey);
      const dedupeMatches = dedupeKey
        ? scoped.filter((candidate) => normalizeLocalDedupeKey(candidate.dedupeKey) === dedupeKey)
        : [];
      const allMatches = item.memoryId
        ? scoped.filter((candidate) => candidate.memoryId === item.memoryId)
        : dedupeMatches.length > 0
          ? dedupeMatches
          : scoped.filter(
              (candidate) =>
                normalizeLocalComparable(candidate.entityKey ?? "") === normalizeLocalComparable(item.entityKey ?? "") &&
                normalizeLocalComparable(candidate.text) === normalizeLocalComparable(item.text),
            );
      const liveMatches = allMatches.filter(
        (candidate) => candidate.status === "active" || candidate.status === "candidate",
      );
      const matches = item.memoryId || liveMatches.length === 0 ? allMatches : liveMatches;

      if (matches.length > 1) {
        throw new Error(`Multiple channel memories match this fact: ${matches.map((entry) => entry.memoryId).join(", ")}`);
      }
      const existing = matches[0];
      if (item.memoryId && !existing) {
        throw new Error(`Channel memory ${item.memoryId} was not found in the current channel`);
      }
      if (existing && ["archived", "rejected"].includes(existing.status)) {
        throw new Error(`Channel memory ${existing.memoryId} is ${existing.status} and cannot be reactivated`);
      }

      const { expectedUpdatedAt: _expectedUpdatedAt, ...incoming } = item;
      const now = new Date();
      const nowIso = now.toISOString();
      const conflictingDedupeMemory = dedupeKey
        ? scoped.find(
            (candidate) =>
              normalizeLocalDedupeKey(candidate.dedupeKey) === dedupeKey &&
              candidate.memoryId !== existing?.memoryId &&
              (candidate.status === "active" || candidate.status === "candidate"),
          )
        : undefined;
      if (conflictingDedupeMemory) {
        throw new Error(
          `Channel memory dedupe key ${dedupeKey} is already used by ${conflictingDedupeMemory.memoryId}`,
        );
      }
      if (
        existing?.dedupeKey &&
        dedupeKey &&
        normalizeLocalDedupeKey(existing.dedupeKey) !== dedupeKey
      ) {
        throw new Error(`Channel memory ${existing.memoryId} dedupe key cannot be changed`);
      }

      const memoryId =
        existing?.memoryId ??
        item.memoryId ??
        buildLocalDeterministicMemoryId(item.workspaceId, item.channelId, dedupeKey, item.entityKey, item.text);
      if (!existing && scoped.some((candidate) => candidate.memoryId === memoryId)) {
        throw new Error(`Channel memory ID collision for ${memoryId}`);
      }

      const record: ChannelMemoryItem = {
        ...existing,
        ...incoming,
        memoryId,
        dedupeKey: dedupeKey ?? existing?.dedupeKey,
        entityKey: item.entityKey ?? existing?.entityKey,
        attributes:
          existing?.attributes || item.attributes
            ? { ...(existing?.attributes ?? {}), ...(item.attributes ?? {}) }
            : undefined,
        tags: mergeLocalTags(existing?.tags, item.tags),
        importance: item.importance ?? existing?.importance,
        status:
          existing?.status === "active" || (existing?.status === "candidate" && item.origin === "explicit")
            ? "active"
            : item.status,
        origin: existing?.origin === "explicit" ? "explicit" : item.origin,
        sourceType: existing?.sourceType ?? item.sourceType,
        sourceRef: existing?.sourceRef ?? item.sourceRef,
        createdByUserId: existing?.createdByUserId ?? item.createdByUserId,
        createdAt: existing?.createdAt ?? nowIso,
        updatedAt: nextChannelMemoryUpdatedAt(existing?.updatedAt, now),
      };

      if (
        existing &&
        decideExistingChannelMemoryUpsert({
          existing,
          next: record,
          incomingOrigin: item.origin,
          requestedMemoryId: item.memoryId,
          expectedUpdatedAt: item.expectedUpdatedAt,
        }) === "noop"
      ) {
        return existing;
      }

      upsert(
        state.channelMemories,
        record,
        (candidate) =>
          candidate.workspaceId === record.workspaceId &&
          candidate.channelId === record.channelId &&
          candidate.memoryId === record.memoryId,
      );
      return record;
    });
  }

  async get(workspaceId: string, channelId: string, memoryId: string): Promise<ChannelMemoryItem | null> {
    const state = await this.store.load();
    return (
      state.channelMemories.find(
        (item) => item.workspaceId === workspaceId && item.channelId === channelId && item.memoryId === memoryId,
      ) ?? null
    );
  }

  async search(input: {
    workspaceId: string;
    channelId: string;
    query: string;
    entityKey?: string;
    limit?: number;
    statuses?: ChannelMemoryItem["status"][];
  }): Promise<ChannelMemoryItem[]> {
    const state = await this.store.load();
    const statuses = input.statuses ?? ["active"];
    return rankSearchResults(
      state.channelMemories.filter(
        (item) =>
          item.workspaceId === input.workspaceId &&
          item.channelId === input.channelId &&
          statuses.includes(item.status) &&
          (!input.entityKey || item.entityKey === input.entityKey),
      ),
      input.query,
      input.limit,
    );
  }
}

function normalizeLocalDedupeKey(value?: string): string | undefined {
  const normalized = value?.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, "-");
  return normalized || undefined;
}

function normalizeLocalComparable(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

function buildLocalDeterministicMemoryId(
  workspaceId: string,
  channelId: string,
  dedupeKey: string | undefined,
  entityKey: string | undefined,
  text: string,
): string {
  const identity = dedupeKey ?? `exact:${normalizeLocalComparable(entityKey ?? "")}:${normalizeLocalComparable(text)}`;
  return `chanmem_${createHash("sha256").update(`${workspaceId}\0${channelId}\0${identity}`).digest("hex").slice(0, 32)}`;
}

function mergeLocalTags(existing?: string[], incoming?: string[]): string[] | undefined {
  const merged = [...new Set([...(existing ?? []), ...(incoming ?? [])])];
  return merged.length > 0 ? merged : undefined;
}

export class LocalUserPreferenceRepository {
  constructor(private readonly store: FileStateStore) {}

  async save(
    item: Omit<UserPreferenceItem, "preferenceId" | "createdAt" | "updatedAt"> & {
      preferenceId?: string;
    },
  ): Promise<UserPreferenceItem> {
    return this.store.update((state) => {
      const existing = item.preferenceId
        ? state.userPreferences.find(
            (candidate) =>
              candidate.workspaceId === item.workspaceId &&
              candidate.userId === item.userId &&
              candidate.preferenceId === item.preferenceId,
          )
        : undefined;
      const now = new Date().toISOString();
      const record: UserPreferenceItem = {
        ...existing,
        ...item,
        preferenceId: item.preferenceId ?? `pref_${randomUUID()}`,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      upsert(
        state.userPreferences,
        record,
        (candidate) =>
          candidate.workspaceId === record.workspaceId &&
          candidate.userId === record.userId &&
          candidate.preferenceId === record.preferenceId,
      );
      return record;
    });
  }

  async search(input: {
    workspaceId: string;
    userId: string;
    query: string;
    entityKey?: string;
    limit?: number;
  }): Promise<UserPreferenceItem[]> {
    const state = await this.store.load();
    return rankSearchResults(
      state.userPreferences.filter(
        (item) =>
          item.workspaceId === input.workspaceId &&
          item.userId === input.userId &&
          (!input.entityKey || item.entityKey === input.entityKey),
      ),
      input.query,
      input.limit,
    );
  }
}

export class LocalTaskStateRepository {
  constructor(private readonly store: FileStateStore) {}

  async get(workspaceId: string, taskId: string): Promise<TaskState | null> {
    const state = await this.store.load();
    return state.tasks.find((task) => task.workspaceId === workspaceId && task.taskId === taskId) ?? null;
  }

  async upsert(
    task: Omit<TaskState, "taskId" | "createdAt" | "updatedAt"> & { taskId?: string },
  ): Promise<TaskState> {
    return this.store.update((state) => {
      const existing = task.taskId
        ? state.tasks.find((candidate) => candidate.workspaceId === task.workspaceId && candidate.taskId === task.taskId)
        : undefined;
      const now = new Date().toISOString();
      const record: TaskState = {
        ...existing,
        ...task,
        taskId: task.taskId ?? `task_${randomUUID()}`,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      upsert(state.tasks, record, (candidate) => candidate.workspaceId === record.workspaceId && candidate.taskId === record.taskId);
      return record;
    });
  }

  async list(input: {
    workspaceId: string;
    statuses?: TaskStatus[];
    limit?: number;
    dueBefore?: string;
    ownerUserId?: string;
  }): Promise<TaskState[]> {
    const state = await this.store.load();
    const statuses = input.statuses && input.statuses.length > 0 ? input.statuses : (["open", "in_progress"] as TaskStatus[]);
    return state.tasks
      .filter((task) => task.workspaceId === input.workspaceId)
      .filter((task) => statuses.includes(task.status))
      .filter((task) => !input.ownerUserId || !task.ownerUserId || task.ownerUserId === input.ownerUserId)
      .filter((task) => !input.dueBefore || !task.dueAt || task.dueAt <= input.dueBefore!)
      .sort((a, b) => {
        const dueA = a.dueAt ?? "9999-12-31T23:59:59.999Z";
        const dueB = b.dueAt ?? "9999-12-31T23:59:59.999Z";
        return dueA.localeCompare(dueB) || b.updatedAt.localeCompare(a.updatedAt);
      })
      .slice(0, Math.min(Math.max(input.limit ?? 10, 1), 50));
  }

  async search(input: {
    workspaceId: string;
    query: string;
    statuses?: TaskStatus[];
    limit?: number;
    dueBefore?: string;
    ownerUserId?: string;
  }): Promise<TaskState[]> {
    const query = input.query.trim();
    if (!query) {
      return [];
    }

    const statuses =
      input.statuses && input.statuses.length > 0
        ? input.statuses
        : (["open", "in_progress", "done", "cancelled"] as TaskStatus[]);
    const terms = normalizeSearchText(query).split(/\s+/).filter(Boolean);
    const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
    const state = await this.store.load();

    return state.tasks
      .filter((task) => task.workspaceId === input.workspaceId)
      .filter((task) => statuses.includes(task.status))
      .filter((task) => !input.ownerUserId || !task.ownerUserId || task.ownerUserId === input.ownerUserId)
      .filter((task) => !input.dueBefore || !task.dueAt || task.dueAt <= input.dueBefore)
      .filter((task) => matchesTaskSearch(task, terms))
      .sort((a, b) => {
        const dueA = a.dueAt ?? "9999-12-31T23:59:59.999Z";
        const dueB = b.dueAt ?? "9999-12-31T23:59:59.999Z";
        return dueA.localeCompare(dueB) || b.updatedAt.localeCompare(a.updatedAt);
      })
      .slice(0, limit);
  }

  async patch(input: {
    workspaceId: string;
    taskId: string;
    expectedUpdatedAt?: string;
    patch: Partial<Pick<
      TaskState,
      "title" | "description" | "status" | "dueAt" | "priority" | "calendarEventId" | "sourceType" | "sourceRef" | "metadata"
    >>;
  }): Promise<TaskState> {
    const existing = await this.get(input.workspaceId, input.taskId);
    if (!existing) {
      throw new Error(`Task ${input.taskId} was not found`);
    }
    if (input.expectedUpdatedAt && existing.updatedAt !== input.expectedUpdatedAt) {
      throw new Error(`Task ${input.taskId} changed since it was loaded`);
    }

    const patch = Object.fromEntries(
      Object.entries(input.patch).filter(([, value]) => value !== undefined),
    ) as Partial<TaskState>;
    return this.upsert({
      ...existing,
      ...patch,
    });
  }

  async markDone(input: {
    workspaceId: string;
    taskId: string;
    completedByUserId?: string;
    completedAt?: string;
  }): Promise<TaskState> {
    const existing = await this.get(input.workspaceId, input.taskId);
    if (!existing) {
      throw new Error(`Task ${input.taskId} was not found`);
    }

    return this.upsert({
      ...existing,
      status: "done",
      completedAt: input.completedAt ?? new Date().toISOString(),
      completedByUserId: input.completedByUserId,
    });
  }
}

export class LocalTaskEventRepository {
  constructor(private readonly store: FileStateStore) {}

  async save(
    event: Omit<TaskEventRecord, "eventId" | "createdAt"> & {
      eventId?: string;
      createdAt?: string;
    },
  ): Promise<TaskEventRecord> {
    return this.store.update((state) => {
      const record: TaskEventRecord = {
        ...event,
        eventId: event.eventId ?? `tevt_${randomUUID()}`,
        createdAt: event.createdAt ?? new Date().toISOString(),
      };
      state.taskEvents.push(record);
      return record;
    });
  }
}

export class LocalRecurringTaskRepository {
  constructor(private readonly store: FileStateStore) {}

  async get(workspaceId: string, recurringTaskId: string): Promise<RecurringTask | null> {
    const state = await this.store.load();
    return state.recurringTasks.find((task) => task.workspaceId === workspaceId && task.recurringTaskId === recurringTaskId) ?? null;
  }

  async list(input: { workspaceId: string; enabled?: boolean; limit?: number }): Promise<RecurringTask[]> {
    const state = await this.store.load();
    return state.recurringTasks
      .filter((task) => task.workspaceId === input.workspaceId)
      .filter((task) => input.enabled === undefined || task.enabled === input.enabled)
      .slice(0, Math.min(Math.max(input.limit ?? 100, 1), 250));
  }

  async upsert(
    task: Omit<
      RecurringTask,
      "createdAt" | "updatedAt" | "dueTime" | "timezone" | "enabled" | "leadTimeDays"
    > &
      Partial<Pick<RecurringTask, "dueTime" | "timezone" | "enabled" | "leadTimeDays">>,
  ): Promise<RecurringTask> {
    return this.store.update((state) => {
      const existing = state.recurringTasks.find(
        (candidate) => candidate.workspaceId === task.workspaceId && candidate.recurringTaskId === task.recurringTaskId,
      );
      const now = new Date().toISOString();
      const record = recurringTaskSchema.parse({
        ...existing,
        ...task,
        recurrence: {
          ...existing?.recurrence,
          ...task.recurrence,
        },
        leadTimeDays: task.leadTimeDays ?? existing?.leadTimeDays ?? 0,
        dayOfTask: task.dayOfTask ?? existing?.dayOfTask,
        dueTime: task.dueTime ?? existing?.dueTime ?? "23:59",
        timezone: task.timezone ?? existing?.timezone ?? "Asia/Tokyo",
        enabled: task.enabled ?? existing?.enabled ?? true,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      upsert(
        state.recurringTasks,
        record,
        (candidate) => candidate.workspaceId === record.workspaceId && candidate.recurringTaskId === record.recurringTaskId,
      );
      return record;
    });
  }

  async disable(workspaceId: string, recurringTaskId: string): Promise<RecurringTask> {
    const existing = await this.get(workspaceId, recurringTaskId);
    if (!existing) {
      throw new Error(`Recurring task ${recurringTaskId} was not found`);
    }
    return this.upsert({ ...existing, enabled: false });
  }
}

export class LocalScheduledTaskRepository {
  constructor(private readonly store: FileStateStore) {}

  async get(workspaceId: string, taskId: string): Promise<ScheduledTask | null> {
    const state = await this.store.load();
    return state.scheduledTasks.find((task) => task.workspaceId === workspaceId && task.taskId === taskId) ?? null;
  }

  async getLegacy(taskId: string): Promise<ScheduledTask | null> {
    const state = await this.store.load();
    return state.scheduledTasks.find((task) => task.taskId === taskId) ?? null;
  }

  async list(input: { workspaceId: string; enabled?: boolean; limit?: number }): Promise<ScheduledTask[]> {
    const state = await this.store.load();
    return state.scheduledTasks
      .filter((task) => task.workspaceId === input.workspaceId)
      .filter((task) => input.enabled === undefined || task.enabled === input.enabled)
      .slice(0, Math.min(input.limit ?? 50, 100));
  }

  async save(task: ScheduledTask): Promise<void> {
    await this.store.update((state) => {
      upsert(state.scheduledTasks, task, (candidate) => candidate.workspaceId === task.workspaceId && candidate.taskId === task.taskId);
    });
  }

  async delete(workspaceId: string, taskId: string): Promise<void> {
    await this.store.update((state) => {
      state.scheduledTasks = state.scheduledTasks.filter((task) => !(task.workspaceId === workspaceId && task.taskId === taskId));
    });
  }
}

export class LocalCalendarDraftRepository {
  constructor(private readonly store: FileStateStore) {}

  async save(draft: CalendarDraft): Promise<CalendarDraft> {
    return this.store.update((state) => {
      upsert(
        state.calendarDrafts,
        draft,
        (candidate) =>
          candidate.workspaceId === draft.workspaceId &&
          candidate.userId === draft.userId &&
          candidate.draftId === draft.draftId,
      );
      return draft;
    });
  }

  async get(workspaceId: string, userId: string | undefined, draftId: string): Promise<CalendarDraft | null> {
    const state = await this.store.load();
    return (
      state.calendarDrafts.find(
        (draft) => draft.workspaceId === workspaceId && draft.userId === userId && draft.draftId === draftId,
      ) ?? null
    );
  }

  async list(input: {
    workspaceId: string;
    userId?: string;
    statuses?: CalendarDraftStatus[];
    limit?: number;
  }): Promise<CalendarDraft[]> {
    const state = await this.store.load();
    return state.calendarDrafts
      .filter((draft) => draft.workspaceId === input.workspaceId && draft.userId === input.userId)
      .filter((draft) => !input.statuses || input.statuses.includes(draft.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, Math.min(Math.max(input.limit ?? 10, 1), 20));
  }
}

export class LocalWorkSessionRepository {
  constructor(private readonly store: FileStateStore) {}

  async get(input: {
    workspaceId: string;
    ownerUserId: string;
    kind: WorkSessionKind;
    workSessionId: string;
  }): Promise<WorkSessionRecord | null> {
    const state = await this.store.load();
    return (
      state.workSessions.find(
        (session) =>
          session.workspaceId === input.workspaceId &&
          session.ownerUserId === input.ownerUserId &&
          session.kind === input.kind &&
          session.workSessionId === input.workSessionId,
      ) ?? null
    );
  }

  async create(input: CreateWorkSessionInput): Promise<WorkSessionRecord> {
    const now = input.now ?? new Date();
    const expiresAt = new Date(now.getTime() + input.maxLifetimeSeconds * 1000);
    const record: WorkSessionRecord = {
      workspaceId: input.workspaceId,
      ownerUserId: input.ownerUserId,
      workSessionId: input.workSessionId ?? randomUUID(),
      runtimeSessionId: input.runtimeSessionId ?? randomUUID(),
      kind: input.kind,
      status: "active",
      createdAt: now.toISOString(),
      lastUsedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      ttl: Math.floor(expiresAt.getTime() / 1000),
    };
    await this.save(record);
    return record;
  }

  async save(record: WorkSessionRecord): Promise<void> {
    await this.store.update((state) => {
      upsert(
        state.workSessions,
        record,
        (candidate) =>
          candidate.workspaceId === record.workspaceId &&
          candidate.ownerUserId === record.ownerUserId &&
          candidate.kind === record.kind &&
          candidate.workSessionId === record.workSessionId,
      );
    });
  }

  async listActiveByOwner(input: ListActiveWorkSessionsInput): Promise<WorkSessionRecord[]> {
    const state = await this.store.load();
    const now = input.now ?? new Date();
    return state.workSessions
      .filter((session) => session.workspaceId === input.workspaceId && session.ownerUserId === input.ownerUserId)
      .filter((session) => !input.kind || session.kind === input.kind)
      .filter((session) => session.status === "active" && Date.parse(session.expiresAt) > now.getTime())
      .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
      .slice(0, Math.min(Math.max(input.limit ?? 100, 1), 250));
  }

  async markCompleted(input: WorkSessionLifecycleInput & { workSessionId: string }): Promise<void> {
    await this.markStatus(input, "completed");
  }

  async markExpired(input: WorkSessionLifecycleInput & { workSessionId: string }): Promise<void> {
    await this.markStatus(input, "expired");
  }

  async touch(input: WorkSessionLifecycleInput & { workSessionId: string }): Promise<void> {
    await this.store.update((state) => {
      const record = findWorkSession(state.workSessions, input);
      if (record) {
        record.lastUsedAt = (input.now ?? new Date()).toISOString();
      }
    });
  }

  async expireIdleSessions(input: WorkSessionLifecycleInput & { idleTimeoutSeconds: number }): Promise<WorkSessionRecord[]> {
    const now = input.now ?? new Date();
    const active = await this.listActiveByOwner(input);
    const expired = active.filter((session) => Date.parse(session.lastUsedAt) + input.idleTimeoutSeconds * 1000 <= now.getTime());
    for (const session of expired) {
      await this.markExpired({ ...input, workSessionId: session.workSessionId, now });
    }
    return expired;
  }

  async enforceActiveLimit(input: WorkSessionLifecycleInput & { maxActiveSessions: number }): Promise<WorkSessionRecord[]> {
    const active = await this.listActiveByOwner(input);
    const expired = active.slice(Math.max(input.maxActiveSessions, 0));
    for (const session of expired) {
      await this.markExpired({ ...input, workSessionId: session.workSessionId, now: input.now });
    }
    return expired;
  }

  private async markStatus(input: WorkSessionLifecycleInput & { workSessionId: string }, status: WorkSessionStatus): Promise<void> {
    await this.store.update((state) => {
      const record = findWorkSession(state.workSessions, input);
      if (record) {
        record.status = status;
        record.lastUsedAt = (input.now ?? new Date()).toISOString();
      }
    });
  }
}

export class LocalSkillRepository implements SkillRepository {
  constructor(private readonly store: FileStateStore) {}

  async listGeneratedSkills(workspaceId: string): Promise<GeneratedSkillRecord[]> {
    const state = await this.store.load();
    return state.generatedSkills.filter((skill) => skill.workspaceId === workspaceId);
  }

  async getGeneratedSkill(workspaceId: string, skillId: string): Promise<GeneratedSkillRecord | null> {
    const state = await this.store.load();
    return state.generatedSkills.find((skill) => skill.workspaceId === workspaceId && skill.skillId === skillId) ?? null;
  }

  async putGeneratedSkill(
    record: Omit<GeneratedSkillRecord, "createdAt" | "updatedAt"> & {
      createdAt?: string;
      updatedAt?: string;
    },
  ): Promise<GeneratedSkillRecord> {
    return this.store.update((state) => {
      const existing = state.generatedSkills.find(
        (candidate) => candidate.workspaceId === record.workspaceId && candidate.skillId === record.skillId,
      );
      const now = new Date().toISOString();
      const item: GeneratedSkillRecord = {
        ...record,
        createdAt: record.createdAt ?? existing?.createdAt ?? now,
        updatedAt: record.updatedAt ?? now,
      };
      upsert(state.generatedSkills, item, (candidate) => candidate.workspaceId === item.workspaceId && candidate.skillId === item.skillId);
      return item;
    });
  }

  async listBuiltinSkillOverrides(workspaceId: string): Promise<BuiltinSkillOverride[]> {
    const state = await this.store.load();
    return state.builtinSkillOverrides.filter((override) => override.workspaceId === workspaceId);
  }

  async getBuiltinSkillOverride(workspaceId: string, skillId: string): Promise<BuiltinSkillOverride | null> {
    const state = await this.store.load();
    return state.builtinSkillOverrides.find((override) => override.workspaceId === workspaceId && override.skillId === skillId) ?? null;
  }

  async putBuiltinSkillOverride(
    record: Omit<BuiltinSkillOverride, "updatedAt"> & { updatedAt?: string },
  ): Promise<BuiltinSkillOverride> {
    return this.store.update((state) => {
      const item: BuiltinSkillOverride = {
        ...record,
        updatedAt: record.updatedAt ?? new Date().toISOString(),
      };
      upsert(
        state.builtinSkillOverrides,
        item,
        (candidate) => candidate.workspaceId === item.workspaceId && candidate.skillId === item.skillId,
      );
      return item;
    });
  }
}

function rankSearchResults<T extends { text: string; attributes?: Record<string, unknown>; tags?: string[]; importance?: number; updatedAt: string }>(
  items: T[],
  query: string,
  limit = 8,
): T[] {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  return items
    .filter((item) => matchesSearch(buildSearchText(item), terms))
    .sort((a, b) => {
      const importanceDiff = (b.importance ?? 0) - (a.importance ?? 0);
      if (importanceDiff !== 0) {
        return importanceDiff;
      }
      return b.updatedAt.localeCompare(a.updatedAt);
    })
    .slice(0, Math.min(Math.max(limit, 1), 20));
}

function buildSearchText(item: { text: string; attributes?: Record<string, unknown>; tags?: string[] }): string {
  return normalize([item.text, JSON.stringify(item.attributes ?? {}), (item.tags ?? []).join(" ")].join(" "));
}

function matchesSearch(searchText: string, terms: string[]): boolean {
  return terms.length === 0 || terms.every((term) => searchText.includes(term));
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function upsert<T>(items: T[], item: T, predicate: (candidate: T) => boolean): void {
  const index = items.findIndex(predicate);
  if (index >= 0) {
    items[index] = item;
    return;
  }
  items.push(item);
}

function findWorkSession(
  sessions: WorkSessionRecord[],
  input: WorkSessionLifecycleInput & { workSessionId: string },
): WorkSessionRecord | undefined {
  return sessions.find(
    (session) =>
      session.workspaceId === input.workspaceId &&
      session.ownerUserId === input.ownerUserId &&
      session.kind === input.kind &&
      session.workSessionId === input.workSessionId,
  );
}
