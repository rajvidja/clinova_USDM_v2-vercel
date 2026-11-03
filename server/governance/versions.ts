import { createHash, randomUUID } from 'node:crypto';
import { canonical, diffBundles } from '../../shared/elements.ts';
import type { ChangeRequestStatus } from '../../shared/governance.ts';
import type { ProtocolBundle, ProtocolStatus, SaveRequest } from '../../shared/types.ts';
import { validateProtocol } from '../../shared/validation.ts';
import { audit } from '../audit.ts';
import { assertCan } from '../auth.ts';
import { currentActor } from '../context.ts';
import { db, dryRun, tx } from '../db.ts';
import { createSnapshot, getBundle, getSnapshot, HttpError, saveProtocol, setStatus } from '../repo.ts';
import { freezeVersions, record } from './lineage.ts';

// Protocol versions (immutable once approved), version approval and change control for Final protocols.

const now = () => new Date().toISOString();
const sha = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
const userName = (id: string | null) => (id ? ((db.prepare(`SELECT display_name FROM users WHERE id = ?`).get(id) as any)?.display_name ?? id) : null);

const approvalRecord = (entityType: string, entityId: string, studyId: string, decision: string, comment: string) =>
  db.prepare(`INSERT INTO approval_records (id, entity_type, entity_id, study_id, decision, decided_by, comment, created_at) VALUES (?,?,?,?,?,?,?,?)`).run(
    randomUUID(),
    entityType,
    entityId,
    studyId,
    decision,
    currentActor().userId,
    comment,
    now(),
  );

const protocolRow = (id: string) => {
  const p = db.prepare(`SELECT p.*, s.id AS sid FROM protocols p JOIN studies s ON s.id = p.study_id WHERE p.id = ?`).get(id) as any;
  if (!p) throw new HttpError(404, 'Protocol not found');
  return p;
};

/** The mapping configuration a version was recorded against, so version comparisons can show mapping changes. */
function mappingSnapshot(studyId: string) {
  const release = db.prepare(`SELECT id, version FROM usdm_releases WHERE is_selected = 1`).get() as any;
  if (!release) return null;
  const rules = db
    .prepare(`SELECT id, version, status, source_entity, source_field, target_entity, target_property, scope_element_id FROM usdm_mapping_registry WHERE release_id = ? AND active = 1 AND (scope_study_id IS NULL OR scope_study_id = ?) ORDER BY id`)
    .all(release.id, studyId) as any[];
  const run = db.prepare(`SELECT id, status, review_status FROM usdm_mapping_runs WHERE study_id = ? ORDER BY created_at DESC LIMIT 1`).get(studyId) as any;
  return {
    releaseId: release.id,
    usdmVersion: release.version,
    rules: rules.map((r) => ({ id: r.id, version: Number(r.version), status: r.status, source: `${r.source_entity}.${r.source_field}`, target: `${r.target_entity ?? ''}.${r.target_property ?? ''}`, scopeElementId: r.scope_element_id })),
    latestRun: run ? { id: run.id, status: run.status, reviewStatus: run.review_status } : null,
  };
}

const toVersion = (r: any) => ({
  id: r.id,
  protocolId: r.protocol_id,
  revision: Number(r.revision),
  versionLabel: r.version_label,
  status: r.status,
  note: r.note,
  createdAt: r.created_at,
  amendmentNumber: r.amendment_number,
  changeReason: r.change_reason,
  authorId: r.author_id,
  authorName: userName(r.author_id),
  approvalStatus: r.approval_status as 'Recorded' | 'Pending Approval' | 'Approved' | 'Rejected',
  approvedBy: r.approved_by,
  approvedByName: userName(r.approved_by),
  approvedAt: r.approved_at,
  changeRequestId: r.change_request_id,
  contentHash: r.content_hash,
});

