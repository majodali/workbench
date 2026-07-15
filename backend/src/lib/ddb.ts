// DynamoDB document client + typed helpers.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  DeleteCommand,
  UpdateCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { env, INDEXES } from "./env";
import type { User, Page } from "./types";

const client = new DynamoDBClient({ region: env.region });
export const ddb = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

// ---- Users ----

export async function getUserById(userId: string): Promise<User | undefined> {
  const res = await ddb.send(
    new GetCommand({ TableName: env.usersTable, Key: { userId } })
  );
  return res.Item as User | undefined;
}

export async function getUserByUsername(username: string): Promise<User | undefined> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: env.usersTable,
      IndexName: INDEXES.usersByUsername,
      KeyConditionExpression: "usernameLower = :u",
      ExpressionAttributeValues: { ":u": username.toLowerCase() },
      Limit: 1,
    })
  );
  return res.Items?.[0] as User | undefined;
}

export async function putUser(user: User): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: env.usersTable,
      Item: user,
      ConditionExpression: "attribute_not_exists(userId)",
    })
  );
}

export async function updateUserPassword(
  userId: string,
  passwordHash: string
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: env.usersTable,
      Key: { userId },
      UpdateExpression: "SET passwordHash = :h",
      ExpressionAttributeValues: { ":h": passwordHash },
      ConditionExpression: "attribute_exists(userId)",
    })
  );
}

export async function listUsers(): Promise<User[]> {
  const res = await ddb.send(new ScanCommand({ TableName: env.usersTable }));
  return (res.Items as User[]) ?? [];
}

// ---- Pages ----

export async function getPage(slug: string): Promise<Page | undefined> {
  const res = await ddb.send(
    new GetCommand({ TableName: env.pagesTable, Key: { slug } })
  );
  return res.Item as Page | undefined;
}

export async function putPage(page: Page): Promise<void> {
  await ddb.send(new PutCommand({ TableName: env.pagesTable, Item: page }));
}

export async function deletePageRecord(slug: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: env.pagesTable, Key: { slug } }));
}

export async function listPagesByOwner(ownerId: string): Promise<Page[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: env.pagesTable,
      IndexName: INDEXES.pagesByOwner,
      KeyConditionExpression: "ownerId = :o",
      ExpressionAttributeValues: { ":o": ownerId },
    })
  );
  return (res.Items as Page[]) ?? [];
}

export async function listAllPages(): Promise<Page[]> {
  const res = await ddb.send(new ScanCommand({ TableName: env.pagesTable }));
  return (res.Items as Page[]) ?? [];
}
