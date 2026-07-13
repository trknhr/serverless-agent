import { randomUUID } from "node:crypto";
import { AgentContentBlock, ToolExecutionResult } from "../agent/types";
import {
  AgentTurnToolCallTrace,
  AgentTurnTraceRecord,
  buildTraceExpiresAt,
  hashTraceIdentifier,
  sanitizeTraceValue,
  summarizeAgentContentBlocks,
  truncateTraceText,
} from "../eval/agentTurnTrace";
import { SkillRegistry, formatSkillSummariesForPrompt } from "../skills/registry";
import { logger } from "../shared/logger";
import { CustomToolExecutor } from "../tools/executeCustomTool";
import { customToolDefinitions } from "../tools/definitions";
import { AgentRuntimeRequest } from "./contracts";
import { buildSystemPrompt, type SystemPromptMode } from "./instructions";
import { shouldUseDocumentModel } from "./modelSelection";
import { mapToolExecutionResultToModelOutput } from "./toolResultOutput";

export type SessionHistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

export type BedrockServiceTier = (typeof bedrockServiceTiers)[number];

export interface AgentRunnerAi {
  ToolLoopAgent: new (options: unknown) => {
    stream: (options: unknown) => Promise<{ fullStream: AsyncIterable<Record<string, unknown>> }>;
  };
  jsonSchema: (schema: unknown) => unknown;
  tool: (options: unknown) => unknown;
}

export type AgentTurnEvent =
  | {
      event: "message";
      data: { text: string };
    }
  | {
      event: "metadata";
      data: {
        taskIds: string[];
        recurringTaskIds: string[];
        savedMemoryIds: string[];
        calendarDraftIds: string[];
        traceId?: string;
        turnId?: string;
      };
    };

export interface SessionHistoryStore {
  get(sessionId: string): Promise<SessionHistoryMessage[]> | SessionHistoryMessage[];
  set(sessionId: string, messages: SessionHistoryMessage[]): Promise<void> | void;
}

export interface RunAgentTurnOptions {
  request: AgentRuntimeRequest;
  sessionId?: string;
  ai: AgentRunnerAi;
  modelProvider: (modelId: string) => unknown;
  modelId: string;
  documentModelId?: string;
  bedrockServiceTier?: BedrockServiceTier;
  customSystemPrompt?: string;
  systemPromptMode?: SystemPromptMode;
  log: ReturnType<typeof logger.child>;
  createExecutor?: (
    request: AgentRuntimeRequest,
    log: ReturnType<typeof logger.child>,
    skillRegistry?: SkillRegistry,
  ) => CustomToolExecutor | null | Promise<CustomToolExecutor | null>;
  createSkillRegistry?: (request: AgentRuntimeRequest) => SkillRegistry | null;
  sessionHistoryStore?: SessionHistoryStore;
  useSessionHistory?: (request: AgentRuntimeRequest) => boolean;
  bedrockRegion?: string;
  runtimeSessionId?: string;
  saveTurnTrace?: (record: AgentTurnTraceRecord) => Promise<void>;
}

const bedrockServiceTiers = ["reserved", "priority", "default", "flex"] as const;
const inMemorySessionHistories = new Map<string, SessionHistoryMessage[]>();
const maxSessionHistoryMessages = 20;
const writeToolNames = new Set([
  "propose_skill",
  "approve_skill",
  "enable_skill",
  "reject_skill",
  "archive_skill",
  "disable_skill",
  "save_memory",
  "promote_memory_to_workspace",
  "upsert_task",
  "patch_task",
  "mark_task_done",
  "upsert_recurring_task",
  "disable_recurring_task",
  "create_scheduled_reminder",
  "update_scheduled_reminder",
  "delete_scheduled_reminder",
  "create_calendar_draft",
  "apply_calendar_draft",
  "discard_calendar_draft",
]);

type WriteCapability =
  | "any_write"
  | "memory_write"
  | "task_write"
  | "complete_task"
  | "recurring_task_write"
  | "scheduled_reminder_write"
  | "calendar_draft_write"
  | "apply_calendar"
  | "skill_write";

