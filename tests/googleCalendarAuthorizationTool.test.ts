import { describe, expect, it } from "vitest";
import { CustomToolExecutor } from "../src/tools/executeCustomTool";
import { customToolDefinitions } from "../src/tools/definitions";
import { Logger } from "../src/shared/logger";

function firstText(result: Awaited<ReturnType<CustomToolExecutor["execute"]>>): string {
  return result.content?.[0]?.type === "text" ? result.content[0].text : "";
}

function toolPayload(result: Awaited<ReturnType<CustomToolExecutor["execute"]>>): Record<string, unknown> {
  expect(result.isError).toBeUndefined();
  return JSON.parse(firstText(result)) as Record<string, unknown>;
}

describe("start_google_calendar_authorization tool", () => {
  it("is exposed in custom tool definitions", () => {
    const definition = customToolDefinitions.find((tool) => tool.name === "start_google_calendar_authorization");

    expect(definition).toMatchObject({
      name: "start_google_calendar_authorization",
      input_schema: {
        type: "object",
        properties: {},
      },
    });
  });

  it("describes authorization as explicit opt-in only", () => {
    const definition = customToolDefinitions.find((tool) => tool.name === "start_google_calendar_authorization");

    expect(definition?.description).toContain("Only use this when the user explicitly asks");
    expect(definition?.description).toContain("Do not use this for ordinary reminders");
  });

  it("returns an OAuth start URL for the current workspace user", async () => {
    const executor = new CustomToolExecutor(
      {
        memoryItems: {},
        tasks: {},
        taskEvents: {},
      } as never,
      {
        workspaceId: "workspace-1",
        userId: "user-1",
        channelId: "channel-1",
        logger: new Logger({ test: "google-calendar-authorization-tool" }),
      },
      {
        googleOAuthStartUrl: "https://app.example/google/oauth/start",
      },
    );

    const result = await executor.execute({
      id: "tool-google-auth",
      type: "agent.tool_use",
      name: "start_google_calendar_authorization",
      input: {},
    });

    expect(toolPayload(result)).toMatchObject({
      authorization_required: true,
      authorization_url:
        "https://app.example/google/oauth/start?workspace_id=workspace-1&user_id=user-1",
      workspace_id: "workspace-1",
      user_id: "user-1",
      channel_id: "channel-1",
    });
  });

  it("keeps authorization guidance provider-neutral", async () => {
    const executor = new CustomToolExecutor(
      {
        memoryItems: {},
        tasks: {},
        taskEvents: {},
      } as never,
      {
        workspaceId: "line:group:G1",
        userId: "line:user:U1",
        channelId: "line:group:G1",
        logger: new Logger({ test: "google-calendar-authorization-tool" }),
      },
      {
        googleOAuthStartUrl: "https://app.example/google/oauth/start",
      },
    );

    const result = await executor.execute({
      id: "tool-google-auth",
      type: "agent.tool_use",
      name: "start_google_calendar_authorization",
      input: {},
    });
    const payload = toolPayload(result);

    expect(payload).toMatchObject({
      authorization_required: true,
      authorization_url_available: true,
      authorization_url:
        "https://app.example/google/oauth/start?workspace_id=line%3Agroup%3AG1&user_id=line%3Auser%3AU1",
      workspace_id: "line:group:G1",
      user_id: "line:user:U1",
      channel_id: "line:group:G1",
      next_step: "Ask the user to open authorization_url to connect Google Calendar for this user.",
    });
    expect(String(payload.next_step)).not.toContain("LINE");
    expect(String(payload.next_step)).not.toContain("group");
    expect(String(payload.next_step)).not.toContain("1:1");
  });

  it("requires a user context", async () => {
    const executor = new CustomToolExecutor(
      {
        memoryItems: {},
        tasks: {},
        taskEvents: {},
      } as never,
      {
        workspaceId: "workspace-1",
        logger: new Logger({ test: "google-calendar-authorization-tool" }),
      },
      {
        googleOAuthStartUrl: "https://app.example/google/oauth/start",
      },
    );

    const result = await executor.execute({
      id: "tool-google-auth",
      type: "agent.tool_use",
      name: "start_google_calendar_authorization",
      input: {},
    });

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("Google Calendar authorization requires a user context");
  });
});
