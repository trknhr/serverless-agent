import { builtinSkillDefinitions } from "./builtinCatalog.generated";
import { customToolDefinitions } from "../tools/definitions";
import {
  BuiltinSkillAdminSummary,
  BuiltinSkillDefinition,
  BuiltinSkillOverride,
  GeneratedSkillRecord,
  GeneratedSkillTestCase,
  SetBuiltinSkillEnabledResult,
  SkillAdminSummary,
  SkillConstraints,
  SkillDocument,
  SkillRepository,
  SkillSummary,
  SkillStatus,
} from "./types";
import { parseSkillMarkdown } from "./skillMarkdown";

const defaultKnownToolNames = new Set(customToolDefinitions.map((tool) => tool.name));

export interface ProposeSkillInput {
  skillMarkdown: string;
  triggerHints?: string[];
  toolAllowlist?: string[];
  constraints?: SkillConstraints;
  version?: string;
  evaluationNotes?: string;
  testCases?: GeneratedSkillTestCase[];
  createdFromConversationId?: string;
  createdByUserId?: string;
}

export interface ListSkillsInput {
  source?: "builtin" | "generated" | "all";
  statuses?: SkillStatus[];
}

export class SkillRegistry {
  private readonly builtinsById: Map<string, BuiltinSkillDefinition>;

  constructor(
    private readonly repository?: SkillRepository,
    builtins: BuiltinSkillDefinition[] = builtinSkillDefinitions,
    private readonly knownToolNames: ReadonlySet<string> = defaultKnownToolNames,
  ) {
    this.builtinsById = new Map(builtins.map((skill) => [skill.skillId, skill]));
  }

  async listEnabledSummaries(workspaceId: string): Promise<SkillSummary[]> {
    const overrides = await this.listBuiltinOverrides(workspaceId);
    const builtinSummaries = [...this.builtinsById.values()]
      .filter((skill) => overrides.get(skill.skillId)?.enabled ?? skill.defaultEnabled)
      .map(toBuiltinSummary);
    const generated = await this.listGeneratedSkills(workspaceId);
    const generatedSummaries = generated
      .filter((skill) => skill.status === "enabled" && !this.builtinsById.has(skill.skillId))
      .map(toGeneratedSummary);

    return [...builtinSummaries, ...generatedSummaries].sort((a, b) => a.skillId.localeCompare(b.skillId));
  }

  async loadSkill(workspaceId: string, skillId: string): Promise<SkillDocument | null> {
    const builtin = this.builtinsById.get(skillId);
    if (builtin) {
      const override = await this.repository?.getBuiltinSkillOverride(workspaceId, skillId);
      const enabled = override?.enabled ?? builtin.defaultEnabled;
      return enabled ? toBuiltinDocument(builtin) : null;
    }

    const generated = await this.repository?.getGeneratedSkill(workspaceId, skillId);
    if (!generated || generated.status !== "enabled") {
      return null;
    }

    return toGeneratedDocument(generated);
  }

  async listSkills(workspaceId: string, input: ListSkillsInput = {}): Promise<SkillAdminSummary[]> {
    const source = input.source ?? "all";
    const statusFilter = input.statuses ? new Set(input.statuses) : undefined;
    const skills: SkillAdminSummary[] = [];

    if (source === "all" || source === "builtin") {
      const overrides = await this.listBuiltinOverrides(workspaceId);
      for (const builtin of this.builtinsById.values()) {
        const enabled = overrides.get(builtin.skillId)?.enabled ?? builtin.defaultEnabled;
        const status = enabled ? "enabled" : "disabled";
        if (!statusFilter || statusFilter.has(status)) {
          skills.push({
            ...toBuiltinSummary(builtin),
            status,
            enabled,
          });
        }
      }
    }

    if (source === "all" || source === "generated") {
      const generated = await this.listGeneratedSkills(workspaceId);
      for (const skill of generated) {
        if (!statusFilter || statusFilter.has(skill.status)) {
          skills.push({
            ...toGeneratedSummary(skill),
            status: skill.status,
            enabled: skill.status === "enabled",
          });
        }
      }
    }

    return skills.sort((a, b) => a.skillId.localeCompare(b.skillId));
  }

  async listBuiltinSkillAdminSummaries(workspaceId: string): Promise<BuiltinSkillAdminSummary[]> {
    const overrides = await this.listBuiltinOverrides(workspaceId);
    return [...this.builtinsById.values()]
      .map((builtin) => toBuiltinAdminSummary(builtin, overrides.get(builtin.skillId)))
      .sort((a, b) => a.skillId.localeCompare(b.skillId));
  }

