import { SecretsProvider } from "../aws/secretsProvider";
import { GoogleOAuthConnectionRepository } from "../repo/googleOAuthConnectionRepository";
import { parseGoogleOAuthClientConfig } from "./googleOAuth";
import { GoogleCalendarClient } from "./googleCalendarClient";

export class GoogleCalendarAuthorizationRequiredError extends Error {
  constructor(public readonly authorizationUrl: string) {
    super(`Google Calendar authorization is required: ${authorizationUrl}`);
  }
}

export function createUserGoogleCalendarClient(input: {
  workspaceId: string;
  userId?: string;
  defaultTimeZone: string;
  googleCalendarSecretId: string;
  googleOAuthStartUrl?: string;
  secretsProvider: SecretsProvider;
  connections: GoogleOAuthConnectionRepository;
}): GoogleCalendarClient {
  return new GoogleCalendarClient({
    defaultTimeZone: input.defaultTimeZone,
    credentialsProvider: async () => {
      if (!input.userId) {
        throw new Error("Google Calendar requires a user context.");
      }

      const rawSecret = await input.secretsProvider.getSecretString(input.googleCalendarSecretId);
      const config = parseGoogleOAuthClientConfig(rawSecret);
      const connection = await input.connections.get(input.workspaceId, input.userId);
      if (!connection) {
        throw new GoogleCalendarAuthorizationRequiredError(
          buildGoogleOAuthStartUrl(input.googleOAuthStartUrl, input.workspaceId, input.userId),
        );
      }

      return {
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        refreshToken: connection.refreshToken,
        calendarId: connection.calendarId ?? "primary",
        timeZone: connection.timeZone ?? input.defaultTimeZone,
      };
    },
  });
}

export function buildGoogleOAuthStartUrl(
  startUrl: string | undefined,
  workspaceId: string,
  userId: string,
): string {
  if (!startUrl) {
    return "Google OAuth start URL is not configured.";
  }

  const url = new URL(startUrl);
  url.searchParams.set("workspace_id", workspaceId);
  url.searchParams.set("user_id", userId);
  return url.toString();
}
