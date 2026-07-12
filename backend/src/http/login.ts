// POST /login  { username, password } -> { token, user }
import type { APIGatewayProxyEventV2, APIGatewayProxyHandlerV2 } from "aws-lambda";
import { getUserByUsername } from "../lib/ddb";
import { verifyPassword, signToken } from "../lib/auth";
import { ok, badRequest, unauthorized, parseBody, serverError } from "../lib/http";
import { toPublicUser } from "../lib/types";

export const handler: APIGatewayProxyHandlerV2 = async (
  event: APIGatewayProxyEventV2
) => {
  try {
    const { username, password } = parseBody<{ username?: string; password?: string }>(
      event
    );
    if (!username || !password) return badRequest("username and password are required");

    const user = await getUserByUsername(username.trim());
    if (!user) return unauthorized("Invalid username or password");

    const good = await verifyPassword(password, user.passwordHash);
    if (!good) return unauthorized("Invalid username or password");

    const token = signToken({ sub: user.userId, username: user.username, role: user.role });
    return ok({ token, user: toPublicUser(user) });
  } catch (err) {
    console.error("login error", err);
    return serverError();
  }
};
