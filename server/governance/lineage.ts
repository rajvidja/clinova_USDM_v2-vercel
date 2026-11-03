import { createHash, randomUUID } from 'node:crypto';
import { canonical, diffFlat, flattenBundle, type ElementChange, type FlatProtocol, type StudyElement } from '../../shared/elements.ts';
import type { LineageRecord } from '../../shared/governance.ts';
import type { ProtocolBundle } from '../../shared/types.ts';
import { audit } from '../audit.ts';
import { currentActor } from '../context.ts';
import { db, tx } from '../db.ts';
import { getBundle, HttpError } from '../repo.ts';

// Every change to a protocol is recorded here: a per-element version history, a lineage record per element
// (source, extraction method, authorship, review status) and one audit entry describing the change set.

export interface Provenance {
  sourceType: 'builder' | 'digitisation' | 'ocr';
  sourceDocumentId?: string | null;
  extractionMethod: string;
  /** Per-element source location, keyed by element id. */
  elements?: Record<string, { section?: string; text?: string; page?: number | null }>;
}

export interface TrackOptions {
  reason?: string | null;
  provenance?: Provenance;
  changeRequestId?: string | null;
  /** Element authorship when it differs from the acting user (e.g. an approved change request). */
  author?: string;
  /** Review status for the changed elements (default Pending). */
  reviewStatus?: 'Pending' | 'Approved';
  reviewer?: string;
  /** Skip the audit entry (callers that write a more specific one). */
  silent?: boolean;
}

/** Working versions by the same user within this window are coalesced (autosave), unless frozen by a snapshot. */
const COALESCE_MS = 10 * 60_000;
const now = () => new Date().toISOString();
const hash = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex').slice(0, 32);

const safeBundle = (id: string): ProtocolBundle | null => {
  try {
    return getBundle(id);
  } catch {
    return null;
  }
};

/** Wraps a repository mutation so its effect on study elements is versioned, traced and audited. */
export async function track<T>(action: string, protocolId: string | null, fn: () => T | Promise<T>, opts: TrackOptions & { resultProtocolId?: (r: T) => string } = {}): Promise<T> {
  const before = protocolId ? safeBundle(protocolId) : null;
  const result = await fn();
  const pid = protocolId ?? opts.resultProtocolId?.(result) ?? null;
  if (!pid) return result;
  const after = safeBundle(pid);
  record(action, before, after, opts);
  return result;
}

/** Records every element of a newly created protocol with its provenance (Builder, document digitisation or OCR). */
export function recordCreation(action: string, protocolId: string, provenance: Provenance, reason?: string) {
  return record(action, null, getBundle(protocolId), { provenance, reason });
}

export function record(action: string, before: ProtocolBundle | null, after: ProtocolBundle | null, opts: TrackOptions = {}) {
  const a = before ? flattenBundle(before) : null;
  const b = after ? flattenBundle(after) : null;
  const diff = diffFlat(a, b);
  const ref = (after ?? before)!;
  const studyId = ref.study.id;
  const protocolId = ref.protocol.id;
  if (!diff.elements.length && !diff.relations.length && !opts.reason && action !== 'protocol.deleted') return diff;
  const actor = currentActor();
  const author = opts.author ?? actor.userId;
  tx(() => {
    const t = now();
    for (const c of diff.elements) writeVersion(c, b ?? a!, protocolId, studyId, author, t, opts);
    // Relationship changes count as a modification of the dependent element (endpoint links, SoA cells).
    const touched = new Set(diff.elements.map((e) => e.id));
    for (const r of diff.relations) {
      const owner = r.relation.kind === 'objective-endpoint' ? r.relation.to : r.relation.from;
      if (touched.has(owner) || !b?.elements.has(owner)) continue;
      touched.add(owner);
      const el = b.elements.get(owner)!;
      writeVersion({ id: owner, type: el.type, label: el.label, change: 'modified', fields: [{ field: 'relationships', before: null, after: null }], after: el.content }, b, protocolId, studyId, author, t, opts);
    }
    if (!opts.silent) {
      audit({
        action,
        entityType: 'protocol',
        entityId: protocolId,
        studyId,
        previous: diff.elements.length || diff.relations.length ? compact(diff.elements, 'before') : null,
        next: {
          summary: diff.summary,
          changes: compact(diff.elements, 'after'),
          relations: diff.relations.map((r) => ({ change: r.change, kind: r.relation.kind, from: r.fromLabel, to: r.toLabel, value: r.relation.value ?? null })),
          changeRequestId: opts.changeRequestId ?? undefined,
        },
        reason: opts.reason,
      });
    }
  });
  return diff;
}

