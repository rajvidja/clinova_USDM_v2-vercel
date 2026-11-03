import type { MappingStatus, TransformationType } from '../../shared/governance.ts';
import type { FieldDef } from '../../shared/types.ts';
import type { InternalModel, InternalRecord } from './internal_model.ts';
import type { MappingRule, SourceEntity } from './mapping_registry.ts';
import { cdiscCode, resolveTerm } from './terminology_mapper.ts';
import { fillTemplate, isBlank, parseAmount, parseDuration, parseTiming, parseWindow, plainText, quantity, sectionXhtml, visitWindowText, type TransformResult } from './transforms.ts';
import type { LoadedRelease } from './usdm_version.ts';

// Pipeline stage 2: the mapping rules engine. Applies the active registry rules to every internal record and returns,
// per record, the USDM property values it produced and a result for every rule (mapped, provisional, empty,
// unsupported, needs configuration, ...). Original values are kept in the result so nothing is silently dropped.

export type FieldOutcome =
  | 'mapped'
  | 'provisional'
  | 'empty'
  | 'unconverted'
  | 'unsupported'
  | 'needs-config'
  | 'terminology-review'
  | 'no-equivalent'
  | 'rule-inactive'
  | 'relationship';

export interface FieldResult {
  ruleId: string;
  ruleVersion: number;
  group: string;
  sourceEntity: string;
  sourceField: string;
  targetEntity: string | null;
  targetProperty: string | null;
  transformationType: TransformationType;
  ruleStatus: MappingStatus;
  scope: 'rule' | 'study' | 'element';
  outcome: FieldOutcome;
  original: unknown;
  value?: unknown;
  message?: string;
  terminologyId?: string;
}

export interface MappedRecord {
  record: InternalRecord;
  /** USDM values by class then property, e.g. values.Objective.level. */
  values: Record<string, Record<string, unknown>>;
  fields: FieldResult[];
}

export interface MapperOutput {
  records: Map<string, MappedRecord>;
  byEntity: Record<SourceEntity, MappedRecord[]>;
  /** Relationship rules that are active and approved for use, by relationship key. */
  relationships: Map<string, MappingRule>;
  /** Relationship rules that exist but are not usable (inactive, rejected or unsupported). */
  blockedRelationships: Map<string, MappingRule>;
}

const APPLIED: MappingStatus[] = ['Mapped', 'Validated', 'Requires Review'];
const PROVISIONAL: MappingStatus[] = ['Requires Review'];

const preview = (v: unknown): unknown => {
  if (v === undefined) return null;
  if (typeof v === 'string') return v.length > 600 ? `${v.slice(0, 600)}…` : v;
  if (v && typeof v === 'object') {
    const s = JSON.stringify(v);
    return s.length > 600 ? `${s.slice(0, 600)}…` : v;
  }
  return v;
};

const sourceValue = (rec: InternalRecord, field: string): unknown => (field.startsWith('(') ? undefined : rec.fields[field]);

