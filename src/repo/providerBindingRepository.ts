import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient } from "./documentClient";

export type ProviderName = "slack" | "line" | "discord";
export type ProviderBindingStatus = "active" | "disabled";
export type ProviderBindingKind = "installation" | "conversation";
export type ProviderWorkspaceResolutionMode = "fallback" | "bound_only";

export interface ProviderBinding {
  provider: ProviderName;
  providerAccountId: string;
  bindingKind: ProviderBindingKind;
  providerConversationKey?: string;
  workspaceId: string;
  conversationId?: string;
  status: ProviderBindingStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ResolveWorkspaceInput {
  provider: ProviderName;
  providerAccountId: string;
  providerConversationKey: string;
  fallbackWorkspaceId: string;
  resolutionMode?: ProviderWorkspaceResolutionMode;
}

export interface ResolvedWorkspace {
  workspaceId: string;
  source: "conversation_binding" | "installation_binding" | "fallback";
}

function buildProviderPk(provider: ProviderName, providerAccountId: string): string {
  return `PROVIDER#${provider}#ACCOUNT#${providerAccountId}`;
}

function buildInstallationSk(): string {
  return "INSTALLATION";
}

function buildConversationSk(providerConversationKey: string): string {
  return `CONVERSATION#${providerConversationKey}`;
}

export class ProviderBindingRepository {
  constructor(private readonly tableName: string) {}

  async save(binding: Omit<ProviderBinding, "createdAt" | "updatedAt"> & {
    createdAt?: string;
    updatedAt?: string;
  }): Promise<ProviderBinding> {
    const now = new Date().toISOString();
    const record: ProviderBinding = {
      ...binding,
      createdAt: binding.createdAt ?? now,
      updatedAt: binding.updatedAt ?? now,
    };

    await documentClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: buildProviderPk(record.provider, record.providerAccountId),
          sk:
            record.bindingKind === "installation"
              ? buildInstallationSk()
              : buildConversationSk(requireConversationKey(record)),
          provider: record.provider,
          providerAccountId: record.providerAccountId,
          bindingKind: record.bindingKind,
          providerConversationKey: record.providerConversationKey,
          workspaceId: record.workspaceId,
          conversationId: record.conversationId,
          status: record.status,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        },
      }),
    );

    return record;
  }

  async resolveWorkspace(input: ResolveWorkspaceInput): Promise<ResolvedWorkspace | null> {
    const conversationBinding = await this.findConversationBinding(
      input.provider,
      input.providerAccountId,
      input.providerConversationKey,
    );
    if (conversationBinding) {
      return activeResolution(conversationBinding, "conversation_binding");
    }

    const installationBinding = await this.findInstallationBinding(input.provider, input.providerAccountId);
    if (installationBinding) {
      return activeResolution(installationBinding, "installation_binding");
    }

    if ((input.resolutionMode ?? "fallback") === "bound_only") {
      return null;
    }

    return {
      workspaceId: input.fallbackWorkspaceId,
      source: "fallback",
    };
  }

  async findInstallationBinding(
    provider: ProviderName,
    providerAccountId: string,
  ): Promise<ProviderBinding | null> {
    return this.get(provider, providerAccountId, buildInstallationSk());
  }

  async findConversationBinding(
    provider: ProviderName,
    providerAccountId: string,
    providerConversationKey: string,
  ): Promise<ProviderBinding | null> {
    return this.get(provider, providerAccountId, buildConversationSk(providerConversationKey));
  }

  private async get(
    provider: ProviderName,
    providerAccountId: string,
    sk: string,
  ): Promise<ProviderBinding | null> {
    const response = await documentClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          pk: buildProviderPk(provider, providerAccountId),
          sk,
        },
      }),
    );

    return response.Item ? mapProviderBinding(response.Item) : null;
  }
}

function activeResolution(
  binding: ProviderBinding,
  source: Exclude<ResolvedWorkspace["source"], "fallback">,
): ResolvedWorkspace | null {
  if (binding.status !== "active") {
    return null;
  }

  return {
    workspaceId: binding.workspaceId,
    source,
  };
}

function requireConversationKey(binding: ProviderBinding): string {
  if (!binding.providerConversationKey) {
    throw new Error("Conversation provider binding requires providerConversationKey.");
  }

  return binding.providerConversationKey;
}

function mapProviderBinding(item: Record<string, unknown>): ProviderBinding {
  return {
    provider: item.provider as ProviderName,
    providerAccountId: item.providerAccountId as string,
    bindingKind: item.bindingKind as ProviderBindingKind,
    providerConversationKey: item.providerConversationKey as string | undefined,
    workspaceId: item.workspaceId as string,
    conversationId: item.conversationId as string | undefined,
    status: item.status as ProviderBindingStatus,
    createdAt: item.createdAt as string,
    updatedAt: item.updatedAt as string,
  };
}
