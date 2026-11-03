import { randomUUID } from 'node:crypto';
import { ROLES } from '../../shared/governance.ts';
import { audit } from '../audit.ts';
import { currentActor } from '../context.ts';
import { db, tx } from '../db.ts';
import { HttpError } from '../repo.ts';
import dictionarySeed from './rules/data-dictionary.json' with { type: 'json' };

// Data ownership (who owns / stewards each study's data) and the data dictionary.

// ---------- Data owners ----------

export function listOwners(studyId?: string) {
  const rows = db
    .prepare(
      `SELECT o.*, u.display_name, u.username, s.title AS study_title, s.protocol_number FROM data_owners o JOIN users u ON u.id = o.user_id JOIN studies s ON s.id = o.study_id
       ${studyId ? 'WHERE o.study_id = ?' : ''} ORDER BY s.title, o.entity_type, o.responsibility`,
    )
    .all(...(studyId ? [studyId] : [])) as any[];
  return rows.map((r) => ({
    id: r.id,
    studyId: r.study_id,
    studyTitle: r.study_title,
    protocolNumber: r.protocol_number,
    entityType: r.entity_type,
    responsibility: r.responsibility,
    userId: r.user_id,
    userName: r.display_name,
    username: r.username,
    assignedBy: r.assigned_by,
    assignedAt: r.assigned_at,
  }));
}