  async setBuiltinSkillEnabled(
    workspaceId: string,
    skillId: string,
    enabled: boolean,
    actorUserId?: string,
  ): Promise<SetBuiltinSkillEnabledResult> {
    const putBuiltinSkillOverride = this.repository?.putBuiltinSkillOverride;
    if (!putBuiltinSkillOverride) {
      throw new Error("Built-in skill override storage is not configured.");
    }

    const builtin = this.builtinsById.get(skillId);
    if (!builtin) {
      throw new Error(`Built-in skill was not found: ${skillId}`);
    }

    const existing = await this.repository?.getBuiltinSkillOverride(workspaceId, skillId);
    const previousEnabled = existing?.enabled ?? builtin.defaultEnabled;
    const override = await putBuiltinSkillOverride.call(this.repository, {
      workspaceId,
      skillId,
      enabled,
      version: builtin.version,
      updatedByUserId: actorUserId,
      previousEnabled,
    });

    return {
      skill: toBuiltinAdminSummary(builtin, override),
      audit: {
        actorUserId,
        previousEnabled,
        nextEnabled: enabled,
        updatedAt: override.updatedAt,
      },
    };
  }

  async proposeSkill(workspaceId: string, input: ProposeSkillInput): Promise<GeneratedSkillRecord> {
    const putGeneratedSkill = this.repository?.putGeneratedSkill;
    if (!putGeneratedSkill) {
      throw new Error("Generated skill storage is not configured.");
    }

    const parsed = parseSkillMarkdown(input.skillMarkdown);
    if (this.builtinsById.has(parsed.skillId)) {
      throw new Error(`Skill ${parsed.skillId} is a built-in skill and cannot be replaced by a generated skill.`);
    }

    const existing = await this.repository?.getGeneratedSkill(workspaceId, parsed.skillId);
    if (existing?.status === "enabled") {
      throw new Error(`Generated skill ${parsed.skillId} is already enabled. Disable it before replacing the draft.`);
    }
    return await putGeneratedSkill.call(this.repository, {
      workspaceId,
      skillId: parsed.skillId,
      status: "proposed",
      version: input.version ?? existing?.version ?? "0.1.0",
      title: parsed.title,
      description: parsed.description,
      triggerHints: input.triggerHints ?? existing?.triggerHints ?? [],
      toolAllowlist: input.toolAllowlist ?? existing?.toolAllowlist ?? [],
      constraints: input.constraints ?? existing?.constraints ?? {},
      body: parsed.body,
      evaluationNotes: input.evaluationNotes ?? existing?.evaluationNotes,
      testCases: input.testCases ?? existing?.testCases ?? [],
      createdFromConversationId: input.createdFromConversationId ?? existing?.createdFromConversationId,
      createdByUserId: input.createdByUserId ?? existing?.createdByUserId,
      approvedByUserId: undefined,
      createdAt: existing?.createdAt,
    });
  }

  async approveSkill(workspaceId: string, skillId: string, approvedByUserId?: string): Promise<GeneratedSkillRecord> {
    const existing = await this.getGeneratedSkillForUpdate(workspaceId, skillId);
    this.validateGeneratedSkillForApproval(existing);
    return await this.putGeneratedSkillStatus(existing, "approved", approvedByUserId);
  }

  async enableSkill(workspaceId: string, skillId: string): Promise<GeneratedSkillRecord> {
    const existing = await this.getGeneratedSkillForUpdate(workspaceId, skillId);
    if (existing.status !== "approved" && existing.status !== "disabled") {
      throw new Error(`Generated skill ${skillId} must be approved or disabled before it can be enabled.`);
    }
    return await this.putGeneratedSkillStatus(existing, "enabled");
  }

  async disableSkill(workspaceId: string, skillId: string): Promise<GeneratedSkillRecord> {
    const existing = await this.getGeneratedSkillForUpdate(workspaceId, skillId);
    return await this.putGeneratedSkillStatus(existing, "disabled");
  }

  async rejectSkill(workspaceId: string, skillId: string): Promise<GeneratedSkillRecord> {
    const existing = await this.getGeneratedSkillForUpdate(workspaceId, skillId);
    if (existing.status !== "proposed") {
      throw new Error(`Generated skill ${skillId} must be proposed before it can be rejected.`);
    }
    return await this.putGeneratedSkillStatus(existing, "rejected");
  }

  async archiveSkill(workspaceId: string, skillId: string): Promise<GeneratedSkillRecord> {
    const existing = await this.getGeneratedSkillForUpdate(workspaceId, skillId);
    if (existing.status === "enabled") {
      throw new Error(`Generated skill ${skillId} must be disabled before it can be archived.`);
    }
    return await this.putGeneratedSkillStatus(existing, "archived");
  }

