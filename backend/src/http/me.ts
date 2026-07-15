// GET /me -> { user }
import type { APIGatewayProxyEventV2, APIGatewayProxyHandlerV2 } from "aws-lambda";
import { getUserById } from "../lib/ddb";
import { getAuth, ok, unauthorized, notFound, serverError } from "../lib/http";
import { toPublicUser } from "../lib/types";

export const handler: APIGatewayProxyHandlerV2 = async (
  event: APIGatewayProxyEventV2
) => {
  try {
    const auth = getAuth(event);
    if (!auth) return unauthorized();
    const user = await getUserById(auth.sub);
    if (!user) return notFound("User no longer exists");
    return ok({ user: toPublicUser(user) });
  } catch (err) {
    console.error("me error", err);
    return serverError();
  }
};
