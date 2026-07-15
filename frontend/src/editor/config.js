/**
 * Runtime configuration. Production serves /config.json next to the app
 * (written by CDK at deploy), so the build never hardcodes environment URLs.
 * Local dev falls back to VITE_API_URL or an empty apiUrl (publishing
 * disabled with a hint).
 */

let cached = null;

export async function loadRuntimeConfig() {
  if (cached) return cached;
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}config.json`, { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      if (data && data.apiUrl) {
        cached = {
          apiUrl: data.apiUrl,
          appName: data.appName ?? 'contraption',
          pagesPrefix: data.pagesPrefix ?? 'p',
        };
        return cached;
      }
    }
  } catch {
    /* fall through to defaults */
  }
  cached = {
    apiUrl: import.meta.env.VITE_API_URL ?? '',
    appName: 'contraption',
    pagesPrefix: 'p',
  };
  return cached;
}
