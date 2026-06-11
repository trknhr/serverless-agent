import { promises as fs } from "node:fs";
import path from "node:path";
import {
  ModelAttachmentImageAnalyzer,
} from "../src/attachments/attachmentImageAnalyzer";
import { ArchivedAttachmentImageReader } from "../src/attachments/attachmentImageReader";
import { SourceDocument } from "../src/documents/sourceDocument";
import { SourceDocumentRepository } from "../src/repo/sourceDocumentRepository";
import { BedrockServiceTier } from "../src/agentcore/runAgentTurn";
import { logger } from "../src/shared/logger";

type DynamicImport = <T>(specifier: string) => Promise<T>;
const dynamicImport = new Function("specifier", "return import(specifier)") as DynamicImport;

interface EvalCase {
  id: string;
  image: string;
  question: string;
  expect: Array<string | string[]>;
  forbid?: string[];
}

interface CliOptions {
  casesPath: string;
  modelId: string;
  region: string;
  serviceTier?: BedrockServiceTier;
  only?: string;
  verbose: boolean;
}

interface CaseResult {
  id: string;
  passed: boolean;
  missedFacts: string[][];
  forbiddenHits: string[];
  output: string;
  error?: string;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const casesFile = path.resolve(options.casesPath);
  const casesDir = path.dirname(casesFile);
  const cases = await loadCases(casesFile, options.only);
  if (cases.length === 0) {
    throw new Error("No eval cases matched.");
  }

  const [{ createAmazonBedrock }, { defaultProvider }, ai] = await Promise.all([
    dynamicImport<{ createAmazonBedrock: (options: unknown) => (modelId: string) => unknown }>(
      "@ai-sdk/amazon-bedrock",
    ),
    dynamicImport<{ defaultProvider: () => unknown }>("@aws-sdk/credential-provider-node"),
    dynamicImport<{ generateText: (options: unknown) => Promise<{ text: string }> }>("ai"),
  ]);

  const bedrock = createAmazonBedrock({
    region: options.region,
    credentialProvider: defaultProvider(),
  });

  const analyzer = new ModelAttachmentImageAnalyzer({
    reader: buildLocalImageReader(casesDir),
    ai,
    modelProvider: bedrock,
    modelId: options.modelId,
    bedrockServiceTier: options.serviceTier,
    log: logger.child({ component: "eval-image-analysis" }),
  });

  console.log(`Model: ${options.modelId} (region ${options.region}${options.serviceTier ? `, tier ${options.serviceTier}` : ""})`);
  console.log(`Cases: ${cases.length}\n`);

  const results: CaseResult[] = [];
  for (const evalCase of cases) {
    results.push(await runCase(analyzer, evalCase, options.verbose));
  }

  const passed = results.filter((result) => result.passed).length;
  const totalFacts = cases.reduce((sum, evalCase) => sum + evalCase.expect.length, 0);
  const missedFacts = results.reduce((sum, result) => sum + result.missedFacts.length, 0);
  console.log(`\n${passed}/${results.length} cases passed, ${totalFacts - missedFacts}/${totalFacts} facts found`);

  if (passed < results.length) {
    process.exitCode = 1;
  }
}

