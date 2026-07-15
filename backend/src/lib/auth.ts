// Password hashing (bcrypt) + JWT issuance/verification.
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { env } from "./env";

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export interface TokenPayload {
  sub: string; // userId
  username: string;
  role: "admin" | "member";
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, env.jwtSecret, { expiresIn: TOKEN_TTL_SECONDS });
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    const decoded = jwt.verify(token, env.jwtSecret) as jwt.JwtPayload;
    if (!decoded.sub || !decoded.username) return null;
    return {
      sub: String(decoded.sub),
      username: String(decoded.username),
      role: decoded.role === "admin" ? "admin" : "member",
    };
  } catch {
    return null;
  }
}
