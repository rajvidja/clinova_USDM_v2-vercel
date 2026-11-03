import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, ROLES, type Permission, type Role, type SessionUser } from '../shared/governance.ts';
import { audit } from './audit.ts';
import { runAs, SYSTEM_ACTOR, type Actor } from './context.ts';
import { db, tx } from './db.ts';
import { HttpError } from './repo.ts';

// Authentication: scrypt password hashes, stateless HMAC-signed session cookies (so they work across serverless
// instances), per-user token versions for revocation, an idle timeout with sliding renewal and login throttling.

const COOKIE = 'piq_session';
const SESSION_HOURS = Number(process.env.PROTOCOLIQ_SESSION_HOURS ?? 8);
const DEMO_PASSWORD = process.env.PROTOCOLIQ_DEMO_PASSWORD ?? 'ProtocolIQ-demo';
const now = () => new Date().toISOString();

// ---------- Passwords ----------

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function checkPassword(password: string, stored: string): boolean {
  const [scheme, n, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: 8, p: 1 });
  return timingSafeEqual(actual, expected);
}

export function validatePassword(p: unknown): string {
  if (typeof p !== 'string' || p.length < 10 || p.length > 200) throw new HttpError(400, 'Passwords must be 10–200 characters.');
  return p;
}

// ---------- Secret ----------

let secret: Buffer | null = null;
function sessionSecret(): Buffer {
  if (secret) return secret;
  const env = process.env.PROTOCOLIQ_SESSION_SECRET;
  if (env) return (secret = Buffer.from(env));
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = 'session_secret'`).get() as { value: string } | undefined;
  if (row) return (secret = Buffer.from(row.value, 'base64'));
  const fresh = randomBytes(32);
  db.prepare(`INSERT INTO app_settings (key, value) VALUES ('session_secret', ?)`).run(fresh.toString('base64'));
  return (secret = fresh);
}

// ---------- Roles, permissions and seed users ----------

export function seedAccessControl() {
  tx(() => {
    if (!db.prepare(`SELECT 1 FROM user_permissions LIMIT 1`).get()) {
      const ins = db.prepare(`INSERT INTO user_permissions (role, permission) VALUES (?, ?)`);
      for (const role of ROLES) for (const p of DEFAULT_ROLE_PERMISSIONS[role]) ins.run(role, p);
    }
    if (!db.prepare(`SELECT 1 FROM users LIMIT 1`).get()) {
      // Synthetic prototype accounts, one per role. Deterministic ids keep references stable across demo instances.
      const accounts: [string, string, Role][] = [
        ['admin', 'Alex Admin', 'ADMIN'],
        ['steward', 'Sam Steward', 'DATA_STEWARD'],
        ['author', 'Priya Author', 'PROTOCOL_AUTHOR'],
        ['reviewer', 'Rene Reviewer', 'REVIEWER'],
        ['viewer', 'Vic Viewer', 'VIEWER'],
      ];
      const t = now();
      const hash = hashPassword(DEMO_PASSWORD);
      for (const [username, name, role] of accounts) {
        const id = `usr-${username}`;
        db.prepare(`INSERT INTO users (id, username, display_name, email, password_hash, active, is_demo, created_at, updated_at) VALUES (?,?,?,?,?,1,1,?,?)`).run(
          id,
          username,
          name,
          `${username}@example.org`,
          hash,
          t,
          t,
        );
        db.prepare(`INSERT INTO user_roles (user_id, role, granted_by, granted_at) VALUES (?,?,?,?)`).run(id, role, 'system', t);
      }
      runAs(SYSTEM_ACTOR, () => audit({ action: 'user.seeded', entityType: 'user', next: accounts.map(([u, , r]) => ({ username: u, role: r })) }));
    }
  });
}

export function demoAccounts() {
  if (process.env.PROTOCOLIQ_HIDE_DEMO_ACCOUNTS === '1') return [];
  const rows = db.prepare(`SELECT u.username, u.display_name, GROUP_CONCAT(r.role) AS roles FROM users u JOIN user_roles r ON r.user_id = u.id WHERE u.is_demo = 1 AND u.active = 1 GROUP BY u.id ORDER BY u.created_at`).all() as any[];
  return rows.length ? { password: DEMO_PASSWORD, accounts: rows.map((r) => ({ username: r.username, displayName: r.display_name, roles: String(r.roles).split(',') })) } : [];
}

function rolesOf(userId: string): Role[] {
  return (db.prepare(`SELECT role FROM user_roles WHERE user_id = ? ORDER BY role`).all(userId) as { role: Role }[]).map((r) => r.role);
}

export function permissionsFor(roles: Role[]): Set<Permission> {
  if (!roles.length) return new Set();
  const rows = db.prepare(`SELECT DISTINCT permission FROM user_permissions WHERE role IN (${roles.map(() => '?').join(',')})`).all(...roles) as { permission: Permission }[];
  return new Set(rows.map((r) => r.permission));
}

export function sessionUser(userId: string): SessionUser | null {
  const u = db.prepare(`SELECT * FROM users WHERE id = ? AND active = 1`).get(userId) as any;
  if (!u) return null;
  const roles = rolesOf(u.id);
  return { id: u.id, username: u.username, displayName: u.display_name, email: u.email, roles, permissions: [...permissionsFor(roles)], isDemo: !!u.is_demo };
}

// ---------- Session tokens ----------

interface TokenPayload {
  uid: string;
  tv: number;
  iat: number;
  exp: number;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const sign = (body: string) => createHmac('sha256', sessionSecret()).update(body).digest('base64url');

function issueToken(userId: string, tokenVersion: number): { token: string; exp: number } {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + SESSION_HOURS * 3600;
  const body = b64(JSON.stringify({ uid: userId, tv: tokenVersion, iat, exp } satisfies TokenPayload));
  return { token: `${body}.${sign(body)}`, exp };
}

function readToken(token: string | undefined): TokenPayload | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString()) as TokenPayload;
    return p.exp > Date.now() / 1000 ? p : null;
  } catch {
    return null;
  }
}

function cookieValue(req: Request, name: string): string | undefined {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

const secureCookie = (req: Request) => req.secure || req.headers['x-forwarded-proto'] === 'https';

function setCookie(req: Request, res: Response, token: string, exp: number) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(exp * 1000).toUTCString()}${secureCookie(req) ? '; Secure' : ''}`,
  );
}

