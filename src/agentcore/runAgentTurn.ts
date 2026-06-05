import { AgentContentBlock, ToolExecutionResult } from "../agent/types";
import { SkillRegistry, formatSkillSummariesForPrompt } from "../skills/registry";
import { logger } from "../shared/logger";
import { CustomToolExecutor } from "../tools/executeCustomTool";
import { customToolDefinitions } from "../tools/definitions";
import { AgentRuntimeRequest } from "./contracts";
import { buildSystemPrompt } from "./instructions";

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
  log: ReturnType<typeof logger.child>;
  createExecutor?: (
    request: AgentRuntimeRequest,
    log: ReturnType<typeof logger.child>,
    skillRegistry?: SkillRegistry,
  ) => CustomToolExecutor | null | Promise<CustomToolExecutor | null>;
  createSkillRegistry?: (request: AgentRuntimeRequest) => SkillRegistry | null;
  sessionHistoryStore?: SessionHistoryStore;
  useSessionHistory?: (request: AgentRuntimeRequest) => boolean;
}

const bedrockServiceTiers = ["reserved", "priority", "default", "flex"] as const;
const inMemorySessionHistories = new Map<string, SessionHistoryMessage[]>();
const maxSessionHistoryMessages = 20;

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
  const skillRegistry =
    request.disableTools || !request.toolContext ? null : options.createSkillRegistry?.(request) ?? null;
  const executor = request.disableTools
    ? null
    : await options.createExecutor?.(request, options.log, skillRegistry ?? undefined);
  const tools = executor ? createTools(options.ai, executor) : {};
  const skillPrompt =
    executor && skillRegistry
      ? await buildEnabledSkillPrompt(skillRegistry, request.toolContext!.workspaceId, options.log)
      : "";
  const selectedModelId = selectModelId(request, options.documentModelId ?? options.modelId, options.modelId);
  const agent = new options.ai.ToolLoopAgent({
    model: options.modelProvider(selectedModelId),
    instructions: buildSystemPrompt(skillPrompt),
    tools,
    ...(options.bedrockServiceTier
      ? {
          providerOptions: {
            bedrock: {
              serviceTier: options.bedrockServiceTier,
            },
          },
        }
      : {}),
  });

  options.log.info("AgentCore request started", {
    modelId: selectedModelId,
    bedrockServiceTier: options.bedrockServiceTier ?? "default",
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

  let assistantText = "";
  for await (const part of stream.fullStream) {
    if (part.type === "error") {
      throw new Error(`Model stream failed: ${formatStreamError(part.error)}`);
    }
    if (part.type !== "text-delta" || typeof part.text !== "string") {
      continue;
    }

    assistantText += part.text;
    yield { event: "message", data: { text: part.text } };
  }

  const summary = executor?.getSummary() ?? {
    taskIds: [],
    recurringTaskIds: [],
    savedMemoryIds: [],
    calendarDraftIds: [],
  };
  await saveSessionHistory(options, history, userHistoryText, assistantText);
  yield { event: "metadata", data: summary };
  options.log.info("AgentCore request completed", {
    taskIds: summary.taskIds,
    recurringTaskIds: summary.recurringTaskIds,
    savedMemoryIds: summary.savedMemoryIds,
    calendarDraftIds: summary.calendarDraftIds,
  });
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

function createTools(ai: AgentRunnerAi, executor: CustomToolExecutor): Record<string, unknown> {
  return Object.fromEntries(
    customToolDefinitions.map((definition) => [
      definition.name,
      ai.tool({
        description: definition.description,
        inputSchema: ai.jsonSchema(definition.input_schema),
        execute: async (input: Record<string, unknown>) => {
          const result = await executor.execute({
            id: `agentcore_tool_${Date.now()}_${definition.name}`,
            type: "agent.tool_use",
            name: definition.name,
            input,
          });
          return simplifyToolResult(result);
        },
      }),
    ]),
  );
}

function simplifyToolResult(result: ToolExecutionResult): Record<string, unknown> {
  return {
    isError: Boolean(result.isError),
    content: (result.content ?? []).map((block) => {
      if (block.type === "text") {
        return { type: "text", text: block.text };
      }
      return {
        type: block.type,
        note: "Non-text tool output was returned.",
      };
    }),
  };
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
  return hasModelBinaryInput(request.content) ? documentModelId : modelId;
}

function hasModelBinaryInput(blocks: AgentContentBlock[]): boolean {
  return blocks.some((block) => block.type === "image" || (block.type === "document" && block.source.type !== "text"));
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
