// GET /health -> { ok: true }  (public; handy for uptime checks + diagnostics)
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { ok } from "../lib/http";

export const handler: APIGatewayProxyHandlerV2 = async () => ok({ ok: true });