export function clearCookie(req: Request, res: Response) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie(req) ? '; Secure' : ''}`);
}

// ---------- Login ----------

const failures = new Map<string, { count: number; until: number }>();
const LOCK_AFTER = 8;
const LOCK_MS = 15 * 60_000;

export function login(req: Request, res: Response): SessionUser {
  const username = String(req.body?.username ?? '').trim().slice(0, 100);
  const password = String(req.body?.password ?? '');
  const key = `${username.toLowerCase()}|${req.ip}`;
  const f = failures.get(key);
  if (f && f.count >= LOCK_AFTER && f.until > Date.now()) throw new HttpError(429, 'Too many failed sign-in attempts. Try again in 15 minutes.');
  const u = db.prepare(`SELECT * FROM users WHERE username = ?`).get(username) as any;
  const ok = !!u && u.active === 1 && checkPassword(password, u.password_hash);
  const actor = { ...SYSTEM_ACTOR, ip: req.ip };
  if (!ok) {
    failures.set(key, { count: (f && f.until > Date.now() ? f.count : 0) + 1, until: Date.now() + LOCK_MS });
    runAs(actor, () => audit({ action: 'auth.login_failed', entityType: 'user', entityId: u?.id ?? null, username: username || '(blank)', userId: u?.id ?? null, next: { reason: !u ? 'unknown user' : u.active ? 'wrong password' : 'inactive account' } }));
    throw new HttpError(401, 'Invalid username or password.');
  }
  failures.delete(key);
  db.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`).run(now(), u.id);
  const { token, exp } = issueToken(u.id, Number(u.token_version));
  setCookie(req, res, token, exp);
  runAs(actor, () => audit({ action: 'auth.login', entityType: 'user', entityId: u.id, username: u.username, userId: u.id }));
  return sessionUser(u.id)!;
}

