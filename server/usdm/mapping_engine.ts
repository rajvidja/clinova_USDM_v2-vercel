import { randomUUID } from 'node:crypto';
import type { MappingStatus } from '../../shared/governance.ts';
import { audit } from '../audit.ts';
import { currentActor } from '../context.ts';
import { db, tx } from '../db.ts';
import { HttpError } from '../repo.ts';
import { assembleV4, type AssemblyIssue, type ElementTarget } from './assembler_v4.ts';
import { mapEntities, type FieldResult } from './entity_mapper.ts';
import { loadInternalModel, type ElementRef } from './internal_model.ts';
import { rulesForRun } from './mapping_registry.ts';
import type { RelationshipRecord } from './relationship_mapper.ts';
import { validateUsdm, type ValidationReport } from './schema_validator.ts';
import { CONFORMANCE_NOTE, SUPPORTED_MAJOR_VERSIONS } from './usdm_config.ts';
import { resolveRelease, type LoadedRelease } from './usdm_version.ts';

// Orchestrates the mapping pipeline:
//   internal model -> mapping rules engine -> entity transformation (+ relationships) -> schema validation -> report.
// Each stage is a separate module and can be exercised on its own; runMapping() wires them together. Stored runs
// are reviewed (approved/rejected) before an export can use them.

export interface RecordReport {
  recordId: string;
  elementId: string;
  entity: string;
  label: string;
  reviewStatus: string;
  mappingStatus: MappingStatus;
  statusReason: string;
  usdm: { id: string; cls: string }[];
  fields: FieldResult[];
}

export interface MappingReport {
  release: { id: string; version: string };
  studyId: string;
  protocolId: string;
  protocolRevision: number;
  includePending: boolean;
  generatedAt: string;
  generatedBy: string;
  counts: {
    elements: number;
    mapped: number;
    requiresReview: number;
    validated: number;
    notMapped: number;
    rejected: number;
    fieldsMapped: number;
    fieldsProvisional: number;
    fieldsUnmapped: number;
    unsupported: number;
    needsConfiguration: number;
    terminologyIssues: number;
    schemaErrors: number;
    referenceErrors: number;
    assemblyErrors: number;
    warnings: number;
  };
  records: RecordReport[];
  issues: AssemblyIssue[];
  relationships: { summary: Record<string, { created: number; blocked: number; invalid: number; duplicate: number }>; problems: RelationshipRecord[] };
  validation: ValidationReport;
  pending: { excluded: ElementRef[]; included: ElementRef[]; blocking: ElementRef[] };
  valid: boolean;
  conformance: { label: string; schemaValid: boolean; referencesValid: boolean; coreRulesExecuted: false; note: string };
}

export interface PipelineResult {
  output: Record<string, any>;
  report: MappingReport;
}

export function conformanceLabel(release: { version: string }, schemaValid: boolean, referencesValid: boolean) {
  if (schemaValid && referencesValid) return `USDM ${release.version} schema-valid (official API schema and referential integrity). CDISC CORE rules not executed.`;
  return `Not valid against the USDM ${release.version} schema`;
}

const UNMAPPED: FieldResult['outcome'][] = ['empty', 'unconverted', 'unsupported', 'needs-config', 'terminology-review', 'no-equivalent', 'rule-inactive'];
const REVIEW: FieldResult['outcome'][] = ['needs-config', 'terminology-review', 'unconverted', 'provisional'];

function recordStatus(t: ElementTarget | undefined, fields: FieldResult[], errors: AssemblyIssue[], excluded: boolean): { status: MappingStatus; reason: string } {
  if (excluded) return { status: 'Not Mapped', reason: 'Excluded: element is not approved (run without pending elements)' };
  if (t?.reviewStatus === 'Rejected') return { status: 'Rejected', reason: 'Element was rejected in review' };
  if (!t || t.status === 'omitted' || !t.usdm.length) return { status: 'Not Mapped', reason: t?.reason ?? 'No USDM object was produced' };
  const blocking = fields.filter((f) => REVIEW.includes(f.outcome));
  if (errors.length) return { status: 'Requires Review', reason: errors[0].message };
  if (blocking.length) return { status: 'Requires Review', reason: `${blocking.length} field(s) need review: ${blocking[0].targetEntity}.${blocking[0].targetProperty} (${blocking[0].outcome})` };
  const applied = fields.filter((f) => f.outcome === 'mapped');
  if (applied.length && applied.every((f) => f.ruleStatus === 'Validated')) return { status: 'Validated', reason: 'All applied mapping rules are validated' };
  return { status: 'Mapped', reason: 'Mapped by active rules' };
}

