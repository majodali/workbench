// POST /me/password  { currentPassword, newPassword } -> { ok: true }
import type { APIGatewayProxyEventV2, APIGatewayProxyHandlerV2 } from "aws-lambda";
import { getUserById, updateUserPassword } from "../lib/ddb";
import { verifyPassword, hashPassword } from "../lib/auth";
import { getAuth, ok, badRequest, unauthorized, parseBody, serverError } from "../lib/http";

export const handler: APIGatewayProxyHandlerV2 = async (
  event: APIGatewayProxyEventV2
) => {
  try {
    const auth = getAuth(event);
    if (!auth) return unauthorized();

    const { currentPassword, newPassword } = parseBody<{
      currentPassword?: string;
      newPassword?: string;
    }>(event);
    if (!currentPassword || !newPassword) {
      return badRequest("currentPassword and newPassword are required");
    }
    if (newPassword.length < 6) {
      return badRequest("New password must be at least 6 characters");
    }

    const user = await getUserById(auth.sub);
    if (!user) return unauthorized();

    const good = await verifyPassword(currentPassword, user.passwordHash);
    if (!good) return unauthorized("Current password is incorrect");

    await updateUserPassword(user.userId, await hashPassword(newPassword));
    return ok({ ok: true });
  } catch (err) {
    console.error("changePassword error", err);
    return serverError();
  }
};
