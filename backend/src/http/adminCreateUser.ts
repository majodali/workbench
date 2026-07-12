// POST /admin/users  { username, password, displayName?, role? } -> { user }
import { randomUUID } from "node:crypto";
import type { APIGatewayProxyEventV2, APIGatewayProxyHandlerV2 } from "aws-lambda";
import { getUserByUsername, putUser } from "../lib/ddb";
import { hashPassword } from "../lib/auth";
import {
  getAuth,
  ok,
  badRequest,
  unauthorized,
  forbidden,
  parseBody,
  serverError,
  json,
} from "../lib/http";
import { toPublicUser, type User } from "../lib/types";

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

export const handler: APIGatewayProxyHandlerV2 = async (
  event: APIGatewayProxyEventV2
) => {
  try {
    const auth = getAuth(event);
    if (!auth) return unauthorized();
    if (auth.role !== "admin") return forbidden("Admins only");

    const body = parseBody<{
      username?: string;
      password?: string;
      displayName?: string;
      role?: string;
    }>(event);
    const username = body.username?.trim() ?? "";
    const password = body.password ?? "";
    const displayName = body.displayName?.trim() || username;
    const role = body.role === "admin" ? "admin" : "member";

    if (!USERNAME_RE.test(username)) {
      return badRequest("Username must be 3-20 chars: letters, numbers, underscore");
    }
    if (password.length < 6) return badRequest("Password must be at least 6 characters");

    const existing = await getUserByUsername(username);
    if (existing) return json(409, { error: "That username is already taken" });

    const user: User = {
      userId: randomUUID(),
      username,
      usernameLower: username.toLowerCase(),
      displayName,
      passwordHash: await hashPassword(password),
      role,
      createdAt: Date.now(),
    };
    await putUser(user);
    return ok({ user: toPublicUser(user) });
  } catch (err) {
    console.error("adminCreateUser error", err);
    return serverError();
  }
};