export function assignOwner(input: { studyId: string; entityType?: string; responsibility: 'Owner' | 'Steward'; userId: string }) {
  if (!['Owner', 'Steward'].includes(input.responsibility)) throw new HttpError(400, 'Responsibility must be Owner or Steward');
  if (!db.prepare(`SELECT 1 FROM studies WHERE id = ?`).get(input.studyId)) throw new HttpError(400, 'Study not found');
  if (!db.prepare(`SELECT 1 FROM users WHERE id = ? AND active = 1`).get(input.userId)) throw new HttpError(400, 'User not found');
  const entityType = input.entityType || '*';
  const actor = currentActor();
  const t = new Date().toISOString();
  const before = db.prepare(`SELECT * FROM data_owners WHERE study_id = ? AND entity_type = ? AND responsibility = ?`).get(input.studyId, entityType, input.responsibility) as any;
  tx(() => {
    if (before) db.prepare(`UPDATE data_owners SET user_id = ?, assigned_by = ?, assigned_at = ? WHERE id = ?`).run(input.userId, actor.userId, t, before.id);
    else db.prepare(`INSERT INTO data_owners (id, study_id, entity_type, responsibility, user_id, assigned_by, assigned_at) VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), input.studyId, entityType, input.responsibility, input.userId, actor.userId, t);
    audit({ action: 'governance.owner.assigned', entityType: 'data_owner', entityId: `${input.studyId}:${entityType}:${input.responsibility}`, studyId: input.studyId, previous: before ? { userId: before.user_id } : null, next: { userId: input.userId, entityType, responsibility: input.responsibility } });
  });
  return listOwners(input.studyId);
}

export function removeOwner(id: string) {
  const row = db.prepare(`SELECT * FROM data_owners WHERE id = ?`).get(id) as any;
  if (!row) throw new HttpError(404, 'Assignment not found');
  tx(() => {
    db.prepare(`DELETE FROM data_owners WHERE id = ?`).run(id);
    audit({ action: 'governance.owner.removed', entityType: 'data_owner', entityId: id, studyId: row.study_id, previous: { userId: row.user_id, entityType: row.entity_type, responsibility: row.responsibility } });
  });
}

// ---------- Data dictionary ----------

const DATA_TYPES = ['text', 'number', 'date', 'select', 'boolean', 'list', 'table', 'richtext'];

export function seedDictionary() {
  const t = new Date().toISOString();
  tx(() => {
    for (const e of dictionarySeed.entries as any[]) {
      if (db.prepare(`SELECT 1 FROM data_dictionary WHERE id = ?`).get(e.id)) continue;
      db.prepare(
        `INSERT INTO data_dictionary (id, name, definition, data_type, permitted_values_json, source, owner_role, entity_types_json, required, terminology_ref, version, updated_by, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,1,'system',?)`,
      ).run(e.id, e.name, e.definition, e.dataType, JSON.stringify(e.permittedValues ?? []), e.source ?? '', e.ownerRole ?? '', JSON.stringify(e.entityTypes ?? []), e.required ? 1 : 0, e.terminologyRef ?? '', t);
    }
  });
}

/** Splits a dictionary id into the mapping-registry source entity and field. */
const bindingOf = (id: string) => {
  const dot = id.indexOf('.');
  return { entity: id.slice(0, dot), field: id.slice(dot + 1) };
};

const toEntry = (r: any, releaseId: string | null) => {
  const { entity, field } = bindingOf(r.id);
  const mappings = releaseId
    ? (db
        .prepare(`SELECT id, target_entity, target_property, transformation_type, status FROM usdm_mapping_registry WHERE release_id = ? AND source_entity = ? AND source_field = ? AND scope_study_id IS NULL AND active = 1`)
        .all(releaseId, entity, field) as any[])
    : [];
  const elementType = entity === 'design' ? 'subsection' : entity;
  const rules = (db.prepare(`SELECT id, name, severity, check_type, config_json FROM governance_rules WHERE active = 1 AND (entity_type = ? OR entity_type = '*')`).all(elementType) as any[]).filter((g) => {
    const c = JSON.parse(g.config_json);
    return c.field === field || (entity === 'design' && g.check_type === 'builtin' && c.key === 'numeric-fields' && field.endsWith('SampleSize'));
  });
  return {
    id: r.id,
    name: r.name,
    definition: r.definition,
    dataType: r.data_type,
    permittedValues: JSON.parse(r.permitted_values_json),
    source: r.source,
    ownerRole: r.owner_role,
    entityTypes: JSON.parse(r.entity_types_json),
    required: !!r.required,
    terminologyRef: r.terminology_ref,
    version: Number(r.version),
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
    usdmMappings: mappings.map((m) => ({ id: m.id, target: m.target_entity ? `${m.target_entity}${m.target_property ? `.${m.target_property}` : ''}` : '—', type: m.transformation_type, status: m.status })),
    validationRules: rules.map((g) => ({ id: g.id, name: g.name, severity: g.severity })),
  };
};

export function listDictionary(q?: string) {
  const release = db.prepare(`SELECT id FROM usdm_releases WHERE is_selected = 1`).get() as { id: string } | undefined;
  const rows = db
    .prepare(`SELECT * FROM data_dictionary ${q ? 'WHERE name LIKE ? OR id LIKE ? OR definition LIKE ?' : ''} ORDER BY id`)
    .all(...(q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [])) as any[];
  return rows.map((r) => toEntry(r, release?.id ?? null));
}

export function upsertDictionary(input: any) {
  const id = String(input.id ?? '').trim();
  if (!/^[a-z]+\.[A-Za-z0-9_.#-]+$/.test(id)) throw new HttpError(400, "Id must be '<entity>.<field>', e.g. 'study.phase'");
  if (!String(input.name ?? '').trim()) throw new HttpError(400, 'Field name is required');
  if (!DATA_TYPES.includes(input.dataType)) throw new HttpError(400, `Data type must be one of ${DATA_TYPES.join(', ')}`);
  if (input.ownerRole && !(ROLES as readonly string[]).includes(input.ownerRole)) throw new HttpError(400, 'Unknown owner role');
  const permitted = Array.isArray(input.permittedValues) ? input.permittedValues.map(String).slice(0, 200) : [];
  const types = Array.isArray(input.entityTypes) ? input.entityTypes.map(String).slice(0, 20) : [];
  const actor = currentActor();
  const t = new Date().toISOString();
  const before = db.prepare(`SELECT * FROM data_dictionary WHERE id = ?`).get(id) as any;
  tx(() => {
    if (before)
      db.prepare(
        `UPDATE data_dictionary SET name = ?, definition = ?, data_type = ?, permitted_values_json = ?, source = ?, owner_role = ?, entity_types_json = ?, required = ?, terminology_ref = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?`,
      ).run(String(input.name).trim(), String(input.definition ?? ''), input.dataType, JSON.stringify(permitted), String(input.source ?? ''), input.ownerRole ?? '', JSON.stringify(types), input.required ? 1 : 0, String(input.terminologyRef ?? ''), actor.userId, t, id);
    else
      db.prepare(
        `INSERT INTO data_dictionary (id, name, definition, data_type, permitted_values_json, source, owner_role, entity_types_json, required, terminology_ref, version, updated_by, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)`,
      ).run(id, String(input.name).trim(), String(input.definition ?? ''), input.dataType, JSON.stringify(permitted), String(input.source ?? ''), input.ownerRole ?? '', JSON.stringify(types), input.required ? 1 : 0, String(input.terminologyRef ?? ''), actor.userId, t);
    audit({ action: before ? 'governance.dictionary.updated' : 'governance.dictionary.created', entityType: 'data_dictionary', entityId: id, previous: before ?? null, next: db.prepare(`SELECT * FROM data_dictionary WHERE id = ?`).get(id) });
  });
  return listDictionary().find((e) => e.id === id)!;
}
