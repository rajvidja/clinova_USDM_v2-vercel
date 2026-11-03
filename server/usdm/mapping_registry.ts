import { createHash, randomUUID } from 'node:crypto';
import type { MappingStatus, TransformationType } from '../../shared/governance.ts';
import { audit } from '../audit.ts';
import { currentActor } from '../context.ts';
import { db, tx } from '../db.ts';
import { HttpError } from '../repo.ts';
import { SEED_RULES } from './usdm_config.ts';
import { loadRelease, releaseId } from './usdm_version.ts';

// The USDM mapping registry: one row per source field -> USDM class.property rule, per release. Rows scoped to a
// study (and optionally one element) hold manual mappings configured for that study. Every change is versioned in
// usdm_mapping_history (append-only).

export const SOURCE_ENTITIES = ['study', 'protocol', 'design', 'section', 'arm', 'objective', 'endpoint', 'criterion', 'visit', 'activity', 'footnote', 'soa'] as const;
export type SourceEntity = (typeof SOURCE_ENTITIES)[number];
export const SOURCE_ENTITY_LABELS: Record<SourceEntity, string> = {
  study: 'Study',
  protocol: 'Protocol version',
  design: 'Study design (protocol sections)',
  section: 'Protocol sections (narrative)',
  arm: 'Study arm / intervention',
  objective: 'Objective',
  endpoint: 'Endpoint',
  criterion: 'Eligibility criterion',
  visit: 'Encounter / visit',
  activity: 'Activity',
  footnote: 'SoA footnote',
  soa: 'Schedule of Activities',
};
const TYPES: TransformationType[] = ['direct', 'value', 'terminology', 'relationship', 'manual', 'unsupported'];
const STATUSES: MappingStatus[] = ['Not Mapped', 'Mapped', 'Requires Review', 'Validated', 'Rejected'];

