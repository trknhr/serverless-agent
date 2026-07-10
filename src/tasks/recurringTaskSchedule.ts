import { createHash } from "node:crypto";
import { RecurringTask, RecurringTaskWeekday } from "./recurringTask";

const WEEKDAYS: RecurringTaskWeekday[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

export type RecurringTaskMaterializationKind = "primary" | "day_of";

export interface RecurringTaskOccurrence {
  kind: RecurringTaskMaterializationKind;
  eventDate: string;
  dueDate: string;
  title: string;
  description?: string;
  dueTime: string;
  priority?: "low" | "medium" | "high";
}

export function enumerateRecurringTaskOccurrences(
  recurringTask: RecurringTask,
  now: Date,
  lookaheadDays: number,
): RecurringTaskOccurrence[] {
  const today = formatDateInTimeZone(now, recurringTask.timezone);
  const leadTimeDays = recurringTask.leadTimeDays ?? 0;
  const occurrences: RecurringTaskOccurrence[] = [];

  for (let offset = 0; offset <= lookaheadDays; offset += 1) {
    const dueDate = addDays(today, offset);
    const primaryEventDate = addDays(dueDate, leadTimeDays);

    if (isRecurringTaskOccurrenceDate(recurringTask, primaryEventDate)) {
      occurrences.push({
        kind: "primary",
        eventDate: primaryEventDate,
        dueDate,
        title: recurringTask.title,
        description: recurringTask.description,
        dueTime: recurringTask.dueTime,
        priority: recurringTask.priority,
      });
    }

    if (recurringTask.dayOfTask?.enabled && isRecurringTaskOccurrenceDate(recurringTask, dueDate)) {
      occurrences.push({
        kind: "day_of",
        eventDate: dueDate,
        dueDate,
        title: recurringTask.dayOfTask.title,
        description: recurringTask.dayOfTask.description,
        dueTime: recurringTask.dayOfTask.dueTime ?? recurringTask.dueTime,
        priority: recurringTask.dayOfTask.priority ?? recurringTask.priority,
      });
    }
  }

  return occurrences;
}

export function isRecurringTaskOccurrenceDate(
  recurringTask: RecurringTask,
  dateOnly: string,
): boolean {
  const startDate = formatDateInTimeZone(new Date(recurringTask.createdAt), recurringTask.timezone);
  const interval = recurringTask.recurrence.interval ?? 1;

  if (dateOnly < startDate) {
    return false;
  }

  if (recurringTask.recurrence.frequency === "daily") {
    return daysBetween(startDate, dateOnly) % interval === 0;
  }

  if (recurringTask.recurrence.frequency === "weekly") {
    const days = daysBetween(startDate, dateOnly);
    if (Math.floor(days / 7) % interval !== 0) {
      return false;
    }
    const weekdays = recurringTask.recurrence.daysOfWeek ?? [weekdayForDate(startDate)];
    return weekdays.includes(weekdayForDate(dateOnly));
  }

  if (recurringTask.recurrence.frequency === "monthly") {
    if (monthsBetween(startDate, dateOnly) % interval !== 0) {
      return false;
    }
    return matchesDaySelector(recurringTask, dateOnly, parseDateOnly(startDate).day);
  }

  if (recurringTask.recurrence.frequency === "yearly") {
    const startYear = parseDateOnly(startDate).year;
    const candidate = parseDateOnly(dateOnly);
    if ((candidate.year - startYear) % interval !== 0) {
      return false;
    }
    if (candidate.month !== recurringTask.recurrence.monthOfYear) {
      return false;
    }
    return matchesDaySelector(recurringTask, dateOnly);
  }

  return false;
}

export function buildRecurringOccurrenceTaskId(
  recurringTask: RecurringTask,
  eventDate: string,
  kind: RecurringTaskMaterializationKind = "primary",
): string {
  const phaseSuffix = kind === "day_of" ? ":day_of" : "";
  const hash = createHash("sha256")
    .update(`${recurringTask.workspaceId}:${recurringTask.recurringTaskId}:${eventDate}${phaseSuffix}`)
    .digest("hex")
    .slice(0, 16);
  const idSuffix = kind === "day_of" ? "_day_of" : "";
  return `task_rec_${hash}_${eventDate.replace(/-/g, "")}${idSuffix}`;
}

export function buildOccurrenceDueAt(dateOnly: string, dueTime: string, timeZone: string): string {
  return `${dateOnly}T${dueTime}:00${timeZoneOffsetForLocalDateTime(dateOnly, dueTime, timeZone)}`;
}

function matchesDaySelector(
  recurringTask: RecurringTask,
  dateOnly: string,
  defaultDayOfMonth?: number,
): boolean {
  const dayOfMonth = parseDateOnly(dateOnly).day;
  let hasExplicitSelector = false;
  if (recurringTask.recurrence.daysOfMonth?.length) {
    hasExplicitSelector = true;
    if (recurringTask.recurrence.daysOfMonth.includes(dayOfMonth)) {
      return true;
    }
  }
  if (recurringTask.recurrence.weekOfMonth && recurringTask.recurrence.daysOfWeek?.length) {
    hasExplicitSelector = true;
    if (
      recurringTask.recurrence.daysOfWeek.some((weekday) =>
        isNthWeekdayOfMonth(dateOnly, weekday, recurringTask.recurrence.weekOfMonth!),
      )
    ) {
      return true;
    }
  }
  return !hasExplicitSelector && defaultDayOfMonth !== undefined && dayOfMonth === defaultDayOfMonth;
}

function addDays(dateOnly: string, days: number): string {
  const { year, month, day } = parseDateOnly(dateOnly);
  return formatUtcDateOnly(new Date(Date.UTC(year, month - 1, day + days)));
}

function daysBetween(startDate: string, endDate: string): number {
  const start = parseDateOnly(startDate);
  const end = parseDateOnly(endDate);
  return Math.floor(
    (Date.UTC(end.year, end.month - 1, end.day) - Date.UTC(start.year, start.month - 1, start.day)) /
      (24 * 60 * 60 * 1000),
  );
}

function monthsBetween(startDate: string, endDate: string): number {
  const start = parseDateOnly(startDate);
  const end = parseDateOnly(endDate);
  return (end.year - start.year) * 12 + (end.month - start.month);
}

function weekdayForDate(dateOnly: string): RecurringTaskWeekday {
  const { year, month, day } = parseDateOnly(dateOnly);
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

function isNthWeekdayOfMonth(
  dateOnly: string,
  weekday: RecurringTaskWeekday,
  weekOfMonth: number | "last",
): boolean {
  if (weekdayForDate(dateOnly) !== weekday) {
    return false;
  }
  const { day, month } = parseDateOnly(dateOnly);
  if (weekOfMonth === "last") {
    return parseDateOnly(addDays(dateOnly, 7)).month !== month;
  }
  return Math.floor((day - 1) / 7) + 1 === weekOfMonth;
}

function formatDateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function parseDateOnly(dateOnly: string): { year: number; month: number; day: number } {
  const [year, month, day] = dateOnly.split("-").map((part) => Number.parseInt(part, 10));
  return { year, month, day };
}

function formatUtcDateOnly(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function timeZoneOffsetForLocalDateTime(dateOnly: string, dueTime: string, timeZone: string): string {
  const { year, month, day } = parseDateOnly(dateOnly);
  const [hour, minute] = dueTime.split(":").map((part) => Number.parseInt(part, 10));
  const targetWallTime = Date.UTC(year, month - 1, day, hour, minute, 0);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  let instant = targetWallTime;

  for (let iteration = 0; iteration < 8; iteration += 1) {
    const local = dateTimeParts(formatter, new Date(instant));
    const renderedWallTime = Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
      local.second,
    );
    const adjustment = targetWallTime - renderedWallTime;
    if (adjustment === 0) {
      const offsetMinutes = Math.round((targetWallTime - instant) / 60_000);
      return formatOffsetMinutes(offsetMinutes);
    }
    instant += adjustment;
  }

  throw new Error(`Local time ${dateOnly} ${dueTime} does not exist in ${timeZone}`);
}

function dateTimeParts(
  formatter: Intl.DateTimeFormat,
  date: Date,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = formatter.formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number.parseInt(parts.find((part) => part.type === type)?.value ?? "0", 10);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

function formatOffsetMinutes(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}
