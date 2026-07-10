import { describe, expect, it } from "vitest";
import { RecurringTask, recurringTaskSchema } from "../src/tasks/recurringTask";
import {
  buildOccurrenceDueAt,
  buildRecurringOccurrenceTaskId,
  enumerateRecurringTaskOccurrences,
} from "../src/tasks/recurringTaskSchedule";

function task(overrides: Partial<RecurringTask> = {}): RecurringTask {
  return recurringTaskSchema.parse({
    recurringTaskId: "rt_family_day",
    workspaceId: "T1",
    title: "Prepare a gift",
    description: "Choose, buy, and ship it",
    recurrence: {
      frequency: "yearly",
      monthOfYear: 5,
      daysOfWeek: ["sunday"],
      weekOfMonth: 2,
    },
    leadTimeDays: 7,
    dayOfTask: {
      title: "Send the message today",
      dueTime: "09:00",
    },
    dueTime: "23:59",
    timezone: "Asia/Tokyo",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

describe("recurring task scheduling", () => {
  it("preserves daily, weekly, and monthly occurrence behavior", () => {
    const daily = task({
      recurrence: { frequency: "daily", interval: 2 },
      leadTimeDays: 0,
      dayOfTask: undefined,
      timezone: "UTC",
      createdAt: "2026-01-01T00:00:00Z",
    });
    expect(
      enumerateRecurringTaskOccurrences(daily, new Date("2026-01-01T00:00:00Z"), 4).map(
        (occurrence) => occurrence.eventDate,
      ),
    ).toEqual(["2026-01-01", "2026-01-03", "2026-01-05"]);

    const weekly = task({
      recurrence: { frequency: "weekly", interval: 2, daysOfWeek: ["wednesday"] },
      leadTimeDays: 0,
      dayOfTask: undefined,
      timezone: "UTC",
      createdAt: "2026-01-05T00:00:00Z",
    });
    expect(
      enumerateRecurringTaskOccurrences(weekly, new Date("2026-01-05T00:00:00Z"), 16).map(
        (occurrence) => occurrence.eventDate,
      ),
    ).toEqual(["2026-01-07", "2026-01-21"]);

    const monthly = task({
      recurrence: { frequency: "monthly", interval: 1, daysOfMonth: [10] },
      leadTimeDays: 0,
      dayOfTask: undefined,
      timezone: "UTC",
      createdAt: "2026-01-15T00:00:00Z",
    });
    expect(
      enumerateRecurringTaskOccurrences(monthly, new Date("2026-01-15T00:00:00Z"), 27).map(
        (occurrence) => occurrence.eventDate,
      ),
    ).toEqual(["2026-02-10"]);
  });

  it("treats monthly fixed days and nth weekdays as a union", () => {
    const monthly = task({
      recurrence: {
        frequency: "monthly",
        interval: 1,
        daysOfMonth: [10],
        daysOfWeek: ["friday"],
        weekOfMonth: 2,
      },
      leadTimeDays: 0,
      dayOfTask: undefined,
      timezone: "UTC",
      createdAt: "2026-01-01T00:00:00Z",
    });

    expect(
      enumerateRecurringTaskOccurrences(
        monthly,
        new Date("2026-01-01T00:00:00Z"),
        9,
      ).map((occurrence) => occurrence.eventDate),
    ).toEqual(["2026-01-09", "2026-01-10"]);
  });

  it("materializes a yearly nth-weekday preparation deadline and day-of task", () => {
    const occurrences = enumerateRecurringTaskOccurrences(
      task(),
      new Date("2027-05-02T00:00:00+09:00"),
      7,
    );

    expect(occurrences).toEqual([
      expect.objectContaining({
        kind: "primary",
        eventDate: "2027-05-09",
        dueDate: "2027-05-02",
        title: "Prepare a gift",
      }),
      expect.objectContaining({
        kind: "day_of",
        eventDate: "2027-05-09",
        dueDate: "2027-05-09",
        title: "Send the message today",
        dueTime: "09:00",
      }),
    ]);
  });

  it("keeps Father's Day in June instead of anchoring it to the creation month", () => {
    const father = task({
      recurringTaskId: "rt_father",
      recurrence: {
        frequency: "yearly",
        interval: 1,
        monthOfYear: 6,
        daysOfWeek: ["sunday"],
        weekOfMonth: 3,
      },
    });

    expect(
      enumerateRecurringTaskOccurrences(father, new Date("2027-06-13T00:00:00+09:00"), 7),
    ).toEqual([
      expect.objectContaining({ kind: "primary", eventDate: "2027-06-20", dueDate: "2027-06-13" }),
      expect.objectContaining({ kind: "day_of", eventDate: "2027-06-20", dueDate: "2027-06-20" }),
    ]);
    expect(
      enumerateRecurringTaskOccurrences(father, new Date("2027-05-09T00:00:00+09:00"), 14),
    ).toEqual([]);
  });

  it("supports fixed yearly dates and leap-day years", () => {
    const leapDay = task({
      recurrence: {
        frequency: "yearly",
        interval: 1,
        monthOfYear: 2,
        daysOfMonth: [29],
      },
      leadTimeDays: 0,
      dayOfTask: undefined,
      createdAt: "2026-01-01T00:00:00Z",
    });

    expect(
      enumerateRecurringTaskOccurrences(leapDay, new Date("2027-02-28T00:00:00Z"), 1),
    ).toEqual([]);
    expect(
      enumerateRecurringTaskOccurrences(leapDay, new Date("2028-02-29T00:00:00Z"), 0),
    ).toEqual([expect.objectContaining({ eventDate: "2028-02-29", dueDate: "2028-02-29" })]);
  });

  it("preserves legacy primary IDs and makes day-of IDs distinct", () => {
    const definition = task();
    const legacyPrimaryId = buildRecurringOccurrenceTaskId(definition, "2027-05-09");
    const explicitPrimaryId = buildRecurringOccurrenceTaskId(definition, "2027-05-09", "primary");
    const dayOfId = buildRecurringOccurrenceTaskId(definition, "2027-05-09", "day_of");

    expect(explicitPrimaryId).toBe(legacyPrimaryId);
    expect(dayOfId).not.toBe(legacyPrimaryId);
    expect(dayOfId).toContain("_day_of");
    expect(buildOccurrenceDueAt("2027-05-02", "23:59", "Asia/Tokyo")).toBe(
      "2027-05-02T23:59:00+09:00",
    );
  });

  it("uses the offset at the requested local time on DST transition days", () => {
    expect(buildOccurrenceDueAt("2026-03-08", "01:30", "America/New_York")).toBe(
      "2026-03-08T01:30:00-05:00",
    );
    expect(buildOccurrenceDueAt("2026-03-08", "03:30", "America/New_York")).toBe(
      "2026-03-08T03:30:00-04:00",
    );
    expect(() => buildOccurrenceDueAt("2026-03-08", "02:30", "America/New_York")).toThrow(
      "does not exist",
    );
  });
});