export function logout(req: Request, res: Response, everywhere = false) {
  const p = readToken(cookieValue(req, COOKIE));
  if (p) {
    if (everywhere) db.prepare(`UPDATE users SET token_version = token_version + 1 WHERE id = ?`).run(p.uid);
    audit({ action: everywhere ? 'auth.logout_all' : 'auth.logout', entityType: 'user', entityId: p.uid });
  }
  clearCookie(req, res);
}

// ---------- Middleware ----------

declare module 'express-serve-static-core' {
  interface Request {
    actor?: Actor;
    user?: SessionUser;
  }
}

/** Resolves the session cookie, renews it when past half its lifetime, and runs the request as that user. */
export function authenticate(req: Request, res: Response, next: NextFunction) {
  const p = readToken(cookieValue(req, COOKIE));
  const row = p ? (db.prepare(`SELECT token_version FROM users WHERE id = ? AND active = 1`).get(p.uid) as { token_version: number } | undefined) : undefined;
  const user = row && Number(row.token_version) === p!.tv ? sessionUser(p!.uid) : null;
  if (!user) {
    if (p) clearCookie(req, res);
    return next();
  }
  if (p!.exp - Date.now() / 1000 < (SESSION_HOURS * 3600) / 2) {
    const { token, exp } = issueToken(user.id, p!.tv);
    setCookie(req, res, token, exp);
  }
  const actor: Actor = { userId: user.id, username: user.username, displayName: user.displayName, roles: user.roles, permissions: new Set(user.permissions), ip: req.ip };
  req.user = user;
  req.actor = actor;
  runAs(actor, () => next());
}

/** Rejects cross-site state-changing requests (defence in depth on top of SameSite cookies). */
export function sameOrigin(req: Request, _res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin) {
    const host = req.headers['x-forwarded-host'] ?? req.headers.host;
    try {
      if (new URL(origin).host !== host) return next(new HttpError(403, 'Cross-origin request rejected'));
    } catch {
      return next(new HttpError(403, 'Invalid Origin header'));
    }
  }
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new HttpError(401, 'Sign in required'));
  next();
}

export const can = (actor: Actor | undefined, permission: Permission) => !!actor && (actor.permissions.has('*') || actor.permissions.has(permission));

export function assertCan(actor: Actor | undefined, permission: Permission) {
  if (!can(actor, permission)) throw new HttpError(403, `Your role does not allow this action (${PERMISSIONS[permission]}).`);
}

export const requirePermission = (permission: Permission) => (req: Request, _res: Response, next: NextFunction) => {
  if (!req.user) return next(new HttpError(401, 'Sign in required'));
  if (!can(req.actor, permission)) return next(new HttpError(403, `Your role does not allow this action (${PERMISSIONS[permission]}).`));
  next();
};

// ---------- User administration ----------

export function listUsers() {
  return (db.prepare(`SELECT * FROM users ORDER BY created_at`).all() as any[]).map((u) => ({
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    email: u.email,
    active: !!u.active,
    isDemo: !!u.is_demo,
    roles: rolesOf(u.id),
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
  }));
}

const cleanRoles = (roles: unknown): Role[] => {
  const list = Array.isArray(roles) ? roles.filter((r): r is Role => (ROLES as readonly string[]).includes(r)) : [];
  if (!list.length) throw new HttpError(400, 'At least one valid role is required.');
  return [...new Set(list)];
};

export function createUser(body: any) {
  const username = String(body?.username ?? '').trim();
  if (!/^[a-z0-9._-]{3,40}$/i.test(username)) throw new HttpError(400, 'Usernames are 3–40 letters, digits, dots, dashes or underscores.');
  if (db.prepare(`SELECT 1 FROM users WHERE username = ?`).get(username)) throw new HttpError(409, 'That username is taken.');
  const displayName = String(body?.displayName ?? '').trim().slice(0, 120) || username;
  const email = String(body?.email ?? '').trim().slice(0, 200);
  const roles = cleanRoles(body?.roles);
  const hash = hashPassword(validatePassword(body?.password));
  const id = randomUUID();
  const t = now();
  tx(() => {
    db.prepare(`INSERT INTO users (id, username, display_name, email, password_hash, active, is_demo, created_at, updated_at) VALUES (?,?,?,?,?,1,0,?,?)`).run(id, username, displayName, email, hash, t, t);
    for (const r of roles) db.prepare(`INSERT INTO user_roles (user_id, role, granted_by, granted_at) VALUES (?,?,?,?)`).run(id, r, 'admin', t);
    audit({ action: 'user.created', entityType: 'user', entityId: id, next: { username, displayName, email, roles }, reason: body?.reason });
  });
  return listUsers().find((u) => u.id === id)!;
}