/** Runs the full pipeline for one protocol without storing anything except newly seen terminology values. */
export function runPipeline(protocolId: string, opts: { releaseId?: string | null; includePending?: boolean } = {}): PipelineResult {
  const release = resolveRelease(opts.releaseId);
  const major = release.version.split('.')[0];
  if (!SUPPORTED_MAJOR_VERSIONS.includes(major)) throw new HttpError(409, `ProtocolIQ cannot assemble USDM ${release.version} (no structural assembler for major version ${major})`);
  const includePending = !!opts.includePending;
  const model = loadInternalModel(protocolId, includePending);
  const rules = rulesForRun(release.id, model.studyId);
  const mapped = mapEntities(model, release, rules);
  const assembly = assembleV4(release, model, mapped);
  const validation = validateUsdm(release, assembly.wrapper);
  return { output: assembly.wrapper, report: buildReport(release, model, mapped, assembly, validation) };
}

function buildReport(
  release: LoadedRelease,
  model: ReturnType<typeof loadInternalModel>,
  mapped: ReturnType<typeof mapEntities>,
  assembly: ReturnType<typeof assembleV4>,
  validation: ValidationReport,
): MappingReport {
  const targets = new Map(assembly.targets.map((t) => [t.recordId, t]));
  const errorsByElement = new Map<string, AssemblyIssue[]>();
  for (const i of assembly.issues) if (i.level === 'error' && i.elementId) errorsByElement.set(i.elementId, [...(errorsByElement.get(i.elementId) ?? []), i]);
  const records: RecordReport[] = [];
  for (const m of mapped.records.values()) {
    const t = targets.get(m.record.id);
    const s = recordStatus(t, m.fields, errorsByElement.get(m.record.elementId) ?? [], false);
    records.push({ recordId: m.record.id, elementId: m.record.elementId, entity: m.record.entity, label: m.record.label, reviewStatus: m.record.reviewStatus, mappingStatus: s.status, statusReason: s.reason, usdm: t?.usdm ?? [], fields: m.fields });
  }
  for (const x of model.excluded)
    records.push({ recordId: x.elementId, elementId: x.elementId, entity: x.type === 'subsection' ? 'section' : x.type, label: x.label, reviewStatus: x.reviewStatus, mappingStatus: 'Not Mapped', statusReason: 'Excluded: element is not approved', usdm: [], fields: [] });

  const allFields = records.flatMap((r) => r.fields);
  const count = (s: MappingStatus) => records.filter((r) => r.mappingStatus === s).length;
  const assemblyErrors = assembly.issues.filter((i) => i.level === 'error').length;
  const blocking = model.blockingPending.length > 0;
  const valid = validation.schemaValid && validation.referencesValid && !blocking;
  return {
    release: { id: release.id, version: release.version },
    studyId: model.studyId,
    protocolId: model.protocolId,
    protocolRevision: model.revision,
    includePending: model.includePending,
    generatedAt: new Date().toISOString(),
    generatedBy: currentActor().userId,
    counts: {
      elements: records.length,
      mapped: count('Mapped'),
      requiresReview: count('Requires Review'),
      validated: count('Validated'),
      notMapped: count('Not Mapped'),
      rejected: count('Rejected'),
      fieldsMapped: allFields.filter((f) => f.outcome === 'mapped').length,
      fieldsProvisional: allFields.filter((f) => f.outcome === 'provisional').length,
      fieldsUnmapped: allFields.filter((f) => UNMAPPED.includes(f.outcome)).length,
      unsupported: allFields.filter((f) => f.outcome === 'unsupported').length,
      needsConfiguration: allFields.filter((f) => f.outcome === 'needs-config').length,
      terminologyIssues: allFields.filter((f) => f.outcome === 'terminology-review').length,
      schemaErrors: validation.schemaErrors.length,
      referenceErrors: validation.referenceErrors.length + validation.duplicateIds.length,
      assemblyErrors,
      warnings: assembly.issues.filter((i) => i.level === 'warning').length + validation.cardinalityWarnings.length,
    },
    records,
    issues: [
      ...assembly.issues,
      ...model.blockingPending.map((b) => ({ level: 'error' as const, code: 'root-pending', message: `${b.label} is ${b.reviewStatus}. Approve it, or run with pending elements included.`, elementId: b.elementId })),
    ],
    relationships: { summary: assembly.relationshipSummary, problems: assembly.relationships.filter((r) => r.status !== 'created') },
    validation,
    pending: { excluded: model.excluded, included: model.pendingIncluded, blocking: model.blockingPending },
    valid,
    conformance: { label: conformanceLabel(release, validation.schemaValid, validation.referencesValid), schemaValid: validation.schemaValid, referencesValid: validation.referencesValid, coreRulesExecuted: false, note: CONFORMANCE_NOTE },
  };
}

