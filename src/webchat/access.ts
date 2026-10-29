import { timingSafeEqual } from "node:crypto";

export function bearerMatches(authorizationHeader: string | undefined, expected: string): boolean {
  const presented = authorizationHeader?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  const actual = Buffer.from(presented);
  const required = Buffer.from(expected);
  if (actual.length !== required.length) {
    timingSafeEqual(required, required);
    return false;
  }
  return timingSafeEqual(actual, required);
}
