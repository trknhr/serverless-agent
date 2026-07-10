import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  DescribeContinuousBackupsCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  buildDynamoRepairPlan,
  DynamoRepairManifest,
  fingerprintDynamoRecord,
  fingerprintDynamoRepairTarget,
  isRepairTarget,
  validateDynamoRepairManifest,
} from "../src/maintenance/dynamoRepair";

interface CliOptions {
  manifestPath: string;
  region?: string;
  apply: boolean;
  confirm?: string;
  backupPath?: string;
  verbose: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const manifest = validateDynamoRepairManifest(
    JSON.parse(await readFile(resolve(options.manifestPath), "utf8")),
  );
  const region = options.region ?? manifest.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  const lowLevelClient = new DynamoDBClient({ region });
  const documentClient = DynamoDBDocumentClient.from(lowLevelClient, {
    marshallOptions: { removeUndefinedValues: true },
  });

  const current = await loadCurrentRecords(documentClient, manifest);
  const appliedAt = new Date().toISOString();
  const plan = buildDynamoRepairPlan(manifest, current, appliedAt);
  printPlan(manifest, plan, options.verbose);

  if (plan.conflicts.length > 0) {
    throw new Error("Repair has conflicts; no writes were performed");
  }
  if (!options.apply) {
    console.log("DRY RUN: no writes were performed");
    return;
  }
  if (options.confirm !== manifest.repairId) {
    throw new Error(`Applying requires --confirm ${manifest.repairId}`);
  }
  if (plan.changes.length === 0) {
    console.log("All records already match the repair target; no writes were needed");
    return;
  }

  assertConditionalVersionFields(plan.changes);

  const pitr = await assertPointInTimeRecovery(lowLevelClient, [...new Set(plan.changes.map((change) => change.tableName))]);
  const effectiveRegion = await lowLevelClient.config.region();
  const backupPath = resolve(
    options.backupPath ??
      `.serverless-agent/repairs/${manifest.repairId}/before-${appliedAt.replace(/[:.]/g, "-")}.json`,
  );
  await writeVerifiedBackup(backupPath, {
    repairId: manifest.repairId,
    capturedAt: appliedAt,
    region: effectiveRegion,
    tables: manifest.tables,
    manifestFingerprint: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
    pointInTimeRecovery: pitr,
    records: plan.changes.map((change) => ({
      id: change.id,
      tableAlias: change.tableAlias,
      tableName: change.tableName,
      key: change.key,
      before: change.before,
      beforeFingerprint: fingerprintDynamoRecord(change.before),
    })),
  });
  console.log(`Verified backup: ${backupPath}`);

  await documentClient.send(
    new TransactWriteCommand({
      TransactItems: plan.changes.map((change) => ({
        Put: {
          TableName: change.tableName,
          Item: change.after,
          ConditionExpression: "#createdAt = :createdAt AND #updatedAt = :updatedAt",
          ExpressionAttributeNames: {
            "#createdAt": "createdAt",
            "#updatedAt": "updatedAt",
          },
          ExpressionAttributeValues: {
            ":createdAt": change.before.createdAt,
            ":updatedAt": change.before.updatedAt,
          },
        },
      })),
    }),
  );

  const after = await loadCurrentRecords(documentClient, manifest);
  const failedPostConditions = manifest.records
    .filter((record) => !isRepairTarget(after.get(record.id) ?? {}, record))
    .map((record) => record.id);
  if (failedPostConditions.length > 0) {
    throw new Error(`Post-write verification failed for: ${failedPostConditions.join(", ")}`);
  }
  console.log(`Applied and verified ${plan.changes.length} record changes`);
}

async function loadCurrentRecords(
  client: DynamoDBDocumentClient,
  manifest: DynamoRepairManifest,
): Promise<Map<string, Record<string, unknown> | undefined>> {
  const entries = await Promise.all(
    manifest.records.map(async (record) => {
      const response = await client.send(
        new GetCommand({
          TableName: manifest.tables[record.table],
          Key: record.key,
          ConsistentRead: true,
        }),
      );
      return [record.id, response.Item] as const;
    }),
  );
  return new Map(entries);
}

