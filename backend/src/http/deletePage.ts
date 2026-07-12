// DELETE /pages/{slug} -> { ok: true }  (owner or admin)
import type { APIGatewayProxyEventV2, APIGatewayProxyHandlerV2 } from "aws-lambda";
import { getPage, deletePageRecord } from "../lib/ddb";
import { deletePageObject } from "../lib/s3";
import {
  getAuth,
  ok,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  serverError,
} from "../lib/http";

export const handler: APIGatewayProxyHandlerV2 = async (
  event: APIGatewayProxyEventV2
) => {
  try {
    const auth = getAuth(event);
    if (!auth) return unauthorized();

    const slug = event.pathParameters?.slug;
    if (!slug) return badRequest("slug is required");

    const page = await getPage(slug);
    if (!page) return notFound("Page not found");
    if (page.ownerId !== auth.sub && auth.role !== "admin") {
      return forbidden("You can only delete your own pages");
    }

    await deletePageObject(slug);
    await deletePageRecord(slug);
    return ok({ ok: true });
  } catch (err) {
    console.error("deletePage error", err);
    return serverError();
  }
};