const writeClaimPatterns: Array<{ capability: WriteCapability; pattern: RegExp }> = [
  {
    capability: "apply_calendar",
    pattern:
      /(?:^|[\n。！？!?])\s*(?:はい[、,]?\s*)?(?:Google\s*)?カレンダー(?:に|へ)[^。\n]{0,60}(?:登録|追加|反映)(?:しました|したよ|した)(?=$|[\s。！!？?])/iu,
  },
  {
    capability: "apply_calendar",
    pattern: /\bI(?:'ve| have)?\s+(?:added|applied)\b[^.!?\n]{0,80}\b(?:Google\s+)?Calendar\b/i,
  },
  {
    capability: "complete_task",
    pattern:
      /(?:^|[\n。！？!?])\s*(?:はい[、,]?\s*)?(?:完了(?:済み)?(?:に|として登録)(?:しました|したよ|した)|(?:タスク|TODO|ToDo|todo|「[^」]{1,80}」|『[^』]{1,80}』)[^。\n]{0,60}を完了(?:済み)?(?:に)?(?:しました|したよ|した)|[^。\n]{1,80}を完了(?:済み)?登録(?:しました|したよ|した))(?=$|[\s。！!？?])/u,
  },
  {
    capability: "complete_task",
    pattern:
      /\bI(?:'ve| have)?\s+marked\b[^.!?\n]{0,80}\b(?:task|todo|to-do)\b[^.!?\n]{0,40}\b(?:done|complete(?:d)?)\b/i,
  },
  {
    capability: "memory_write",
    pattern:
      /(?:^|[\n。！？!?、,])\s*(?:はい[、,]?\s*)?(?:(?:この|その)?(?:情報|内容|メモ|記憶|「[^」]{1,80}」|『[^』]{1,80}』)[^。\n]{0,40}(?:を|は)?\s*)?(?:メモ|記憶)(?:に)?(?:しておき|しました|したよ|した|しておきます|しておきました)(?=$|[\s。！!？?])/u,
  },
  {
    capability: "memory_write",
    pattern:
      /(?:^|[\n。！？!?、,])\s*(?:はい[、,]?\s*)?(?:(?:この|その)?(?:情報|内容|予定|メモ|記憶|リマインダー)[^。\n]{0,40}(?:を|は)?\s*)?覚えておき(?:ます|ました|ますね|ましたよ)(?=$|[\s。！!？?])/u,
  },
  {
    capability: "memory_write",
    pattern: /\bI(?:'ve| have)?\s+(?:saved|registered|remembered)\b[^.!?\n]{0,80}\b(?:memory|note|information|preference)\b/i,
  },
  {
    capability: "memory_write",
    pattern:
      /(?:^|[\n。！？!?])\s*(?:はい[、,]?\s*)?(?:情報|内容|メモ|記憶)[^。\n]{0,60}(?:を)?(?:保存|登録|作成|追加|更新|変更)(?:しておき(?:ました|ます)|しました|したよ|した)(?=$|[\s。！!？?])/u,
  },
  {
    capability: "task_write",
    pattern:
      /(?:^|[\n。！？!?])\s*(?:はい[、,]?\s*)?(?:タスク|TODO|ToDo|todo|「[^」]{1,80}」|『[^』]{1,80}』)[^。\n]{0,80}(?:を)?(?:保存|登録|作成|追加|更新|変更|削除|無効(?:化|に))(?:しておき(?:ました|ます)|しました|したよ|した)(?=$|[\s。！!？?])/u,
  },
  {
    capability: "task_write",
    pattern: /\bI(?:'ve| have)?\s+(?:created|added|updated|changed|deleted|disabled)\b[^.!?\n]{0,80}\b(?:task|todo|to-do)\b/i,
  },
  {
    capability: "recurring_task_write",
    pattern:
      /(?:^|[\n。！？!?])\s*(?:はい[、,]?\s*)?(?:定期|繰り返し|毎日|毎週|毎月|毎年)[^。\n]{0,80}(?:タスク|作業)[^。\n]{0,60}(?:保存|登録|作成|追加|更新|変更|削除|無効(?:化|に))(?:しておき(?:ました|ます)|しました|したよ|した)(?=$|[\s。！!？?])/u,
  },
  {
    capability: "scheduled_reminder_write",
    pattern:
      /(?:^|[\n。！？!?])\s*(?:はい[、,]?\s*)?(?:定期)?(?:リマインダー|通知)[^。\n]{0,80}(?:を)?(?:保存|登録|作成|追加|更新|変更|削除|無効(?:化|に))(?:しておき(?:ました|ます)|しました|したよ|した)(?=$|[\s。！!？?])/u,
  },
  {
    capability: "calendar_draft_write",
    pattern:
      /(?:^|[\n。！？!?])\s*(?:はい[、,]?\s*)?(?:カレンダー)?下書き[^。\n]{0,80}(?:を)?(?:保存|作成|追加|更新|変更|削除|破棄)(?:しておき(?:ました|ます)|しました|したよ|した)(?=$|[\s。！!？?])/u,
  },
  {
    capability: "skill_write",
    pattern:
      /(?:^|[\n。！？!?])\s*(?:はい[、,]?\s*)?スキル[^。\n]{0,80}(?:を)?(?:保存|提案|作成|承認|有効(?:化|に)|無効(?:化|に)|更新|変更|却下|削除|アーカイブ)(?:しておき(?:ました|ます)|しました|したよ|した)(?=$|[\s。！!？?])/u,
  },
  {
    capability: "any_write",
    pattern:
      /(?:^|[\n。！？!?])\s*(?:はい[、,]?\s*)?(?:保存|登録|更新|変更|削除|無効(?:化|に))(?:しておき(?:ました|ます)|しました|したよ|した)(?=$|[\s。！!？?])/u,
  },
  {
    capability: "any_write",
    pattern: /\bI(?:'ve| have)?\s+(?:saved|registered|created|added|updated|changed|deleted|removed|disabled)\b/i,
  },
];

const inMemorySessionHistoryStore: SessionHistoryStore = {
  get(sessionId: string) {
    return inMemorySessionHistories.get(sessionId) ?? [];
  },
  set(sessionId: string, messages: SessionHistoryMessage[]) {
    inMemorySessionHistories.set(sessionId, messages);
  },
};

export async function* runAgentTurn(options: RunAgentTurnOptions): AsyncGenerator<AgentTurnEvent> {
  const request = options.request;
  const traceId = request.context.traceId ?? request.context.correlationId ?? `trace_${randomUUID()}`;
  const turnId = request.context.turnId ?? `turn_${randomUUID()}`;
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const toolCalls: AgentTurnToolCallTrace[] = [];
  const onToolCall = (call: AgentTurnToolCallTrace) => {
    toolCalls.push(call);
  };
  const selectedModelId = selectModelId(request, options.documentModelId ?? options.modelId, options.modelId);
  const selectedBedrockServiceTier =
    selectedModelId === options.modelId ? options.bedrockServiceTier : undefined;
  let modelOutputText = "";
  let assistantText = "";
  let summary = emptyToolSummary();
  let status: AgentTurnTraceRecord["status"] = "completed";
  let errorMessage: string | undefined;
  let executor: CustomToolExecutor | null = null;

  try {
    const skillRegistry =
      request.disableTools || !request.toolContext ? null : options.createSkillRegistry?.(request) ?? null;
    executor = request.disableTools
      ? null
      : (await options.createExecutor?.(request, options.log, skillRegistry ?? undefined)) ?? null;
    const tools = executor ? createTools(options.ai, executor, onToolCall) : {};
    const skillPrompt =
      executor && skillRegistry
        ? await buildEnabledSkillPrompt(skillRegistry, request.toolContext!.workspaceId, options.log)
        : "";
    const agent = new options.ai.ToolLoopAgent({
      model: options.modelProvider(selectedModelId),
      instructions: buildSystemPrompt(skillPrompt, {
        customSystemPrompt: options.customSystemPrompt,
        systemPromptMode: options.systemPromptMode,
      }),
      tools,
      ...(selectedBedrockServiceTier
        ? {
            providerOptions: {
              bedrock: {
                serviceTier: selectedBedrockServiceTier,
              },
            },
          }
        : {}),
    });

    options.log.info("AgentCore request started", {
      modelId: selectedModelId,
      bedrockServiceTier: selectedBedrockServiceTier ?? "default",
      hasTools: Object.keys(tools).length > 0,
    });

    const history = await getSessionHistory(options);
    const userHistoryText = toHistoryText(request.content);
    const stream = await agent.stream({
      messages: [
        ...history,
        {
          role: "user",
          content: toUserContent(request.content),
        },
      ],
    });

    for await (const part of stream.fullStream) {
      if (part.type === "error") {
        throw new Error(`Model stream failed: ${formatStreamError(part.error)}`);
      }
      if (part.type !== "text-delta" || typeof part.text !== "string") {
        continue;
      }

      modelOutputText += part.text;
    }

    const writeToolFailureNotice = buildWriteToolFailureNotice(toolCalls, request);
    const unsupportedWriteClaims = findUnsupportedWriteClaims(modelOutputText, toolCalls);
    if (unsupportedWriteClaims.length > 0) {
      assistantText = writeToolFailureNotice ?? buildUnverifiedWriteClaimNotice(request);
      options.log.warn("Replaced an unverified write success claim", {
        capabilities: unsupportedWriteClaims,
        successfulWriteTools: toolCalls
          .filter((call) => writeToolNames.has(call.name) && !call.isError)
          .map((call) => call.name),
      });
    } else {
      assistantText = appendNotice(modelOutputText, writeToolFailureNotice);
    }
    if (assistantText) {
      yield { event: "message", data: { text: assistantText } };
    }

    summary = executor?.getSummary() ?? summary;
    await saveSessionHistory(options, history, userHistoryText, assistantText);
    yield { event: "metadata", data: { ...summary, traceId, turnId } };
    options.log.info("AgentCore request completed", {
      taskIds: summary.taskIds,
      recurringTaskIds: summary.recurringTaskIds,
      savedMemoryIds: summary.savedMemoryIds,
      calendarDraftIds: summary.calendarDraftIds,
    });
  } catch (error) {
    status = "failed";
    errorMessage = error instanceof Error ? error.message : String(error);
    summary = executor?.getSummary() ?? summary;
    throw error;
  } finally {
    if (options.saveTurnTrace) {
      try {
        const tracedModelOutputText = modelOutputText ? truncateTraceText(modelOutputText) : undefined;
        const tracedOutputText = assistantText ? truncateTraceText(assistantText) : undefined;
        await options.saveTurnTrace({
          traceId,
          turnId,
          workspaceId: request.context.workspaceId,
          source: request.context.source,
          status,
          createdAt: startedAt,
          updatedAt: new Date().toISOString(),
          expiresAt: buildTraceExpiresAt(startedAt),
          modelId: selectedModelId,
          bedrockRegion: options.bedrockRegion,
          bedrockServiceTier: selectedBedrockServiceTier ?? "default",
          runtimeSessionId: options.runtimeSessionId ?? options.sessionId,
          userIdHash: hashTraceIdentifier(request.context.userId),
          channelIdHash: hashTraceIdentifier(request.context.channelId),
          conversationId: request.context.conversationTs,
          taskId: request.context.taskId,
          sourceId: request.context.sourceId,
          input: summarizeAgentContentBlocks(request.content),
          output: tracedOutputText ? { text: tracedOutputText } : undefined,
          modelOutput: tracedModelOutputText ? { text: tracedModelOutputText } : undefined,
          toolCalls,
          summary,
          error: errorMessage,
          latencyMs: Date.now() - started,
        });
      } catch (traceError) {
        options.log.warn("Failed to save agent turn trace", {
          traceId,
          turnId,
          error: traceError instanceof Error ? traceError.message : String(traceError),
        });
      }
    }
  }
}

function emptyToolSummary(): {
  taskIds: string[];
  recurringTaskIds: string[];
  savedMemoryIds: string[];
  calendarDraftIds: string[];
} {
  return {
    taskIds: [],
    recurringTaskIds: [],
    savedMemoryIds: [],
    calendarDraftIds: [],
  };
}

function buildWriteToolFailureNotice(
  toolCalls: AgentTurnToolCallTrace[],
  request: AgentRuntimeRequest,
): string | undefined {
  const writeErrors = toolCalls
    .filter((call, index) =>
      call.isError &&
      writeToolNames.has(call.name) &&
      !hasLaterSuccessfulEquivalentWrite(toolCalls, index, call)
    )
    .map((call) => ({
      name: call.name,
      message: extractToolCallErrorMessage(call),
    }))
    .filter((error) => error.message);

  if (writeErrors.length === 0) {
    return undefined;
  }

  const uniqueErrors = Array.from(
    new Map(writeErrors.map((error) => [`${error.name}:${error.message}`, error])).values(),
  ).slice(0, 5);
  const lines = uniqueErrors.map((error) => `- ${error.name}: ${error.message}`);

  if (shouldUseJapaneseWriteFailureNotice(request)) {
    return [
      "保存できませんでした。実際には保存・更新されていません。",
      "原因:",
      ...lines,
    ].join("\n");
  }

  return [
    "The save or update failed. Nothing was saved or changed.",
    "Cause:",
    ...lines,
  ].join("\n");
}

function findUnsupportedWriteClaims(
  modelOutputText: string,
  toolCalls: AgentTurnToolCallTrace[],
): WriteCapability[] {
  const claimedCapabilities = new Set(
    writeClaimPatterns
      .filter(({ pattern }) => pattern.test(modelOutputText))
      .map(({ capability }) => capability),
  );
  if (claimedCapabilities.size === 0) {
    return [];
  }

  const supportedCapabilities = new Set<WriteCapability>();
  for (const call of toolCalls) {
    if (call.isError || !writeToolNames.has(call.name)) {
      continue;
    }
    for (const capability of successfulWriteCapabilities(call)) {
      supportedCapabilities.add(capability);
    }
  }

  return [...claimedCapabilities].filter((capability) => !supportedCapabilities.has(capability));
}

function successfulWriteCapabilities(call: AgentTurnToolCallTrace): WriteCapability[] {
  const input = isRecord(call.input) ? call.input : {};

  switch (call.name) {
    case "propose_skill":
    case "approve_skill":
    case "enable_skill":
    case "reject_skill":
    case "archive_skill":
    case "disable_skill":
      return ["any_write", "skill_write"];
    case "save_memory":
    case "promote_memory_to_workspace":
      return ["any_write", "memory_write"];
    case "upsert_task":
      return input.status === "done"
        ? ["any_write", "task_write", "complete_task"]
        : ["any_write", "task_write"];
    case "patch_task":
      return input.status === "done"
        ? ["any_write", "task_write", "complete_task"]
        : ["any_write", "task_write"];
    case "mark_task_done":
      return ["any_write", "task_write", "complete_task"];
    case "upsert_recurring_task":
    case "disable_recurring_task":
      return ["any_write", "recurring_task_write"];
    case "create_scheduled_reminder":
    case "update_scheduled_reminder":
    case "delete_scheduled_reminder":
      return ["any_write", "scheduled_reminder_write"];
    case "create_calendar_draft":
    case "discard_calendar_draft":
      return ["any_write", "calendar_draft_write"];
    case "apply_calendar_draft":
      return ["any_write", "calendar_draft_write", "apply_calendar"];
    default:
      return [];
  }
}

function buildUnverifiedWriteClaimNotice(request: AgentRuntimeRequest): string {
  if (shouldUseJapaneseWriteFailureNotice(request)) {
    return [
      "宣言された変更を確認できませんでした。",
      "対応する書き込み処理の成功記録がないため、その変更が行われたとは確認できません。もう一度実行してください。",
    ].join("\n");
  }

  return [
    "The claimed change could not be verified.",
    "There is no successful matching write operation, so that change cannot be confirmed. Please try again.",
  ].join("\n");
}

function appendNotice(modelOutputText: string, notice: string | undefined): string {
  if (!notice) {
    return modelOutputText;
  }

  return [modelOutputText.trimEnd(), notice].filter(Boolean).join("\n\n");
}

function hasLaterSuccessfulEquivalentWrite(
  toolCalls: AgentTurnToolCallTrace[],
  failedIndex: number,
  failedCall: AgentTurnToolCallTrace,
): boolean {
  const failedKey = buildWriteToolAttemptKey(failedCall);
  return toolCalls
    .slice(failedIndex + 1)
    .some((call) => !call.isError && writeToolNames.has(call.name) && buildWriteToolAttemptKey(call) === failedKey);
}

function buildWriteToolAttemptKey(call: AgentTurnToolCallTrace): string {
  return `${call.name}:${stableStringify(canonicalizeWriteToolInput(call.input))}`;
}

function canonicalizeWriteToolInput(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeWriteToolInput);
  }

  if (!isRecord(value)) {
    return value;
  }

  const entries = Object.entries(value)
    .filter(([key]) => key !== "date_validation" && key !== "dateValidation")
    .map(([key, item]) => [key, canonicalizeWriteToolInput(item)] as const)
    .filter(([, item]) => !isEmptyCanonicalValue(item))
    .sort(([left], [right]) => left.localeCompare(right));

  return Object.fromEntries(entries);
}

function isEmptyCanonicalValue(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

function extractToolCallErrorMessage(call: AgentTurnToolCallTrace): string {
  if (call.error) {
    return call.error;
  }

  const output = call.output;
  if (!isRecord(output)) {
    return "Tool execution failed.";
  }

  const content = output.content;
  if (!Array.isArray(content)) {
    return "Tool execution failed.";
  }

  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      return block.text;
    }
  }

  return "Tool execution failed.";
}

function shouldUseJapaneseWriteFailureNotice(request: AgentRuntimeRequest): boolean {
  const language = request.resources?.defaultResponseLanguage?.trim().toLowerCase();
  if (language?.startsWith("ja")) {
    return true;
  }

  return /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(toHistoryText(request.content));
}

export function parseBedrockServiceTier(value: string | undefined): BedrockServiceTier | undefined {
  if (!value) {
    return undefined;
  }
  if (bedrockServiceTiers.includes(value as BedrockServiceTier)) {
    return value as BedrockServiceTier;
  }
  throw new Error(`Invalid BEDROCK_SERVICE_TIER '${value}'. Expected one of: ${bedrockServiceTiers.join(", ")}`);
}

function createTools(
  ai: AgentRunnerAi,
  executor: CustomToolExecutor,
  onToolCall?: (call: AgentTurnToolCallTrace) => void,
): Record<string, unknown> {
  return Object.fromEntries(
    customToolDefinitions.map((definition) => [
      definition.name,
      ai.tool({
        description: definition.description,
        inputSchema: ai.jsonSchema(definition.input_schema),
        execute: async (input: Record<string, unknown>) => {
          const toolCallId = `agentcore_tool_${Date.now()}_${definition.name}`;
          const toolUseEvent = {
            id: toolCallId,
            type: "agent.tool_use" as const,
            name: definition.name,
            input,
          };
          if (!onToolCall) {
            return executor.execute(toolUseEvent);
          }

          const started = Date.now();
          const startedAt = new Date(started).toISOString();
          try {
            const result = await executor.execute(toolUseEvent);
            onToolCall({
              toolCallId,
              name: definition.name,
              input: sanitizeTraceValue(input),
              output: summarizeToolResultForTrace(result),
              isError: Boolean(result.isError),
              startedAt,
              completedAt: new Date().toISOString(),
              durationMs: Date.now() - started,
            });
            return result;
          } catch (error) {
            onToolCall({
              toolCallId,
              name: definition.name,
              input: sanitizeTraceValue(input),
              isError: true,
              error: error instanceof Error ? error.message : String(error),
              startedAt,
              completedAt: new Date().toISOString(),
              durationMs: Date.now() - started,
            });
            throw error;
          }
        },
        toModelOutput: ({ output }: { output: ToolExecutionResult }) =>
          mapToolExecutionResultToModelOutput(output),
      }),
    ]),
  );
}

function summarizeToolResultForTrace(result: ToolExecutionResult): unknown {
  return sanitizeTraceValue({
    isError: Boolean(result.isError),
    content: (result.content ?? []).map((block) => {
      if (block.type === "text") {
        return {
          type: "text",
          text: block.text,
        };
      }
      return {
        type: block.type,
        note: "Non-text tool output omitted from trace.",
      };
    }),
  });
}

async function buildEnabledSkillPrompt(
  skillRegistry: SkillRegistry,
  workspaceId: string,
  log: ReturnType<typeof logger.child>,
): Promise<string> {
  try {
    return formatSkillSummariesForPrompt(await skillRegistry.listEnabledSummaries(workspaceId));
  } catch (error) {
    log.warn("Failed to load skill summaries", {
      error: error instanceof Error ? error.message : String(error),
    });
    return "";
  }
}

async function getSessionHistory(options: RunAgentTurnOptions): Promise<SessionHistoryMessage[]> {
  if (!shouldUseSessionHistory(options)) {
    return [];
  }

  return await (options.sessionHistoryStore ?? inMemorySessionHistoryStore).get(options.sessionId!);
}

async function saveSessionHistory(
  options: RunAgentTurnOptions,
  previous: SessionHistoryMessage[],
  userText: string,
  assistantText: string,
): Promise<void> {
  if (!shouldUseSessionHistory(options)) {
    return;
  }

  const next = [
    ...previous,
    { role: "user" as const, content: userText },
    { role: "assistant" as const, content: assistantText },
  ].slice(-maxSessionHistoryMessages);
  await (options.sessionHistoryStore ?? inMemorySessionHistoryStore).set(options.sessionId!, next);
}

function shouldUseSessionHistory(options: RunAgentTurnOptions): boolean {
  if (!options.sessionId) {
    return false;
  }
  const shouldUse = options.useSessionHistory ?? defaultShouldUseSessionHistory;
  return shouldUse(options.request);
}

function defaultShouldUseSessionHistory(request: AgentRuntimeRequest): boolean {
  return ["direct_chat_api", "scheduler"].includes(request.context.source);
}

function selectModelId(request: AgentRuntimeRequest, documentModelId: string, modelId: string): string {
  return shouldUseDocumentModel(request) ? documentModelId : modelId;
}

function formatStreamError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return JSON.stringify(error);
}

function toHistoryText(blocks: AgentContentBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === "text") {
        return block.text;
      }

      if (block.type === "image") {
        return block.source.type === "url"
          ? `[Image attachment: ${block.source.url}]`
          : `[Image attachment: ${block.source.media_type}]`;
      }

      const title = block.title ?? "untitled";
      if (block.source.type === "text") {
        return [
          `Attached document: ${title}`,
          block.context,
          truncateForHistory(block.source.data),
        ]
          .filter(Boolean)
          .join("\n\n");
      }
      if (block.source.type === "url") {
        return `Attached document: ${title} (${block.source.url})`;
      }
      if (block.source.type === "base64") {
        return `Attached document: ${title} (${block.source.media_type})`;
      }
      return `Attached document: ${title} (${block.source.file_id})`;
    })
    .join("\n\n")
    .trim();
}

