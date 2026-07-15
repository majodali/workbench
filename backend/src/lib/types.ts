// Shared entity + public wire types.

export interface User {
  userId: string;
  username: string;
  usernameLower: string; // case-insensitive login lookup (GSI)
  displayName: string;
  passwordHash: string;
  role: "admin" | "member";
  createdAt: number;
}

export interface PublicUser {
  userId: string;
  username: string;
  displayName: string;
  role: "admin" | "member";
  createdAt: number;
}

export function toPublicUser(u: User): PublicUser {
  return {
    userId: u.userId,
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    createdAt: u.createdAt,
  };
}

/** A published Contraption page: one HTML object in the site bucket + this record. */
export interface Page {
  slug: string; // partition key; also the URL path segment
  ownerId: string;
  ownerUsername: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface PublicPage {
  slug: string;
  ownerUsername: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Site-relative URL of the published page. */
  path: string;
}

export function toPublicPage(p: Page, pagesPrefix: string): PublicPage {
  return {
    slug: p.slug,
    ownerUsername: p.ownerUsername,
    title: p.title,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    path: `/${pagesPrefix}/${p.slug}/`,
  };
}
