import { createHash, randomUUID } from 'node:crypto';
import { audit } from '../audit.ts';
import { currentActor } from '../context.ts';
import { db, tx } from '../db.ts';
import { HttpError } from '../repo.ts';
import { BUNDLED_RELEASES, SUPPORTED_MAJOR_VERSIONS } from './usdm_config.ts';

// USDM release registry. Each release keeps its own schema, model and terminology; mappings and exports reference a
// release id, so historical mappings and exports stay tied to the release they were made with.

export interface ModelAttribute {
  types: string[];
  cardinality: string;
  relationship: 'Value' | 'Ref';
  definition?: string;
  preferredTerm?: string;
}
export interface ModelClass {
  abstract?: boolean;
  superClasses?: string[];
  definition?: string;
  attributes: Record<string, ModelAttribute>;
}
export interface UsdmModel {
  classes: Record<string, ModelClass>;
}
export interface CtTerm {
  code: string;
  submissionValue: string;
  synonyms: string[];
  preferredTerm: string;
  definition: string;
}
export interface CtCodelist {
  code: string;
  name: string;
  extensible: boolean;
  package: string;
  packageVersion: string;
  terms: CtTerm[];
}
export interface UsdmTerminology {
  codeSystem: string;
  codelists: Record<string, CtCodelist>;
}