function truncateForHistory(value: string): string {
  const maxLength = 4000;
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}\n[truncated]`;
}

function toUserContent(blocks: AgentContentBlock[]): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [];

  for (const block of blocks) {
    if (block.type === "text") {
      content.push({ type: "text", text: block.text });
      continue;
    }

    if (block.type === "image") {
      if (block.source.type === "url") {
        content.push({ type: "image", image: new URL(block.source.url) });
        continue;
      }
      content.push({
        type: "image",
        image: block.source.data,
        mediaType: block.source.media_type,
      });
      continue;
    }

    if (block.source.type === "text") {
      content.push({
        type: "text",
        text: [
          `Attached document: ${block.title ?? "untitled"}`,
          block.context,
          block.source.data,
        ]
          .filter(Boolean)
          .join("\n\n"),
      });
      continue;
    }

    if (block.source.type === "base64") {
      content.push({
        type: "file",
        data: block.source.data,
        filename: block.title,
        mediaType: block.source.media_type,
      });
      continue;
    }

    if (block.source.type === "url") {
      content.push({
        type: "file",
        data: new URL(block.source.url),
        filename: block.title,
        mediaType: block.source.media_type ?? inferMediaTypeFromTitle(block.title),
      });
      continue;
    }

    content.push({
      type: "text",
      text: `Attachment note: ${block.title ?? block.source.file_id} could not be sent to the model.`,
    });
  }

  return content;
}

function inferMediaTypeFromTitle(title: string | undefined): string {
  const lower = title?.toLowerCase() ?? "";
  if (lower.endsWith(".pdf")) {
    return "application/pdf";
  }
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) {
    return "text/markdown";
  }
  if (lower.endsWith(".txt")) {
    return "text/plain";
  }
  if (lower.endsWith(".csv")) {
    return "text/csv";
  }
  if (lower.endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (lower.endsWith(".doc")) {
    return "application/msword";
  }
  if (lower.endsWith(".xlsx")) {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  if (lower.endsWith(".xls")) {
    return "application/vnd.ms-excel";
  }
  if (lower.endsWith(".html") || lower.endsWith(".htm")) {
    return "text/html";
  }
  return "application/octet-stream";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
