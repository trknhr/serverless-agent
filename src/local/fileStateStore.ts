import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CalendarDraft } from "../calendar/calendarDraft";
import { SessionHistoryMessage, SessionHistoryStore } from "../agentcore/runAgentTurn";
import { ChannelMemoryItem } from "../memory/channelMemoryItem";
import { MemoryItem } from "../memory/memoryItem";
import { UserPreferenceItem } from "../memory/userPreferenceItem";
import { BuiltinSkillOverride, GeneratedSkillRecord } from "../skills/types";
import { WorkSessionRecord } from "../shared/contracts";
import { RecurringTask } from "../tasks/recurringTask";
import { ScheduledTask } from "../tasks/taskDefinition";
import { TaskEventRecord, TaskState } from "../tasks/taskState";

export const DEFAULT_LOCAL_STATE_PATH = ".serverless-agent/local-state/state.json";

export interface LocalState {
  version: 1;
  sessionHistories: Record<string, SessionHistoryMessage[]>;
  memoryItems: MemoryItem[];
  channelMemories: ChannelMemoryItem[];
  userPreferences: UserPreferenceItem[];
  tasks: TaskState[];
  taskEvents: TaskEventRecord[];
  recurringTasks: RecurringTask[];
  scheduledTasks: ScheduledTask[];
  calendarDrafts: CalendarDraft[];
  workSessions: WorkSessionRecord[];
  generatedSkills: GeneratedSkillRecord[];
  builtinSkillOverrides: BuiltinSkillOverride[];
}

export class FileStateStore implements SessionHistoryStore {
  constructor(private readonly filePath = DEFAULT_LOCAL_STATE_PATH) {}

  get path(): string {
    return this.filePath;
  }

  async load(): Promise<LocalState> {
    try {
      const text = await readFile(this.filePath, "utf-8");
      return normalizeState(JSON.parse(text) as Partial<LocalState>);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return createEmptyState();
      }
      throw error;
    }
  }

  async save(state: LocalState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(normalizeState(state), null, 2)}\n`, "utf-8");
    await rename(tmpPath, this.filePath);
  }

  async update<T>(mutator: (state: LocalState) => T | Promise<T>): Promise<T> {
    const state = await this.load();
    const result = await mutator(state);
    await this.save(state);
    return result;
  }

  async get(sessionId: string): Promise<SessionHistoryMessage[]> {
    const state = await this.load();
    return state.sessionHistories[sessionId] ?? [];
  }

  async set(sessionId: string, messages: SessionHistoryMessage[]): Promise<void> {
    await this.update((state) => {
      state.sessionHistories[sessionId] = messages;
    });
  }
}

export function createEmptyState(): LocalState {
  return {
    version: 1,
    sessionHistories: {},
    memoryItems: [],
    channelMemories: [],
    userPreferences: [],
    tasks: [],
    taskEvents: [],
    recurringTasks: [],
    scheduledTasks: [],
    calendarDrafts: [],
    workSessions: [],
    generatedSkills: [],
    builtinSkillOverrides: [],
  };
}

function normalizeState(state: Partial<LocalState>): LocalState {
  return {
    ...createEmptyState(),
    ...state,
    version: 1,
    sessionHistories: state.sessionHistories ?? {},
    memoryItems: state.memoryItems ?? [],
    channelMemories: state.channelMemories ?? [],
    userPreferences: state.userPreferences ?? [],
    tasks: state.tasks ?? [],
    taskEvents: state.taskEvents ?? [],
    recurringTasks: state.recurringTasks ?? [],
    scheduledTasks: state.scheduledTasks ?? [],
    calendarDrafts: state.calendarDrafts ?? [],
    workSessions: state.workSessions ?? [],
    generatedSkills: state.generatedSkills ?? [],
    builtinSkillOverrides: state.builtinSkillOverrides ?? [],
  };
}