/** Records the current protocol state as a version with authorship, hash and mapping snapshot. */
export function createVersion(protocolId: string, note: string, opts: { changeReason?: string; approvalStatus?: 'Recorded' | 'Pending Approval'; authorId?: string; changeRequestId?: string } = {}) {
  const p = protocolRow(protocolId);
  return tx(() => {
    const v = createSnapshot(protocolId, note);
    const bundle = getSnapshot(protocolId, v.id);
    db.prepare(
      `UPDATE protocol_versions SET amendment_number = ?, change_reason = ?, author_id = ?, approval_status = ?, change_request_id = ?, content_hash = ?, mapping_snapshot_json = ? WHERE id = ?`,
    ).run(
      p.amendment_number ?? '',
      opts.changeReason ?? '',
      opts.authorId ?? currentActor().userId,
      opts.approvalStatus ?? 'Recorded',
      opts.changeRequestId ?? null,
      sha(bundle),
      JSON.stringify(mappingSnapshot(p.study_id)),
      v.id,
    );
    freezeVersions(protocolId);
    audit({ action: 'version.created', entityType: 'protocol_version', entityId: v.id, studyId: p.study_id, next: { protocolId, revision: v.revision, versionLabel: v.versionLabel, note, approvalStatus: opts.approvalStatus ?? 'Recorded' } });
    return getVersion(v.id);
  });
}

export function getVersion(id: string) {
  const r = db.prepare(`SELECT * FROM protocol_versions WHERE id = ?`).get(id);
  if (!r) throw new HttpError(404, 'Version not found');
  return toVersion(r);
}

export function listVersions(studyId: string) {
  if (!db.prepare(`SELECT 1 FROM studies WHERE id = ?`).get(studyId)) throw new HttpError(404, 'Study not found');
  const rows = db
    .prepare(`SELECT v.* FROM protocol_versions v JOIN protocols p ON p.id = v.protocol_id WHERE p.study_id = ? ORDER BY v.created_at DESC`)
    .all(studyId) as any[];
  const requests = listChangeRequests({ studyId });
  return { versions: rows.map(toVersion), changeRequests: requests };
}

/** The person accountable for the protocol content: the latest non-system author of an element change. */
function contentAuthor(protocolId: string): string | null {
  const r = db.prepare(`SELECT changed_by FROM element_versions WHERE protocol_id = ? AND changed_by != 'system' ORDER BY changed_at DESC LIMIT 1`).get(protocolId) as any;
  return r?.changed_by ?? null;
}

/**
 * Marking a protocol Final is its approval: repository validation applies, the approver must not be the latest
 * content author, and the resulting version is recorded as Approved (and is then immutable).
 */
