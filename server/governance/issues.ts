import { randomUUID } from 'node:crypto';
import type { GovernanceIssue, IssueStatus, Page, Severity } from '../../shared/governance.ts';
import { ISSUE_STATUSES, RULE_CATEGORIES, SEVERITIES } from '../../shared/governance.ts';
import { audit, queryAudit } from '../audit.ts';
import { can } from '../auth.ts';
import { currentActor } from '../context.ts';
import { db, tx } from '../db.ts';
import { HttpError } from '../repo.ts';

// Governance issues: findings of the quality engine (one issue per fingerprint) and manually raised issues.
// Accepting an exception needs a reason and the exception.approve permission, and is audited. Findings from the
// USDM schema/reference checks cannot be accepted as exceptions: those errors block export until fixed.

const NON_WAIVABLE_RULE_KEYS = new Set(['usdm-schema-errors', 'usdm-invalid-references']);

const toIssue = (r: any): GovernanceIssue => ({
  id: r.id,
  origin: r.origin,
  studyId: r.study_id,
  studyTitle: r.study_title ?? undefined,
  protocolNumber: r.protocol_number ?? undefined,
  protocolId: r.protocol_id,
  elementId: r.element_id,
  elementType: r.element_type,
  elementLabel: r.element_label ?? null,
  ruleId: r.rule_id,
  category: r.category,
  severity: r.severity,
  title: r.title,
  description: r.description,
  detectedValue: r.detected_value,
  expectedCondition: r.expected_condition,
  status: r.status,
  assignedTo: r.assigned_to,
  assignedToName: r.assigned_name ?? null,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  lastDetectedAt: r.last_detected_at,
  resolvedBy: r.resolved_by,
  resolvedAt: r.resolved_at,
  resolution: r.resolution,
  exceptionReason: r.exception_reason,
  exceptionApprovedBy: r.exception_approved_by,
  exceptionApprovedAt: r.exception_approved_at,
});

const SELECT = `SELECT i.*, s.title AS study_title, s.protocol_number, u.display_name AS assigned_name, l.label AS element_label
  FROM governance_issues i LEFT JOIN studies s ON s.id = i.study_id LEFT JOIN users u ON u.id = i.assigned_to LEFT JOIN lineage_records l ON l.element_id = i.element_id`;

export interface IssueFilter {
  studyId?: string;
  protocolId?: string;
  status?: string;
  severity?: string;
  category?: string;
  ruleId?: string;
  assignedTo?: string;
  elementType?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}

export function listIssues(f: IssueFilter): Page<GovernanceIssue> & { counts: Record<string, number> } {
  const where: string[] = [];
  const args: (string | number)[] = [];
  const eq = (col: string, v?: string) => v && (where.push(`${col} = ?`), args.push(v));
  eq('i.study_id', f.studyId);
  eq('i.protocol_id', f.protocolId);
  if (f.status === 'unresolved') where.push(`i.status IN ('Open','Assigned','In Progress')`);
  else eq('i.status', f.status);
  eq('i.severity', f.severity);
  eq('i.category', f.category);
  eq('i.rule_id', f.ruleId);
  eq('i.element_type', f.elementType);
  if (f.assignedTo === 'me') (where.push('i.assigned_to = ?'), args.push(currentActor().userId));
  else if (f.assignedTo === 'unassigned') where.push('i.assigned_to IS NULL');
  else eq('i.assigned_to', f.assignedTo);
  if (f.q) {
    where.push('(i.title LIKE ? OR i.description LIKE ? OR i.detected_value LIKE ? OR s.title LIKE ? OR s.protocol_number LIKE ?)');
    const q = `%${f.q}%`;
    args.push(q, q, q, q, q);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const pageSize = Math.min(Math.max(Number(f.pageSize) || 25, 1), 200);
  const page = Math.max(Number(f.page) || 1, 1);
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM governance_issues i LEFT JOIN studies s ON s.id = i.study_id ${w}`).get(...args) as { n: number }).n;
  const items = (
    db
      .prepare(
        `${SELECT} ${w} ORDER BY CASE i.status WHEN 'Open' THEN 0 WHEN 'Assigned' THEN 1 WHEN 'In Progress' THEN 2 WHEN 'Accepted Exception' THEN 3 ELSE 4 END,
           CASE i.severity WHEN 'Critical' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 WHEN 'Low' THEN 3 ELSE 4 END, i.updated_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, pageSize, (page - 1) * pageSize) as any[]
  ).map(toIssue);
  const counts = Object.fromEntries((db.prepare(`SELECT i.status, COUNT(*) AS n FROM governance_issues i LEFT JOIN studies s ON s.id = i.study_id ${w} GROUP BY i.status`).all(...args) as any[]).map((r) => [r.status, Number(r.n)]));
  return { items, total, page, pageSize, counts };
}

