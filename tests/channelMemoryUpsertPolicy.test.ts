import { describe, expect, it } from "vitest";
import { ChannelMemoryItem } from "../src/memory/channelMemoryItem";
import {
  decideExistingChannelMemoryUpsert,
  nextChannelMemoryUpdatedAt,
} from "../src/memory/channelMemoryUpsertPolicy";

function memory(overrides: Partial<ChannelMemoryItem> = {}): ChannelMemoryItem {
  return {
    workspaceId: "T1",
    channelId: "C1",
    memoryId: "chanmem_fixture",
    dedupeKey: "project:fixture:owner",
    text: "The owner is U1",
    status: "active",
    origin: "explicit",
    createdAt: "created",
    updatedAt: "updated",
    ...overrides,
  };
}

describe("channel memory upsert policy", () => {
  it("blocks inferred changes to active memory", () => {
    const existing = memory();
    expect(() =>
      decideExistingChannelMemoryUpsert({
        existing,
        next: memory({ text: "The owner might be U2", origin: "explicit" }),
        incomingOrigin: "inferred",
      }),
    ).toThrow("cannot be changed by inferred input");
  });

  it("treats an identical retry as a no-op even with a stale token", () => {
    const existing = memory();
    expect(
      decideExistingChannelMemoryUpsert({
        existing,
        next: memory({ updatedAt: "new-attempt-time" }),
        incomingOrigin: "inferred",
        expectedUpdatedAt: "stale",
      }),
    ).toBe("noop");
  });

  it("requires both ID and version token for an explicit active-memory change", () => {
    const existing = memory();
    const next = memory({ text: "The owner is U2" });

    expect(() =>
      decideExistingChannelMemoryUpsert({
        existing,
        next,
        incomingOrigin: "explicit",
        expectedUpdatedAt: "updated",
      }),
    ).toThrow("requires memory_id and expected_updated_at");
    expect(() =>
      decideExistingChannelMemoryUpsert({
        existing,
        next,
        incomingOrigin: "explicit",
        requestedMemoryId: existing.memoryId,
      }),
    ).toThrow("requires memory_id and expected_updated_at");
  });

  it("allows a versioned explicit active-memory change", () => {
    const existing = memory();
    expect(
      decideExistingChannelMemoryUpsert({
        existing,
        next: memory({ text: "The owner is U2" }),
        incomingOrigin: "explicit",
        requestedMemoryId: existing.memoryId,
        expectedUpdatedAt: existing.updatedAt,
      }),
    ).toBe("write");
  });

  it("rejects a stale token when the desired content differs", () => {
    const existing = memory();
    expect(() =>
      decideExistingChannelMemoryUpsert({
        existing,
        next: memory({ text: "The owner is U2" }),
        incomingOrigin: "explicit",
        requestedMemoryId: existing.memoryId,
        expectedUpdatedAt: "stale",
      }),
    ).toThrow("changed since it was loaded");
  });

  it("allows candidate refinement and explicit promotion without a caller token", () => {
    const candidate = memory({ status: "candidate", origin: "inferred" });
    expect(
      decideExistingChannelMemoryUpsert({
        existing: candidate,
        next: memory({ status: "candidate", origin: "inferred", text: "Possible owner: U2" }),
        incomingOrigin: "inferred",
      }),
    ).toBe("write");
    expect(
      decideExistingChannelMemoryUpsert({
        existing: candidate,
        next: memory({ status: "active", origin: "explicit" }),
        incomingOrigin: "explicit",
      }),
    ).toBe("write");
  });

  it("always advances the version timestamp for an existing memory", () => {
    expect(
      nextChannelMemoryUpdatedAt(
        "2026-01-01T00:00:00.000Z",
        new Date("2026-01-01T00:00:00.000Z"),
      ),
    ).toBe("2026-01-01T00:00:00.001Z");
    expect(
      nextChannelMemoryUpdatedAt(
        "2026-01-01T00:00:00.010Z",
        new Date("2026-01-01T00:00:00.000Z"),
      ),
    ).toBe("2026-01-01T00:00:00.011Z");
  });
});