export function finalise(protocolId: string, reason: string) {
  const p = protocolRow(protocolId);
  if (p.status === 'Final') throw new HttpError(409, 'Protocol is already Final');
  const report = validateProtocol(getBundle(protocolId));
  if (report.errors.length) throw new HttpError(422, `Cannot mark as Final: ${report.errors.length} validation error(s) must be resolved first.`);
  const actor = currentActor();
  const author = contentAuthor(protocolId);
  if (author && author === actor.userId) throw new HttpError(403, 'A protocol must be approved as Final by someone other than its latest author');
  return tx(() => {
    setStatus(protocolId, 'Final');
    const snap = db.prepare(`SELECT id FROM protocol_versions WHERE protocol_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(protocolId) as any;
    const bundle = getSnapshot(protocolId, snap.id);
    const t = now();
    db.prepare(
      `UPDATE protocol_versions SET author_id = ?, approval_status = 'Approved', approved_by = ?, approved_at = ?, change_reason = ?, amendment_number = ?, content_hash = ?, mapping_snapshot_json = ? WHERE id = ?`,
    ).run(author, actor.userId, t, reason ?? '', p.amendment_number ?? '', sha(bundle), JSON.stringify(mappingSnapshot(p.study_id)), snap.id);
    freezeVersions(protocolId);
    approvalRecord('protocol_version', snap.id, p.study_id, 'Approved', reason ?? '');
    audit({ action: 'protocol.approved', entityType: 'protocol', entityId: protocolId, studyId: p.study_id, previous: { status: p.status }, next: { status: 'Final', versionId: snap.id, revision: bundle.protocol.revision }, reason });
    return getVersion(snap.id);
  });
}

/** Submits a recorded version (e.g. an amendment draft milestone) for formal approval. */
export function requestVersionApproval(id: string, note: string) {
  const v = getVersion(id);
  if (v.approvalStatus !== 'Recorded' && v.approvalStatus !== 'Rejected') throw new HttpError(409, `Version is ${v.approvalStatus}`);
  const p = protocolRow(v.protocolId);
  tx(() => {
    db.prepare(`UPDATE protocol_versions SET approval_status = 'Pending Approval', author_id = COALESCE(author_id, ?) WHERE id = ?`).run(currentActor().userId, id);
    audit({ action: 'version.submitted', entityType: 'protocol_version', entityId: id, studyId: p.study_id, previous: { approvalStatus: v.approvalStatus }, next: { approvalStatus: 'Pending Approval' }, reason: note });
  });
  return getVersion(id);
}

/** Status changes other than Final. Leaving Final unlocks direct editing and therefore needs approval rights and a reason. */
export function changeStatus(protocolId: string, status: ProtocolStatus, reason: string) {
  const p = protocolRow(protocolId);
  if (status === 'Final') return { protocol: getBundle(protocolId).protocol, version: finalise(protocolId, reason) };
  if (p.status === 'Final') {
    assertCan(currentActor(), 'protocol.approve');
    if (!reason?.trim()) throw new HttpError(400, 'A reason is required to return a Final protocol to editing');
  }
  const protocol = setStatus(protocolId, status);
  audit({ action: p.status === 'Final' ? 'protocol.unlocked' : 'protocol.status', entityType: 'protocol', entityId: protocolId, studyId: p.study_id, previous: { status: p.status }, next: { status }, reason });
  return { protocol, version: null };
}

export function decideVersion(id: string, decision: 'Approved' | 'Rejected', comment: string) {
  const v = getVersion(id);
  const p = protocolRow(v.protocolId);
  if (v.approvalStatus !== 'Pending Approval') throw new HttpError(409, `Only versions pending approval can be ${decision.toLowerCase()} (this one is ${v.approvalStatus})`);
  const actor = currentActor();
  if (v.authorId === actor.userId) throw new HttpError(403, 'A version cannot be approved or rejected by its author');
  if (decision === 'Rejected' && !comment?.trim()) throw new HttpError(400, 'A rejection comment is required');
  const bundle = getSnapshot(v.protocolId, id);
  if (v.contentHash && sha(bundle) !== v.contentHash) throw new HttpError(409, 'Version content does not match its recorded hash');
  tx(() => {
    db.prepare(`UPDATE protocol_versions SET approval_status = ?, approved_by = ?, approved_at = ? WHERE id = ?`).run(decision, actor.userId, now(), id);
    approvalRecord('protocol_version', id, p.study_id, decision, comment ?? '');
    audit({ action: decision === 'Approved' ? 'version.approved' : 'version.rejected', entityType: 'protocol_version', entityId: id, studyId: p.study_id, previous: { approvalStatus: 'Pending Approval' }, next: { approvalStatus: decision }, reason: comment });
  });
  return getVersion(id);
}

export function compareVersions(protocolId: string, fromId: string, toId: string | 'current') {
  const from = getSnapshot(protocolId, fromId);
  const to = toId === 'current' ? getBundle(protocolId) : getSnapshot(protocolId, toId);
  const fromMap = (db.prepare(`SELECT mapping_snapshot_json FROM protocol_versions WHERE id = ?`).get(fromId) as any)?.mapping_snapshot_json;
  const toMap = toId === 'current' ? JSON.stringify(mappingSnapshot(protocolRow(protocolId).study_id)) : (db.prepare(`SELECT mapping_snapshot_json FROM protocol_versions WHERE id = ?`).get(toId) as any)?.mapping_snapshot_json;
  const a = fromMap ? JSON.parse(fromMap) : null;
  const b = toMap ? JSON.parse(toMap) : null;
  let mapping = null;
  if (a && b) {
    const am = new Map(a.rules.map((r: any) => [r.id, r]));
    const bm = new Map(b.rules.map((r: any) => [r.id, r]));
    mapping = {
      releaseChanged: a.releaseId !== b.releaseId,
      from: { releaseId: a.releaseId, latestRun: a.latestRun },
      to: { releaseId: b.releaseId, latestRun: b.latestRun },
      added: b.rules.filter((r: any) => !am.has(r.id)),
      removed: a.rules.filter((r: any) => !bm.has(r.id)),
      changed: b.rules
        .filter((r: any) => am.has(r.id) && ((am.get(r.id) as any).version !== r.version || (am.get(r.id) as any).status !== r.status))
        .map((r: any) => ({ id: r.id, source: r.source, target: r.target, from: { version: (am.get(r.id) as any).version, status: (am.get(r.id) as any).status }, to: { version: r.version, status: r.status } })),
    };
  }
  return { diff: diffBundles(from, to), mapping, from: { id: fromId, revision: from.protocol.revision }, to: { id: toId, revision: to.protocol.revision } };
}

// ---------- Change requests ----------

const toRequest = (r: any) => ({
  id: r.id,
  studyId: r.study_id,
  protocolId: r.protocol_id,
  title: r.title,
  justification: r.justification,
  status: r.status as ChangeRequestStatus,
  payload: JSON.parse(r.payload_json) as SaveRequest,
  baseRevision: Number(r.base_revision),
  validation: r.validation_json ? JSON.parse(r.validation_json) : null,
  diff: r.diff_json ? JSON.parse(r.diff_json) : null,
  proposedBy: r.proposed_by,
  proposedByName: userName(r.proposed_by),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  submittedAt: r.submitted_at,
  decidedBy: r.decided_by,
  decidedByName: userName(r.decided_by),
  decidedAt: r.decided_at,
  decisionComment: r.decision_comment,
  resultingVersionId: r.resulting_version_id,
});

export function listChangeRequests(f: { studyId?: string; protocolId?: string; status?: string }) {
  const where: string[] = [];
  const args: string[] = [];
  if (f.studyId) (where.push('study_id = ?'), args.push(f.studyId));
  if (f.protocolId) (where.push('protocol_id = ?'), args.push(f.protocolId));
  if (f.status) (where.push('status = ?'), args.push(f.status));
  return (db.prepare(`SELECT * FROM change_requests ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC`).all(...args) as any[]).map(toRequest);
}

export function getChangeRequest(id: string) {
  const r = db.prepare(`SELECT * FROM change_requests WHERE id = ?`).get(id);
  if (!r) throw new HttpError(404, 'Change request not found');
  return { ...toRequest(r), approvals: db.prepare(`SELECT * FROM approval_records WHERE entity_type = 'change_request' AND entity_id = ? ORDER BY created_at`).all(id) };
}

const cleanPayload = (p: any): SaveRequest => {
  if (!p || typeof p !== 'object') throw new HttpError(400, 'The proposed change is empty');
  const out: SaveRequest = {};
  if (p.meta && typeof p.meta === 'object') out.meta = p.meta;
  if (Array.isArray(p.subsections)) out.subsections = p.subsections.filter((s: any) => s && typeof s.id === 'string').map((s: any) => ({ id: s.id, content: s.content ?? {} }));
  for (const k of ['objectives', 'endpoints', 'arms', 'criteria'] as const) if (Array.isArray(p[k])) (out as any)[k] = p[k];
  if (p.soa && typeof p.soa === 'object') out.soa = p.soa;
  if (!Object.keys(out).length) throw new HttpError(400, 'The proposed change is empty');
  return out;
};

/** Applies the payload inside a rolled-back transaction to compute the diff and validation impact. */
function simulate(protocolId: string, payload: SaveRequest) {
  const before = getBundle(protocolId);
  const after = dryRun(() => {
    saveProtocol(protocolId, payload, { allowFinal: true });
    return getBundle(protocolId);
  }) as ProtocolBundle;
  const diff = diffBundles(before, after);
  const pre = validateProtocol(before);
  const post = validateProtocol(after);
  const known = new Set(pre.errors.map((e) => e.id));
  return {
    diff,
    validation: {
      errors: post.errors.length,
      warnings: post.warnings.length,
      newErrors: post.errors.filter((e) => !known.has(e.id)).map((e) => ({ id: e.id, rule: e.rule, message: e.message, location: e.location })),
      checkedAt: post.checkedAt,
    },
  };
}

export function createChangeRequest(input: { protocolId: string; title: string; justification: string; payload: unknown; submit?: boolean }) {
  const p = protocolRow(input.protocolId);
  if (!input.title?.trim()) throw new HttpError(400, 'A title is required');
  if (!input.justification?.trim()) throw new HttpError(400, 'A justification is required for every change request');
  const payload = cleanPayload(input.payload);
  const id = randomUUID();
  const t = now();
  tx(() => {
    db.prepare(
      `INSERT INTO change_requests (id, study_id, protocol_id, title, justification, status, payload_json, base_revision, proposed_by, created_at, updated_at) VALUES (?,?,?,?,?,'Draft',?,?,?,?,?)`,
    ).run(id, p.study_id, p.id, input.title.trim().slice(0, 300), input.justification.trim().slice(0, 4000), JSON.stringify(payload), Number(p.revision), currentActor().userId, t, t);
    audit({ action: 'change_request.created', entityType: 'change_request', entityId: id, studyId: p.study_id, next: { title: input.title, protocolId: p.id, baseRevision: Number(p.revision) }, reason: input.justification });
  });
  return input.submit ? submitChangeRequest(id) : getChangeRequest(id);
}

const requireOwnDraft = (id: string) => {
  const cr = getChangeRequest(id);
  if (cr.status !== 'Draft') throw new HttpError(409, `Change request is ${cr.status}`);
  if (cr.proposedBy !== currentActor().userId) throw new HttpError(403, 'Only the proposer can modify a draft change request');
  return cr;
};

export function updateChangeRequest(id: string, patch: { title?: string; justification?: string; payload?: unknown }) {
  const cr = requireOwnDraft(id);
  const p = protocolRow(cr.protocolId);
  const next = {
    title: patch.title !== undefined ? patch.title.trim().slice(0, 300) : cr.title,
    justification: patch.justification !== undefined ? patch.justification.trim().slice(0, 4000) : cr.justification,
    payload: patch.payload !== undefined ? cleanPayload(patch.payload) : cr.payload,
  };
  if (!next.title || !next.justification) throw new HttpError(400, 'Title and justification are required');
  tx(() => {
    db.prepare(`UPDATE change_requests SET title = ?, justification = ?, payload_json = ?, base_revision = ?, updated_at = ? WHERE id = ?`).run(next.title, next.justification, JSON.stringify(next.payload), Number(p.revision), now(), id);
    audit({ action: 'change_request.updated', entityType: 'change_request', entityId: id, studyId: cr.studyId, previous: { title: cr.title, justification: cr.justification }, next: { title: next.title, justification: next.justification } });
  });
  return getChangeRequest(id);
}

export function submitChangeRequest(id: string) {
  const cr = requireOwnDraft(id);
  const p = protocolRow(cr.protocolId);
  if (Number(p.revision) !== cr.baseRevision) throw new HttpError(409, 'The protocol changed since this request was drafted. Update the request against the current version.');
  const sim = simulate(cr.protocolId, cr.payload);
  if (!sim.diff.elements.length && !sim.diff.relations.length) throw new HttpError(400, 'The proposed change does not modify the protocol');
  const blocked = sim.validation.newErrors.length > 0;
  tx(() => {
    db.prepare(`UPDATE change_requests SET validation_json = ?, diff_json = ?, status = ?, submitted_at = ?, updated_at = ? WHERE id = ?`).run(
      JSON.stringify(sim.validation),
      JSON.stringify(sim.diff),
      blocked ? 'Draft' : 'Pending Review',
      blocked ? null : now(),
      now(),
      id,
    );
    audit({ action: blocked ? 'change_request.validation_failed' : 'change_request.submitted', entityType: 'change_request', entityId: id, studyId: cr.studyId, next: { validation: sim.validation, changedElements: sim.diff.elements.length } });
  });
  if (blocked) throw Object.assign(new HttpError(422, `The proposed change introduces ${sim.validation.newErrors.length} validation error(s) and was not submitted.`), { details: sim.validation });
  return getChangeRequest(id);
}

export function approveChangeRequest(id: string, comment: string) {
  const cr = getChangeRequest(id);
  if (cr.status !== 'Pending Review') throw new HttpError(409, `Only requests pending review can be approved (this one is ${cr.status})`);
  const actor = currentActor();
  if (cr.proposedBy === actor.userId) throw new HttpError(403, 'A change request cannot be approved by its proposer');
  const p = protocolRow(cr.protocolId);
  if (Number(p.revision) !== cr.baseRevision) throw new HttpError(409, 'The protocol changed after this request was submitted; it must be re-drafted and re-validated.');
  const sim = simulate(cr.protocolId, cr.payload);
  if (sim.validation.newErrors.length) throw new HttpError(422, 'The change no longer validates against the current protocol');
  return tx(() => {
    const before = getBundle(cr.protocolId);
    saveProtocol(cr.protocolId, cr.payload, { allowFinal: true });
    const after = getBundle(cr.protocolId);
    record('change_request.applied', before, after, { author: cr.proposedBy, reviewer: actor.userId, reviewStatus: 'Approved', changeRequestId: id, reason: cr.justification, silent: true });
    const version = createVersion(cr.protocolId, `Change request approved: ${cr.title}`, { changeReason: cr.justification, authorId: cr.proposedBy, changeRequestId: id });
    db.prepare(`UPDATE protocol_versions SET approval_status = 'Approved', approved_by = ?, approved_at = ? WHERE id = ?`).run(actor.userId, now(), version.id);
    db.prepare(`UPDATE change_requests SET status = 'Approved', decided_by = ?, decided_at = ?, decision_comment = ?, resulting_version_id = ?, updated_at = ? WHERE id = ?`).run(actor.userId, now(), comment ?? '', version.id, now(), id);
    approvalRecord('change_request', id, cr.studyId, 'Approved', comment ?? '');
    approvalRecord('protocol_version', version.id, cr.studyId, 'Approved', `Approved through change request ${cr.title}`);
    audit({ action: 'change_request.approved', entityType: 'change_request', entityId: id, studyId: cr.studyId, previous: { status: 'Pending Review', revision: before.protocol.revision }, next: { status: 'Approved', revision: after.protocol.revision, versionId: version.id, changedElements: sim.diff.elements.length }, reason: comment || cr.justification });
    return getChangeRequest(id);
  });
}

export function rejectChangeRequest(id: string, comment: string) {
  const cr = getChangeRequest(id);
  if (cr.status !== 'Pending Review') throw new HttpError(409, `Only requests pending review can be rejected (this one is ${cr.status})`);
  if (!comment?.trim()) throw new HttpError(400, 'A rejection comment is required');
  const actor = currentActor();
  if (cr.proposedBy === actor.userId) throw new HttpError(403, 'A change request cannot be rejected by its proposer');
  tx(() => {
    db.prepare(`UPDATE change_requests SET status = 'Rejected', decided_by = ?, decided_at = ?, decision_comment = ?, updated_at = ? WHERE id = ?`).run(actor.userId, now(), comment.trim(), now(), id);
    approvalRecord('change_request', id, cr.studyId, 'Rejected', comment.trim());
    audit({ action: 'change_request.rejected', entityType: 'change_request', entityId: id, studyId: cr.studyId, previous: { status: 'Pending Review' }, next: { status: 'Rejected' }, reason: comment.trim() });
  });
  return getChangeRequest(id);
}

export function withdrawChangeRequest(id: string) {
  const cr = getChangeRequest(id);
  if (!['Draft', 'Pending Review'].includes(cr.status)) throw new HttpError(409, `Change request is ${cr.status}`);
  if (cr.proposedBy !== currentActor().userId) throw new HttpError(403, 'Only the proposer can withdraw a change request');
  tx(() => {
    db.prepare(`UPDATE change_requests SET status = 'Withdrawn', updated_at = ? WHERE id = ?`).run(now(), id);
    audit({ action: 'change_request.withdrawn', entityType: 'change_request', entityId: id, studyId: cr.studyId, previous: { status: cr.status }, next: { status: 'Withdrawn' } });
  });
  return getChangeRequest(id);
}
