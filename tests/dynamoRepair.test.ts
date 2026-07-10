import { describe, expect, it } from "vitest";
import {
  buildDynamoRepairPlan,
  DynamoRepairManifest,
  validateDynamoRepairManifest,
} from "../src/maintenance/dynamoRepair";

const expected = {
  pk: "CHANNEL#T1#C1",
  sk: "MEMORY#chanmem_1",
  workspaceId: "T1",
  channelId: "C1",
  memoryId: "chanmem_1",
  text: "Old fact",
  searchText: "old fact {} family",
  tags: ["family"],
  status: "candidate",
  origin: "inferred",
  createdAt: "created",
  updatedAt: "old-updated",
};

const manifest: DynamoRepairManifest = {
  repairId: "family-calendar-v1",
  tables: { memory: "memory-table" },
  records: [
    {
      id: "memory-1",
      table: "memory",
      recordType: "channel_memory",
      key: { pk: expected.pk, sk: expected.sk },
      expected,
      patch: {
        text: "Canonical fact",
        tags: ["family", "birthday"],
        attributes: { date_kind: "birthday" },
        status: "active",
        origin: "explicit",
      },
      rebuildMemorySearchText: true,
    },
  ],
};

describe("DynamoDB repair planning", () => {
  it("builds an idempotent change from the captured baseline", () => {
    const plan = buildDynamoRepairPlan(
      manifest,
      new Map([["memory-1", expected]]),
      "2026-07-10T01:00:00.000Z",
    );

    expect(plan.conflicts).toEqual([]);
    expect(plan.noops).toEqual([]);
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0].after).toMatchObject({
      memoryId: "chanmem_1",
      text: "Canonical fact",
      status: "active",
      origin: "explicit",
      createdAt: "created",
      updatedAt: "2026-07-10T01:00:00.000Z",
      searchText: expect.stringContaining("canonical fact"),
    });

    const secondRun = buildDynamoRepairPlan(
      manifest,
      new Map([["memory-1", plan.changes[0].after]]),
      "2026-07-11T01:00:00.000Z",
    );
    expect(secondRun).toMatchObject({ changes: [], noops: ["memory-1"], conflicts: [] });
  });

  it("stops on drift or missing records", () => {
    const drifted = { ...expected, text: "Someone changed this" };
    const driftPlan = buildDynamoRepairPlan(
      manifest,
      new Map([["memory-1", drifted]]),
      "2026-07-10T01:00:00.000Z",
    );
    expect(driftPlan.changes).toEqual([]);
    expect(driftPlan.conflicts).toEqual([
      { id: "memory-1", reason: "Current record differs from the captured baseline" },
    ]);

    const missingPlan = buildDynamoRepairPlan(
      manifest,
      new Map([["memory-1", undefined]]),
      "2026-07-10T01:00:00.000Z",
    );
    expect(missingPlan.conflicts).toEqual([{ id: "memory-1", reason: "Record is missing" }]);
  });

  it("does not treat patch-only matches with other drift as already repaired", () => {
    const first = buildDynamoRepairPlan(
      manifest,
      new Map([["memory-1", expected]]),
      "2026-07-10T01:00:00.000Z",
    );
    const corrupted = { ...first.changes[0].after, createdAt: "CORRUPTED" };
    const rerun = buildDynamoRepairPlan(
      manifest,
      new Map([["memory-1", corrupted]]),
      "2026-07-11T01:00:00.000Z",
    );

    expect(rerun.noops).toEqual([]);
    expect(rerun.changes).toEqual([]);
    expect(rerun.conflicts).toEqual([
      { id: "memory-1", reason: "Current record differs from the captured baseline" },
    ]);
  });

  it("rejects invalid recurring-task targets before writing", () => {
    const recurring = {
      pk: "WORKSPACE#T1",
      sk: "RECURRING_TASK#rt1",
      recurringTaskId: "rt1",
      workspaceId: "T1",
      title: "Annual task",
      recurrence: { frequency: "monthly", interval: 1, daysOfMonth: [10] },
      leadTimeDays: 0,
      dueTime: "23:59",
      timezone: "Asia/Tokyo",
      enabled: true,
      createdAt: "created",
      updatedAt: "updated",
    };
    const invalidManifest: DynamoRepairManifest = {
      repairId: "invalid-recurring",
      tables: { recurring: "recurring-table" },
      records: [
        {
          id: "rt1",
          table: "recurring",
          recordType: "recurring_task",
          key: { pk: recurring.pk, sk: recurring.sk },
          expected: recurring,
          patch: {
            recurrence: {
              frequency: "yearly",
              interval: 1,
              monthOfYear: 2,
              daysOfMonth: [30],
            },
          },
        },
      ],
    };

    const plan = buildDynamoRepairPlan(
      invalidManifest,
      new Map([["rt1", recurring]]),
      "2026-07-10T01:00:00.000Z",
    );
    expect(plan.changes).toEqual([]);
    expect(plan.conflicts[0]).toMatchObject({ id: "rt1" });
    expect(plan.conflicts[0].reason).toContain("Recurring task target is invalid");
  });

  it("validates manifest structure and duplicate IDs", () => {
    expect(validateDynamoRepairManifest(manifest)).toMatchObject({ repairId: "family-calendar-v1" });
    expect(() =>
      validateDynamoRepairManifest({
        ...manifest,
        records: [...manifest.records, manifest.records[0]],
      }),
    ).toThrow("Duplicate repair record id");
    expect(() =>
      validateDynamoRepairManifest({
        ...manifest,
        records: [{ ...manifest.records[0], patch: { pk: "OTHER" } }],
      }),
    ).toThrow("cannot patch protected field pk");
    expect(() =>
      validateDynamoRepairManifest({
        ...manifest,
        records: [
          manifest.records[0],
          { ...manifest.records[0], id: "same-key" },
        ],
      }),
    ).toThrow("Duplicate repair target key");
  });
});
