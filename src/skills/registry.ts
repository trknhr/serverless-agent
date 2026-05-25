import { builtinSkillDefinitions } from "./builtinCatalog.generated";
import {
  BuiltinSkillDefinition,
  GeneratedSkillRecord,
  SkillAdminSummary,
  SkillConstraints,
  SkillDocument,
  SkillRepository,
  SkillSummary,
  SkillStatus,
} from "./types";
import { parseSkillMarkdown } from "./skillMarkdown";

export interface ProposeSkillInput {
  skillMarkdown: string;
  triggerHints?: string[];
  toolAllowlist?: string[];
  constraints?: SkillConstraints;
  version?: string;
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
      status: "draft",
      version: input.version ?? existing?.version ?? "0.1.0",
      title: parsed.title,
      description: parsed.description,
      triggerHints: input.triggerHints ?? existing?.triggerHints ?? [],
      toolAllowlist: input.toolAllowlist ?? existing?.toolAllowlist ?? [],
      constraints: input.constraints ?? existing?.constraints ?? {},
      body: parsed.body,
      createdFromConversationId: input.createdFromConversationId ?? existing?.createdFromConversationId,
      createdByUserId: input.createdByUserId ?? existing?.createdByUserId,
      approvedByUserId: undefined,
      createdAt: existing?.createdAt,
    });
  }

  async approveSkill(workspaceId: string, skillId: string, approvedByUserId?: string): Promise<GeneratedSkillRecord> {
    return await this.updateGeneratedSkillStatus(workspaceId, skillId, "enabled", approvedByUserId);
  }

  async disableSkill(workspaceId: string, skillId: string): Promise<GeneratedSkillRecord> {
    return await this.updateGeneratedSkillStatus(workspaceId, skillId, "disabled");
  }

  private async listBuiltinOverrides(workspaceId: string): Promise<Map<string, { enabled: boolean }>> {
    const records = await this.repository?.listBuiltinSkillOverrides(workspaceId);
    return new Map((records ?? []).map((record) => [record.skillId, { enabled: record.enabled }]));
  }

  private async listGeneratedSkills(workspaceId: string): Promise<GeneratedSkillRecord[]> {
    return this.repository?.listGeneratedSkills(workspaceId) ?? [];
  }

  private async updateGeneratedSkillStatus(
    workspaceId: string,
    skillId: string,
    status: SkillStatus,
    approvedByUserId?: string,
  ): Promise<GeneratedSkillRecord> {
    const putGeneratedSkill = this.repository?.putGeneratedSkill;
    if (!putGeneratedSkill) {
      throw new Error("Generated skill storage is not configured.");
    }
    if (this.builtinsById.has(skillId)) {
      throw new Error(`Skill ${skillId} is a built-in skill. Generated skill status tools cannot change it.`);
    }

    const existing = await this.repository?.getGeneratedSkill(workspaceId, skillId);
    if (!existing) {
      throw new Error(`Generated skill was not found: ${skillId}`);
    }

    return await putGeneratedSkill.call(this.repository, {
      ...existing,
      status,
      approvedByUserId: approvedByUserId ?? existing.approvedByUserId,
    });
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
