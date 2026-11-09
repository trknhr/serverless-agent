import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient } from "./documentClient";
import { ConnectionRepository } from "./connectionRepository";

export const DEFAULT_GOOGLE_CALENDAR_CONNECTION_ID = "google-calendar";

export interface GoogleOAuthConnection {
  workspaceId: string;
  userId: string;
  googleSubject?: string;
  googleEmail?: string;
  refreshToken: string;
  calendarId?: string;
  timeZone?: string;
  scopes?: string[];
  connectedAt: string;
  updatedAt: string;
}

function buildPk(workspaceId: string, userId: string): string {
  return `WORKSPACE#${workspaceId}#USER#${userId}`;
}

export class GoogleOAuthConnectionRepository {
  private readonly connections: ConnectionRepository;

  constructor(private readonly tableName: string) {
    this.connections = new ConnectionRepository(tableName);
  }

  async get(workspaceId: string, userId: string): Promise<GoogleOAuthConnection | null> {
    const response = await documentClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          pk: buildPk(workspaceId, userId),
          sk: "GOOGLE_CALENDAR",
        },
      }),
    );

    return response.Item ? mapConnection(response.Item) : null;
  }

  async save(
    connection: Omit<GoogleOAuthConnection, "connectedAt" | "updatedAt"> &
      Partial<Pick<GoogleOAuthConnection, "connectedAt" | "updatedAt">>,
  ): Promise<GoogleOAuthConnection> {
    const now = new Date().toISOString();
    const existing = await this.get(connection.workspaceId, connection.userId);
    const record: GoogleOAuthConnection = {
      ...connection,
      connectedAt: existing?.connectedAt ?? connection.connectedAt ?? now,
      updatedAt: connection.updatedAt ?? now,
    };

    await documentClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: buildPk(record.workspaceId, record.userId),
          sk: "GOOGLE_CALENDAR",
          workspaceId: record.workspaceId,
          userId: record.userId,
          googleSubject: record.googleSubject,
          googleEmail: record.googleEmail,
          refreshToken: record.refreshToken,
          calendarId: record.calendarId,
          timeZone: record.timeZone,
          scopes: record.scopes,
          connectedAt: record.connectedAt,
          updatedAt: record.updatedAt,
        },
      }),
    );

    return record;
  }

  async saveAccount(
    connection: Omit<GoogleOAuthConnection, "connectedAt" | "updatedAt"> &
      Partial<Pick<GoogleOAuthConnection, "connectedAt" | "updatedAt">>,
    options: { connectionId?: string; accountId: string; displayName?: string; makeDefault?: boolean },
  ): Promise<GoogleOAuthConnection> {
    const connectionId = options.connectionId ?? DEFAULT_GOOGLE_CALENDAR_CONNECTION_ID;
    const account = await this.connections.saveAccount({
      workspaceId: connection.workspaceId,
      userId: connection.userId,
      connectionId,
      accountId: options.accountId,
      providerAccountId: connection.googleSubject,
      displayName: options.displayName ?? connection.googleEmail ?? options.accountId,
      email: connection.googleEmail,
      status: "active",
      credentials: { refreshToken: connection.refreshToken },
      settings: {
        calendarId: connection.calendarId ?? "primary",
        timeZone: connection.timeZone,
      },
      scopes: connection.scopes,
      connectedAt: connection.connectedAt,
      updatedAt: connection.updatedAt,
    });
    const existingConnection = await this.connections.getConnection(
      connection.workspaceId,
      connection.userId,
      connectionId,
    );
    const makeDefault = !existingConnection?.defaultAccountId || options.makeDefault === true;
    await this.connections.saveConnection({
      workspaceId: connection.workspaceId,
      userId: connection.userId,
      connectionId,
      provider: "google",
      capability: "calendar",
      displayName: "Google Calendar",
      defaultAccountId: makeDefault ? options.accountId : existingConnection?.defaultAccountId,
      status: "active",
    });
    const result = mapGenericAccount(account);
    // The runtime reads only the canonical connection via the legacy record.
    if (connectionId === DEFAULT_GOOGLE_CALENDAR_CONNECTION_ID &&
        (makeDefault || existingConnection?.defaultAccountId === options.accountId)) {
      await this.save(result);
    }
    return result;
  }

  async listAccounts(workspaceId: string, userId: string, connectionId = DEFAULT_GOOGLE_CALENDAR_CONNECTION_ID) {
    const connection = await this.connections.getConnection(workspaceId, userId, connectionId);
    const accounts = await this.connections.listAccounts(workspaceId, userId, connectionId);
    return accounts.map((account) => ({
      ...mapGenericAccount(account),
      accountId: account.accountId,
      connectionId,
      isDefault: account.accountId === connection?.defaultAccountId,
    }));
  }

  async setDefaultAccount(
    workspaceId: string,
    userId: string,
    accountId: string,
    connectionId = DEFAULT_GOOGLE_CALENDAR_CONNECTION_ID,
  ): Promise<GoogleOAuthConnection> {
    await this.connections.setDefaultAccount(workspaceId, userId, connectionId, accountId);
    const account = await this.connections.getAccount(workspaceId, userId, connectionId, accountId);
    if (!account) throw new Error(`Google account not found: ${accountId}`);
    const result = mapGenericAccount(account);
    if (connectionId === DEFAULT_GOOGLE_CALENDAR_CONNECTION_ID) {
      await this.save(result);
    }
    return result;
  }
}

function mapGenericAccount(account: import("./connectionRepository").ConnectionAccount): GoogleOAuthConnection {
  return {
    workspaceId: account.workspaceId,
    userId: account.userId,
    googleSubject: account.providerAccountId,
    googleEmail: account.email,
    refreshToken: account.credentials.refreshToken,
    calendarId: account.settings?.calendarId as string | undefined,
    timeZone: account.settings?.timeZone as string | undefined,
    scopes: account.scopes,
    connectedAt: account.connectedAt,
    updatedAt: account.updatedAt,
  };
}

function mapConnection(item: Record<string, unknown>): GoogleOAuthConnection {
  return {
    workspaceId: item.workspaceId as string,
    userId: item.userId as string,
    googleSubject: item.googleSubject as string | undefined,
    googleEmail: item.googleEmail as string | undefined,
    refreshToken: item.refreshToken as string,
    calendarId: item.calendarId as string | undefined,
    timeZone: item.timeZone as string | undefined,
    scopes: item.scopes as string[] | undefined,
    connectedAt: item.connectedAt as string,
    updatedAt: item.updatedAt as string,
  };
}
