import { z } from "zod";

export const skillStatusSchema = z.enum(["draft", "approved", "enabled", "disabled"]);
export const skillSourceSchema = z.enum(["builtin", "generated"]);

export const skillConstraintsSchema = z
  .object({
    maxToolCalls: z.number().int().positive().optional(),
    requiresConfirmation: z.boolean().optional(),
  })
  .catchall(z.unknown());

export type SkillStatus = z.infer<typeof skillStatusSchema>;
export type SkillSource = z.infer<typeof skillSourceSchema>;
export type SkillConstraints = z.infer<typeof skillConstraintsSchema>;

export interface SkillSummary {
  skillId: string;
  source: SkillSource;
  version: string;
  title: string;
  description: string;
  triggerHints: string[];
  toolAllowlist: string[];
  constraints: SkillConstraints;
}

export interface SkillAdminSummary extends SkillSummary {
  status: SkillStatus | "enabled" | "disabled";
  enabled: boolean;
}

export interface SkillDocument extends SkillSummary {
  body: string;
}

export interface BuiltinSkillDefinition {
  skillId: string;
  version: string;
  title: string;
  description: string;
  defaultEnabled: boolean;
  triggerHints: string[];
  toolAllowlist: string[];
  constraints: SkillConstraints;
  body: string;
}

export interface GeneratedSkillRecord {
  workspaceId: string;
  skillId: string;
  status: SkillStatus;
  version: string;
  title: string;
  description: string;
  triggerHints: string[];
  toolAllowlist: string[];
  constraints: SkillConstraints;
  body: string;
  createdFromConversationId?: string;
  createdByUserId?: string;
  approvedByUserId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BuiltinSkillOverride {
  workspaceId: string;
  skillId: string;
  enabled: boolean;
  version?: string;
  config?: Record<string, unknown>;
  updatedAt: string;
}

export interface SkillRepository {
  listGeneratedSkills(workspaceId: string): Promise<GeneratedSkillRecord[]>;
  getGeneratedSkill(workspaceId: string, skillId: string): Promise<GeneratedSkillRecord | null>;
  putGeneratedSkill?(
    record: Omit<GeneratedSkillRecord, "createdAt" | "updatedAt"> & {
      createdAt?: string;
      updatedAt?: string;
    },
  ): Promise<GeneratedSkillRecord>;
  listBuiltinSkillOverrides(workspaceId: string): Promise<BuiltinSkillOverride[]>;
  getBuiltinSkillOverride(workspaceId: string, skillId: string): Promise<BuiltinSkillOverride | null>;
  putBuiltinSkillOverride?(
    record: Omit<BuiltinSkillOverride, "updatedAt"> & { updatedAt?: string },
  ): Promise<BuiltinSkillOverride>;
}