export function getIssue(id: string) {
  const r = db.prepare(`${SELECT} WHERE i.id = ?`).get(id);
  if (!r) throw new HttpError(404, 'Issue not found');
  const issue = toIssue(r);
  const comments = (
    db.prepare(`SELECT c.*, u.display_name FROM governance_issue_comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.issue_id = ? ORDER BY c.created_at`).all(id) as any[]
  ).map((c) => ({ id: c.id, userId: c.user_id, userName: c.display_name ?? (c.user_id === 'system' ? 'System' : c.user_id), text: c.text, createdAt: c.created_at }));
  const history = queryAudit({ entityType: 'governance_issue', entityId: id, pageSize: 100 }).items;
  const waivable = isWaivable(issue);
  return { ...issue, comments, history, exceptionAllowed: waivable };
}

function isWaivable(issue: GovernanceIssue) {
  if (!issue.ruleId) return true;
  const rule = db.prepare(`SELECT config_json FROM governance_rules WHERE id = ?`).get(issue.ruleId) as { config_json: string } | undefined;
  const key = rule ? JSON.parse(rule.config_json).key : undefined;
  return !NON_WAIVABLE_RULE_KEYS.has(key);
}

export function createIssue(input: { studyId: string; protocolId?: string | null; elementId?: string | null; elementType?: string | null; severity: Severity; category: string; title: string; description?: string; assignedTo?: string | null }) {
  if (!input.title?.trim() || input.title.length > 300) throw new HttpError(400, 'Title is required (max 300 characters)');
  if (!SEVERITIES.includes(input.severity)) throw new HttpError(400, 'Unknown severity');
  if (!(RULE_CATEGORIES as string[]).includes(input.category) && input.category !== 'other') throw new HttpError(400, 'Unknown category');
  if (!db.prepare(`SELECT 1 FROM studies WHERE id = ?`).get(input.studyId)) throw new HttpError(400, 'Study not found');
  if (input.protocolId && !db.prepare(`SELECT 1 FROM protocols WHERE id = ? AND study_id = ?`).get(input.protocolId, input.studyId)) throw new HttpError(400, 'Protocol not found for this study');
  if (input.assignedTo && !db.prepare(`SELECT 1 FROM users WHERE id = ? AND active = 1`).get(input.assignedTo)) throw new HttpError(400, 'Assignee not found');
  const actor = currentActor();
  const id = randomUUID();
  const t = new Date().toISOString();
  tx(() => {
    db.prepare(
      `INSERT INTO governance_issues (id, fingerprint, origin, study_id, protocol_id, element_id, element_type, rule_id, category, severity, title, description, status, assigned_to, created_by, created_at, updated_at)
       VALUES (?,?,'manual',?,?,?,?,NULL,?,?,?,?,?,?,?,?,?)`,
    ).run(id, `manual:${id}`, input.studyId, input.protocolId ?? null, input.elementId ?? null, input.elementType ?? null, input.category, input.severity, input.title.trim(), String(input.description ?? '').slice(0, 5000), input.assignedTo ? 'Assigned' : 'Open', input.assignedTo ?? null, actor.userId, t, t);
    audit({ action: 'issue.created', entityType: 'governance_issue', entityId: id, studyId: input.studyId, next: { title: input.title, severity: input.severity, category: input.category, assignedTo: input.assignedTo ?? null } });
  });
  return getIssue(id);
}

export interface IssueUpdate {
  status?: IssueStatus;
  assignedTo?: string | null;
  comment?: string;
  resolution?: string;
  exceptionReason?: string;
  severity?: Severity;
}

