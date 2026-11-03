import { createHash, randomUUID } from 'node:crypto';
import type { AuditEntry, Page } from '../shared/governance.ts';
import { currentActor } from './context.ts';
import { db } from './db.ts';

// Append-only audit trail. UPDATE/DELETE are rejected by database triggers (migration 2), the API exposes no
// mutation endpoints, and each record carries a SHA-256 hash chained to the previous record so tampering with the
// file outside the application is detectable with verifyAuditChain().

const MAX_VALUE = 60_000;

function serialise(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v);
  return s.length > MAX_VALUE ? JSON.stringify({ truncated: true, preview: s.slice(0, MAX_VALUE) }) : s;
}

const digest = (prev: string, r: Record<string, unknown>) =>
  createHash('sha256')
    .update(prev)
    .update(JSON.stringify([r.id, r.user_id, r.username, r.action, r.entity_type, r.entity_id, r.study_id, r.previous_value, r.new_value, r.reason, r.created_at]))
    .digest('hex');

export interface AuditInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  studyId?: string | null;
  previous?: unknown;
  next?: unknown;
  reason?: string | null;
  /** Override the acting user, e.g. for failed logins. */
  username?: string;
  userId?: string | null;
}

export function audit(input: AuditInput): string {
  const actor = currentActor();
  const last = db.prepare(`SELECT hash FROM audit_logs ORDER BY seq DESC LIMIT 1`).get() as { hash: string } | undefined;
  const row = {
    id: randomUUID(),
    user_id: input.userId !== undefined ? input.userId : actor.userId,
    username: input.username ?? actor.username,
    action: input.action,
    entity_type: input.entityType,
    entity_id: input.entityId ?? null,
    study_id: input.studyId ?? null,
    previous_value: serialise(input.previous),
    new_value: serialise(input.next),
    reason: input.reason ? String(input.reason).slice(0, 2000) : null,
    ip: actor.ip ?? null,
    created_at: new Date().toISOString(),
  };
  const prev = last?.hash ?? 'genesis';
  db.prepare(
    `INSERT INTO audit_logs (id, user_id, username, action, entity_type, entity_id, study_id, previous_value, new_value, reason, ip, created_at, prev_hash, hash)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(row.id, row.user_id, row.username, row.action, row.entity_type, row.entity_id, row.study_id, row.previous_value, row.new_value, row.reason, row.ip, row.created_at, prev, digest(prev, row));
  return row.id;
}

const parse = (s: string | null) => {
  if (s === null) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

const toEntry = (r: any): AuditEntry => ({
  seq: Number(r.seq),
  id: r.id,
  userId: r.user_id,
  username: r.username,
  action: r.action,
  entityType: r.entity_type,
  entityId: r.entity_id,
  studyId: r.study_id,
  previousValue: parse(r.previous_value),
  newValue: parse(r.new_value),
  reason: r.reason,
  ip: r.ip,
  createdAt: r.created_at,
  hash: r.hash,
});

export interface AuditQuery {
  studyId?: string;
  entityType?: string;
  entityId?: string;
  userId?: string;
  action?: string;
  q?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export function queryAudit(f: AuditQuery): Page<AuditEntry> {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.studyId) (where.push('study_id = ?'), args.push(f.studyId));
  if (f.entityType) (where.push('entity_type = ?'), args.push(f.entityType));
  if (f.entityId) (where.push('entity_id = ?'), args.push(f.entityId));
  if (f.userId) (where.push('user_id = ?'), args.push(f.userId));
  if (f.action) (where.push('action LIKE ?'), args.push(`${f.action}%`));
  if (f.from) (where.push('created_at >= ?'), args.push(f.from));
  if (f.to) (where.push('created_at <= ?'), args.push(f.to));
  if (f.q) (where.push('(action LIKE ? OR username LIKE ? OR entity_id LIKE ? OR reason LIKE ? OR new_value LIKE ?)'), args.push(...Array(5).fill(`%${f.q}%`)));
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const pageSize = Math.min(200, Math.max(1, f.pageSize ?? 50));
  const page = Math.max(1, f.page ?? 1);
  const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM audit_logs ${clause}`).get(...args) as { n: number }).n);
  const items = (db.prepare(`SELECT * FROM audit_logs ${clause} ORDER BY seq DESC LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize) as any[]).map(toEntry);
  return { items, total, page, pageSize };
}

export function verifyAuditChain(): { ok: boolean; records: number; brokenAt: number | null } {
  let prev = 'genesis';
  let n = 0;
  for (const r of db.prepare(`SELECT * FROM audit_logs ORDER BY seq`).iterate() as Iterable<any>) {
    n++;
    if (r.prev_hash !== prev || digest(prev, r) !== r.hash) return { ok: false, records: n, brokenAt: Number(r.seq) };
    prev = r.hash;
  }
  return { ok: true, records: n, brokenAt: null };
}
