import { CognitoJwtVerifier } from "aws-jwt-verify";

export interface CognitoWebChatOwner {
  workspaceId: string;
  userId: string;
}

export interface CognitoWebChatVerifier {
  verifyAuthorization(authorizationHeader: string | undefined): Promise<CognitoWebChatOwner>;
}

export function createCognitoWebChatVerifier(userPoolId: string, clientId: string): CognitoWebChatVerifier {
  const verifier = CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: "id" });
  return {
    async verifyAuthorization(authorizationHeader) {
      const token = authorizationHeader?.match(/^Bearer\s+(.+)$/i)?.[1];
      if (!token) {
        throw new Error("Missing bearer token");
      }
      const payload = await verifier.verify(token);
      return {
        workspaceId: `cognito:${userPoolId}`,
        userId: payload.sub,
      };
    },
  };
}