export function updateUser(id: string, body: any, actor: Actor) {
  const before = listUsers().find((u) => u.id === id);
  if (!before) throw new HttpError(404, 'User not found');
  tx(() => {
    const t = now();
    if (body?.displayName !== undefined || body?.email !== undefined) {
      db.prepare(`UPDATE users SET display_name = ?, email = ?, updated_at = ? WHERE id = ?`).run(
        String(body.displayName ?? before.displayName).trim().slice(0, 120) || before.username,
        String(body.email ?? before.email).trim().slice(0, 200),
        t,
        id,
      );
    }
    if (body?.roles !== undefined) {
      const roles = cleanRoles(body.roles);
      if (id === actor.userId && !roles.includes('ADMIN')) throw new HttpError(400, 'You cannot remove your own Admin role.');
      db.prepare(`DELETE FROM user_roles WHERE user_id = ?`).run(id);
      for (const r of roles) db.prepare(`INSERT INTO user_roles (user_id, role, granted_by, granted_at) VALUES (?,?,?,?)`).run(id, r, actor.userId, t);
    }
    if (body?.active !== undefined) {
      if (id === actor.userId && !body.active) throw new HttpError(400, 'You cannot deactivate your own account.');
      db.prepare(`UPDATE users SET active = ?, token_version = token_version + 1, updated_at = ? WHERE id = ?`).run(body.active ? 1 : 0, t, id);
    }
    if (body?.password !== undefined) {
      db.prepare(`UPDATE users SET password_hash = ?, is_demo = 0, token_version = token_version + 1, updated_at = ? WHERE id = ?`).run(hashPassword(validatePassword(body.password)), t, id);
    }
    const adminsLeft = db.prepare(`SELECT COUNT(*) AS n FROM users u JOIN user_roles r ON r.user_id = u.id WHERE r.role = 'ADMIN' AND u.active = 1`).get() as { n: number };
    if (!Number(adminsLeft.n)) throw new HttpError(400, 'At least one active Admin is required.');
    const after = listUsers().find((u) => u.id === id)!;
    audit({
      action: body?.roles !== undefined ? 'user.roles_changed' : body?.password !== undefined ? 'user.password_reset' : 'user.updated',
      entityType: 'user',
      entityId: id,
      previous: { displayName: before.displayName, email: before.email, roles: before.roles, active: before.active },
      next: { displayName: after.displayName, email: after.email, roles: after.roles, active: after.active, passwordChanged: body?.password !== undefined },
      reason: body?.reason,
    });
  });
  return listUsers().find((u) => u.id === id)!;
}

export function changeOwnPassword(actor: Actor, current: string, next: string) {
  const u = db.prepare(`SELECT password_hash FROM users WHERE id = ?`).get(actor.userId) as any;
  if (!u || !checkPassword(String(current ?? ''), u.password_hash)) throw new HttpError(400, 'Current password is incorrect.');
  db.prepare(`UPDATE users SET password_hash = ?, is_demo = 0, token_version = token_version + 1, updated_at = ? WHERE id = ?`).run(hashPassword(validatePassword(next)), now(), actor.userId);
  audit({ action: 'user.password_changed', entityType: 'user', entityId: actor.userId });
}

export function permissionMatrix() {
  const rows = db.prepare(`SELECT role, permission FROM user_permissions`).all() as { role: Role; permission: Permission }[];
  return {
    roles: ROLES,
    permissions: Object.entries(PERMISSIONS).map(([id, label]) => ({ id, label, roles: rows.filter((r) => r.permission === id).map((r) => r.role) })),
  };
}

export function displayName(userId: string | null | undefined): string | null {
  if (!userId) return null;
  if (userId === 'system') return 'System';
  return ((db.prepare(`SELECT display_name FROM users WHERE id = ?`).get(userId) as { display_name: string } | undefined)?.display_name ?? userId) as string;
}

