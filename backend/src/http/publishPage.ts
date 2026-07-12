// POST /pages  { slug, title?, project } -> { page }
//
// Renders the project into a self-contained HTML page and writes it to the
// site bucket under the pages prefix. Authenticated users only; a slug is
// owned by whoever published it first (admins may overwrite any slug).
import type { APIGatewayProxyEventV2, APIGatewayProxyHandlerV2 } from "aws-lambda";
import { getPage, putPage } from "../lib/ddb";
import { renderPublishedPage } from "../lib/render";
import { writePageObject } from "../lib/s3";
import { env } from "../lib/env";
import {
  getAuth,
  ok,
  badRequest,
  unauthorized,
  forbidden,
  parseBody,
  serverError,
} from "../lib/http";
import { toPublicPage, type Page } from "../lib/types";

// Lowercase letters/digits/hyphens, 2-63 chars, no leading/trailing hyphen.
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/;
const MAX_PROJECT_BYTES = 1_000_000;

interface ProjectDoc {
  name?: string;
  page?: { html?: string };
  components?: unknown[];
}

export const handler: APIGatewayProxyHandlerV2 = async (
  event: APIGatewayProxyEventV2
) => {
  try {
    const auth = getAuth(event);
    if (!auth) return unauthorized();

    const body = parseBody<{ slug?: string; title?: string; project?: ProjectDoc }>(event);
    const slug = body.slug?.trim().toLowerCase() ?? "";
    const project = body.project;

    if (!SLUG_RE.test(slug)) {
      return badRequest(
        "slug must be 2-63 lowercase letters, digits or hyphens (no leading/trailing hyphen)"
      );
    }
    if (!project || !Array.isArray(project.components)) {
      return badRequest("project (with a components array) is required");
    }
    if (JSON.stringify(project).length > MAX_PROJECT_BYTES) {
      return badRequest("project is too large to publish (1 MB limit)");
    }

    const title = body.title?.trim() || project.name?.trim() || slug;

    const existing = await getPage(slug);
    if (existing && existing.ownerId !== auth.sub && auth.role !== "admin") {
      return forbidden(`"${slug}" was published by another user`);
    }

    await writePageObject(slug, renderPublishedPage(title, project));

    const now = Date.now();
    const page: Page = {
      slug,
      // An admin overwriting keeps the original owner unless it was theirs.
      ownerId: existing?.ownerId ?? auth.sub,
      ownerUsername: existing ? existing.ownerUsername : auth.username,
      title,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await putPage(page);

    return ok({ page: toPublicPage(page, env.pagesPrefix) });
  } catch (err) {
    console.error("publishPage error", err);
    return serverError();
  }
};
