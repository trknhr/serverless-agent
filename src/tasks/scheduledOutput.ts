import type { ScheduledOutputProvider, ScheduledTask } from "./taskDefinition";

export interface ScheduledSlackOutputTarget {
  provider: "slack";
  channelId: string;
  conversationKey: string;
}

export interface ScheduledLineOutputTarget {
  provider: "line";
  channelId: string;
  conversationKey: string;
  targetId: string;
  targetType: "user" | "group" | "room";
}

export type ScheduledOutputTarget = ScheduledSlackOutputTarget | ScheduledLineOutputTarget;

export interface ScheduledOutputFields {
  outputChannelId: string;
  outputProvider: ScheduledOutputProvider;
  outputConversationKey: string;
}

export function normalizeScheduledOutputFields(input: {
  outputChannelId: string;
  outputProvider?: ScheduledOutputProvider;
  outputConversationKey?: string;
}): ScheduledOutputFields {
  const target = resolveScheduledOutputTarget({
    outputChannelId: input.outputChannelId,
    outputProvider: input.outputProvider,
    outputConversationKey: input.outputConversationKey,
  });

  return {
    outputChannelId: target.channelId,
    outputProvider: target.provider,
    outputConversationKey: target.conversationKey,
  };
}

export function resolveScheduledOutputTarget(
  task: Pick<ScheduledTask, "outputChannelId" | "outputProvider" | "outputConversationKey">,
): ScheduledOutputTarget {
  const provider = task.outputProvider ?? inferProvider(task.outputConversationKey ?? task.outputChannelId);

  if (provider === "line") {
    const parsed = parseLineConversationKey(task.outputConversationKey ?? task.outputChannelId);
    if (!parsed) {
      throw new Error(`Invalid LINE scheduled output target: ${task.outputConversationKey ?? task.outputChannelId}`);
    }

    return {
      provider: "line",
      channelId: `line:${parsed.conversationKey}`,
      conversationKey: parsed.conversationKey,
      targetId: parsed.targetId,
      targetType: parsed.targetType,
    };
  }

  const conversationKey = normalizeSlackConversationKey(task.outputConversationKey ?? task.outputChannelId);
  return {
    provider: "slack",
    channelId: conversationKey.replace(/^channel:/, ""),
    conversationKey,
  };
}

function inferProvider(value: string): ScheduledOutputProvider {
  return parseLineConversationKey(value) ? "line" : "slack";
}

function parseLineConversationKey(value: string): {
  conversationKey: string;
  targetId: string;
  targetType: "user" | "group" | "room";
} | null {
  const match = value.match(/^(?:line:)?(user|group|room):(.+)$/);
  if (!match) {
    return null;
  }

  const [, targetType, targetId] = match;
  return {
    conversationKey: `${targetType}:${targetId}`,
    targetId,
    targetType: targetType as "user" | "group" | "room",
  };
}

function normalizeSlackConversationKey(value: string): string {
  const withoutProvider = value.startsWith("slack:") ? value.slice("slack:".length) : value;
  return withoutProvider.startsWith("channel:") ? withoutProvider : `channel:${withoutProvider}`;
}
