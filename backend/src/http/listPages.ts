// GET /pages          -> { pages }  (signed-in user's own pages)
// GET /pages?all=true -> { pages }  (admin: every published page)
import type { APIGatewayProxyEventV2, APIGatewayProxyHandlerV2 } from "aws-lambda";
import { listPagesByOwner, listAllPages } from "../lib/ddb";
import { env } from "../lib/env";
import { getAuth, ok, unauthorized, forbidden, serverError } from "../lib/http";
import { toPublicPage } from "../lib/types";

export const handler: APIGatewayProxyHandlerV2 = async (
  event: APIGatewayProxyEventV2
) => {
  try {
    const auth = getAuth(event);
    if (!auth) return unauthorized();

    const wantAll = event.queryStringParameters?.all === "true";
    if (wantAll && auth.role !== "admin") return forbidden("Admins only");

    const pages = wantAll ? await listAllPages() : await listPagesByOwner(auth.sub);
    return ok({
      pages: pages
        .map((p) => toPublicPage(p, env.pagesPrefix))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    });
  } catch (err) {
    console.error("listPages error", err);
    return serverError();
  }
};
