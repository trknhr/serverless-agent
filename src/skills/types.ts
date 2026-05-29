import { z } from "zod";

export const skillStatusSchema = z.enum(["proposed", "approved", "enabled", "disabled", "rejected", "archived"]);
export const storedSkillStatusSchema = z
  .union([skillStatusSchema, z.literal("draft")])
  .transform((status) => (status === "draft" ? "proposed" : status));
export const skillSourceSchema = z.enum(["builtin", "generated"]);

export const generatedSkillTestCaseSchema = z.object({
  name: z.string().min(1),
  prompt: z.string().min(1),
  expectedBehavior: z.string().min(1),
});

export const skillConstraintsSchema = z
  .object({
    maxToolCalls: z.number().int().positive().optional(),
    requiresConfirmation: z.boolean().optional(),
  })
  .catchall(z.unknown());

export type SkillStatus = z.infer<typeof skillStatusSchema>;
export type SkillSource = z.infer<typeof skillSourceSchema>;
export type SkillConstraints = z.infer<typeof skillConstraintsSchema>;
export type GeneratedSkillTestCase = z.infer<typeof generatedSkillTestCaseSchema>;

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

export interface BuiltinSkillAdminSummary extends SkillAdminSummary {
  source: "builtin";
  defaultEnabled: boolean;
  audit?: {
    updatedAt?: string;
    updatedByUserId?: string;
    previousEnabled?: boolean;
  };
}

export interface BuiltinSkillEnablementAudit {
  actorUserId?: string;
  previousEnabled: boolean;
  nextEnabled: boolean;
  updatedAt: string;
}

export interface SetBuiltinSkillEnabledResult {
  skill: BuiltinSkillAdminSummary;
  audit: BuiltinSkillEnablementAudit;
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
  evaluationNotes?: string;
  testCases: GeneratedSkillTestCase[];
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
  updatedByUserId?: string;
  previousEnabled?: boolean;
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
