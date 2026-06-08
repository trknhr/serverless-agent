import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleCalendarClient } from "../src/calendar/googleCalendarClient";
import {
  GoogleCalendarAuthorizationRequiredError,
  createUserGoogleCalendarClient,
} from "../src/calendar/userGoogleCalendar";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function okJson(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("GoogleCalendarClient", () => {
  it("uses credentials, caches access tokens, and calls calendar endpoints", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T00:00:00Z"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ access_token: "access", expires_in: 3600 }))
      .mockResolvedValueOnce(okJson({ items: [{ id: "event1", status: "confirmed" }] }))
      .mockResolvedValueOnce(okJson({ items: [{ id: "primary" }], nextPageToken: "next" }))
      .mockResolvedValueOnce(okJson({ items: [{ id: "team" }] }))
      .mockResolvedValueOnce(okJson({ id: "created" }))
      .mockResolvedValueOnce(okJson({ id: "patched" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        okJson({
          timeMin: "2026-05-14T00:00:00Z",
          timeMax: "2026-05-15T00:00:00Z",
          calendars: {
            primary: {
              busy: [{ start: "2026-05-14T01:00:00Z", end: "2026-05-14T02:00:00Z" }],
            },
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const credentialsProvider = vi.fn().mockResolvedValue({
      clientId: "cid",
      clientSecret: "secret",
      refreshToken: "refresh",
      calendarId: "primary",
      timeZone: "Asia/Tokyo",
    });
    const client = new GoogleCalendarClient({
      credentialsProvider,
      defaultTimeZone: "UTC",
    });

    await expect(
      client.listEvents({
        query: "planning",
        maxResults: 100,
        timeMin: "2026-05-14T00:00:00Z",
        timeMax: "2026-05-15T00:00:00Z",
        privateProperties: { slackTaskId: "task1" },
      }),
    ).resolves.toEqual({
      calendarId: "primary",
      timeZone: "Asia/Tokyo",
      events: [{ id: "event1", status: "confirmed" }],
    });

    const eventUrl = new URL(fetchMock.mock.calls[1][0]);
    expect(eventUrl.pathname).toBe("/calendar/v3/calendars/primary/events");
    expect(eventUrl.searchParams.get("maxResults")).toBe("50");
    expect(eventUrl.searchParams.get("q")).toBe("planning");
    expect(eventUrl.searchParams.getAll("privateExtendedProperty")).toEqual(["slackTaskId=task1"]);

    await expect(client.listCalendars({ minAccessRole: "writer", maxResults: 500 })).resolves.toEqual({
      calendars: [{ id: "primary" }, { id: "team" }],
    });
    expect(new URL(fetchMock.mock.calls[2][0]).searchParams.get("maxResults")).toBe("250");
    expect(new URL(fetchMock.mock.calls[3][0]).searchParams.get("pageToken")).toBe("next");

    await expect(client.createEvent({ body: { summary: "New" } })).resolves.toEqual({ id: "created" });
    expect(fetchMock.mock.calls[4][1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(fetchMock.mock.calls[4][1].body)).toEqual({ summary: "New" });

    await expect(
      client.patchEvent({
        eventId: "event/with/slash",
        calendarId: "team@example.com",
        body: { summary: "Updated" },
      }),
    ).resolves.toEqual({ id: "patched" });
    expect(fetchMock.mock.calls[5][0]).toContain("/calendar/v3/calendars/team%40example.com/events/event%2Fwith%2Fslash");

    await expect(client.deleteEvent({ eventId: "event1" })).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[6][1]).toMatchObject({ method: "DELETE" });

    await expect(
      client.queryFreeBusy({
        timeMin: "2026-05-14T00:00:00Z",
        timeMax: "2026-05-15T00:00:00Z",
      }),
    ).resolves.toMatchObject({
      timeZone: "Asia/Tokyo",
      calendars: {
        primary: {
          busy: [{ start: "2026-05-14T01:00:00Z", end: "2026-05-14T02:00:00Z" }],
        },
      },
    });
    expect(JSON.parse(fetchMock.mock.calls[7][1].body)).toMatchObject({
      items: [{ id: "primary" }],
    });
    expect(credentialsProvider).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.filter(([url]) => url === "https://oauth2.googleapis.com/token")).toHaveLength(1);
  });

  it("finds the first non-cancelled event by private properties", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ access_token: "access" }))
        .mockResolvedValueOnce(
          okJson({
            items: [
              { id: "cancelled", status: "cancelled" },
              { id: "active", status: "confirmed" },
            ],
          }),
        ),
    );
    const client = new GoogleCalendarClient({
      credentialsProvider: async () => ({
        clientId: "cid",
        clientSecret: "secret",
        refreshToken: "refresh",
        calendarId: "primary",
        timeZone: "UTC",
      }),
      defaultTimeZone: "UTC",
    });

    await expect(
      client.findEventByPrivateProperties({ privateProperties: { slackTaskId: "task1" } }),
    ).resolves.toEqual({ id: "active", status: "confirmed" });
  });

  it("handles explicit calendar options, empty event matches, and provided freebusy calendars", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ access_token: "access", expires_in: 3600 }))
      .mockResolvedValueOnce(okJson({ items: [] }))
      .mockResolvedValueOnce(okJson({ items: [] }))
      .mockResolvedValueOnce(
        okJson({
          timeMin: "2026-05-14T00:00:00Z",
          timeMax: "2026-05-15T00:00:00Z",
          calendars: {},
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = new GoogleCalendarClient({
      credentialsProvider: async () => ({
        clientId: "cid",
        clientSecret: "secret",
        refreshToken: "refresh",
        calendarId: "primary",
        timeZone: "UTC",
      }),
      defaultTimeZone: "UTC",
    });

    await expect(
      client.listEvents({
        calendarId: "team@example.com",
        timeZone: "Asia/Tokyo",
        maxResults: 0,
      }),
    ).resolves.toMatchObject({
      calendarId: "team@example.com",
      timeZone: "Asia/Tokyo",
      events: [],
    });
    const eventUrl = new URL(fetchMock.mock.calls[1][0]);
    expect(eventUrl.pathname).toBe("/calendar/v3/calendars/team%40example.com/events");
    expect(eventUrl.searchParams.get("maxResults")).toBe("1");
    expect(eventUrl.searchParams.has("q")).toBe(false);

    await expect(client.findEventByPrivateProperties({ privateProperties: {} })).resolves.toBeNull();
    await expect(
      client.queryFreeBusy({
        calendarIds: ["team", "personal"],
        timeMin: "2026-05-14T00:00:00Z",
        timeMax: "2026-05-15T00:00:00Z",
        timeZone: "Asia/Tokyo",
      }),
    ).resolves.toMatchObject({
      timeZone: "Asia/Tokyo",
      calendars: {},
    });
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toMatchObject({
      timeZone: "Asia/Tokyo",
      items: [{ id: "team" }, { id: "personal" }],
    });
  });

  it("refreshes access tokens once cached tokens are close to expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T00:00:00Z"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ access_token: "access-1", expires_in: 120 }))
      .mockResolvedValueOnce(okJson({ items: [] }))
      .mockResolvedValueOnce(okJson({ access_token: "access-2", expires_in: 120 }))
      .mockResolvedValueOnce(okJson({ items: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GoogleCalendarClient({
      credentialsProvider: async () => ({
        clientId: "cid",
        clientSecret: "secret",
        refreshToken: "refresh",
        calendarId: "primary",
        timeZone: "UTC",
      }),
      defaultTimeZone: "UTC",
    });

    await client.listCalendars();
    vi.setSystemTime(new Date("2026-05-14T00:01:01Z"));
    await client.listCalendars();

    expect(fetchMock.mock.calls.filter(([url]) => url === "https://oauth2.googleapis.com/token")).toHaveLength(2);
    expect(fetchMock.mock.calls[1][1].headers.authorization).toBe("Bearer access-1");
    expect(fetchMock.mock.calls[3][1].headers.authorization).toBe("Bearer access-2");
  });

  it("loads credentials from secret provider and applies secret defaults", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ access_token: "access" }))
        .mockResolvedValueOnce(okJson({ items: [] })),
    );
    const client = new GoogleCalendarClient({
      secretProvider: async () =>
        JSON.stringify({
          client_id: "cid",
          client_secret: "secret",
          refresh_token: "refresh",
        }),
      defaultTimeZone: "Asia/Tokyo",
    });

    await expect(client.listEvents({})).resolves.toMatchObject({
      calendarId: "primary",
      timeZone: "Asia/Tokyo",
    });
  });

  it("reports missing credentials and failed Google API responses", async () => {
    const noCredentials = new GoogleCalendarClient({ defaultTimeZone: "UTC" });
    await expect(noCredentials.listEvents({})).rejects.toThrow("credentials are not configured");

    const badSecret = new GoogleCalendarClient({
      secretProvider: async () => JSON.stringify({ client_id: "cid", client_secret: "secret" }),
      defaultTimeZone: "UTC",
    });
    await expect(badSecret.listEvents({})).rejects.toThrow("missing refresh_token");

    const missingClientId = new GoogleCalendarClient({
      secretProvider: async () =>
        JSON.stringify({
          client_secret: "secret",
          refresh_token: "refresh",
        }),
      defaultTimeZone: "UTC",
    });
    await expect(missingClientId.listEvents({})).rejects.toThrow("missing client_id");

    const missingClientSecret = new GoogleCalendarClient({
      secretProvider: async () =>
        JSON.stringify({
          client_id: "cid",
          refresh_token: "refresh",
        }),
      defaultTimeZone: "UTC",
    });
    await expect(missingClientSecret.listEvents({})).rejects.toThrow("missing client_secret");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "refresh denied" } }), {
          status: 401,
          statusText: "Unauthorized",
        }),
      ),
    );
    const tokenFailure = new GoogleCalendarClient({
      credentialsProvider: async () => ({
        clientId: "cid",
        clientSecret: "secret",
        refreshToken: "refresh",
        calendarId: "primary",
        timeZone: "UTC",
      }),
      defaultTimeZone: "UTC",
    });
    await expect(tokenFailure.listEvents({})).rejects.toThrow(
      "Failed to refresh Google OAuth token: refresh denied",
    );

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ access_token: "access" }))
        .mockResolvedValueOnce(new Response("not json", { status: 500, statusText: "Server Error" })),
    );
    const apiFailure = new GoogleCalendarClient({
      credentialsProvider: async () => ({
        clientId: "cid",
        clientSecret: "secret",
        refreshToken: "refresh",
        calendarId: "primary",
        timeZone: "UTC",
      }),
      defaultTimeZone: "UTC",
    });
    await expect(apiFailure.listEvents({})).rejects.toThrow(
      "Google Calendar API request failed: 500 Server Error",
    );

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ access_token: "access" }))
        .mockResolvedValueOnce(new Response(null, { status: 503, statusText: "Unavailable" })),
    );
    const emptyError = new GoogleCalendarClient({
      credentialsProvider: async () => ({
        clientId: "cid",
        clientSecret: "secret",
        refreshToken: "refresh",
        calendarId: "primary",
        timeZone: "UTC",
      }),
      defaultTimeZone: "UTC",
    });
    await expect(emptyError.listEvents({})).rejects.toThrow(
      "Google Calendar API request failed: 503 Unavailable",
    );
  });
});