function compact(changes: ElementChange[], side: 'before' | 'after') {
  return changes.map((c) => ({
    id: c.id,
    type: c.type,
    label: c.label,
    change: c.change,
    fields: c.change === 'modified' ? Object.fromEntries(c.fields.map((f) => [f.field, side === 'before' ? f.before : f.after])) : side === 'before' ? c.before ?? null : c.after ?? null,
  }));
}

function writeVersion(c: ElementChange, flat: FlatProtocol, protocolId: string, studyId: string, author: string, t: string, opts: TrackOptions) {
  const el: StudyElement | undefined = flat.elements.get(c.id);
  const content = c.change === 'deleted' ? c.before ?? {} : el?.content ?? c.after ?? {};
  const contentHash = hash(content);
  const last = db.prepare(`SELECT * FROM element_versions WHERE element_id = ? ORDER BY version DESC LIMIT 1`).get(c.id) as any;
  const changeType = c.change === 'added' ? 'created' : c.change === 'deleted' ? 'deleted' : 'modified';
  const coalesce =
    last &&
    !last.frozen &&
    last.changed_by === author &&
    !opts.changeRequestId &&
    !last.change_request_id &&
    last.change_type !== 'deleted' &&
    changeType !== 'deleted' &&
    Date.now() - Date.parse(last.changed_at) < COALESCE_MS;
  if (coalesce) {
    db.prepare(`UPDATE element_versions SET content_json = ?, content_hash = ?, changed_at = ?, reason = COALESCE(?, reason) WHERE id = ?`).run(JSON.stringify(content), contentHash, t, opts.reason ?? null, last.id);
  } else {
    db.prepare(
      `INSERT INTO element_versions (id, element_id, protocol_id, study_id, element_type, version, change_type, content_json, content_hash, changed_by, changed_at, reason, change_request_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(randomUUID(), c.id, protocolId, studyId, c.type, (last ? Number(last.version) : 0) + 1, changeType, JSON.stringify(content), contentHash, author, t, opts.reason ?? null, opts.changeRequestId ?? null);
  }

  const lin = db.prepare(`SELECT * FROM lineage_records WHERE element_id = ?`).get(c.id) as any;
  const review = opts.reviewStatus ?? 'Pending';
  if (c.change === 'deleted') {
    if (lin) db.prepare(`UPDATE lineage_records SET deleted_at = ?, modified_by = ?, modified_at = ? WHERE element_id = ?`).run(t, author, t, c.id);
    return;
  }
  const prov = opts.provenance;
  const loc = prov?.elements?.[c.id];
  if (!lin) {
    const sourceType = prov?.sourceType ?? 'builder';
    db.prepare(
      `INSERT INTO lineage_records (element_id, element_type, study_id, protocol_id, label, source_type, source_document_id, source_page, source_section, source_text, extraction_method, internal_entity_type, created_by, modified_by, created_at, modified_at, review_status, reviewed_by, reviewed_at, content_hash)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      c.id,
      c.type,
      studyId,
      protocolId,
      el?.label ?? c.label,
      sourceType,
      prov?.sourceDocumentId ?? null,
      loc?.page ?? null,
      loc?.section ?? null,
      loc?.text ? loc.text.slice(0, 4000) : null,
      prov ? (loc ? prov.extractionMethod : sourceType === 'builder' ? 'manual-entry' : 'template-placeholder') : 'manual-entry',
      c.type,
      author,
      author,
      t,
      t,
      review,
      review === 'Approved' ? opts.reviewer ?? null : null,
      review === 'Approved' ? t : null,
      contentHash,
    );
  } else {
    db.prepare(
      `UPDATE lineage_records SET label = ?, modified_by = ?, modified_at = ?, content_hash = ?, deleted_at = NULL, review_status = ?, reviewed_by = ?, reviewed_at = ? WHERE element_id = ?`,
    ).run(el?.label ?? c.label, author, t, contentHash, review, review === 'Approved' ? opts.reviewer ?? null : null, review === 'Approved' ? t : null, c.id);
  }
}