export function mapEntities(model: InternalModel, release: LoadedRelease, rules: MappingRule[]): MapperOutput {
  const records = new Map<string, MappedRecord>();
  const byEntity = Object.fromEntries(Object.keys(model.records).map((k) => [k, [] as MappedRecord[]])) as Record<SourceEntity, MappedRecord[]>;
  const relationships = new Map<string, MappingRule>();
  const blockedRelationships = new Map<string, MappingRule>();

  const global = rules.filter((r) => !r.scopeStudyId);
  const scoped = rules.filter((r) => r.scopeStudyId === model.studyId && r.transformationType === 'manual');
  for (const r of global)
    if (r.transformationType === 'relationship' && r.rule.relationship) {
      if (APPLIED.includes(r.status)) relationships.set(r.rule.relationship, r);
      else blockedRelationships.set(r.rule.relationship, r);
    }
  for (const r of global)
    if (r.transformationType === 'unsupported' && r.targetEntity === 'StudyCell') blockedRelationships.set('arm-intervention', r);

  for (const [entity, recs] of Object.entries(model.records) as [SourceEntity, InternalRecord[]][]) {
    const entityRules = global.filter((r) => r.sourceEntity === entity);
    for (const rec of recs) {
      const out: MappedRecord = { record: rec, values: {}, fields: [] };
      const set = (cls: string, prop: string, value: unknown, multiple: boolean) => {
        const o = (out.values[cls] ??= {});
        if (multiple) {
          const arr = (o[prop] as unknown[] | undefined) ?? [];
          const key = JSON.stringify(value);
          if (!arr.some((x) => JSON.stringify(x) === key)) arr.push(value);
          o[prop] = arr;
        } else if (o[prop] === undefined) o[prop] = value;
      };
      // Highest priority first; for single-valued targets the first successful rule wins.
      const ordered = [...entityRules].sort((a, b) => Number(a.rule.priority ?? 1) - Number(b.rule.priority ?? 1));
      const handled = new Set<string>();
      for (const rule of ordered) {
        // A manual mapping configured for this element, or for all elements of this type in the study, takes precedence.
        const override =
          rule.transformationType !== 'relationship' && rule.targetProperty
            ? scoped.find((s) => s.scopeElementId === rec.elementId && s.targetEntity === rule.targetEntity && s.targetProperty === rule.targetProperty) ??
              scoped.find((s) => !s.scopeElementId && s.sourceEntity === entity && s.targetEntity === rule.targetEntity && s.targetProperty === rule.targetProperty)
            : undefined;
        if (override && handled.has(`${rule.targetEntity}.${rule.targetProperty}`)) continue;
        if (override) handled.add(`${rule.targetEntity}.${rule.targetProperty}`);
        const effective = override ?? rule;
        const scope: FieldResult['scope'] = override ? (override.scopeElementId ? 'element' : 'study') : 'rule';
        const base: Omit<FieldResult, 'outcome'> = {
          ruleId: effective.id,
          ruleVersion: effective.version,
          group: rule.group,
          sourceEntity: entity,
          sourceField: rule.sourceField,
          targetEntity: rule.targetEntity,
          targetProperty: rule.targetProperty,
          transformationType: effective.transformationType,
          ruleStatus: effective.status,
          scope,
          original: preview(sourceValue(rec, rule.sourceField)),
        };
        const push = (r: Partial<FieldResult> & { outcome: FieldOutcome }) => out.fields.push({ ...base, ...r });

        if (effective.transformationType === 'relationship') {
          push({ outcome: APPLIED.includes(effective.status) ? 'relationship' : 'rule-inactive', message: APPLIED.includes(effective.status) ? undefined : `Relationship rule is ${effective.status}` });
          continue;
        }
        if (effective.transformationType === 'unsupported') {
          const orig = sourceValue(rec, rule.sourceField);
          // Unsupported fields with no source value are listed once per entity type, not per empty record.
          if (rule.sourceField.startsWith('(') || !isBlank(orig)) push({ outcome: 'unsupported', message: effective.reason });
          continue;
        }
        if (!APPLIED.includes(effective.status)) {
          if (effective.transformationType === 'manual' && effective.status === 'Not Mapped') {
            push({ outcome: 'needs-config', message: effective.reason || 'Manual value required' });
          } else {
            push({ outcome: 'rule-inactive', message: `Rule status is ${effective.status}; not applied` });
          }
          continue;
        }
        const provisional = PROVISIONAL.includes(effective.status);
        const multiple = !!rule.rule.multiple;
        const r = applyRule(effective, rec, release, model);
        if (r.kind === 'value') {
          set(rule.targetEntity!, rule.targetProperty!, r.value, multiple);
          push({ outcome: provisional || r.provisional ? 'provisional' : 'mapped', value: preview(r.value), message: r.note ?? (provisional ? `Rule '${effective.status}'` : undefined), terminologyId: r.terminologyId });
        } else {
          push({ outcome: r.outcome, message: r.message, terminologyId: r.terminologyId });
        }
      }
      records.set(rec.id, out);
      byEntity[entity].push(out);
    }
  }
  return { records, byEntity, relationships, blockedRelationships };
}

