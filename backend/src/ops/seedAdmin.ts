// CloudFormation custom-resource handler (invoked by CDK on deploy) that
// creates the first admin account if one doesn't already exist. Credentials
// come from ADMIN_USERNAME / ADMIN_PASSWORD env vars set by the stack.
import { randomUUID } from "node:crypto";
import { getUserByUsername, putUser } from "../lib/ddb";
import { hashPassword } from "../lib/auth";
import type { User } from "../lib/types";

interface CfnEvent {
  RequestType: "Create" | "Update" | "Delete";
  PhysicalResourceId?: string;
}

export const handler = async (event: CfnEvent) => {
  const physicalId = "app-admin-seed";
  if (event.RequestType === "Delete") {
    return { PhysicalResourceId: event.PhysicalResourceId ?? physicalId };
  }

  const username = (process.env.ADMIN_USERNAME ?? "").trim();
  const password = process.env.ADMIN_PASSWORD ?? "";
  if (!username || !password) {
    console.warn("ADMIN_USERNAME/ADMIN_PASSWORD not set — skipping admin seed");
    return { PhysicalResourceId: physicalId };
  }

  const existing = await getUserByUsername(username);
  if (existing) {
    console.log(`Admin '${username}' already exists — nothing to do`);
    return { PhysicalResourceId: physicalId };
  }

  const admin: User = {
    userId: randomUUID(),
    username,
    usernameLower: username.toLowerCase(),
    displayName: username,
    passwordHash: await hashPassword(password),
    role: "admin",
    createdAt: Date.now(),
  };
  await putUser(admin);
  console.log(`Seeded admin account '${username}'`);
  return { PhysicalResourceId: physicalId };
};
