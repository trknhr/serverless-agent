import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { SecretsProvider } from "../../aws/secretsProvider";
import {
  buildGoogleAuthorizationUrl,
  createGoogleOAuthState,
  exchangeGoogleAuthorizationCode,
  fetchGoogleUserInfo,
  parseGoogleOAuthClientConfig,
  verifyGoogleOAuthState,
} from "../../calendar/googleOAuth";
import { loadGoogleOAuthEnv } from "../../config/env";
import { GoogleOAuthConnectionRepository } from "../../repo/googleOAuthConnectionRepository";
import { logger } from "../../shared/logger";

const env = loadGoogleOAuthEnv();
const secretsProvider = new SecretsProvider();
const connections = new GoogleOAuthConnectionRepository(env.GOOGLE_OAUTH_CONNECTIONS_TABLE_NAME);

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = event.requestContext.requestId;
  const log = logger.child({ requestId, component: "google-oauth" });

  try {
    if (event.httpMethod === "GET" && event.resource === "/oauth/google/start") {
      return startOAuth(event);
    }
    if (event.httpMethod === "GET" && event.resource === "/oauth/google/callback") {
      return callbackOAuth(event, log);
    }

    return response(404, "Not found");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Google OAuth error";
    log.error("Google OAuth failed", { error: message });
    return htmlResponse(500, "Google Calendar連携に失敗しました", message);
  }
}

async function startOAuth(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const workspaceId = event.queryStringParameters?.workspace_id;
  const userId = event.queryStringParameters?.user_id;
  if (!workspaceId || !userId) {
    return response(400, "Missing workspace_id or user_id");
  }

  const rawSecret = await secretsProvider.getSecretString(env.GOOGLE_CALENDAR_SECRET_ID);
  const config = parseGoogleOAuthClientConfig(rawSecret);
  const signingSecret = await secretsProvider.getSecretString(env.SLACK_SIGNING_SECRET_SECRET_ID);
  const redirectUri = buildRedirectUri(event);
  const makeDefaultValue = event.queryStringParameters?.make_default;
  const state = createGoogleOAuthState({
    workspaceId,
    userId,
    connectionId: event.queryStringParameters?.connection_id,
    accountLabel: event.queryStringParameters?.account_label,
    makeDefault: makeDefaultValue === undefined ? undefined : makeDefaultValue === "true",
  }, signingSecret);
  const location = buildGoogleAuthorizationUrl({ config, redirectUri, state });

  return {
    statusCode: 302,
    headers: {
      location,
    },
    body: "",
  };
}

async function callbackOAuth(
  event: APIGatewayProxyEvent,
  log: typeof logger,
): Promise<APIGatewayProxyResult> {
  const code = event.queryStringParameters?.code;
  const stateToken = event.queryStringParameters?.state;
  if (!code || !stateToken) {
    return response(400, "Missing code or state");
  }

  const rawSecret = await secretsProvider.getSecretString(env.GOOGLE_CALENDAR_SECRET_ID);
  const config = parseGoogleOAuthClientConfig(rawSecret);
  const signingSecret = await secretsProvider.getSecretString(env.SLACK_SIGNING_SECRET_SECRET_ID);
  const state = verifyGoogleOAuthState(stateToken, signingSecret);
  const token = await exchangeGoogleAuthorizationCode({
    config,
    redirectUri: buildRedirectUri(event),
    code,
  });
  if (!token.refresh_token) {
    throw new Error("Google did not return a refresh token. Reopen the authorization link and approve access again.");
  }

  const userInfo = await fetchGoogleUserInfo(token.access_token);
  const accountId = userInfo.sub ?? userInfo.email;
  if (!accountId) {
    throw new Error("Google did not return an account identifier.");
  }
  await connections.saveAccount({
    workspaceId: state.workspaceId,
    userId: state.userId,
    googleSubject: userInfo.sub,
    googleEmail: userInfo.email,
    refreshToken: token.refresh_token,
    calendarId: "primary",
    timeZone: env.GOOGLE_CALENDAR_TIME_ZONE,
    scopes: token.scope?.split(/\s+/).filter(Boolean),
  }, {
    connectionId: state.connectionId,
    accountId,
    displayName: state.accountLabel ?? userInfo.email ?? accountId,
    makeDefault: state.makeDefault,
  });

  log.info("Google Calendar connected", {
    workspaceId: state.workspaceId,
    userId: state.userId,
    googleEmail: userInfo.email,
    connectionId: state.connectionId ?? "google-calendar",
    accountId,
  });

  return htmlResponse(
    200,
    "Google Calendar連携が完了しました",
    "接続アカウントを保存しました。チャットに戻って、もう一度カレンダー操作を依頼してください。",
  );
}

function buildRedirectUri(event: APIGatewayProxyEvent): string {
  const host = event.headers.Host ?? event.headers.host;
  if (!host) {
    throw new Error("Missing request host");
  }

  const stage = event.requestContext.stage;
  return `https://${host}/${stage}/oauth/google/callback`;
}

function htmlResponse(statusCode: number, title: string, message: string): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      "content-type": "text/html; charset=utf-8",
    },
    body: `<!doctype html><html><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`,
  };
}

function response(statusCode: number, body: string): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      "content-type": "text/plain; charset=utf-8",
    },
    body,
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
