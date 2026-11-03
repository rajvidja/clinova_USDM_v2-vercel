import { createHash, randomUUID } from 'node:crypto';
import { audit } from '../audit.ts';
import { currentActor } from '../context.ts';
import { db, tx } from '../db.ts';
import { HttpError } from '../repo.ts';
import { getRun, resolveProtocol } from './mapping_engine.ts';
import { loadRelease } from './usdm_version.ts';

// Pipeline stage 6: USDM JSON export. Only an approved, valid and current mapping run can be exported, and only
// when no critical governance issue for the protocol is open. Every attempt (exported or refused) is recorded.
// The conformance label never claims more than the checks that ran: schema + referential integrity, CORE not run.

export interface ExportRecord {
  id: string;
  runId: string | null;
  releaseId: string;
  releaseVersion: string;
  studyId: string;
  protocolId: string;
  protocolRevision: number | null;
  status: 'exported' | 'rejected';
  conformanceLabel: string;
  validation: any;
  fileSha256: string | null;
  reason: string;
  exportedBy: string;
  exportedAt: string;
}

const toExport = (r: any): ExportRecord => ({
  id: r.id,
  runId: r.run_id,
  releaseId: r.release_id,
  releaseVersion: r.release_version,
  studyId: r.study_id,
  protocolId: r.protocol_id,
  protocolRevision: r.protocol_revision,
  status: r.status,
  conformanceLabel: r.conformance_label,
  validation: JSON.parse(r.validation_json),
  fileSha256: r.file_sha256,
  reason: r.reason,
  exportedBy: r.exported_by,
  exportedAt: r.exported_at,
});

/** Blocking reasons for exporting a run; empty when it can be exported. */
export function exportBlockers(run: ReturnType<typeof getRun>): string[] {
  const out: string[] = [];
  const rel = loadRelease(run.releaseId);
  if (rel.status !== 'Active') out.push(`USDM release ${rel.version} is inactive`);
  if (run.status !== 'valid') out.push(`Run is not valid: ${run.schemaErrors} schema error(s), ${run.referenceErrors} reference error(s)${run.report.pending.blocking.length ? ', root elements pending review' : ''}`);
  if (run.reviewStatus !== 'Approved') out.push(`Run is ${run.reviewStatus.toLowerCase()}; a reviewer must approve it before export`);
  if (run.stale) out.push(`Run is out of date: ${run.staleReason}`);
  const critical = db
    .prepare(`SELECT COUNT(*) AS n FROM governance_issues WHERE protocol_id = ? AND severity = 'Critical' AND status NOT IN ('Resolved','Accepted Exception')`)
    .get(run.protocolId) as { n: number };
  if (critical.n) out.push(`${critical.n} critical data-quality issue(s) are open for this protocol`);
  // Critical schema findings can never be waived by an exception: the run itself must validate.
  return out;
}

function chooseRun(studyId: string, opts: { runId?: string | null; protocolId?: string | null }) {
  if (opts.runId) {
    const run = getRun(opts.runId);
    if (run.studyId !== studyId) throw new HttpError(404, 'Mapping run not found for this study');
    return run;
  }
  const protocolId = resolveProtocol(studyId, opts.protocolId);
  const row = db.prepare(`SELECT id FROM usdm_mapping_runs WHERE protocol_id = ? AND review_status = 'Approved' ORDER BY created_at DESC LIMIT 1`).get(protocolId) as { id: string } | undefined;
  if (!row) {
    const any = db.prepare(`SELECT id FROM usdm_mapping_runs WHERE protocol_id = ? ORDER BY created_at DESC LIMIT 1`).get(protocolId) as { id: string } | undefined;
    if (!any) throw new HttpError(409, 'This study has not been mapped to USDM yet. Run the mapping first.');
    return getRun(any.id);
  }
  return getRun(row.id);
}

export function exportStudy(studyId: string, opts: { runId?: string | null; protocolId?: string | null }) {
  const run = chooseRun(studyId, opts);
  const blockers = exportBlockers(run);
  const actor = currentActor();
  const id = randomUUID();
  const t = new Date().toISOString();
  const pending = run.report.pending.included.length;
  const label = blockers.length
    ? `Not exported: ${run.report.conformance.label}`
    : `${run.report.conformance.label}${pending ? ` Includes ${pending} element(s) not yet approved in element review.` : ''}`;
  const body = blockers.length ? null : JSON.stringify(run.output, null, 2);
  const sha = body ? createHash('sha256').update(body).digest('hex') : null;
  const validation = {
    schemaValid: run.report.validation.schemaValid,
    referencesValid: run.report.validation.referencesValid,
    schemaErrors: run.report.validation.schemaErrors.length,
    referenceErrors: run.report.validation.referenceErrors.length,
    cardinalityWarnings: run.report.validation.cardinalityWarnings.length,
    coreRulesExecuted: false,
    blockers,
  };
  tx(() => {
    db.prepare(
      `INSERT INTO usdm_export_records (id, run_id, release_id, release_version, study_id, protocol_id, protocol_revision, status, conformance_label, validation_json, file_sha256, reason, exported_by, exported_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, run.id, run.releaseId, run.releaseVersion, studyId, run.protocolId, run.protocolRevision, blockers.length ? 'rejected' : 'exported', label, JSON.stringify(validation), sha, blockers.join('; '), actor.userId, t);
    audit({ action: blockers.length ? 'usdm.export.rejected' : 'usdm.exported', entityType: 'usdm_export', entityId: id, studyId, next: { runId: run.id, release: run.releaseVersion, sha256: sha, blockers } });
  });
  const record = toExport(db.prepare(`SELECT * FROM usdm_export_records WHERE id = ?`).get(id));
  if (blockers.length) throw Object.assign(new HttpError(409, `USDM export refused: ${blockers.join('; ')}`), { record });
  return { record, body: body!, filename: `${run.output.study?.name ?? 'study'}_USDM_${run.releaseVersion}.json`.replace(/[^A-Za-z0-9._-]+/g, '_') };
}

/** Re-downloads a previous export; the stored run output is immutable, and the hash is re-checked. */
export function exportFile(exportId: string) {
  const r = db.prepare(`SELECT * FROM usdm_export_records WHERE id = ?`).get(exportId) as any;
  if (!r || r.status !== 'exported') throw new HttpError(404, 'Export not found');
  const run = getRun(r.run_id);
  const body = JSON.stringify(run.output, null, 2);
  if (createHash('sha256').update(body).digest('hex') !== r.file_sha256) throw new HttpError(500, 'Stored export does not match its recorded checksum');
  return { record: toExport(r), body, filename: `${run.output.study?.name ?? 'study'}_USDM_${r.release_version}.json`.replace(/[^A-Za-z0-9._-]+/g, '_') };
}

export function listExports(f: { studyId?: string; status?: string; page?: number; pageSize?: number }) {
  const conds: string[] = [];
  const args: string[] = [];
  if (f.studyId) (conds.push('study_id = ?'), args.push(f.studyId));
  if (f.status) (conds.push('status = ?'), args.push(f.status));
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const pageSize = Math.min(Math.max(Number(f.pageSize) || 20, 1), 100);
  const page = Math.max(Number(f.page) || 1, 1);
  const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM usdm_export_records ${where}`).get(...args) as { n: number }).n);
  const items = (db.prepare(`SELECT * FROM usdm_export_records ${where} ORDER BY exported_at DESC LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize) as any[]).map(toExport);
  return { items, total, page, pageSize };
}