  private async listBuiltinOverrides(workspaceId: string): Promise<Map<string, BuiltinSkillOverride>> {
    const records = await this.repository?.listBuiltinSkillOverrides(workspaceId);
    return new Map((records ?? []).map((record) => [record.skillId, record]));
  }

  private async listGeneratedSkills(workspaceId: string): Promise<GeneratedSkillRecord[]> {
    return this.repository?.listGeneratedSkills(workspaceId) ?? [];
  }

  private async getGeneratedSkillForUpdate(workspaceId: string, skillId: string): Promise<GeneratedSkillRecord> {
    if (this.builtinsById.has(skillId)) {
      throw new Error(`Skill ${skillId} is a built-in skill. Generated skill status tools cannot change it.`);
    }

    const existing = await this.repository?.getGeneratedSkill(workspaceId, skillId);
    if (!existing) {
      throw new Error(`Generated skill was not found: ${skillId}`);
    }
    return existing;
  }

  private async putGeneratedSkillStatus(
    existing: GeneratedSkillRecord,
    status: SkillStatus,
    approvedByUserId?: string,
  ): Promise<GeneratedSkillRecord> {
    const putGeneratedSkill = this.repository?.putGeneratedSkill;
    if (!putGeneratedSkill) {
      throw new Error("Generated skill storage is not configured.");
    }

    return await putGeneratedSkill.call(this.repository, {
      ...existing,
      status,
      approvedByUserId: approvedByUserId ?? existing.approvedByUserId,
    });
  }

  private validateGeneratedSkillForApproval(skill: GeneratedSkillRecord): void {
    const unknownTools = skill.toolAllowlist.filter((toolName) => !this.knownToolNames.has(toolName));
    if (unknownTools.length > 0) {
      throw new Error(`Generated skill ${skill.skillId} references unknown tools: ${unknownTools.join(", ")}`);
    }
    if (skill.testCases.length === 0) {
      throw new Error(`Generated skill ${skill.skillId} requires at least one test case before approval.`);
    }
  }
}

export function formatSkillSummariesForPrompt(summaries: SkillSummary[]): string {
  if (summaries.length === 0) {
    return "";
  }

  return [
    "Available skills are listed below. They are lightweight summaries only.",
    "When a skill is relevant, call load_skill with its skill_id before following its workflow.",
    "Only load skill IDs from this list.",
    ...summaries.map((skill) => {
      const hints = skill.triggerHints.length > 0 ? ` Triggers: ${skill.triggerHints.join(", ")}.` : "";
      const tools = skill.toolAllowlist.length > 0 ? ` Tools: ${skill.toolAllowlist.join(", ")}.` : "";
      return `- ${skill.skillId}: ${skill.title}. ${skill.description}${hints}${tools}`;
    }),
  ].join("\n");
}

function toBuiltinSummary(skill: BuiltinSkillDefinition): SkillSummary {
  return {
    skillId: skill.skillId,
    source: "builtin",
    version: skill.version,
    title: skill.title,
    description: skill.description,
    triggerHints: skill.triggerHints,
    toolAllowlist: skill.toolAllowlist,
    constraints: skill.constraints,
  };
}

function toBuiltinDocument(skill: BuiltinSkillDefinition): SkillDocument {
  return {
    ...toBuiltinSummary(skill),
    body: skill.body,
  };
}

function toBuiltinAdminSummary(
  skill: BuiltinSkillDefinition,
  override?: BuiltinSkillOverride,
): BuiltinSkillAdminSummary {
  const enabled = override?.enabled ?? skill.defaultEnabled;
  return {
    ...toBuiltinSummary(skill),
    source: "builtin",
    defaultEnabled: skill.defaultEnabled,
    status: enabled ? "enabled" : "disabled",
    enabled,
    audit: override
      ? {
          updatedAt: override.updatedAt,
          updatedByUserId: override.updatedByUserId,
          previousEnabled: override.previousEnabled,
        }
      : undefined,
  };
}

function toGeneratedSummary(skill: GeneratedSkillRecord): SkillSummary {
  return {
    skillId: skill.skillId,
    source: "generated",
    version: skill.version,
    title: skill.title,
    description: skill.description,
    triggerHints: skill.triggerHints,
    toolAllowlist: skill.toolAllowlist,
    constraints: skill.constraints,
  };
}

function toGeneratedDocument(skill: GeneratedSkillRecord): SkillDocument {
  return {
    ...toGeneratedSummary(skill),
    body: skill.body,
  };
}