/** Freeze current working versions (called when a protocol version snapshot is taken). */
export function freezeVersions(protocolId: string) {
  db.prepare(`UPDATE element_versions SET frozen = 1 WHERE protocol_id = ? AND frozen = 0`).run(protocolId);
}

// ---------- Review ----------

export function reviewElements(protocolId: string, elementIds: string[] | 'all-pending', decision: 'Approved' | 'Rejected', comment: string) {
  const actor = currentActor();
  const rows = (
    elementIds === 'all-pending'
      ? db.prepare(`SELECT element_id, study_id, label, review_status FROM lineage_records WHERE protocol_id = ? AND review_status = 'Pending' AND deleted_at IS NULL`).all(protocolId)
      : elementIds.map((id) => db.prepare(`SELECT element_id, study_id, label, review_status FROM lineage_records WHERE element_id = ? AND protocol_id = ?`).get(id, protocolId)).filter(Boolean)
  ) as any[];
  const t = now();
  tx(() => {
    for (const r of rows) {
      db.prepare(`UPDATE lineage_records SET review_status = ?, reviewed_by = ?, reviewed_at = ? WHERE element_id = ?`).run(decision, actor.userId, t, r.element_id);
      db.prepare(`INSERT INTO approval_records (id, entity_type, entity_id, study_id, decision, decided_by, comment, created_at) VALUES (?,?,?,?,?,?,?,?)`).run(
        randomUUID(),
        'element',
        r.element_id,
        r.study_id,
        decision,
        actor.userId,
        comment,
        t,
      );
    }
    if (rows.length)
      audit({
        action: decision === 'Approved' ? 'element.approved' : 'element.rejected',
        entityType: 'protocol',
        entityId: protocolId,
        studyId: rows[0].study_id,
        previous: rows.map((r) => ({ id: r.element_id, label: r.label, reviewStatus: r.review_status })),
        next: { reviewStatus: decision, elements: rows.length },
        reason: comment,
      });
  });
  return rows.length;
}

// ---------- Queries ----------

export const toLineage = (r: any): LineageRecord => ({
  elementId: r.element_id,
  elementType: r.element_type,
  studyId: r.study_id,
  protocolId: r.protocol_id,
  label: r.label,
  sourceType: r.source_type,
  sourceDocumentId: r.source_document_id,
  sourceDocumentName: r.source_document_name ?? null,
  sourcePage: r.source_page,
  sourceSection: r.source_section,
  sourceText: r.source_text,
  extractionMethod: r.extraction_method,
  internalEntityType: r.internal_entity_type,
  usdmMappingId: r.usdm_mapping_id,
  usdmEntity: r.usdm_entity,
  usdmRunId: r.usdm_run_id,
  createdBy: r.created_by,
  modifiedBy: r.modified_by,
  createdAt: r.created_at,
  modifiedAt: r.modified_at,
  reviewStatus: r.review_status,
  reviewedBy: r.reviewed_by,
  reviewedAt: r.reviewed_at,
  deletedAt: r.deleted_at,
});

export function lineageFor(protocolId: string, includeDeleted = false): LineageRecord[] {
  return (
    db
      .prepare(
        `SELECT l.*, d.filename AS source_document_name FROM lineage_records l LEFT JOIN source_documents d ON d.id = l.source_document_id
         WHERE l.protocol_id = ? ${includeDeleted ? '' : 'AND l.deleted_at IS NULL'} ORDER BY l.element_type, l.created_at`,
      )
      .all(protocolId) as any[]
  ).map(toLineage);
}

export function elementVersions(elementId: string) {
  return (db.prepare(`SELECT * FROM element_versions WHERE element_id = ? ORDER BY version DESC`).all(elementId) as any[]).map((r) => ({
    id: r.id,
    version: Number(r.version),
    changeType: r.change_type,
    content: JSON.parse(r.content_json),
    changedBy: r.changed_by,
    changedAt: r.changed_at,
    reason: r.reason,
    changeRequestId: r.change_request_id,
    frozen: !!r.frozen,
  }));
}