export interface UsdmRelease {
  id: string;
  version: string;
  name: string;
  description: string;
  schemaLocation: string;
  schemaVersion: string;
  schemaSha256: string;
  rootSchema: string;
  status: 'Active' | 'Inactive';
  isSelected: boolean;
  hasModel: boolean;
  hasTerminology: boolean;
  sources: unknown[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface LoadedRelease extends UsdmRelease {
  schema: { components: { schemas: Record<string, any> }; info?: { version?: string } };
  model: UsdmModel | null;
  ct: UsdmTerminology | null;
}

const now = () => new Date().toISOString();
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const cache = new Map<string, LoadedRelease>();

const toRelease = (r: any): UsdmRelease => ({
  id: r.id,
  version: r.version,
  name: r.name,
  description: r.description,
  schemaLocation: r.schema_location,
  schemaVersion: r.schema_version,
  schemaSha256: r.schema_sha256,
  rootSchema: r.root_schema,
  status: r.status,
  isSelected: !!r.is_selected,
  hasModel: !!r.has_model,
  hasTerminology: !!r.has_ct,
  sources: JSON.parse(r.sources_json || '[]'),
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const SUMMARY_COLS = `id, version, name, description, schema_location, schema_version, schema_sha256, root_schema, status, is_selected, sources_json,
  created_by, created_at, updated_at, model_json IS NOT NULL AS has_model, ct_json IS NOT NULL AS has_ct`;

export const releaseId = (version: string) => `usdm-${version}`;

/** Inserts bundled releases that are not yet registered. The first bundled release becomes the selected one. */
export function seedReleases() {
  const t = now();
  for (const pkg of BUNDLED_RELEASES) {
    const id = releaseId(pkg.version);
    if (db.prepare(`SELECT 1 FROM usdm_releases WHERE id = ?`).get(id)) continue;
    const schemaJson = JSON.stringify(pkg.schema);
    const anySelected = db.prepare(`SELECT 1 FROM usdm_releases WHERE is_selected = 1`).get();
    db.prepare(
      `INSERT INTO usdm_releases (id, version, name, description, schema_location, schema_version, schema_sha256, root_schema, schema_json, model_json, ct_json, sources_json, status, is_selected, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'Active',?,'system',?,?)`,
    ).run(
      id,
      pkg.version,
      pkg.name,
      pkg.description,
      pkg.schemaLocation,
      String((pkg.schema as any)?.info?.version ?? pkg.version),
      sha256(schemaJson),
      pkg.rootSchema,
      schemaJson,
      JSON.stringify(pkg.model),
      JSON.stringify(pkg.ct),
      JSON.stringify(pkg.sources),
      anySelected ? 0 : 1,
      t,
      t,
    );
  }
}

export function listReleases(): UsdmRelease[] {
  return (db.prepare(`SELECT ${SUMMARY_COLS} FROM usdm_releases ORDER BY created_at`).all() as any[]).map(toRelease);
}

export function loadRelease(id: string): LoadedRelease {
  const row = db.prepare(`SELECT ${SUMMARY_COLS}, schema_json, model_json, ct_json FROM usdm_releases WHERE id = ?`).get(id) as any;
  if (!row) throw new HttpError(404, 'USDM release not found');
  const hit = cache.get(id);
  if (hit && hit.schemaSha256 === row.schema_sha256 && hit.updatedAt === row.updated_at) return hit;
  const loaded: LoadedRelease = {
    ...toRelease(row),
    schema: JSON.parse(row.schema_json),
    model: row.model_json ? JSON.parse(row.model_json) : null,
    ct: row.ct_json ? JSON.parse(row.ct_json) : null,
  };
  cache.set(id, loaded);
  return loaded;
}

export function selectedRelease(): LoadedRelease {
  const row = db.prepare(`SELECT id FROM usdm_releases WHERE is_selected = 1`).get() as { id: string } | undefined;
  if (!row) throw new HttpError(409, 'No USDM release is selected. An administrator must select one in USDM Releases.');
  return loadRelease(row.id);
}

/** Resolves the release for a request: an explicit id (must be Active) or the selected release. */
export function resolveRelease(id?: string | null): LoadedRelease {
  if (!id) return selectedRelease();
  const r = loadRelease(id);
  if (r.status !== 'Active') throw new HttpError(409, `USDM release ${r.version} is inactive`);
  return r;
}

export interface NewReleaseInput {
  version: string;
  name?: string;
  description?: string;
  schemaLocation: string;
  rootSchema?: string;
  schema: unknown;
  model?: unknown;
  ct?: unknown;
}

const VERSION_RE = /^\d+\.\d+(\.\d+)?$/;

/** Registers a new release from an uploaded official schema. It starts Inactive with no mappings. */
export function registerRelease(input: NewReleaseInput): UsdmRelease {
  const version = String(input.version ?? '').trim();
  if (!VERSION_RE.test(version)) throw new HttpError(400, 'Release version must look like 4.0.0');
  if (db.prepare(`SELECT 1 FROM usdm_releases WHERE version = ?`).get(version)) throw new HttpError(409, `USDM release ${version} is already registered`);
  const schemaLocation = String(input.schemaLocation ?? '').trim();
  if (!/^https:\/\/\S+$/.test(schemaLocation)) throw new HttpError(400, 'Schema location must be the https URL of the official schema file');
  const schema = input.schema as any;
  const rootSchema = String(input.rootSchema || 'Wrapper-Input');
  if (!schema || typeof schema !== 'object' || !schema.components?.schemas) throw new HttpError(400, 'Schema must be the USDM API OpenAPI document (components.schemas)');
  if (!schema.components.schemas[rootSchema]) throw new HttpError(400, `Schema has no root schema '${rootSchema}'`);
  if (input.model && !(input.model as any).classes) throw new HttpError(400, 'Model must be a ProtocolIQ model.json ({ classes })');
  if (input.ct && !(input.ct as any).codelists) throw new HttpError(400, 'Terminology must be a ProtocolIQ terminology.json ({ codelists })');
  const schemaJson = JSON.stringify(schema);
  const actor = currentActor();
  const id = releaseId(version);
  const t = now();
  const schemaVersion = String(schema.info?.version ?? version);
  tx(() => {
    db.prepare(
      `INSERT INTO usdm_releases (id, version, name, description, schema_location, schema_version, schema_sha256, root_schema, schema_json, model_json, ct_json, sources_json, status, is_selected, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'Inactive',0,?,?,?)`,
    ).run(
      id,
      version,
      String(input.name || `CDISC USDM ${version}`).slice(0, 200),
      String(input.description ?? '').slice(0, 2000),
      schemaLocation,
      schemaVersion,
      sha256(schemaJson),
      rootSchema,
      schemaJson,
      input.model ? JSON.stringify(input.model) : null,
      input.ct ? JSON.stringify(input.ct) : null,
      JSON.stringify([{ name: 'Uploaded schema', url: schemaLocation, sha256: sha256(schemaJson) }]),
      actor.userId,
      t,
      t,
    );
    audit({ action: 'usdm.release.registered', entityType: 'usdm_release', entityId: id, next: { version, schemaLocation, schemaVersion, sha256: sha256(schemaJson) } });
  });
  return toRelease(db.prepare(`SELECT ${SUMMARY_COLS} FROM usdm_releases WHERE id = ?`).get(id));
}

export function updateRelease(id: string, patch: { status?: 'Active' | 'Inactive'; select?: boolean; reason?: string }) {
  const before = loadRelease(id);
  const t = now();
  tx(() => {
    if (patch.status && patch.status !== before.status) {
      if (patch.status === 'Inactive' && before.isSelected) throw new HttpError(409, 'Select another release before deactivating the selected release');
      db.prepare(`UPDATE usdm_releases SET status = ?, updated_at = ? WHERE id = ?`).run(patch.status, t, id);
    }
    if (patch.select && !before.isSelected) {
      const status = patch.status ?? before.status;
      if (status !== 'Active') throw new HttpError(409, 'Only an active release can be selected');
      const compat = compatibility(id);
      if (!compat.exportSupported) throw new HttpError(409, `ProtocolIQ has no structural assembler for USDM ${before.version} (supported major versions: ${SUPPORTED_MAJOR_VERSIONS.join(', ')})`);
      db.prepare(`UPDATE usdm_releases SET is_selected = 0, updated_at = ? WHERE is_selected = 1`).run(t);
      db.prepare(`UPDATE usdm_releases SET is_selected = 1, updated_at = ? WHERE id = ?`).run(t, id);
    }
    audit({
      action: 'usdm.release.updated',
      entityType: 'usdm_release',
      entityId: id,
      previous: { status: before.status, selected: before.isSelected },
      next: { status: patch.status ?? before.status, selected: patch.select ? true : before.isSelected },
      reason: patch.reason,
    });
  });
  cache.delete(id);
  return toRelease(db.prepare(`SELECT ${SUMMARY_COLS} FROM usdm_releases WHERE id = ?`).get(id));
}

export interface Compatibility {
  releaseId: string;
  version: string;
  exportSupported: boolean;
  exportNote: string;
  mappings: { total: number; compatible: number; incompatible: { id: string; target: string; problem: string }[] };
  modelAvailable: boolean;
  terminologyAvailable: boolean;
}

/** Checks whether this release's mappings point at classes/properties that exist in its schema. */
export function compatibility(id: string): Compatibility {
  const r = loadRelease(id);
  const major = r.version.split('.')[0];
  const exportSupported = SUPPORTED_MAJOR_VERSIONS.includes(major);
  const schemas = r.schema.components.schemas;
  const rows = db.prepare(`SELECT id, target_entity, target_property, transformation_type FROM usdm_mapping_registry WHERE release_id = ? AND active = 1`).all(id) as any[];
  const incompatible: Compatibility['mappings']['incompatible'] = [];
  for (const m of rows) {
    if (!m.target_entity || m.transformation_type === 'unsupported') continue;
    const s = schemas[`${m.target_entity}-Input`];
    if (!s) {
      incompatible.push({ id: m.id, target: m.target_entity, problem: `Class ${m.target_entity} is not in the ${r.version} schema` });
      continue;
    }
    if (m.target_property && !s.properties?.[m.target_property])
      incompatible.push({ id: m.id, target: `${m.target_entity}.${m.target_property}`, problem: `Property ${m.target_property} is not defined on ${m.target_entity} in ${r.version}` });
  }
  return {
    releaseId: id,
    version: r.version,
    exportSupported,
    exportNote: exportSupported ? `Assembled with the USDM ${major}.x structural assembler.` : `No structural assembler for USDM major version ${major}. Mappings can be configured but exports are disabled.`,
    mappings: { total: rows.length, compatible: rows.length - incompatible.length, incompatible },
    modelAvailable: !!r.model,
    terminologyAvailable: !!r.ct,
  };
}

export function codelist(release: LoadedRelease, code: string): CtCodelist | null {
  return release.ct?.codelists[code] ?? null;
}

export const newId = () => randomUUID();