async function assertPointInTimeRecovery(
  client: DynamoDBClient,
  tableNames: string[],
): Promise<Array<Record<string, unknown>>> {
  const descriptions: Array<Record<string, unknown>> = [];
  for (const tableName of tableNames) {
    const response = await client.send(new DescribeContinuousBackupsCommand({ TableName: tableName }));
    const status = response.ContinuousBackupsDescription?.PointInTimeRecoveryDescription?.PointInTimeRecoveryStatus;
    if (status !== "ENABLED") {
      throw new Error(`Point-in-time recovery is not enabled for ${tableName}`);
    }
    const details = response.ContinuousBackupsDescription?.PointInTimeRecoveryDescription;
    descriptions.push({
      tableName,
      status,
      earliestRestorableDateTime: details?.EarliestRestorableDateTime?.toISOString(),
      latestRestorableDateTime: details?.LatestRestorableDateTime?.toISOString(),
    });
  }
  return descriptions;
}

function assertConditionalVersionFields(
  changes: ReturnType<typeof buildDynamoRepairPlan>["changes"],
): void {
  for (const change of changes) {
    for (const [key, expectedValue] of Object.entries(change.key)) {
      if (change.after[key] !== expectedValue) {
        throw new Error(`Repair record ${change.id} target key ${key} does not match the manifest`);
      }
    }
    if (
      typeof change.before.createdAt !== "string" ||
      !change.before.createdAt ||
      typeof change.before.updatedAt !== "string" ||
      !change.before.updatedAt
    ) {
      throw new Error(`Repair record ${change.id} is missing createdAt or updatedAt for conditional apply`);
    }
  }
}

async function writeVerifiedBackup(path: string, value: unknown): Promise<void> {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const saved = await readFile(path, "utf8");
  if (createHash("sha256").update(saved).digest("hex") !== createHash("sha256").update(text).digest("hex")) {
    throw new Error(`Backup checksum verification failed: ${path}`);
  }
}

function printPlan(
  manifest: DynamoRepairManifest,
  plan: ReturnType<typeof buildDynamoRepairPlan>,
  verbose: boolean,
): void {
  console.log(`Repair: ${manifest.repairId}`);
  console.log(`Changes: ${plan.changes.length}, no-ops: ${plan.noops.length}, conflicts: ${plan.conflicts.length}`);
  for (const change of plan.changes) {
    console.log(
      `CHANGE ${change.id} (${change.tableAlias}) target=${fingerprintDynamoRepairTarget(change.after)}`,
    );
    if (verbose) {
      console.log(JSON.stringify({ before: change.before, after: change.after }, null, 2));
    }
  }
  for (const id of plan.noops) {
    console.log(`NOOP ${id}`);
  }
  for (const conflict of plan.conflicts) {
    console.log(`CONFLICT ${conflict.id}: ${conflict.reason}`);
  }
}

function parseArgs(argv: string[]): CliOptions {
  const options: Partial<CliOptions> = { apply: false, verbose: false };
  for (let index = 0; index < argv.length; index += 1) {
    switch (argv[index]) {
      case "--manifest":
        options.manifestPath = argv[++index];
        break;
      case "--region":
        options.region = argv[++index];
        break;
      case "--apply":
        options.apply = true;
        break;
      case "--confirm":
        options.confirm = argv[++index];
        break;
      case "--backup":
        options.backupPath = argv[++index];
        break;
      case "--verbose":
        options.verbose = true;
        break;
      case "--help":
        printUsage();
        process.exit(0);
      default:
        throw new Error(`Unknown option: ${argv[index]}`);
    }
  }
  if (!options.manifestPath) {
    printUsage();
    throw new Error("Missing --manifest");
  }
  return options as CliOptions;
}

function printUsage(): void {
  console.log([
    "Usage:",
    "  ts-node scripts/repair-dynamodb.ts --manifest PATH [--region REGION] [--verbose]",
    "  ts-node scripts/repair-dynamodb.ts --manifest PATH --apply --confirm REPAIR_ID [--backup PATH]",
    "",
    "Dry-run is the default. Apply requires both --apply and an exact repair ID confirmation.",
  ].join("\n"));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
