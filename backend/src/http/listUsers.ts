// GET /users -> { users }   (any signed-in user)
import type { APIGatewayProxyEventV2, APIGatewayProxyHandlerV2 } from "aws-lambda";
import { listUsers } from "../lib/ddb";
import { getAuth, ok, unauthorized, serverError } from "../lib/http";
import { toPublicUser } from "../lib/types";

export const handler: APIGatewayProxyHandlerV2 = async (
  event: APIGatewayProxyEventV2
) => {
  try {
    const auth = getAuth(event);
    if (!auth) return unauthorized();
    const users = await listUsers();
    return ok({
      users: users
        .map(toPublicUser)
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    });
  } catch (err) {
    console.error("listUsers error", err);
    return serverError();
  }
};
