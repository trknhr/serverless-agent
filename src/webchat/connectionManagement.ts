import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ConnectionRepository } from "../repo/connectionRepository";
import { documentClient } from "../repo/documentClient";
import { DEFAULT_GOOGLE_CALENDAR_CONNECTION_ID, GoogleOAuthConnectionRepository } from "../repo/googleOAuthConnectionRepository";
import type { WebChatHttpDeps } from "./http";

/** Keep the runtime's canonical Google credentials in sync with management actions. */
export function createConnectionManagement(tableName: string): NonNullable<WebChatHttpDeps["connections"]> {
  const repository = new ConnectionRepository(tableName);
  const google = new GoogleOAuthConnectionRepository(tableName);

  async function syncRuntime(workspaceId: string, userId: string, connectionId: string): Promise<void> {
    if (connectionId !== DEFAULT_GOOGLE_CALENDAR_CONNECTION_ID) return;
    const connection = await repository.getConnection(workspaceId, userId, connectionId);
    if (connection?.defaultAccountId) {
      const account = await repository.getAccount(workspaceId, userId, connectionId, connection.defaultAccountId);
      if (account?.credentials.refreshToken) {
        await google.setDefaultAccount(workspaceId, userId, account.accountId, connectionId);
        return;
      }
    }
    await documentClient.send(new DeleteCommand({
      TableName: tableName,
      Key: { pk: `WORKSPACE#${workspaceId}#USER#${userId}`, sk: "GOOGLE_CALENDAR" },
    }));
  }

  return {
    listConnections: (workspaceId, userId) => repository.listConnections(workspaceId, userId),
    listAccounts: (workspaceId, userId, connectionId) => repository.listAccounts(workspaceId, userId, connectionId),
    saveConnection: async (input) => {
      const existing = await repository.getConnection(input.workspaceId, input.userId, input.connectionId);
      return repository.saveConnection({ ...existing, ...input, defaultAccountId: existing?.defaultAccountId });
    },
    saveAccount: async (input, makeDefault) => {
      const { workspaceId, userId, connectionId, accountId } = input;
      const connection = await repository.getConnection(workspaceId, userId, connectionId);
      if (!connection) throw new Error(`Connection not found: ${connectionId}`);
      const existing = await repository.getAccount(workspaceId, userId, connectionId, accountId);
      const account = await repository.saveAccount({
        ...existing, ...input, credentials: { ...existing?.credentials, ...input.credentials },
      });
      if (!connection.defaultAccountId || makeDefault) {
        await repository.setDefaultAccount(workspaceId, userId, connectionId, accountId);
      }
      await syncRuntime(workspaceId, userId, connectionId);
      return account;
    },
    setDefaultAccount: async (workspaceId, userId, connectionId, accountId) => {
      await repository.setDefaultAccount(workspaceId, userId, connectionId, accountId);
      await syncRuntime(workspaceId, userId, connectionId);
    },
    deleteAccount: async (workspaceId, userId, connectionId, accountId) => {
      await repository.deleteAccount(workspaceId, userId, connectionId, accountId);
      await syncRuntime(workspaceId, userId, connectionId);
    },
  };
}
