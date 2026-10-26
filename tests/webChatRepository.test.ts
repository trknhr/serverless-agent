import { afterEach, describe, expect, it, vi } from "vitest";
import { WebChatRepository } from "../src/repo/webChatRepository";

const { sendMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
}));

vi.mock("../src/repo/documentClient", () => ({
  documentClient: {
    send: sendMock,
  },
}));

afterEach(() => {
  sendMock.mockReset();
});

function commandInput(callIndex = 0): Record<string, unknown> {
  return sendMock.mock.calls[callIndex][0].input;
}

describe("WebChatRepository", () => {
  const repository = new WebChatRepository("conversations", "messages");

  it("lists conversations from the updated-at index", async () => {
    sendMock.mockResolvedValueOnce({
      Items: [
        {
          conversationId: "conv_1",
          workspaceId: "w",
          userId: "u",
          title: "Hello",
          createdAt: "2026-10-26T00:00:00.000Z",
          updatedAt: "2026-10-26T00:01:00.000Z",
          preview: "Hello",
        },
      ],
    });

    await expect(repository.listConversations({ workspaceId: "w", userId: "u", limit: 10 })).resolves.toEqual([
      expect.objectContaining({ conversationId: "conv_1", title: "Hello", preview: "Hello" }),
    ]);
    expect(commandInput()).toMatchObject({
      TableName: "conversations",
      IndexName: "UpdatedIndex",
      ScanIndexForward: false,
      Limit: 10,
      ExpressionAttributeValues: { ":ownerKey": "OWNER#w#u" },
    });
  });

  it("caps an oversized list limit and defaults a missing title", async () => {
    sendMock.mockResolvedValueOnce({ Items: [{ conversationId: "conv_1", workspaceId: "w", userId: "u", createdAt: "t", updatedAt: "t" }] });
    await repository.listConversations({ workspaceId: "w", userId: "u", limit: 500 });
    expect(commandInput().Limit).toBe(50);
    sendMock.mockResolvedValueOnce({});
    await repository.listConversations({ workspaceId: "w", userId: "u", limit: 0 });
    expect(commandInput(1).Limit).toBe(50);
  });

  it("creates a conversation owned by the workspace user", async () => {
    sendMock.mockResolvedValueOnce({});
    const conversation = await repository.createConversation({
      workspaceId: "w",
      userId: "u",
      now: new Date("2026-10-26T00:00:00.000Z"),
    });
    expect(conversation.conversationId).toMatch(/^conv_/);
    expect(conversation.title).toBe("New chat");
    expect(commandInput()).toMatchObject({
      TableName: "conversations",
      Item: {
        pk: "OWNER#w#u",
        sk: conversation.conversationId,
        ownerKey: "OWNER#w#u",
        title: "New chat",
      },
    });
  });

  it("loads a conversation only for its owner", async () => {
    sendMock.mockResolvedValueOnce({
      Item: {
        conversationId: "conv_1",
        workspaceId: "other",
        userId: "u",
        title: "Hello",
        createdAt: "t",
        updatedAt: "t",
        runtimeSessionId: "sess",
      },
    });
    await expect(repository.getConversation({ workspaceId: "w", userId: "u", conversationId: "conv_1" })).resolves.toBeNull();

    sendMock.mockResolvedValueOnce({});
    await expect(repository.getConversation({ workspaceId: "w", userId: "u", conversationId: "missing" })).resolves.toBeNull();

    sendMock.mockResolvedValueOnce({
      Item: {
        conversationId: "conv_1",
        workspaceId: "w",
        userId: "u",
        createdAt: "t",
        updatedAt: "t",
      },
    });
    await expect(repository.getConversation({ workspaceId: "w", userId: "u", conversationId: "conv_1" })).resolves.toMatchObject({
      title: "New chat",
      runtimeSessionId: undefined,
    });
  });

  it("updates only the conversation fields that changed", async () => {
    sendMock.mockResolvedValueOnce({});
    await repository.updateConversation({
      workspaceId: "w",
      userId: "u",
      conversationId: "conv_1",
      updatedAt: "2026-10-26T00:02:00.000Z",
      title: "Hello",
      preview: "Hi",
      runtimeSessionId: "sess",
    });
    expect(commandInput()).toMatchObject({
      Key: { pk: "OWNER#w#u", sk: "conv_1" },
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: {
        ":updatedAt": "2026-10-26T00:02:00.000Z",
        ":title": "Hello",
        ":preview": "Hi",
        ":runtimeSessionId": "sess",
      },
    });

    sendMock.mockResolvedValueOnce({});
    await repository.updateConversation({
      workspaceId: "w",
      userId: "u",
      conversationId: "conv_1",
      updatedAt: "2026-10-26T00:03:00.000Z",
    });
    expect(commandInput(1).UpdateExpression).toBe("SET #updatedAt = :updatedAt");
  });

  it("returns an empty page when DynamoDB omits items and fills missing message text", async () => {
    sendMock.mockResolvedValueOnce({});
    await expect(repository.listMessages({ conversationId: "conv_1" })).resolves.toEqual([]);

    sendMock.mockResolvedValueOnce({
      Items: [{ messageId: "msg_a", conversationId: "conv_1", role: "user", createdAt: "t" }],
    });
    await expect(repository.listMessages({ conversationId: "conv_1", limit: Number.POSITIVE_INFINITY })).resolves.toEqual([
      expect.objectContaining({ messageId: "msg_a", role: "user", text: "" }),
    ]);
    expect(commandInput(1).Limit).toBe(200);
  });

  it("rejects a conversation whose user does not match", async () => {
    sendMock.mockResolvedValueOnce({
      Item: {
        conversationId: "conv_1",
        workspaceId: "w",
        userId: "someone-else",
        title: "Hello",
        createdAt: "t",
        updatedAt: "t",
      },
    });
    await expect(repository.getConversation({ workspaceId: "w", userId: "u", conversationId: "conv_1" })).resolves.toBeNull();
  });

  it("returns messages in chronological order and stores a new one", async () => {
    sendMock.mockResolvedValueOnce({
      Items: [
        { messageId: "msg_b", conversationId: "conv_1", role: "assistant", text: "Hi", createdAt: "2026-10-26T00:00:02.000Z" },
        { messageId: "msg_a", conversationId: "conv_1", role: "other", text: "Hey", createdAt: "2026-10-26T00:00:01.000Z" },
      ],
    });
    await expect(repository.listMessages({ conversationId: "conv_1", limit: 20 })).resolves.toEqual([
      expect.objectContaining({ messageId: "msg_a", role: "user", text: "Hey" }),
      expect.objectContaining({ messageId: "msg_b", role: "assistant", text: "Hi" }),
    ]);
    expect(commandInput()).toMatchObject({
      TableName: "messages",
      ScanIndexForward: false,
      Limit: 20,
    });

    sendMock.mockResolvedValueOnce({});
    const message = await repository.appendMessage({
      conversationId: "conv_1",
      role: "user",
      text: "Next",
      now: new Date("2026-10-26T00:00:03.000Z"),
    });
    expect(message.messageId).toMatch(/^msg_/);
    expect(commandInput(1)).toMatchObject({
      TableName: "messages",
      Item: {
        pk: "conv_1",
        text: "Next",
        role: "user",
      },
    });
  });
});
