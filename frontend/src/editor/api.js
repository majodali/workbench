/**
 * Client for the site API: auth (site-wide, app-neutral /auth/* routes) and
 * Contraption page publishing.
 *
 * The token key is deliberately origin-wide — NOT namespaced by app path —
 * so a login works across every app on the site.
 */

import { loadRuntimeConfig } from './config.js';

const TOKEN_KEY = 'site-auth-token';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function call(method, path, body) {
  const { apiUrl } = await loadRuntimeConfig();
  if (!apiUrl) {
    throw new ApiError(0, 'No API configured — publishing needs the deployed backend (config.json).');
  }
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(apiUrl + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  login: (username, password) => call('POST', '/auth/login', { username, password }),
  me: () => call('GET', '/auth/me'),
  publish: (slug, title, project) => call('POST', '/pages', { slug, title, project }),
  listPages: () => call('GET', '/pages'),
  deletePage: (slug) => call('DELETE', `/pages/${encodeURIComponent(slug)}`),
};

/**
 * Fetch a published page and extract the embedded project document — the
 * editing round-trip: any published URL can be reopened in the editor.
 */
export async function fetchPublishedProject(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Could not fetch ${path} (HTTP ${res.status})`);
  const html = await res.text();
  const match = html.match(
    /<script type="application\/json" id="contraption-project">([\s\S]*?)<\/script>/
  );
  if (!match) throw new Error('That page does not contain an embedded Contraption project.');
  return JSON.parse(match[1]);
}
