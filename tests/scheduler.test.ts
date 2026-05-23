import { describe, expect, it } from "vitest";
import {
  buildScheduleExpressionFromRecurrence,
  buildScheduleName,
  extractDailyCronTime,
  normalizeDailyReminderTime,
} from "../src/scheduler/scheduledReminder";

describe("scheduled reminder scheduler helpers", () => {
  it("builds daily, weekly, and monthly EventBridge cron expressions", () => {
    expect(
      buildScheduleExpressionFromRecurrence({
        frequency: "daily",
        time: "8:00",
      }),
    ).toBe("cron(0 8 * * ? *)");

    expect(
      buildScheduleExpressionFromRecurrence({
        frequency: "weekly",
        time: "09:30",
        daysOfWeek: ["monday", "friday"],
      }),
    ).toBe("cron(30 9 ? * MON,FRI *)");

    expect(
      buildScheduleExpressionFromRecurrence({
        frequency: "monthly",
        time: "21:05",
        daysOfMonth: [1, 15],
      }),
    ).toBe("cron(5 21 1,15 * ? *)");
  });

  it("normalizes times and extracts simple daily cron times", () => {
    expect(normalizeDailyReminderTime("8:05")).toBe("08:05");
    expect(extractDailyCronTime("cron(0 8 * * ? *)")).toBe("08:00");
    expect(extractDailyCronTime("cron(30 9 ? * MON *)")).toBeUndefined();
    expect(() => normalizeDailyReminderTime("24:00")).toThrow("valid local time");
  });

  it("builds stable EventBridge-safe schedule names", () => {
    const name = buildScheduleName("serverless-agent", "T1", "Morning Reminder For #general");
    expect(name).toMatch(/^serverless-agent-morning-reminder-for-general-[a-f0-9]+$/);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(buildScheduleName("serverless-agent", "T1", "task1")).toBe(
      buildScheduleName("serverless-agent", "T1", "task1"),
    );
    expect(buildScheduleName("serverless-agent", "T1", "task1")).not.toBe(
      buildScheduleName("serverless-agent", "T2", "task1"),
    );
  });
});
