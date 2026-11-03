import assert from 'node:assert/strict';

export const DEMO_PASSWORD = process.env.PROTOCOLIQ_DEMO_PASSWORD ?? 'ProtocolIQ-demo';

/** Signs in and returns the session cookie. */
export async function signIn(base: string, username: string, password = DEMO_PASSWORD): Promise<string> {
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  assert.equal(res.status, 200, `login as ${username} → ${res.status}`);
  const cookie = res.headers.get('set-cookie');
  assert.ok(cookie, 'session cookie set');
  return cookie.split(';')[0];
}

/** Routes every fetch to the API under `base` through the given user's session (other URLs are untouched). */
export async function useSession(base: string, username: string) {
  const cookie = await signIn(base, username);
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(base)) return original(input, init);
    const headers = new Headers(init?.headers);
    if (!headers.has('cookie')) headers.set('cookie', cookie);
    return original(input, { ...init, headers });
  }) as typeof fetch;
  return () => (globalThis.fetch = original);
}

/** A JSON client bound to one user's session, for multi-user workflow tests. */
export function client(base: string, cookie: string) {
  const send = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, body: json, headers: res.headers };
  };
  const ok = async (method: string, path: string, body?: unknown, expected?: number) => {
    const r = await send(method, path, body);
    assert.ok(expected ? r.status === expected : r.status < 300, `${method} ${path} → ${r.status} ${JSON.stringify(r.body)?.slice(0, 400)}`);
    return r.body;
  };
  return {
    send,
    get: (path: string) => ok('GET', path),
    post: (path: string, body?: unknown, expected?: number) => ok('POST', path, body ?? {}, expected),
    put: (path: string, body?: unknown) => ok('PUT', path, body ?? {}),
    patch: (path: string, body?: unknown) => ok('PATCH', path, body ?? {}),
    del: (path: string) => ok('DELETE', path),
  };
}