type Applied =
  | { kind: 'value'; value: unknown; provisional?: boolean; note?: string; terminologyId?: string }
  | { kind: 'none'; outcome: FieldOutcome; message: string; terminologyId?: string };

const fromTransform = (t: TransformResult): Applied => (t.ok ? { kind: 'value', value: t.value, note: t.note } : { kind: 'none', outcome: t.status === 'empty' ? 'empty' : 'unconverted', message: t.message });

function applyRule(rule: MappingRule, rec: InternalRecord, release: LoadedRelease, model: InternalModel): Applied {
  const cfg = rule.rule;
  const raw = sourceValue(rec, rule.sourceField);
  switch (rule.transformationType) {
    case 'direct': {
      let v = raw;
      if (isBlank(v) && cfg.fallback) v = String(cfg.fallback).includes('{') ? fillTemplate(String(cfg.fallback), rec.fields) : rec.fields[String(cfg.fallback)];
      if (cfg.transform === 'plainText') return fromTransform(plainText(v));
      if (isBlank(v)) return { kind: 'none', outcome: 'empty', message: 'No value recorded' };
      return { kind: 'value', value: typeof v === 'string' ? v.trim() : v, note: isBlank(raw) && cfg.fallback ? `Fallback from '${cfg.fallback}'` : undefined };
    }
    case 'terminology':
      return terminology(release, String(cfg.domain), raw, String(cfg.as ?? 'Code'), !!cfg.optional);
    case 'manual':
      return manualValue(release, cfg);
    case 'value':
      return valueFn(rule, rec, release, raw, model);
    default:
      return { kind: 'none', outcome: 'unsupported', message: rule.reason };
  }
}

export function aliasCode(code: object) {
  return { standardCode: code, standardCodeAliases: [], instanceType: 'AliasCode' };
}

function terminology(release: LoadedRelease, domain: string, raw: unknown, as: string, optional: boolean): Applied {
  const res = resolveTerm(release, domain, raw, !optional);
  const tid = res.entry?.id;
  switch (res.outcome) {
    case 'empty':
      return { kind: 'none', outcome: 'empty', message: 'No value recorded' };
    case 'unknown-domain':
      return { kind: 'none', outcome: 'unconverted', message: `Unknown terminology domain '${domain}'` };
    case 'no-equivalent':
      return { kind: 'none', outcome: 'no-equivalent', message: res.entry?.matchBasis || 'No equivalent CDISC term', terminologyId: tid };
    case 'unmatched':
    case 'review':
    case 'rejected':
      if (optional) return { kind: 'none', outcome: 'empty', message: 'No biomedical concept configured for this activity' };
      return {
        kind: 'none',
        outcome: 'terminology-review',
        message: res.outcome === 'rejected' ? 'Terminology mapping was rejected' : res.entry?.matchBasis || 'Unmatched value; requires manual terminology mapping',
        terminologyId: tid,
      };
  }
  const entry = res.entry;
  if (as === 'BiomedicalConcept') return { kind: 'value', value: { bcEntry: entry }, provisional: res.outcome === 'provisional', terminologyId: tid };
  const code = cdiscCode(release, entry.targetCodelist!, entry.targetCode!, '');
  if (!code) return { kind: 'none', outcome: 'terminology-review', message: `Target ${entry.targetCode} not found in codelist ${entry.targetCodelist}`, terminologyId: tid };
  const value = as === 'AliasCode' ? aliasCode(code) : code;
  return { kind: 'value', value, provisional: res.outcome === 'provisional', note: `${entry.targetCode} ${entry.targetDecode} — ${entry.matchBasis}`, terminologyId: tid };
}

