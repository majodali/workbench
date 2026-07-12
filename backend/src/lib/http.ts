// Helpers for HTTP API (payload format 2.0) Lambda handlers.
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { verifyToken, type TokenPayload } from "./auth";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Content-Type": "application/json",
};

export function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}
export const ok = (b: unknown) => json(200, b);
export const badRequest = (m: string) => json(400, { error: m });
export const unauthorized = (m = "Unauthorized") => json(401, { error: m });
export const forbidden = (m = "Forbidden") => json(403, { error: m });
export const notFound = (m = "Not found") => json(404, { error: m });
export const serverError = (m = "Internal error") => json(500, { error: m });

export function parseBody<T = Record<string, unknown>>(
  event: APIGatewayProxyEventV2
): T {
  if (!event.body) return {} as T;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf-8")
      : event.body;
    return JSON.parse(raw) as T;
  } catch {
    return {} as T;
  }
}

/** Extract + verify the bearer token. Returns null if missing/invalid. */
export function getAuth(event: APIGatewayProxyEventV2): TokenPayload | null {
  const header = event.headers?.authorization ?? event.headers?.Authorization ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  return verifyToken(match[1]);
}
