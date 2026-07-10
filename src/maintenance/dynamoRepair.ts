import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { recurringTaskSchema } from "../tasks/recurringTask";

export type DynamoRepairRecordType = "channel_memory" | "recurring_task";

export interface DynamoRepairRecordPlan {
  id: string;
  table: string;
  key: Record<string, string>;
  expected?: Record<string, unknown>;
  expectedFingerprint?: string;
  targetFingerprint?: string;
  recordType: DynamoRepairRecordType;
  patch: Record<string, unknown>;
  rebuildMemorySearchText?: boolean;
}

export interface DynamoRepairManifest {
  repairId: string;
  region?: string;
  tables: Record<string, string>;
  records: DynamoRepairRecordPlan[];
}

export interface DynamoRepairChange {
  id: string;
  tableAlias: string;
  tableName: string;
  key: Record<string, string>;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

export interface DynamoRepairPlanResult {
  changes: DynamoRepairChange[];
  noops: string[];
  conflicts: Array<{ id: string; reason: string }>;
}

export function buildDynamoRepairPlan(
  manifest: DynamoRepairManifest,
  currentById: Map<string, Record<string, unknown> | undefined>,
  appliedAt: string,
): DynamoRepairPlanResult {
  const changes: DynamoRepairChange[] = [];
  const noops: string[] = [];
  const conflicts: Array<{ id: string; reason: string }> = [];

  for (const record of manifest.records) {
    const tableName = manifest.tables[record.table];
    if (!tableName) {
      conflicts.push({ id: record.id, reason: `Unknown table alias: ${record.table}` });
      continue;
    }

    const current = currentById.get(record.id);
    if (!current) {
      conflicts.push({ id: record.id, reason: "Record is missing" });
      continue;
    }

    if (isRepairTarget(current, record)) {
      noops.push(record.id);
      continue;
    }

    const baselineMatches = record.expectedFingerprint
      ? fingerprintDynamoRecord(current) === record.expectedFingerprint
      : isDeepStrictEqual(normalizeValue(current), normalizeValue(record.expected));
    if (!baselineMatches) {
      conflicts.push({ id: record.id, reason: "Current record differs from the captured baseline" });
      continue;
    }

    const after: Record<string, unknown> = {
      ...current,
      ...record.patch,
      updatedAt: appliedAt,
    };
    if (record.rebuildMemorySearchText) {
      after.searchText = buildMemorySearchText(after);
    }
    const afterValidationError = validateRepairRecord(after, record);
    if (afterValidationError) {
      conflicts.push({ id: record.id, reason: afterValidationError });
      continue;
    }
    const expectedTargetFingerprint =
      record.targetFingerprint ??
      (record.expected ? buildExpectedTargetFingerprint(record.expected, record) : undefined);
    const calculatedTargetFingerprint = fingerprintDynamoRepairTarget(after);
    if (expectedTargetFingerprint !== calculatedTargetFingerprint) {
      conflicts.push({
        id: record.id,
        reason: `Target fingerprint mismatch; calculated ${calculatedTargetFingerprint}`,
      });
      continue;
    }
    changes.push({
      id: record.id,
      tableAlias: record.table,
      tableName,
      key: record.key,
      before: current,
      after,
    });
  }

  const targetRecords = new Map<string, Record<string, unknown>>();
  for (const change of changes) {
    targetRecords.set(change.id, change.after);
  }
  for (const id of noops) {
    const current = currentById.get(id);
    if (current) {
      targetRecords.set(id, current);
    }
  }
  const dedupeOwners = new Map<string, string>();
  for (const record of manifest.records) {
    if (record.recordType !== "channel_memory") {
      continue;
    }
    const target = targetRecords.get(record.id);
    const dedupeKey = typeof target?.dedupeKey === "string" ? target.dedupeKey : undefined;
    if (!dedupeKey || target?.status === "archived" || target?.status === "rejected") {
      continue;
    }
    const previousOwner = dedupeOwners.get(dedupeKey);
    if (previousOwner) {
      conflicts.push({
        id: record.id,
        reason: `Dedupe key ${dedupeKey} is also assigned to ${previousOwner}`,
      });
      continue;
    }
    dedupeOwners.set(dedupeKey, record.id);
  }

  return { changes, noops, conflicts };
}

export function isRepairTarget(
  current: Record<string, unknown>,
  record: DynamoRepairRecordPlan,
): boolean {
  for (const [key, value] of Object.entries(record.patch)) {
    if (!isDeepStrictEqual(normalizeValue(current[key]), normalizeValue(value))) {
      return false;
    }
  }
  if (record.rebuildMemorySearchText) {
    if (current.searchText !== buildMemorySearchText({ ...current, ...record.patch })) {
      return false;
    }
  }
  const targetFingerprint =
    record.targetFingerprint ??
    (record.expected ? buildExpectedTargetFingerprint(record.expected, record) : undefined);
  return Boolean(
    targetFingerprint &&
      fingerprintDynamoRepairTarget(current) === targetFingerprint &&
      !validateRepairRecord(current, record),
  );
}

export function validateDynamoRepairManifest(value: unknown): DynamoRepairManifest {
  if (!isRecord(value) || typeof value.repairId !== "string" || !value.repairId.trim()) {
    throw new Error("Repair manifest requires repairId");
  }
  if (!isRecord(value.tables) || !Array.isArray(value.records)) {
    throw new Error("Repair manifest requires tables and records");
  }
  if (value.records.length === 0 || value.records.length > 100) {
    throw new Error("Repair manifest must contain between 1 and 100 records for one atomic transaction");
  }

  const tables = Object.fromEntries(
    Object.entries(value.tables).map(([key, tableName]) => {
      if (typeof tableName !== "string" || !tableName.trim()) {
        throw new Error(`Invalid table name for alias ${key}`);
      }
      return [key, tableName];
    }),
  );

  const ids = new Set<string>();
  const itemKeys = new Set<string>();
  const records = value.records.map((candidate, index) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== "string" ||
      typeof candidate.table !== "string" ||
      !isStringRecord(candidate.key) ||
      !isRecord(candidate.patch) ||
      (candidate.recordType !== "channel_memory" && candidate.recordType !== "recurring_task")
    ) {
      throw new Error(`Invalid repair record at index ${index}`);
    }
    if (!candidate.id.trim() || !candidate.table.trim() || Object.keys(candidate.key).length === 0) {
      throw new Error(`Invalid repair record identity at index ${index}`);
    }
    if (!tables[candidate.table]) {
      throw new Error(`Repair record ${candidate.id} references unknown table alias ${candidate.table}`);
    }
    const hasExpected = isRecord(candidate.expected);
    const hasFingerprint = typeof candidate.expectedFingerprint === "string";
    if (hasExpected === hasFingerprint) {
      throw new Error(`Repair record ${candidate.id} requires exactly one of expected or expectedFingerprint`);
    }
    if (hasFingerprint && !/^[a-f0-9]{64}$/i.test(candidate.expectedFingerprint as string)) {
      throw new Error(`Repair record ${candidate.id} has an invalid expectedFingerprint`);
    }
    if (hasFingerprint && !/^[a-f0-9]{64}$/i.test(String(candidate.targetFingerprint ?? ""))) {
      throw new Error(`Repair record ${candidate.id} requires a valid targetFingerprint`);
    }
    if (!hasFingerprint && candidate.targetFingerprint !== undefined) {
      throw new Error(`Repair record ${candidate.id} may use targetFingerprint only with expectedFingerprint`);
    }
    if (Object.keys(candidate.patch).length === 0) {
      throw new Error(`Repair record ${candidate.id} has an empty patch`);
    }
    const protectedFields = new Set([...Object.keys(candidate.key), "createdAt", "updatedAt"]);
    const modifiedProtectedField = Object.keys(candidate.patch).find((key) => protectedFields.has(key));
    if (modifiedProtectedField) {
      throw new Error(`Repair record ${candidate.id} cannot patch protected field ${modifiedProtectedField}`);
    }
    if (ids.has(candidate.id)) {
      throw new Error(`Duplicate repair record id: ${candidate.id}`);
    }
    ids.add(candidate.id);
    const itemKey = `${candidate.table}\0${JSON.stringify(normalizeValue(candidate.key))}`;
    if (itemKeys.has(itemKey)) {
      throw new Error(`Duplicate repair target key for record ${candidate.id}`);
    }
    itemKeys.add(itemKey);
    return {
      id: candidate.id,
      table: candidate.table,
      key: candidate.key,
      expected: isRecord(candidate.expected) ? candidate.expected : undefined,
      expectedFingerprint:
        typeof candidate.expectedFingerprint === "string" ? candidate.expectedFingerprint : undefined,
      targetFingerprint:
        typeof candidate.targetFingerprint === "string" ? candidate.targetFingerprint : undefined,
      recordType: candidate.recordType as DynamoRepairRecordType,
      patch: candidate.patch,
      rebuildMemorySearchText: candidate.rebuildMemorySearchText === true,
    };
  });

  return {
    repairId: value.repairId,
    region: typeof value.region === "string" ? value.region : undefined,
    tables,
    records,
  };
}