describe("createUserGoogleCalendarClient", () => {
  it("creates user credentials from stored OAuth connections", async () => {
    const secretsProvider = {
      getSecretString: vi.fn().mockResolvedValue(
        JSON.stringify({
          clientId: "cid",
          clientSecret: "secret",
        }),
      ),
    };
    const connections = {
      get: vi.fn().mockResolvedValue({
        refreshToken: "refresh",
        calendarId: "team",
        timeZone: "UTC",
      }),
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ access_token: "access" }))
      .mockResolvedValueOnce(okJson({ items: [{ id: "team" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createUserGoogleCalendarClient({
      workspaceId: "T1",
      userId: "U1",
      defaultTimeZone: "Asia/Tokyo",
      googleCalendarSecretId: "secret-id",
      googleOAuthStartUrl: "https://app.example/oauth/start",
      secretsProvider: secretsProvider as any,
      connections: connections as any,
    });

    await expect(client.listEvents({})).resolves.toMatchObject({
      calendarId: "team",
      timeZone: "UTC",
    });
    expect(secretsProvider.getSecretString).toHaveBeenCalledWith("secret-id");
    expect(connections.get).toHaveBeenCalledWith("T1", "U1");
  });

  it("requires user context and linked Google connections", async () => {
    const base = {
      workspaceId: "T1",
      defaultTimeZone: "Asia/Tokyo",
      googleCalendarSecretId: "secret-id",
      secretsProvider: {
        getSecretString: vi.fn().mockResolvedValue(JSON.stringify({ clientId: "cid", clientSecret: "secret" })),
      },
      connections: {
        get: vi.fn().mockResolvedValue(null),
      },
    };

    const withoutUser = createUserGoogleCalendarClient(base as any);
    await expect(withoutUser.listEvents({})).rejects.toThrow("requires a user context");

    const withoutConnection = createUserGoogleCalendarClient({
      ...base,
      userId: "U1",
      googleOAuthStartUrl: "https://app.example/oauth/start",
    } as any);
    await expect(withoutConnection.listEvents({})).rejects.toThrow(
      GoogleCalendarAuthorizationRequiredError,
    );
    await expect(withoutConnection.listEvents({})).rejects.toThrow(
      "https://app.example/oauth/start?workspace_id=T1&user_id=U1",
    );

    const withoutStartUrl = createUserGoogleCalendarClient({
      ...base,
      userId: "U1",
    } as any);
    await expect(withoutStartUrl.listEvents({})).rejects.toThrow(
      "Google OAuth start URL is not configured.",
    );
  });

  it("falls back to primary calendar and default timezone for linked users", async () => {
    const secretsProvider = {
      getSecretString: vi.fn().mockResolvedValue(JSON.stringify({ clientId: "cid", clientSecret: "secret" })),
    };
    const connections = {
      get: vi.fn().mockResolvedValue({
        refreshToken: "refresh",
      }),
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ access_token: "access" }))
        .mockResolvedValueOnce(okJson({ items: [] })),
    );

    const client = createUserGoogleCalendarClient({
      workspaceId: "T1",
      userId: "U1",
      defaultTimeZone: "Asia/Tokyo",
      googleCalendarSecretId: "secret-id",
      secretsProvider: secretsProvider as any,
      connections: connections as any,
    });

    await expect(client.listEvents({})).resolves.toMatchObject({
      calendarId: "primary",
      timeZone: "Asia/Tokyo",
    });
  });
});