async function runCase(
  analyzer: ModelAttachmentImageAnalyzer,
  evalCase: EvalCase,
  verbose: boolean,
): Promise<CaseResult> {
  let output: string;
  try {
    output = await analyzer.analyzeImage({
      workspaceId: "eval",
      sourceId: evalCase.image,
      question: evalCase.question,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`FAIL ${evalCase.id}: analyzer error: ${message}`);
    const allFacts = evalCase.expect.map((fact) => (Array.isArray(fact) ? fact : [fact]));
    return { id: evalCase.id, passed: false, missedFacts: allFacts, forbiddenHits: [], output: "", error: message };
  }

  const normalizedOutput = normalize(output);
  const missedFacts: string[][] = [];
  for (const fact of evalCase.expect) {
    const variants = Array.isArray(fact) ? fact : [fact];
    if (!variants.some((variant) => normalizedOutput.includes(normalize(variant)))) {
      missedFacts.push(variants);
    }
  }
  const forbiddenHits = (evalCase.forbid ?? []).filter((value) =>
    normalizedOutput.includes(normalize(value)),
  );

  const passed = missedFacts.length === 0 && forbiddenHits.length === 0;
  console.log(`${passed ? "PASS" : "FAIL"} ${evalCase.id}`);
  for (const fact of missedFacts) {
    console.log(`  missing: ${fact.join(" | ")}`);
  }
  for (const hit of forbiddenHits) {
    console.log(`  forbidden: ${hit}`);
  }
  if (verbose || !passed) {
    console.log(`  output: ${output.replace(/\n/g, "\n          ")}`);
  }
  return { id: evalCase.id, passed, missedFacts, forbiddenHits, output };
}

function buildLocalImageReader(casesDir: string): ArchivedAttachmentImageReader {
  const repository: Pick<SourceDocumentRepository, "get"> = {
    async get(workspaceId: string, sourceId: string): Promise<SourceDocument | null> {
      const filePath = path.resolve(casesDir, sourceId);
      const now = new Date().toISOString();
      return {
        sourceId,
        workspaceId,
        sourceType: "local_file",
        sourceRef: filePath,
        title: path.basename(filePath),
        mimeType: inferMimeType(filePath),
        status: "archived",
        s3Bucket: "local",
        s3Key: filePath,
        createdAt: now,
        updatedAt: now,
      };
    },
  };
  const localS3 = {
    async send(command: { input: { Key?: string } }) {
      const bytes = await fs.readFile(command.input.Key ?? "");
      return {
        ContentLength: bytes.byteLength,
        Body: {
          async transformToByteArray(): Promise<Uint8Array> {
            return bytes;
          },
        },
      };
    },
  };
  return new ArchivedAttachmentImageReader(repository, localS3);
}

function inferMimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "image/jpeg";
  }
}

async function loadCases(casesFile: string, only?: string): Promise<EvalCase[]> {
  const raw = JSON.parse(await fs.readFile(casesFile, "utf8")) as
    | EvalCase[]
    | { cases: EvalCase[] };
  const cases = Array.isArray(raw) ? raw : raw.cases;
  if (!Array.isArray(cases)) {
    throw new Error(`Cases file must be an array or {"cases": [...]}: ${casesFile}`);
  }
  for (const evalCase of cases) {
    if (!evalCase.id || !evalCase.image || !evalCase.question || !Array.isArray(evalCase.expect)) {
      throw new Error(`Each case needs id, image, question, and expect: ${JSON.stringify(evalCase).slice(0, 120)}`);
    }
  }
  return only ? cases.filter((evalCase) => evalCase.id === only) : cases;
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    casesPath: "",
    modelId: process.env.BEDROCK_DOCUMENT_MODEL_ID?.trim() || process.env.BEDROCK_MODEL_ID?.trim() || "",
    region: process.env.BEDROCK_REGION?.trim() || process.env.AWS_REGION?.trim() || "ap-northeast-1",
    serviceTier: parseServiceTier(process.env.BEDROCK_SERVICE_TIER),
    verbose: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--cases":
        options.casesPath = argv[++index] ?? "";
        break;
      case "--model":
        options.modelId = argv[++index] ?? "";
        break;
      case "--region":
        options.region = argv[++index] ?? options.region;
        break;
      case "--tier":
        options.serviceTier = parseServiceTier(argv[++index]);
        break;
      case "--only":
        options.only = argv[++index];
        break;
      case "--verbose":
        options.verbose = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.casesPath) {
    throw new Error(
      "Usage: ts-node scripts/eval-image-analysis.ts --cases path/to/cases.json [--model id] [--region r] [--tier flex] [--only case-id] [--verbose]",
    );
  }
  if (!options.modelId) {
    throw new Error("Set --model or BEDROCK_DOCUMENT_MODEL_ID/BEDROCK_MODEL_ID.");
  }
  return options;
}

function parseServiceTier(value: string | undefined): BedrockServiceTier | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "reserved" || normalized === "priority" || normalized === "default" || normalized === "flex") {
    return normalized;
  }
  throw new Error(`Unsupported Bedrock service tier: ${value}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