/** Full trace of one element: source, current content, relationships, version history, reviews, issues and USDM mapping. */
export function elementLineage(elementId: string) {
  const row = db
    .prepare(`SELECT l.*, d.filename AS source_document_name FROM lineage_records l LEFT JOIN source_documents d ON d.id = l.source_document_id WHERE l.element_id = ?`)
    .get(elementId) as any;
  if (!row) throw new HttpError(404, 'No lineage record for this element');
  const lineage = toLineage(row);
  const bundle = safeBundle(lineage.protocolId);
  const flat = bundle ? flattenBundle(bundle) : null;
  const label = (id: string) => flat?.elements.get(id)?.label ?? id;
  const relations = (flat?.relations ?? [])
    .filter((r) => r.from === elementId || r.to === elementId)
    .map((r) => ({ ...r, direction: r.from === elementId ? 'outgoing' : 'incoming', otherId: r.from === elementId ? r.to : r.from, otherLabel: label(r.from === elementId ? r.to : r.from) }));
  const run = lineage.usdmRunId ? (db.prepare(`SELECT id, status, review_status, created_at, report_json FROM usdm_mapping_runs WHERE id = ?`).get(lineage.usdmRunId) as any) : null;
  const record = run ? (JSON.parse(run.report_json).records as any[]).find((r) => r.elementId === elementId) ?? null : null;
  const rule = lineage.usdmMappingId ? (db.prepare(`SELECT id, source_entity, source_field, target_entity, target_property, transformation_type, status, version FROM usdm_mapping_registry WHERE id = ?`).get(lineage.usdmMappingId) as any) : null;
  const user = (id: string | null) => (id ? ((db.prepare(`SELECT display_name FROM users WHERE id = ?`).get(id) as any)?.display_name ?? id) : null);
  return {
    lineage: { ...lineage, createdByName: user(lineage.createdBy), modifiedByName: user(lineage.modifiedBy), reviewedByName: user(lineage.reviewedBy) },
    study: bundle ? { id: bundle.study.id, title: bundle.study.title, protocolNumber: bundle.study.protocolNumber } : null,
    protocol: bundle ? { id: bundle.protocol.id, version: bundle.protocol.version, status: bundle.protocol.status, revision: bundle.protocol.revision, source: bundle.protocol.source } : null,
    current: flat?.elements.get(elementId) ?? null,
    relations,
    versions: elementVersions(elementId).map((v) => ({ ...v, changedByName: user(v.changedBy) })),
    reviews: (db.prepare(`SELECT * FROM approval_records WHERE entity_type = 'element' AND entity_id = ? ORDER BY created_at DESC`).all(elementId) as any[]).map((a) => ({ decision: a.decision, decidedBy: user(a.decided_by), comment: a.comment, createdAt: a.created_at })),
    issues: db.prepare(`SELECT id, title, severity, status, rule_id, created_at FROM governance_issues WHERE element_id = ? ORDER BY created_at DESC`).all(elementId),
    usdm: run ? { runId: run.id, runStatus: run.status, runReviewStatus: run.review_status, runAt: run.created_at, rule, record } : null,
  };
}

/** Backfill lineage for protocols created before governance was enabled (no history is invented: source = system). */
export function backfillLineage() {
  const missing = db.prepare(`SELECT p.id FROM protocols p WHERE NOT EXISTS (SELECT 1 FROM lineage_records l WHERE l.protocol_id = p.id)`).all() as { id: string }[];
  for (const { id } of missing) {
    const bundle = safeBundle(id);
    if (!bundle) continue;
    const doc = db.prepare(`SELECT id FROM source_documents WHERE protocol_id = ? OR linked_protocol_id = ? LIMIT 1`).get(id, id) as { id: string } | undefined;
    const flat = flattenBundle(bundle);
    const t = now();
    tx(() => {
      for (const el of flat.elements.values()) {
        db.prepare(
          `INSERT OR IGNORE INTO lineage_records (element_id, element_type, study_id, protocol_id, label, source_type, source_document_id, extraction_method, internal_entity_type, created_by, modified_by, created_at, modified_at, review_status, content_hash)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'Pending',?)`,
        ).run(el.id, el.type, bundle.study.id, id, el.label, bundle.protocol.source === 'digitisation' ? 'digitisation' : 'builder', doc?.id ?? null, 'pre-governance-record', el.type, 'system', 'system', bundle.protocol.createdAt, t, hash(el.content));
      }
    });
  }
}