export function updateIssue(id: string, patch: IssueUpdate) {
  const actor = currentActor();
  const before = getIssue(id);
  const t = new Date().toISOString();
  const sets: string[] = [];
  const args: (string | null)[] = [];
  const set = (col: string, v: string | null) => (sets.push(`${col} = ?`), args.push(v));
  const changingWorkflow = patch.status !== undefined || patch.assignedTo !== undefined || patch.severity !== undefined;
  if (changingWorkflow && !can(actor, 'issue.manage') && !can(actor, 'exception.approve')) throw new HttpError(403, 'Your role does not allow managing issues.');
  if (patch.severity && patch.severity !== before.severity) {
    if (before.origin === 'rule') throw new HttpError(400, "A rule-detected issue's severity comes from its rule; change the rule instead");
    if (!SEVERITIES.includes(patch.severity)) throw new HttpError(400, 'Unknown severity');
    set('severity', patch.severity);
  }
  if (patch.assignedTo !== undefined && patch.assignedTo !== before.assignedTo) {
    if (!can(actor, 'issue.manage')) throw new HttpError(403, 'Your role does not allow assigning issues.');
    if (patch.assignedTo && !db.prepare(`SELECT 1 FROM users WHERE id = ? AND active = 1`).get(patch.assignedTo)) throw new HttpError(400, 'Assignee not found');
    set('assigned_to', patch.assignedTo || null);
    if (patch.assignedTo && before.status === 'Open' && !patch.status) set('status', 'Assigned');
  }
  if (patch.status && patch.status !== before.status) {
    if (!ISSUE_STATUSES.includes(patch.status)) throw new HttpError(400, 'Unknown issue status');
    if (patch.status === 'Accepted Exception') {
      if (!can(actor, 'exception.approve')) throw new HttpError(403, 'Only an authorised approver can accept an exception.');
      if (!before.exceptionAllowed) throw new HttpError(409, 'USDM schema and reference errors cannot be accepted as exceptions; they must be fixed before export.');
      if (!patch.exceptionReason?.trim()) throw new HttpError(400, 'A reason is required to accept an exception');
      set('exception_reason', patch.exceptionReason.trim().slice(0, 2000));
      set('exception_approved_by', actor.userId);
      set('exception_approved_at', t);
    } else {
      if (before.status === 'Accepted Exception' && !can(actor, 'exception.approve')) throw new HttpError(403, 'Only an authorised approver can revoke an accepted exception.');
      if (!can(actor, 'issue.manage')) throw new HttpError(403, 'Your role does not allow changing issue status.');
      if (patch.status === 'Assigned' && !(patch.assignedTo ?? before.assignedTo)) throw new HttpError(400, 'Choose an assignee');
    }
    if (patch.status === 'Resolved') {
      if (!patch.resolution?.trim()) throw new HttpError(400, 'Describe how the issue was resolved');
      set('resolution', patch.resolution.trim().slice(0, 2000));
      set('resolved_by', actor.userId);
      set('resolved_at', t);
    } else if (before.status === 'Resolved') {
      set('resolved_by', null);
      set('resolved_at', null);
    }
    set('status', patch.status);
  }
  const comment = patch.comment?.trim();
  if (!sets.length && !comment) throw new HttpError(400, 'Nothing to update');
  tx(() => {
    if (sets.length) db.prepare(`UPDATE governance_issues SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...args, t, id);
    if (comment) db.prepare(`INSERT INTO governance_issue_comments (id, issue_id, user_id, text, created_at) VALUES (?,?,?,?,?)`).run(randomUUID(), id, actor.userId, comment.slice(0, 5000), t);
    if (patch.status === 'Accepted Exception' && patch.status !== before.status)
      db.prepare(`INSERT INTO approval_records (id, entity_type, entity_id, study_id, decision, decided_by, comment, created_at) VALUES (?,?,?,?,?,?,?,?)`).run(
        randomUUID(),
        'issue_exception',
        id,
        before.studyId,
        'Approved',
        actor.userId,
        patch.exceptionReason ?? '',
        t,
      );
    if (sets.length)
      audit({
        action: patch.status === 'Accepted Exception' ? 'issue.exception.accepted' : patch.status && patch.status !== before.status ? 'issue.status.changed' : 'issue.updated',
        entityType: 'governance_issue',
        entityId: id,
        studyId: before.studyId,
        previous: { status: before.status, assignedTo: before.assignedTo, severity: before.severity },
        next: { status: patch.status ?? before.status, assignedTo: patch.assignedTo !== undefined ? patch.assignedTo : before.assignedTo, severity: patch.severity ?? before.severity },
        reason: patch.exceptionReason ?? patch.resolution ?? comment,
      });
    else audit({ action: 'issue.commented', entityType: 'governance_issue', entityId: id, studyId: before.studyId, next: { comment } });
  });
  return getIssue(id);
}