function manualValue(release: LoadedRelease, cfg: Record<string, any>): Applied {
  const v = cfg.value;
  if (v === undefined || v === null || v === '') return { kind: 'none', outcome: 'needs-config', message: 'Manual value not configured' };
  switch (cfg.valueType) {
    case 'boolean':
      if (v === true || v === 'true') return { kind: 'value', value: true };
      if (v === false || v === 'false') return { kind: 'value', value: false };
      return { kind: 'none', outcome: 'needs-config', message: `'${v}' is not true/false` };
    case 'code': {
      const code = cdiscCode(release, String(cfg.codelist), String(v), '');
      return code ? { kind: 'value', value: code } : { kind: 'none', outcome: 'needs-config', message: `${v} is not a term of codelist ${cfg.codelist}` };
    }
    case 'isoCode':
      if (!v || typeof v !== 'object' || !v.code || !v.codeSystem || !v.decode) return { kind: 'none', outcome: 'needs-config', message: 'Code, code system and decode are required' };
      return { kind: 'value', value: { code: String(v.code), codeSystem: String(v.codeSystem), codeSystemVersion: String(v.codeSystemVersion ?? ''), decode: String(v.decode), instanceType: 'Code' } };
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? { kind: 'value', value: String(v) } : { kind: 'none', outcome: 'needs-config', message: 'Date must be YYYY-MM-DD' };
    default:
      return { kind: 'value', value: String(v).trim() };
  }
}

function unitAlias(release: LoadedRelease, unitText: string): Applied {
  const t = terminology(release, 'unit', unitText, 'AliasCode', false);
  return t;
}

function valueFn(rule: MappingRule, rec: InternalRecord, release: LoadedRelease, raw: unknown, model: InternalModel): Applied {
  const cfg = rule.rule;
  switch (cfg.fn) {
    case 'constant':
      return { kind: 'value', value: cfg.value };
    case 'constantCode': {
      const code = cdiscCode(release, String(cfg.codelist), String(cfg.code), '');
      return code ? { kind: 'value', value: code } : { kind: 'none', outcome: 'unconverted', message: `${cfg.code} is not in codelist ${cfg.codelist} for USDM ${release.version}` };
    }
    case 'template': {
      const fields = { ...model.records.study[0]?.fields, ...rec.fields };
      const s = fillTemplate(String(cfg.template), fields).trim();
      return s ? { kind: 'value', value: s } : { kind: 'none', outcome: 'empty', message: 'Template produced no text' };
    }
    case 'quantity':
      return fromTransform(quantity(raw));
    case 'dosage':
    case 'durationQuantity': {
      const parsed = cfg.fn === 'dosage' ? parseAmount(raw) : parseDuration(raw);
      if ('ok' in parsed) return fromTransform(parsed);
      if (!parsed.unitText) return { kind: 'value', value: { value: parsed.value, instanceType: 'Quantity' }, note: 'No unit given' };
      const unit = unitAlias(release, parsed.unitText);
      if (unit.kind !== 'value') return { kind: 'none', outcome: unit.outcome, message: `Unit '${parsed.unitText}': ${unit.message}`, terminologyId: unit.terminologyId };
      return { kind: 'value', value: { value: parsed.value, unit: unit.value, instanceType: 'Quantity' }, provisional: unit.provisional, terminologyId: unit.terminologyId };
    }
    case 'timing': {
      const t = parseTiming(raw);
      return 'ok' in t ? fromTransform(t) : { kind: 'value', value: t };
    }
    case 'window': {
      const text = visitWindowText(rec.fields);
      if (cfg.bound === 'label') return text ? { kind: 'value', value: text } : { kind: 'none', outcome: 'empty', message: 'No visit window recorded' };
      const w = parseWindow(text);
      if ('ok' in w) return fromTransform(w);
      return { kind: 'value', value: cfg.bound === 'lower' ? w.lower : w.upper };
    }
    case 'xhtml': {
      const all = rec.fields['(all fields)'] as { defs: FieldDef[]; content: Record<string, unknown> };
      const { html, structuredOnly } = sectionXhtml(all.defs, all.content);
      if (html) return { kind: 'value', value: html };
      return { kind: 'none', outcome: 'empty', message: structuredOnly ? 'Structured content; emitted as USDM entities' : 'Section has no content' };
    }
    default:
      return { kind: 'none', outcome: 'unconverted', message: `Unknown value transformation '${cfg.fn}'` };
  }
}