export function fingerprintDynamoRecord(record: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(normalizeValue(record))).digest("hex");
}

export function fingerprintDynamoRepairTarget(record: Record<string, unknown>): string {
  const { updatedAt: _updatedAt, ...stableRecord } = record;
  return fingerprintDynamoRecord(stableRecord);
}

function buildExpectedTargetFingerprint(
  expected: Record<string, unknown>,
  record: DynamoRepairRecordPlan,
): string {
  const target = { ...expected, ...record.patch };
  if (record.rebuildMemorySearchText) {
    target.searchText = buildMemorySearchText(target);
  }
  return fingerprintDynamoRepairTarget(target);
}

function validateRepairRecord(
  value: Record<string, unknown>,
  record: DynamoRepairRecordPlan,
): string | undefined {
  for (const [key, expectedValue] of Object.entries(record.key)) {
    if (value[key] !== expectedValue) {
      return `Record key ${key} does not match the manifest key`;
    }
  }

  if (record.recordType === "recurring_task") {
    const result = recurringTaskSchema.safeParse(value);
    return result.success
      ? undefined
      : `Recurring task target is invalid: ${result.error.issues.map((issue) => issue.message).join("; ")}`;
  }

  const requiredStrings = [
    "workspaceId",
    "channelId",
    "memoryId",
    "text",
    "createdAt",
    "updatedAt",
  ];
  const missing = requiredStrings.find((key) => typeof value[key] !== "string" || !value[key]);
  if (missing) {
    return `Channel memory target requires ${missing}`;
  }
  if (!["active", "candidate", "archived", "rejected"].includes(String(value.status))) {
    return "Channel memory target has an invalid status";
  }
  if (!["explicit", "inferred", "imported"].includes(String(value.origin))) {
    return "Channel memory target has an invalid origin";
  }
  if (value.attributes !== undefined && !isRecord(value.attributes)) {
    return "Channel memory target attributes must be an object";
  }
  const attributes = isRecord(value.attributes) ? value.attributes : undefined;
  if (attributes && (Array.isArray(attributes.date_validation) || Array.isArray(attributes.dateValidation))) {
    return "Channel memory target must contain one date_validation object, not an array";
  }
  const dateValidation = attributes?.date_validation ?? attributes?.dateValidation;
  if (dateValidation !== undefined && !isRecord(dateValidation)) {
    return "Channel memory target date_validation must be an object";
  }
  return undefined;
}

function buildMemorySearchText(record: Record<string, unknown>): string {
  const text = typeof record.text === "string" ? record.text : "";
  const attributes = isRecord(record.attributes) ? record.attributes : {};
  const tags = Array.isArray(record.tags)
    ? record.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  return [text, JSON.stringify(attributes), tags.join(" ")]
    .filter(Boolean)
    .join(" ")
    .trim()
    .toLowerCase();
}

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalizeValue(item)]),
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
