import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { ValidateFunction } from 'ajv';
import { isSubclass } from './relationship_mapper.ts';
import type { LoadedRelease } from './usdm_version.ts';

// Pipeline stage 4: validation of the generated USDM JSON.
//  1. JSON schema validation against the official USDM API schema of the selected release (Ajv, JSON Schema 2020-12).
//  2. Referential integrity derived from the USDM model: unique ids, every reference resolves, and references point
//     to a compatible class.
//  3. Model cardinality: attributes the UML model declares as required (1 or 1..*) that the API schema does not
//     enforce are reported as warnings.
// CDISC CORE conformance rules are not executed.

export interface SchemaError {
  path: string;
  message: string;
  keyword: string;
  usdmClass?: string;
  usdmId?: string;
}
export interface ReferenceError {
  path: string;
  usdmId: string;
  usdmClass: string;
  property: string;
  target: string;
  message: string;
}
export interface CardinalityWarning {
  usdmId: string;
  usdmClass: string;
  property: string;
  cardinality: string;
  message: string;
}
export interface ValidationReport {
  releaseId: string;
  releaseVersion: string;
  rootSchema: string;
  schemaValid: boolean;
  schemaErrors: SchemaError[];
  referencesValid: boolean;
  referenceErrors: ReferenceError[];
  duplicateIds: string[];
  cardinalityWarnings: CardinalityWarning[];
  objectCount: number;
  checkedAt: string;
  durationMs: number;
}

const validators = new Map<string, { sha: string; fn: ValidateFunction }>();

function validatorFor(release: LoadedRelease): ValidateFunction {
  const hit = validators.get(release.id);
  if (hit && hit.sha === release.schemaSha256) return hit.fn;
  // CommonJS interop: the constructor is the module itself under Node ESM and `.default` under bundlers.
  const AjvCtor = ((Ajv2020 as any).default ?? Ajv2020) as typeof Ajv2020;
  const formats = ((addFormats as any).default ?? addFormats) as (a: unknown) => void;
  const ajv = new AjvCtor({ strict: false, allErrors: true, validateFormats: true });
  formats(ajv);
  ajv.addSchema({ $id: 'usdm', components: release.schema.components });
  const fn = ajv.getSchema(`usdm#/components/schemas/${release.rootSchema}`);
  if (!fn) throw new Error(`Root schema ${release.rootSchema} not found in USDM ${release.version}`);
  validators.set(release.id, { sha: release.schemaSha256, fn });
  return fn;
}