export interface MappingRule {
  id: string;
  releaseId: string;
  group: string;
  sourceEntity: string;
  sourceField: string;
  targetEntity: string | null;
  targetProperty: string | null;
  transformationType: TransformationType;
  rule: Record<string, any>;
  status: MappingStatus;
  active: boolean;
  reason: string;
  scopeStudyId: string | null;
  scopeElementId: string | null;
  version: number;
  origin: 'seed' | 'user';
  reviewer: string | null;
  reviewedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

const now = () => new Date().toISOString();
const seedId = (version: string, r: { sourceEntity: string; sourceField: string; targetEntity: string | null; targetProperty: string | null }) =>
  `map-${version}-${createHash('sha1').update(`${r.sourceEntity}|${r.sourceField}|${r.targetEntity ?? ''}|${r.targetProperty ?? ''}`).digest('hex').slice(0, 12)}`;

export const toRule = (r: any): MappingRule => {
  const rule = JSON.parse(r.rule_json || '{}');
  return {
    id: r.id,
    releaseId: r.release_id,
    group: rule.group ?? 'Other',
    sourceEntity: r.source_entity,
    sourceField: r.source_field,
    targetEntity: r.target_entity,
    targetProperty: r.target_property,
    transformationType: r.transformation_type,
    rule,
    status: r.status,
    active: !!r.active,
    reason: r.reason,
    scopeStudyId: r.scope_study_id,
    scopeElementId: r.scope_element_id,
    version: Number(r.version),
    origin: r.origin,
    reviewer: r.reviewer,
    reviewedAt: r.reviewed_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
  };
};

function history(m: MappingRule, action: string, reason = '') {
  db.prepare(`INSERT INTO usdm_mapping_history (id, mapping_id, version, action, snapshot_json, changed_by, changed_at, reason) VALUES (?,?,?,?,?,?,?,?)`).run(
    randomUUID(),
    m.id,
    m.version,
    action,
    JSON.stringify(m),
    currentActor().userId,
    now(),
    reason,
  );
}

const get = (id: string) => {
  const r = db.prepare(`SELECT * FROM usdm_mapping_registry WHERE id = ?`).get(id);
  if (!r) throw new HttpError(404, 'Mapping rule not found');
  return toRule(r);
};
export const getMapping = get;

/** Inserts seed rules that are missing for each bundled release. Existing rows (possibly edited) are left alone. */
export function seedMappings() {
  const t = now();
  for (const [version, files] of Object.entries(SEED_RULES)) {
    const rid = releaseId(version);
    if (!db.prepare(`SELECT 1 FROM usdm_releases WHERE id = ?`).get(rid)) continue;
    tx(() => {
      for (const file of files)
        for (const r of file.rules) {
          const id = seedId(version, r);
          if (db.prepare(`SELECT 1 FROM usdm_mapping_registry WHERE id = ?`).get(id)) continue;
          db.prepare(
            `INSERT INTO usdm_mapping_registry (id, release_id, source_entity, source_field, target_entity, target_property, transformation_type, rule_json, status, active, reason, version, origin, created_by, created_at, updated_by, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,1,?,1,'seed','system',?,'system',?)`,
          ).run(id, rid, r.sourceEntity, r.sourceField, r.targetEntity, r.targetProperty, r.type, JSON.stringify({ ...(r.rule ?? {}), group: file.group }), r.status, r.reason ?? '', t, t);
          db.prepare(`INSERT INTO usdm_mapping_history (id, mapping_id, version, action, snapshot_json, changed_by, changed_at, reason) VALUES (?,?,1,'seeded',?,'system',?,?)`).run(
            randomUUID(),
            id,
            JSON.stringify(toRule(db.prepare(`SELECT * FROM usdm_mapping_registry WHERE id = ?`).get(id))),
            t,
            `Seeded from server/usdm/rules (${file.group})`,
          );
        }
    });
  }
}

export interface MappingFilter {
  releaseId: string;
  sourceEntity?: string;
  status?: string;
  type?: string;
  q?: string;
  studyId?: string | null;
  includeInactive?: boolean;
  scope?: 'global' | 'study' | 'all';
}

export function listMappings(f: MappingFilter): MappingRule[] {
  const where = ['release_id = ?'];
  const args: (string | number)[] = [f.releaseId];
  if (f.sourceEntity) (where.push('source_entity = ?'), args.push(f.sourceEntity));
  if (f.status) (where.push('status = ?'), args.push(f.status));
  if (f.type) (where.push('transformation_type = ?'), args.push(f.type));
  if (!f.includeInactive) where.push('active = 1');
  const scope = f.scope ?? 'global';
  if (scope === 'global') where.push('scope_study_id IS NULL');
  else if (scope === 'study') (where.push('scope_study_id = ?'), args.push(f.studyId ?? ''));
  else if (f.studyId) (where.push('(scope_study_id IS NULL OR scope_study_id = ?)'), args.push(f.studyId));
  if (f.q) {
    where.push(`(source_field LIKE ? OR target_entity LIKE ? OR target_property LIKE ? OR reason LIKE ?)`);
    const q = `%${f.q}%`;
    args.push(q, q, q, q);
  }
  return (db.prepare(`SELECT * FROM usdm_mapping_registry WHERE ${where.join(' AND ')} ORDER BY source_entity, target_entity, target_property, created_at`).all(...args) as any[]).map(toRule);
}

/** Active rules for a mapping run: global rules plus manual rows scoped to the study. */
export function rulesForRun(releaseIdValue: string, studyId: string): MappingRule[] {
  return (
    db
      .prepare(`SELECT * FROM usdm_mapping_registry WHERE release_id = ? AND active = 1 AND (scope_study_id IS NULL OR scope_study_id = ?) ORDER BY created_at`)
      .all(releaseIdValue, studyId) as any[]
  ).map(toRule);
}

export interface MappingInput {
  sourceEntity?: string;
  sourceField?: string;
  targetEntity?: string | null;
  targetProperty?: string | null;
  transformationType?: TransformationType;
  rule?: Record<string, unknown>;
  status?: MappingStatus;
  reason?: string;
  scopeStudyId?: string | null;
  scopeElementId?: string | null;
  active?: boolean;
}

function validateInput(release: ReturnType<typeof loadRelease>, m: Required<Pick<MappingInput, 'sourceEntity' | 'sourceField' | 'transformationType' | 'status'>> & MappingInput) {
  if (!(SOURCE_ENTITIES as readonly string[]).includes(m.sourceEntity)) throw new HttpError(400, `Unknown source entity '${m.sourceEntity}'`);
  if (!m.sourceField || m.sourceField.length > 200) throw new HttpError(400, 'Source field is required (max 200 characters)');
  if (!TYPES.includes(m.transformationType)) throw new HttpError(400, 'Unknown transformation type');
  if (!STATUSES.includes(m.status)) throw new HttpError(400, 'Unknown mapping status');
  if (m.transformationType === 'unsupported') {
    if (!m.reason?.trim()) throw new HttpError(400, 'A reason is required when a field has no valid USDM equivalent');
    if (m.status !== 'Not Mapped') throw new HttpError(400, "Unsupported fields must keep status 'Not Mapped'");
  } else {
    if (!m.targetEntity) throw new HttpError(400, 'Target USDM entity is required');
    const s = release.schema.components.schemas[`${m.targetEntity}-Input`];
    if (!s) throw new HttpError(400, `USDM ${release.version} has no class '${m.targetEntity}'`);
    if (m.targetProperty && !s.properties?.[m.targetProperty]) throw new HttpError(400, `USDM ${release.version} class ${m.targetEntity} has no property '${m.targetProperty}'`);
    if (!m.targetProperty && m.transformationType !== 'relationship') throw new HttpError(400, 'Target property is required');
  }
  if (m.rule && JSON.stringify(m.rule).length > 20_000) throw new HttpError(400, 'Rule configuration is too large');
  if (m.transformationType === 'terminology' && !m.rule?.domain) throw new HttpError(400, 'Terminology mappings need a terminology domain');
}

export function createMapping(releaseIdValue: string, input: MappingInput, reason = ''): MappingRule {
  const release = loadRelease(releaseIdValue);
  const actor = currentActor();
  const m = {
    sourceEntity: String(input.sourceEntity ?? ''),
    sourceField: String(input.sourceField ?? '').trim(),
    targetEntity: input.targetEntity || null,
    targetProperty: input.targetProperty || null,
    transformationType: input.transformationType ?? 'direct',
    status: input.status ?? 'Requires Review',
    rule: input.rule ?? {},
    reason: String(input.reason ?? ''),
    scopeStudyId: input.scopeStudyId || null,
    scopeElementId: input.scopeElementId || null,
  } as const;
  if (m.status === 'Validated') throw new HttpError(400, 'Mappings are validated through review, not on creation');
  validateInput(release, m);
  if (m.scopeStudyId && !db.prepare(`SELECT 1 FROM studies WHERE id = ?`).get(m.scopeStudyId)) throw new HttpError(400, 'Scoped study not found');
  const id = randomUUID();
  const t = now();
  tx(() => {
    db.prepare(
      `INSERT INTO usdm_mapping_registry (id, release_id, source_entity, source_field, target_entity, target_property, transformation_type, rule_json, status, active, reason, scope_study_id, scope_element_id, version, origin, created_by, created_at, updated_by, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?,1,'user',?,?,?,?)`,
    ).run(id, releaseIdValue, m.sourceEntity, m.sourceField, m.targetEntity, m.targetProperty, m.transformationType, JSON.stringify(m.rule), m.status, m.reason, m.scopeStudyId, m.scopeElementId, actor.userId, t, actor.userId, t);
    const created = get(id);
    history(created, 'created', reason);
    audit({ action: 'usdm.mapping.created', entityType: 'usdm_mapping', entityId: id, studyId: m.scopeStudyId, next: created, reason });
  });
  return get(id);
}

export function updateMapping(id: string, patch: MappingInput & { expectedVersion?: number }, reason = ''): MappingRule {
  const before = get(id);
  if (patch.expectedVersion != null && Number(patch.expectedVersion) !== before.version) throw new HttpError(409, 'This mapping was changed by someone else. Reload and try again.');
  const release = loadRelease(before.releaseId);
  if (patch.status === 'Validated' || patch.status === 'Rejected') throw new HttpError(400, 'Use the review action to validate or reject a mapping');
  const contentChanged =
    (patch.sourceField !== undefined && patch.sourceField !== before.sourceField) ||
    (patch.targetEntity !== undefined && patch.targetEntity !== before.targetEntity) ||
    (patch.targetProperty !== undefined && patch.targetProperty !== before.targetProperty) ||
    (patch.transformationType !== undefined && patch.transformationType !== before.transformationType) ||
    (patch.rule !== undefined && JSON.stringify({ ...patch.rule, group: before.group }) !== JSON.stringify(before.rule));
  const next = {
    sourceEntity: patch.sourceEntity ?? before.sourceEntity,
    sourceField: (patch.sourceField ?? before.sourceField).trim(),
    targetEntity: patch.targetEntity !== undefined ? patch.targetEntity || null : before.targetEntity,
    targetProperty: patch.targetProperty !== undefined ? patch.targetProperty || null : before.targetProperty,
    transformationType: patch.transformationType ?? before.transformationType,
    rule: patch.rule !== undefined ? { ...patch.rule, group: before.group } : before.rule,
    // A changed definition is never silently kept as Validated.
    status: patch.status ?? (contentChanged && (before.status === 'Validated' || before.status === 'Rejected') ? 'Requires Review' : before.status),
    reason: patch.reason ?? before.reason,
    active: patch.active ?? before.active,
  };
  validateInput(release, next);
  const actor = currentActor();
  tx(() => {
    db.prepare(
      `UPDATE usdm_mapping_registry SET source_entity = ?, source_field = ?, target_entity = ?, target_property = ?, transformation_type = ?, rule_json = ?, status = ?, reason = ?, active = ?,
         version = version + 1, updated_by = ?, updated_at = ?, reviewer = CASE WHEN ? THEN NULL ELSE reviewer END, reviewed_at = CASE WHEN ? THEN NULL ELSE reviewed_at END WHERE id = ?`,
    ).run(
      next.sourceEntity,
      next.sourceField,
      next.targetEntity,
      next.targetProperty,
      next.transformationType,
      JSON.stringify(next.rule),
      next.status,
      next.reason,
      next.active ? 1 : 0,
      actor.userId,
      now(),
      contentChanged ? 1 : 0,
      contentChanged ? 1 : 0,
      id,
    );
    const after = get(id);
    history(after, patch.active === false && before.active ? 'deactivated' : patch.active === true && !before.active ? 'reactivated' : 'updated', reason);
    audit({ action: 'usdm.mapping.updated', entityType: 'usdm_mapping', entityId: id, studyId: before.scopeStudyId, previous: before, next: after, reason });
  });
  return get(id);
}

export function reviewMapping(id: string, decision: 'Validated' | 'Rejected', comment: string): MappingRule {
  const before = get(id);
  const actor = currentActor();
  if (decision === 'Rejected' && !comment?.trim()) throw new HttpError(400, 'A comment is required when rejecting a mapping');
  if (before.origin === 'user' && before.updatedBy === actor.userId) throw new HttpError(403, 'A mapping must be reviewed by someone other than its last editor');
  if (before.transformationType === 'unsupported' && decision === 'Validated') {
    // Validating an unsupported row confirms the "no equivalent" decision; the status stays Not Mapped.
    tx(() => {
      db.prepare(`UPDATE usdm_mapping_registry SET reviewer = ?, reviewed_at = ?, version = version + 1 WHERE id = ?`).run(actor.userId, now(), id);
      const after = get(id);
      history(after, 'confirmed-unsupported', comment);
      audit({ action: 'usdm.mapping.reviewed', entityType: 'usdm_mapping', entityId: id, previous: { status: before.status }, next: { status: after.status, confirmed: true }, reason: comment });
    });
    return get(id);
  }
  if (before.transformationType === 'manual' && decision === 'Validated' && before.rule.value === undefined) throw new HttpError(400, 'Configure a manual value before validating this mapping');
  tx(() => {
    db.prepare(`UPDATE usdm_mapping_registry SET status = ?, reviewer = ?, reviewed_at = ?, version = version + 1 WHERE id = ?`).run(decision, actor.userId, now(), id);
    const after = get(id);
    history(after, decision === 'Validated' ? 'validated' : 'rejected', comment);
    db.prepare(`INSERT INTO approval_records (id, entity_type, entity_id, study_id, decision, decided_by, comment, created_at) VALUES (?,?,?,?,?,?,?,?)`).run(
      randomUUID(),
      'usdm_mapping',
      id,
      before.scopeStudyId,
      decision,
      actor.userId,
      comment ?? '',
      now(),
    );
    audit({ action: 'usdm.mapping.reviewed', entityType: 'usdm_mapping', entityId: id, studyId: before.scopeStudyId, previous: { status: before.status }, next: { status: decision }, reason: comment });
  });
  return get(id);
}

export function mappingHistory(id: string) {
  return (db.prepare(`SELECT * FROM usdm_mapping_history WHERE mapping_id = ? ORDER BY version DESC, changed_at DESC`).all(id) as any[]).map((h) => ({
    id: h.id,
    version: Number(h.version),
    action: h.action,
    snapshot: JSON.parse(h.snapshot_json),
    changedBy: h.changed_by,
    changedAt: h.changed_at,
    reason: h.reason,
  }));
}

/**
 * Sets a study-scoped (optionally element-scoped) manual value for a target property. Creates or versions the row.
 * The configured value applies only to that study; global rules are untouched.
 */
export function setManualValue(
  releaseIdValue: string,
  input: { studyId: string; elementId?: string | null; sourceEntity: string; targetEntity: string; targetProperty: string; value: unknown; valueType: string; codelist?: string },
  reason: string,
): MappingRule {
  if (!reason?.trim()) throw new HttpError(400, 'A reason is required for a manual mapping');
  if (input.value === undefined || input.value === null || input.value === '') throw new HttpError(400, 'A value is required');
  const existing = db
    .prepare(
      `SELECT id FROM usdm_mapping_registry WHERE release_id = ? AND scope_study_id = ? AND COALESCE(scope_element_id, '') = ? AND target_entity = ? AND target_property = ? AND transformation_type = 'manual' AND active = 1`,
    )
    .get(releaseIdValue, input.studyId, input.elementId ?? '', input.targetEntity, input.targetProperty) as { id: string } | undefined;
  const rule = { valueType: input.valueType, codelist: input.codelist, value: input.value };
  if (existing) return updateMapping(existing.id, { rule, status: 'Mapped', reason }, reason);
  return createMapping(
    releaseIdValue,
    {
      sourceEntity: input.sourceEntity,
      sourceField: `(manual) ${input.targetEntity}.${input.targetProperty}`,
      targetEntity: input.targetEntity,
      targetProperty: input.targetProperty,
      transformationType: 'manual',
      rule,
      status: 'Mapped',
      reason,
      scopeStudyId: input.studyId,
      scopeElementId: input.elementId ?? null,
    },
    reason,
  );
}

/**
 * Explicitly copies the global mappings of one release into another release that has none of its own yet.
 * Copies are marked 'Requires Review'; existing mappings are never migrated implicitly.
 */
export function copyMappings(fromReleaseId: string, toReleaseId: string, reason: string) {
  if (!reason?.trim()) throw new HttpError(400, 'A reason is required');
  const target = loadRelease(toReleaseId);
  loadRelease(fromReleaseId);
  if (fromReleaseId === toReleaseId) throw new HttpError(400, 'Choose a different source release');
  const count = (db.prepare(`SELECT COUNT(*) AS n FROM usdm_mapping_registry WHERE release_id = ? AND scope_study_id IS NULL`).get(toReleaseId) as { n: number }).n;
  if (count > 0) throw new HttpError(409, `USDM ${target.version} already has ${count} mappings; copying would mix rule sets`);
  const rows = listMappings({ releaseId: fromReleaseId, scope: 'global', includeInactive: false });
  const schemas = target.schema.components.schemas;
  const actor = currentActor();
  const t = now();
  let copied = 0;
  let incompatible = 0;
  tx(() => {
    for (const r of rows) {
      const ok = r.transformationType === 'unsupported' || (!!r.targetEntity && !!schemas[`${r.targetEntity}-Input`] && (!r.targetProperty || !!schemas[`${r.targetEntity}-Input`].properties?.[r.targetProperty]));
      const id = randomUUID();
      db.prepare(
        `INSERT INTO usdm_mapping_registry (id, release_id, source_entity, source_field, target_entity, target_property, transformation_type, rule_json, status, active, reason, version, origin, created_by, created_at, updated_by, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,1,'user',?,?,?,?)`,
      ).run(
        id,
        toReleaseId,
        r.sourceEntity,
        r.sourceField,
        r.targetEntity,
        r.targetProperty,
        r.transformationType,
        JSON.stringify(r.rule),
        r.transformationType === 'unsupported' ? 'Not Mapped' : 'Requires Review',
        ok ? 1 : 0,
        ok ? r.reason : `Inactive: target not present in USDM ${target.version}. ${r.reason}`.trim(),
        actor.userId,
        t,
        actor.userId,
        t,
      );
      history(get(id), 'copied', `Copied from release ${fromReleaseId} rule ${r.id}: ${reason}`);
      copied++;
      if (!ok) incompatible++;
    }
    audit({ action: 'usdm.mapping.copied', entityType: 'usdm_release', entityId: toReleaseId, next: { from: fromReleaseId, copied, incompatible }, reason });
  });
  return { copied, incompatible };
}
