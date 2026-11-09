import { beforeEach, expect, it, vi } from "vitest";
import { createConnectionManagement } from "../src/webchat/connectionManagement";
import { GoogleOAuthConnectionRepository } from "../src/repo/googleOAuthConnectionRepository";

const { records } = vi.hoisted(() => ({ records: new Map<string, Record<string, unknown>>() }));
vi.mock("../src/repo/documentClient", () => ({
  documentClient: {
    async send(command: { constructor: { name: string }; input: any }) {
      const input = command.input;
      const key = (item: any) => `${item.pk}|${item.sk}`;
      switch (command.constructor.name) {
        case "GetCommand": return { Item: structuredClone(records.get(key(input.Key))) };
        case "PutCommand": records.set(key(input.Item), structuredClone(input.Item)); return {};
        case "DeleteCommand": records.delete(key(input.Key)); return {};
        case "QueryCommand": return { Items: [...records.values()].filter((item) =>
          item.pk === input.ExpressionAttributeValues[":pk"] &&
          String(item.sk).startsWith(input.ExpressionAttributeValues[":prefix"]),
        ).map((item) => structuredClone(item)) };
        default: throw new Error("Unexpected command");
      }
    },
  },
}));
beforeEach(() => records.clear());

it("keeps runtime credentials synchronized through reauthorization, default changes, and removal", async () => {
  const google = new GoogleOAuthConnectionRepository("connections");
  const management = createConnectionManagement("connections");
  const owner = { workspaceId: "w", userId: "u" };
  await google.saveAccount({ ...owner, refreshToken: "old" }, { accountId: "work" });
  await google.saveAccount({ ...owner, refreshToken: "renewed" }, { accountId: "work" });
  expect((await google.get("w", "u"))?.refreshToken).toBe("renewed");
  await google.saveAccount({ ...owner, refreshToken: "personal-token" }, { accountId: "personal" });
  await google.saveAccount({ ...owner, refreshToken: "named-token" }, { connectionId: "other", accountId: "other" });
  expect((await google.get("w", "u"))?.refreshToken).toBe("renewed");
  await management.setDefaultAccount("w", "u", "google-calendar", "personal");
  expect((await google.get("w", "u"))?.refreshToken).toBe("personal-token");
  await management.deleteAccount("w", "u", "google-calendar", "personal");
  expect((await google.get("w", "u"))?.refreshToken).toBe("renewed");
  await management.deleteAccount("w", "u", "google-calendar", "work");
  expect(await google.get("w", "u")).toBeNull();
  expect((await management.listAccounts("w", "u", "other"))).toHaveLength(1);
});

it("preserves an authorized account's credentials when its metadata is saved", async () => {
  const google = new GoogleOAuthConnectionRepository("connections");
  const management = createConnectionManagement("connections");
  const owner = { workspaceId: "w", userId: "u" };
  await google.saveAccount({ ...owner, refreshToken: "token" }, { accountId: "work" });
  await management.saveConnection({ ...owner, connectionId: "google-calendar", provider: "google", capability: "calendar", displayName: "Calendar", status: "active" });
  await management.saveAccount({ ...owner, connectionId: "google-calendar", accountId: "work", displayName: "Work", status: "active", credentials: {} });
  expect((await google.get("w", "u"))?.refreshToken).toBe("token");
  expect((await management.listConnections("w", "u"))[0].defaultAccountId).toBe("work");
});

it("supports first-account defaults and rejects orphan accounts", async () => {
  const management = createConnectionManagement("connections");
  const input = { workspaceId: "w", userId: "u", connectionId: "github", accountId: "work", displayName: "Work", status: "active" as const, credentials: {} };
  await expect(management.saveAccount(input)).rejects.toThrow("Connection not found");
  await management.saveConnection({ workspaceId: "w", userId: "u", connectionId: "github", displayName: "GitHub", provider: "github", capability: "code", status: "active" });
  await management.saveAccount(input);
  await management.saveAccount({ ...input, accountId: "personal" }, true);
  expect((await management.listConnections("w", "u"))[0].defaultAccountId).toBe("personal");
});
