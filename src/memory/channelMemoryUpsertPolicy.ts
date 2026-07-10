import { isDeepStrictEqual } from "node:util";
import { ChannelMemoryItem } from "./channelMemoryItem";

export function decideExistingChannelMemoryUpsert(input: {
  existing: ChannelMemoryItem;
  next: ChannelMemoryItem;
  incomingOrigin: ChannelMemoryItem["origin"];
  requestedMemoryId?: string;
  expectedUpdatedAt?: string;
}): "noop" | "write" {
  if (isEquivalentChannelMemory(input.existing, input.next)) {
    return "noop";
  }

  if (input.existing.status === "active") {
    if (input.incomingOrigin !== "explicit") {
      throw new Error(
        `Channel memory ${input.existing.memoryId} is active and cannot be changed by ${input.incomingOrigin} input`,
      );
    }
    if (
      input.requestedMemoryId !== input.existing.memoryId ||
      !input.expectedUpdatedAt
    ) {
      throw new Error(
        `Changing active channel memory ${input.existing.memoryId} requires memory_id and expected_updated_at`,
      );
    }
  }

  if (
    input.expectedUpdatedAt &&
    input.existing.updatedAt !== input.expectedUpdatedAt
  ) {
    throw new Error(
      `Channel memory ${input.existing.memoryId} changed since it was loaded`,
    );
  }

  return "write";
}

export function nextChannelMemoryUpdatedAt(
  existingUpdatedAt: string | undefined,
  now = new Date(),
): string {
  const nowMs = now.getTime();
  const existingMs = existingUpdatedAt ? Date.parse(existingUpdatedAt) : Number.NaN;
  const nextMs = Number.isFinite(existingMs) && existingMs >= nowMs
    ? existingMs + 1
    : nowMs;
  return new Date(nextMs).toISOString();
}

function isEquivalentChannelMemory(
  existing: ChannelMemoryItem,
  next: ChannelMemoryItem,
): boolean {
  return isDeepStrictEqual(
    { ...existing, updatedAt: undefined },
    { ...next, updatedAt: undefined },
  );
}