// ---------- Stored runs ----------

export interface RunSummary {
  id: string;
  releaseId: string;
  releaseVersion: string;
  studyId: string;
  protocolId: string;
  protocolRevision: number;
  includePending: boolean;
  status: 'valid' | 'invalid';
  schemaErrors: number;
  referenceErrors: number;
  unmapped: number;
  reviewStatus: 'Pending Review' | 'Approved' | 'Rejected';
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewComment: string | null;
  createdBy: string;
  createdAt: string;
  stale: boolean;
  staleReason: string | null;
  counts?: MappingReport['counts'];
}

/** A run is stale when the protocol, the release's mapping rules or its terminology changed after it was produced. */
function staleness(r: any): string | null {
  const p = db.prepare(`SELECT revision FROM protocols WHERE id = ?`).get(r.protocol_id) as { revision: number } | undefined;
  if (!p) return 'Protocol no longer exists';
  if (Number(p.revision) !== Number(r.protocol_revision)) return `Protocol changed (revision ${r.protocol_revision} → ${p.revision})`;
  const m = db
    .prepare(`SELECT MAX(updated_at) AS t FROM usdm_mapping_registry WHERE release_id = ? AND (scope_study_id IS NULL OR scope_study_id = ?)`)
    .get(r.release_id, r.study_id) as { t: string | null };
  if (m.t && m.t > r.created_at) return 'Mapping rules changed after this run';
  const t = db.prepare(`SELECT MAX(COALESCE(reviewed_at, updated_at)) AS t FROM usdm_terminology WHERE release_id = ? AND (updated_by != 'system' OR reviewed_at IS NOT NULL)`).get(r.release_id) as { t: string | null };
  if (t.t && t.t > r.created_at) return 'Terminology mappings changed after this run';
  const rv = db.prepare(`SELECT MAX(reviewed_at) AS t FROM lineage_records WHERE protocol_id = ?`).get(r.protocol_id) as { t: string | null };
  if (!r.include_pending && rv.t && rv.t > r.created_at) return 'Element review decisions changed after this run';
  return null;
}

const toRun = (r: any, withCounts = false): RunSummary => {
  const stale = staleness(r);
  return {
    id: r.id,
    releaseId: r.release_id,
    releaseVersion: r.release_version ?? r.release_id.replace(/^usdm-/, ''),
    studyId: r.study_id,
    protocolId: r.protocol_id,
    protocolRevision: Number(r.protocol_revision),
    includePending: !!r.include_pending,
    status: r.status,
    schemaErrors: Number(r.schema_errors),
    referenceErrors: Number(r.reference_errors),
    unmapped: Number(r.unmapped),
    reviewStatus: r.review_status,
    reviewedBy: r.reviewed_by,
    reviewedAt: r.reviewed_at,
    reviewComment: r.review_comment,
    createdBy: r.created_by,
    createdAt: r.created_at,
    stale: !!stale,
    staleReason: stale,
    counts: withCounts ? (JSON.parse(r.report_json).counts as MappingReport['counts']) : undefined,
  };
};

export function latestProtocolFor(studyId: string): string {
  const row = db.prepare(`SELECT id FROM protocols WHERE study_id = ? ORDER BY updated_at DESC LIMIT 1`).get(studyId) as { id: string } | undefined;
  if (!row) throw new HttpError(404, 'Study not found');
  return row.id;
}

export function resolveProtocol(studyId: string, protocolId?: string | null) {
  if (!protocolId) return latestProtocolFor(studyId);
  const row = db.prepare(`SELECT study_id FROM protocols WHERE id = ?`).get(protocolId) as { study_id: string } | undefined;
  if (!row || row.study_id !== studyId) throw new HttpError(404, 'Protocol not found for this study');
  return protocolId;
}

