import { z } from "zod";
import { RecurringTask } from "../tasks/recurringTask";

export const searchContextSchema = z
  .object({
    query: z.string().max(400).optional(),
    queries: z.array(z.string().min(1).max(400)).max(5).optional(),
    task_statuses: z.array(z.enum(["open", "in_progress", "done", "cancelled"])).optional(),
    task_due_before: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(20).optional(),
    include_web: z.boolean().optional(),
    country: z.string().regex(/^[A-Za-z]{2}$/).optional(),
    language: z.string().regex(/^[A-Za-z]{2,3}$/).optional(),
    freshness: z.enum(["day", "week", "month", "year"]).optional(),
    domains: z.array(z.string().min(1)).max(5).optional(),
  })
  .superRefine((value, ctx) => {
    const hasQuery = Boolean(value.query) || Boolean(value.queries?.length);
    const hasTaskListFilter = hasTaskListFilters(value);

    if (!hasQuery && !hasTaskListFilter) {
      ctx.addIssue({
        code: "custom",
        message: "search_context requires query, queries, task_statuses, or task_due_before",
        path: ["query"],
      });
    }

    if (value.include_web && !hasQuery) {
      ctx.addIssue({
        code: "custom",
        message: "include_web requires query or queries",
        path: ["include_web"],
      });
    }
  });

export type SearchContextInput = z.infer<typeof searchContextSchema>;

export function hasTaskListFilters(input: { task_statuses?: unknown[]; task_due_before?: string }): boolean {
  return Boolean(input.task_statuses?.length) || Boolean(input.task_due_before);
}

export function buildContextSearchQueries(query?: string, additionalQueries?: string[]): string[] {
  const queries: string[] = [...(query ? [query] : []), ...(additionalQueries ?? [])];
  const seen = new Set<string>();

  return queries
    .map(normalizeContextSearchQuery)
    .filter((candidate) => {
      if (!candidate || seen.has(candidate)) {
        return false;
      }
      seen.add(candidate);
      return true;
    });
}

export function buildFallbackContextSearchQueries(queries: string[], maxQueries = 5): string[] {
  const existing = new Set(queries.map(normalizeContextSearchQuery));
  const seen = new Set<string>();
  const fallbackQueries: string[] = [];

  for (const query of queries) {
    const normalized = normalizeContextSearchText(query);
    const matches = normalized.matchAll(/[a-z0-9][a-z0-9_-]*/g);

    for (const match of matches) {
      const token = normalizeContextSearchQuery(match[0]);
      if (!isDistinctiveAsciiSearchToken(token) || existing.has(token) || seen.has(token)) {
        continue;
      }

      seen.add(token);
      fallbackQueries.push(token);

      if (fallbackQueries.length >= maxQueries) {
        return fallbackQueries;
      }
    }
  }

  return fallbackQueries;
}

export function addUniqueSearchRecords(
  target: Map<string, Record<string, unknown>>,
  records: unknown[],
  getKey: (record: Record<string, unknown>) => string,
): void {
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      continue;
    }
    const typedRecord = record as Record<string, unknown>;
    const key = getKey(typedRecord);
    if (key && !target.has(key)) {
      target.set(key, typedRecord);
    }
  }
}

export function stringRecordValue(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

export function buildSearchTerms(query: string): string[] {
  return normalizeContextSearchText(query).split(/\s+/).filter(Boolean);
}

export function matchesContextSearch(searchText: string, terms: string[]): boolean {
  return terms.length === 0 || terms.every((term) => searchText.includes(term));
}

export function buildRecurringTaskSearchText(task: RecurringTask): string {
  return normalizeContextSearchText(
    [
      task.recurringTaskId,
      task.title,
      task.description,
      task.sourceType,
      task.sourceRef,
      JSON.stringify(task.recurrence),
      String(task.leadTimeDays ?? 0),
      task.dayOfTask ? JSON.stringify(task.dayOfTask) : undefined,
      task.metadata ? JSON.stringify(task.metadata) : undefined,
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function normalizeContextSearchText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function normalizeContextSearchQuery(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function isDistinctiveAsciiSearchToken(token: string): boolean {
  return token.length >= 3 && /[a-z0-9]/.test(token);
}
