import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient } from "./documentClient";

export type ConnectionStatus = "active" | "disabled";
export type ConnectionAccountStatus = "active" | "disabled";

export interface Connection {
  workspaceId: string;
  userId: string;
  connectionId: string;
  provider: string;
  capability: string;
  displayName: string;
  defaultAccountId?: string;
  status: ConnectionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionAccount {
  workspaceId: string;
  userId: string;
  connectionId: string;
  accountId: string;
  providerAccountId?: string;
  displayName: string;
  email?: string;
  status: ConnectionAccountStatus;
  credentials: Record<string, string>;
  settings?: Record<string, unknown>;
  scopes?: string[];
  connectedAt: string;
  updatedAt: string;
}

function ownerPk(workspaceId: string, userId: string): string {
  return `WORKSPACE#${workspaceId}#USER#${userId}`;
}

function connectionSk(connectionId: string): string {
  return `CONNECTION#${encodeURIComponent(connectionId)}`;
}

function accountSk(connectionId: string, accountId: string): string {
  return `${connectionSk(connectionId)}#ACCOUNT#${encodeURIComponent(accountId)}`;
}

export class ConnectionRepository {
  constructor(private readonly tableName: string) {}

  async getConnection(workspaceId: string, userId: string, connectionId: string): Promise<Connection | null> {
    const response = await documentClient.send(new GetCommand({
      ConsistentRead: true,
      TableName: this.tableName,
      Key: { pk: ownerPk(workspaceId, userId), sk: connectionSk(connectionId) },
    }));
    return response.Item ? mapConnection(response.Item) : null;
  }

  async listConnections(workspaceId: string, userId: string): Promise<Connection[]> {
    const response = await documentClient.send(new QueryCommand({
      ConsistentRead: true,
      TableName: this.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": ownerPk(workspaceId, userId), ":prefix": "CONNECTION#" },
    }));
    return (response.Items ?? [])
      .filter((item) => item.itemType === "connection")
      .map(mapConnection);
  }

  async saveConnection(input: Omit<Connection, "createdAt" | "updatedAt"> & Partial<Pick<Connection, "createdAt" | "updatedAt">>): Promise<Connection> {
    const now = new Date().toISOString();
    const existing = await this.getConnection(input.workspaceId, input.userId, input.connectionId);
    const record: Connection = {
      ...input,
      createdAt: existing?.createdAt ?? input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    };
    await documentClient.send(new PutCommand({
      TableName: this.tableName,
      Item: { pk: ownerPk(record.workspaceId, record.userId), sk: connectionSk(record.connectionId), itemType: "connection", ...record },
    }));
    return record;
  }

  async getAccount(workspaceId: string, userId: string, connectionId: string, accountId: string): Promise<ConnectionAccount | null> {
    const response = await documentClient.send(new GetCommand({
      ConsistentRead: true,
      TableName: this.tableName,
      Key: { pk: ownerPk(workspaceId, userId), sk: accountSk(connectionId, accountId) },
    }));
    return response.Item ? mapAccount(response.Item) : null;
  }

  async listAccounts(workspaceId: string, userId: string, connectionId: string): Promise<ConnectionAccount[]> {
    const response = await documentClient.send(new QueryCommand({
      ConsistentRead: true,
      TableName: this.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": ownerPk(workspaceId, userId),
        ":prefix": `${connectionSk(connectionId)}#ACCOUNT#`,
      },
    }));
    return (response.Items ?? []).map(mapAccount);
  }

  async saveAccount(input: Omit<ConnectionAccount, "connectedAt" | "updatedAt"> & Partial<Pick<ConnectionAccount, "connectedAt" | "updatedAt">>): Promise<ConnectionAccount> {
    const now = new Date().toISOString();
    const existing = await this.getAccount(input.workspaceId, input.userId, input.connectionId, input.accountId);
    const record: ConnectionAccount = {
      ...input,
      connectedAt: existing?.connectedAt ?? input.connectedAt ?? now,
      updatedAt: input.updatedAt ?? now,
    };
    await documentClient.send(new PutCommand({
      TableName: this.tableName,
      Item: { pk: ownerPk(record.workspaceId, record.userId), sk: accountSk(record.connectionId, record.accountId), itemType: "account", ...record },
    }));
    return record;
  }

  async setDefaultAccount(workspaceId: string, userId: string, connectionId: string, accountId: string): Promise<Connection> {
    const [connection, account] = await Promise.all([
      this.getConnection(workspaceId, userId, connectionId),
      this.getAccount(workspaceId, userId, connectionId, accountId),
    ]);
    if (!connection) throw new Error(`Connection not found: ${connectionId}`);
    if (!account || account.status !== "active") throw new Error(`Active connection account not found: ${accountId}`);
    return this.saveConnection({ ...connection, defaultAccountId: accountId });
  }

  async deleteAccount(workspaceId: string, userId: string, connectionId: string, accountId: string): Promise<void> {
    await documentClient.send(new DeleteCommand({
      TableName: this.tableName,
      Key: { pk: ownerPk(workspaceId, userId), sk: accountSk(connectionId, accountId) },
    }));
    const connection = await this.getConnection(workspaceId, userId, connectionId);
    if (connection?.defaultAccountId === accountId) {
      const accounts = await this.listAccounts(workspaceId, userId, connectionId);
      await this.saveConnection({
        ...connection,
        defaultAccountId: accounts.find((account) => account.status === "active")?.accountId,
      });
    }
  }
}

function mapConnection(item: Record<string, unknown>): Connection {
  return {
    workspaceId: item.workspaceId as string,
    userId: item.userId as string,
    connectionId: item.connectionId as string,
    provider: item.provider as string,
    capability: item.capability as string,
    displayName: item.displayName as string,
    defaultAccountId: item.defaultAccountId as string | undefined,
    status: item.status as ConnectionStatus,
    createdAt: item.createdAt as string,
    updatedAt: item.updatedAt as string,
  };
}

function mapAccount(item: Record<string, unknown>): ConnectionAccount {
  return {
    workspaceId: item.workspaceId as string,
    userId: item.userId as string,
    connectionId: item.connectionId as string,
    accountId: item.accountId as string,
    providerAccountId: item.providerAccountId as string | undefined,
    displayName: item.displayName as string,
    email: item.email as string | undefined,
    status: item.status as ConnectionAccountStatus,
    credentials: item.credentials as Record<string, string>,
    settings: item.settings as Record<string, unknown> | undefined,
    scopes: item.scopes as string[] | undefined,
    connectedAt: item.connectedAt as string,
    updatedAt: item.updatedAt as string,
  };
}