export function mapStudy(studyId: string, opts: { protocolId?: string | null; releaseId?: string | null; includePending?: boolean }) {
  const protocolId = resolveProtocol(studyId, opts.protocolId);
  const { output, report } = runPipeline(protocolId, opts);
  const actor = currentActor();
  const id = randomUUID();
  tx(() => {
    db.prepare(
      `INSERT INTO usdm_mapping_runs (id, release_id, study_id, protocol_id, protocol_revision, include_pending, status, output_json, report_json, schema_errors, reference_errors, unmapped, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      report.release.id,
      studyId,
      protocolId,
      report.protocolRevision,
      report.includePending ? 1 : 0,
      report.valid ? 'valid' : 'invalid',
      JSON.stringify(output),
      JSON.stringify(report),
      report.counts.schemaErrors,
      report.counts.referenceErrors,
      report.counts.fieldsUnmapped,
      actor.userId,
      report.generatedAt,
    );
    // Lineage: which USDM entities each element became in this run.
    const upd = db.prepare(`UPDATE lineage_records SET usdm_entity = ?, usdm_mapping_id = ?, usdm_run_id = ? WHERE element_id = ?`);
    for (const r of report.records) {
      if (!r.usdm.length) continue;
      const primary = r.fields.find((f) => f.outcome === 'mapped' || f.outcome === 'provisional');
      upd.run([...new Set(r.usdm.map((u) => u.cls))].join(', '), primary?.ruleId ?? null, id, r.elementId);
    }
    audit({
      action: 'usdm.mapping.run',
      entityType: 'usdm_run',
      entityId: id,
      studyId,
      next: { protocolId, release: report.release.version, includePending: report.includePending, valid: report.valid, counts: report.counts },
    });
  });
  return getRun(id);
}

export function getRun(id: string) {
  const r = db.prepare(`SELECT r.*, u.version AS release_version FROM usdm_mapping_runs r JOIN usdm_releases u ON u.id = r.release_id WHERE r.id = ?`).get(id) as any;
  if (!r) throw new HttpError(404, 'Mapping run not found');
  return { ...toRun(r, true), report: JSON.parse(r.report_json) as MappingReport, output: JSON.parse(r.output_json) as Record<string, any> };
}

export function listRuns(f: { studyId?: string; protocolId?: string; page?: number; pageSize?: number }) {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.studyId) (where.push('r.study_id = ?'), args.push(f.studyId));
  if (f.protocolId) (where.push('r.protocol_id = ?'), args.push(f.protocolId));
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM usdm_mapping_runs r ${w}`).get(...args) as { n: number }).n);
  const pageSize = Math.min(Math.max(Number(f.pageSize) || 20, 1), 100);
  const page = Math.max(Number(f.page) || 1, 1);
  const rows = db
    .prepare(
      `SELECT r.id, r.release_id, r.study_id, r.protocol_id, r.protocol_revision, r.include_pending, r.status, r.schema_errors, r.reference_errors, r.unmapped, r.review_status, r.reviewed_by, r.reviewed_at,
              r.review_comment, r.created_by, r.created_at, r.report_json, u.version AS release_version
       FROM usdm_mapping_runs r JOIN usdm_releases u ON u.id = r.release_id ${w} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...args, pageSize, (page - 1) * pageSize) as any[];
  return { items: rows.map((r) => toRun(r, true)), total, page, pageSize };
}

export function reviewRun(id: string, decision: 'Approved' | 'Rejected', comment: string) {
  const run = db.prepare(`SELECT * FROM usdm_mapping_runs WHERE id = ?`).get(id) as any;
  if (!run) throw new HttpError(404, 'Mapping run not found');
  const actor = currentActor();
  if (run.review_status !== 'Pending Review') throw new HttpError(409, `This run was already ${run.review_status.toLowerCase()}`);
  if (decision === 'Rejected' && !comment?.trim()) throw new HttpError(400, 'A comment is required when rejecting a mapping run');
  if (run.created_by === actor.userId) throw new HttpError(403, 'A mapping run must be reviewed by someone other than the person who ran it');
  if (decision === 'Approved') {
    if (run.status !== 'valid') throw new HttpError(409, 'Only a run that passes schema and reference validation can be approved');
    const stale = staleness(run);
    if (stale) throw new HttpError(409, `This run is out of date: ${stale}. Run the mapping again.`);
  }
  const t = new Date().toISOString();
  tx(() => {
    db.prepare(`UPDATE usdm_mapping_runs SET review_status = ?, reviewed_by = ?, reviewed_at = ?, review_comment = ? WHERE id = ?`).run(decision, actor.userId, t, comment ?? '', id);
    db.prepare(`INSERT INTO approval_records (id, entity_type, entity_id, study_id, decision, decided_by, comment, created_at) VALUES (?,?,?,?,?,?,?,?)`).run(
      randomUUID(),
      'usdm_run',
      id,
      run.study_id,
      decision,
      actor.userId,
      comment ?? '',
      t,
    );
    audit({ action: decision === 'Approved' ? 'usdm.run.approved' : 'usdm.run.rejected', entityType: 'usdm_run', entityId: id, studyId: run.study_id, previous: { reviewStatus: run.review_status }, next: { reviewStatus: decision }, reason: comment });
  });
  return getRun(id);
}

/** Latest run of a protocol, or null. */
export function latestRun(protocolId: string) {
  const r = db.prepare(`SELECT id FROM usdm_mapping_runs WHERE protocol_id = ? ORDER BY created_at DESC LIMIT 1`).get(protocolId) as { id: string } | undefined;
  return r ? getRun(r.id) : null;
}