/** Walks the JSON tree and returns every object carrying an instanceType, with its JSON pointer. */
function collect(root: unknown) {
  const out: { path: string; obj: Record<string, any> }[] = [];
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}/${i}`));
    else if (v && typeof v === 'object') {
      const o = v as Record<string, any>;
      if (typeof o.instanceType === 'string') out.push({ path, obj: o });
      for (const [k, x] of Object.entries(o)) walk(x, `${path}/${k}`);
    }
  };
  walk(root, '');
  return out;
}

export function validateUsdm(release: LoadedRelease, json: unknown): ValidationReport {
  const t0 = Date.now();
  const fn = validatorFor(release);
  const objects = collect(json);
  const byPath = new Map(objects.map((o) => [o.path, o.obj]));
  const ownerOf = (path: string) => {
    let p = path;
    while (p) {
      const o = byPath.get(p);
      if (o) return o;
      p = p.slice(0, p.lastIndexOf('/'));
    }
    return undefined;
  };
  const schemaValid = fn(json) as boolean;
  // Ajv reports every failed branch of a union (e.g. Interventional vs Observational study design, or "Code | null").
  // Errors from branches whose instanceType does not match the object are noise; drop them and duplicates.
  const raw = fn.errors ?? [];
  const wrongBranches = raw
    .filter((e) => e.keyword === 'const' && e.instancePath.endsWith('/instanceType'))
    .map((e) => ({ base: e.instancePath.slice(0, -'/instanceType'.length), schema: e.schemaPath.split('/properties/')[0] }));
  const seenErr = new Set<string>();
  const schemaErrors: SchemaError[] = raw
    .filter((e) => {
      if (['anyOf', 'oneOf', 'if', 'const'].includes(e.keyword)) return false;
      if (e.keyword === 'enum' && e.instancePath.endsWith('/instanceType')) return false;
      if (e.keyword === 'type' && (e.params as any).type === 'null') return false;
      if (wrongBranches.some((w) => (e.instancePath === w.base || e.instancePath.startsWith(`${w.base}/`)) && e.schemaPath.startsWith(`${w.schema}/`))) return false;
      const key = `${e.instancePath}|${e.keyword}|${JSON.stringify(e.params)}`;
      if (seenErr.has(key)) return false;
      seenErr.add(key);
      return true;
    })
    .slice(0, 500)
    .map((e) => {
      const owner = ownerOf(e.instancePath);
      const extra = e.keyword === 'required' ? ` '${(e.params as any).missingProperty}'` : e.keyword === 'additionalProperties' ? ` '${(e.params as any).additionalProperty}'` : '';
      return { path: e.instancePath || '/', message: `${e.message ?? 'invalid'}${extra}`, keyword: e.keyword, usdmClass: owner?.instanceType, usdmId: owner?.id };
    });

  // Referential integrity
  const ids = new Map<string, string>();
  const duplicateIds: string[] = [];
  for (const { obj } of objects) {
    if (typeof obj.id !== 'string') continue;
    if (ids.has(obj.id)) duplicateIds.push(obj.id);
    ids.set(obj.id, obj.instanceType);
  }
  const referenceErrors: ReferenceError[] = [];
  const cardinalityWarnings: CardinalityWarning[] = [];
  const model = release.model;
  if (model)
    for (const { path, obj } of objects) {
      const cls = model.classes[obj.instanceType];
      if (!cls) continue;
      for (const [prop, attr] of Object.entries(cls.attributes)) {
        const v = obj[prop];
        if (attr.relationship === 'Ref') {
          const refs = v == null ? [] : Array.isArray(v) ? v : [v];
          for (const r of refs) {
            if (typeof r !== 'string') {
              referenceErrors.push({ path: `${path}/${prop}`, usdmId: obj.id, usdmClass: obj.instanceType, property: prop, target: String(r), message: 'Reference is not an id string' });
              continue;
            }
            const targetCls = ids.get(r);
            if (!targetCls) referenceErrors.push({ path: `${path}/${prop}`, usdmId: obj.id, usdmClass: obj.instanceType, property: prop, target: r, message: `Reference '${r}' does not resolve to any object` });
            else if (!attr.types.some((t) => isSubclass(model, targetCls, t)))
              referenceErrors.push({ path: `${path}/${prop}`, usdmId: obj.id, usdmClass: obj.instanceType, property: prop, target: r, message: `${obj.instanceType}.${prop} must reference ${attr.types.join(' | ')}, not ${targetCls}` });
          }
        }
        const min = attr.cardinality.startsWith('1');
        const empty = v === undefined || v === null || (Array.isArray(v) && v.length === 0);
        if (min && empty && prop !== 'instanceType')
          cardinalityWarnings.push({ usdmId: obj.id, usdmClass: obj.instanceType, property: prop, cardinality: attr.cardinality, message: `${obj.instanceType}.${prop} has cardinality ${attr.cardinality} in the USDM model but is empty` });
      }
    }
  // Required-property errors already appear as schema errors; keep warnings for model-only requirements.
  const schemaMissing = new Set(schemaErrors.filter((e) => e.keyword === 'required').map((e) => `${e.usdmId}|${e.message.match(/'(.+)'$/)?.[1]}`));
  return {
    releaseId: release.id,
    releaseVersion: release.version,
    rootSchema: release.rootSchema,
    schemaValid,
    schemaErrors,
    referencesValid: !referenceErrors.length && !duplicateIds.length,
    referenceErrors,
    duplicateIds,
    cardinalityWarnings: cardinalityWarnings.filter((w) => !schemaMissing.has(`${w.usdmId}|${w.property}`)),
    objectCount: objects.length,
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
  };
}
