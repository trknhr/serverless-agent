import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const GOOGLE_CALENDAR_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events",
] as const;

export interface GoogleOAuthClientConfig {
  clientId: string;
  clientSecret: string;
}

export interface GoogleOAuthState {
  workspaceId: string;
  userId: string;
  connectionId?: string;
  accountLabel?: string;
  makeDefault?: boolean;
  nonce: string;
  expiresAt: number;
}

export interface GoogleOAuthTokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  id_token?: string;
}

export interface GoogleUserInfo {
  sub?: string;
  email?: string;
}

const clientConfigSchema = z
  .object({
    client_id: z.string().min(1).optional(),
    clientId: z.string().min(1).optional(),
    client_secret: z.string().min(1).optional(),
    clientSecret: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (!(value.client_id ?? value.clientId)) {
      ctx.addIssue({ code: "custom", message: "Google OAuth secret is missing client_id" });
    }
    if (!(value.client_secret ?? value.clientSecret)) {
      ctx.addIssue({ code: "custom", message: "Google OAuth secret is missing client_secret" });
    }
  });

export function parseGoogleOAuthClientConfig(raw: string): GoogleOAuthClientConfig {
  const parsed = clientConfigSchema.parse(JSON.parse(raw));
  return {
    clientId: parsed.client_id ?? parsed.clientId!,
    clientSecret: parsed.client_secret ?? parsed.clientSecret!,
  };
}

export function buildGoogleAuthorizationUrl(input: {
  config: GoogleOAuthClientConfig;
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.config.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: GOOGLE_CALENDAR_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent select_account",
    state: input.state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeGoogleAuthorizationCode(input: {
  config: GoogleOAuthClientConfig;
  redirectUri: string;
  code: string;
}): Promise<GoogleOAuthTokenResponse> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: input.config.clientId,
      client_secret: input.config.clientSecret,
      code: input.code,
      grant_type: "authorization_code",
      redirect_uri: input.redirectUri,
    }),
  });

  if (!response.ok) {
    throw new Error(`Google OAuth token exchange failed: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as GoogleOAuthTokenResponse;
}

export async function fetchGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Google userinfo request failed: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as GoogleUserInfo;
}

export function createGoogleOAuthState(
  input: Pick<GoogleOAuthState, "workspaceId" | "userId" | "connectionId" | "accountLabel" | "makeDefault">,
  signingSecret: string,
): string {
  const state: GoogleOAuthState = {
    workspaceId: input.workspaceId,
    userId: input.userId,
    connectionId: input.connectionId,
    accountLabel: input.accountLabel,
    makeDefault: input.makeDefault,
    nonce: randomBytes(16).toString("hex"),
    expiresAt: Date.now() + 10 * 60 * 1000,
  };
  const payload = base64UrlEncode(JSON.stringify(state));
  const signature = sign(payload, signingSecret);
  return `${payload}.${signature}`;
}

export function verifyGoogleOAuthState(stateToken: string, signingSecret: string): GoogleOAuthState {
  const [payload, signature] = stateToken.split(".");
  if (!payload || !signature) {
    throw new Error("Invalid OAuth state");
  }

  const expected = sign(payload, signingSecret);
  if (!safeEqual(signature, expected)) {
    throw new Error("Invalid OAuth state signature");
  }

  const state = JSON.parse(base64UrlDecode(payload)) as GoogleOAuthState;
  if (state.expiresAt < Date.now()) {
    throw new Error("OAuth state expired");
  }

  return state;
}

function sign(payload: string, signingSecret: string): string {
  return createHmac("sha256", signingSecret).update(payload).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  try {
    return timingSafeEqual(Buffer.from(left), Buffer.from(right));
  } catch {
    return false;
  }
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf-8").toString("base64url");
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf-8");
}
