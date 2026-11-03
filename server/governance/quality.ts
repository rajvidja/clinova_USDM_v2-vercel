import { createHash, randomUUID } from 'node:crypto';
import { flattenBundle, type StudyElement } from '../../shared/elements.ts';
import type { GovernanceRule, QualityFinding, RuleCategory, Severity } from '../../shared/governance.ts';
import { RULE_CATEGORIES, SEVERITIES } from '../../shared/governance.ts';
import type { ProtocolBundle } from '../../shared/types.ts';
import { audit } from '../audit.ts';
import { currentActor } from '../context.ts';
import { db, tx } from '../db.ts';
import { getBundle, HttpError } from '../repo.ts';
import { resolveTerm } from '../usdm/terminology_mapper.ts';
import { selectedRelease, type LoadedRelease } from '../usdm/usdm_version.ts';
import defaultRules from './rules/default-rules.json' with { type: 'json' };

// Rule-based data quality engine. Rules are rows in governance_rules (seeded from rules/default-rules.json and
// managed in the Rules Manager). Generic check types are evaluated against the governed study elements; 'builtin'
// checks run the named procedures below. Each execution is recorded per rule, results are stored per finding, and
// findings are synchronised with governance issues by fingerprint.

export const CHECK_TYPES = ['required', 'pattern', 'date', 'numeric', 'min-count', 'unique', 'allowed-values', 'terminology', 'max-length', 'builtin'] as const;
export const BUILTIN_KEYS = [
  'soa-required-information',
  'conflicting-protocol-versions',
  'inconsistent-visit-names',
  'inconsistent-arm-references',
  'endpoint-without-objective',
  'activity-nonexistent-visit',
  'invalid-relationship-references',
  'cross-section-conflict',
  'activity-unscheduled',
  'numeric-fields',
  'usdm-invalid-references',
  'usdm-schema-errors',
  'missing-source-reference',
  'missing-page-number',
  'missing-source-section',
  'missing-mapping-history',
  'missing-ownership',
  'missing-review-history',
] as const;
const SEVERITY_WEIGHT: Record<Severity, number> = { Critical: 5, High: 3, Medium: 2, Low: 1, Informational: 0 };

const now = () => new Date().toISOString();

const toRule = (r: any): GovernanceRule => ({
  id: r.id,
  name: r.name,
  description: r.description,
  category: r.category,
  severity: r.severity,
  entityType: r.entity_type,
  checkType: r.check_type,
  config: JSON.parse(r.config_json || '{}'),
  active: !!r.active,
  builtin: !!r.builtin,
  version: Number(r.version),
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedBy: r.updated_by,
  updatedAt: r.updated_at,
});

export function seedRules() {
  const t = now();
  tx(() => {
    for (const r of defaultRules.rules) {
      if (db.prepare(`SELECT 1 FROM governance_rules WHERE id = ?`).get(r.id)) continue;
      db.prepare(
        `INSERT INTO governance_rules (id, name, description, category, severity, entity_type, check_type, config_json, active, builtin, version, created_by, created_at, updated_by, updated_at)
         VALUES (?,?,?,?,?,?,?,?,1,1,1,'system',?,'system',?)`,
      ).run(r.id, r.name, (r as { description?: string }).description ?? '', r.category, r.severity, r.entityType, r.checkType, JSON.stringify(r.config ?? {}), t, t);
    }
  });
}

export function listRules(): (GovernanceRule & { lastRun: { executedAt: string; findings: number; checked: number; status: string } | null })[] {
  return (db.prepare(`SELECT * FROM governance_rules ORDER BY id`).all() as any[]).map((r) => {
    const last = db.prepare(`SELECT executed_at, findings, checked, status FROM governance_rule_runs WHERE rule_id = ? ORDER BY executed_at DESC LIMIT 1`).get(r.id) as any;
    return { ...toRule(r), lastRun: last ? { executedAt: last.executed_at, findings: Number(last.findings), checked: Number(last.checked), status: last.status } : null };
  });
}

export function getRule(id: string): GovernanceRule {
  const r = db.prepare(`SELECT * FROM governance_rules WHERE id = ?`).get(id);
  if (!r) throw new HttpError(404, 'Rule not found');
  return toRule(r);
}

const ENTITY_TYPES = ['*', 'study', 'protocol', 'subsection', 'objective', 'endpoint', 'arm', 'criterion', 'visit', 'activity', 'footnote'];

function validateRuleInput(r: Partial<GovernanceRule>) {
  if (!r.name?.trim() || r.name.length > 200) throw new HttpError(400, 'Rule name is required (max 200 characters)');
  if (!RULE_CATEGORIES.includes(r.category as RuleCategory)) throw new HttpError(400, 'Unknown rule category');
  if (!SEVERITIES.includes(r.severity as Severity)) throw new HttpError(400, 'Unknown severity');
  if (!ENTITY_TYPES.includes(String(r.entityType))) throw new HttpError(400, 'Unknown entity type');
  if (!(CHECK_TYPES as readonly string[]).includes(String(r.checkType))) throw new HttpError(400, 'Unknown check type');
  const c = (r.config ?? {}) as Record<string, any>;
  if (JSON.stringify(c).length > 10_000) throw new HttpError(400, 'Rule configuration is too large');
  const needsField = ['required', 'pattern', 'date', 'numeric', 'unique', 'allowed-values', 'terminology', 'max-length'];
  if (needsField.includes(String(r.checkType)) && (typeof c.field !== 'string' || !c.field)) throw new HttpError(400, 'This check type needs a field');
  if (r.checkType === 'pattern') {
    try {
      new RegExp(String(c.pattern), String(c.flags ?? ''));
    } catch {
      throw new HttpError(400, 'Pattern is not a valid regular expression');
    }
    if (String(c.pattern).length > 500) throw new HttpError(400, 'Pattern is too long');
  }
  if (r.checkType === 'allowed-values' && (!Array.isArray(c.values) || !c.values.length)) throw new HttpError(400, 'List the allowed values');
  if (r.checkType === 'min-count' && !(Number(c.min) >= 1)) throw new HttpError(400, 'Minimum count must be at least 1');
  if (r.checkType === 'max-length' && !(Number(c.max) >= 1)) throw new HttpError(400, 'Maximum length must be at least 1');
  if (r.checkType === 'builtin' && !(BUILTIN_KEYS as readonly string[]).includes(String(c.key))) throw new HttpError(400, 'Unknown built-in check');
  if (r.checkType === 'terminology' && typeof c.domain !== 'string') throw new HttpError(400, 'Terminology checks need a domain');
}

export function createRule(input: Partial<GovernanceRule> & { id?: string }) {
  const rule = { ...input, config: input.config ?? {} };
  validateRuleInput(rule);
  const id = input.id?.trim() || `R-${randomUUID().slice(0, 8).toUpperCase()}`;
  if (!/^[A-Za-z0-9_-]{2,40}$/.test(id)) throw new HttpError(400, 'Rule id may contain letters, digits, - and _');
  if (db.prepare(`SELECT 1 FROM governance_rules WHERE id = ?`).get(id)) throw new HttpError(409, 'A rule with this id already exists');
  const actor = currentActor();
  const t = now();
  tx(() => {
    db.prepare(
      `INSERT INTO governance_rules (id, name, description, category, severity, entity_type, check_type, config_json, active, builtin, version, created_by, created_at, updated_by, updated_at)
       VALUES (?,?,?,?,?,?,?,?,1,0,1,?,?,?,?)`,
    ).run(id, rule.name!.trim(), rule.description ?? '', rule.category!, rule.severity!, rule.entityType!, rule.checkType!, JSON.stringify(rule.config), actor.userId, t, actor.userId, t);
    audit({ action: 'governance.rule.created', entityType: 'governance_rule', entityId: id, next: getRule(id) });
  });
  return getRule(id);
}

export function updateRule(id: string, patch: Partial<GovernanceRule>, reason?: string) {
  const before = getRule(id);
  const next = { ...before, ...patch, id, builtin: before.builtin };
  if (before.builtin && (patch.checkType && patch.checkType !== before.checkType)) throw new HttpError(400, 'The check type of a built-in rule cannot be changed');
  validateRuleInput(next);
  const actor = currentActor();
  tx(() => {
    db.prepare(
      `UPDATE governance_rules SET name = ?, description = ?, category = ?, severity = ?, entity_type = ?, check_type = ?, config_json = ?, active = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?`,
    ).run(next.name.trim(), next.description ?? '', next.category, next.severity, next.entityType, next.checkType, JSON.stringify(next.config), next.active ? 1 : 0, actor.userId, now(), id);
    audit({ action: patch.active !== undefined && patch.active !== before.active ? (patch.active ? 'governance.rule.activated' : 'governance.rule.deactivated') : 'governance.rule.updated', entityType: 'governance_rule', entityId: id, previous: before, next: getRule(id), reason });
  });
  return getRule(id);
}

export function ruleRuns(ruleId: string, limit = 50) {
  return (
    db
      .prepare(
        `SELECT rr.*, s.title AS study_title, s.protocol_number FROM governance_rule_runs rr LEFT JOIN studies s ON s.id = rr.study_id WHERE rr.rule_id = ? ORDER BY rr.executed_at DESC LIMIT ?`,
      )
      .all(ruleId, Math.min(limit, 200)) as any[]
  ).map((r) => ({
    id: r.id,
    runId: r.run_id,
    ruleVersion: Number(r.rule_version),
    studyId: r.study_id,
    studyTitle: r.study_title,
    protocolNumber: r.protocol_number,
    protocolId: r.protocol_id,
    executedBy: r.executed_by,
    executedAt: r.executed_at,
    checked: Number(r.checked),
    findings: Number(r.findings),
    status: r.status,
    error: r.error,
  }));
}

// ---------- Evaluation ----------

interface Ctx {
  bundle: ProtocolBundle;
  elements: StudyElement[];
  byId: Map<string, StudyElement>;
  lineage: Map<string, any>;
  release: LoadedRelease | null;
}

interface Evaluation {
  checked: number;
  findings: QualityFinding[];
}

const blank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length);
const show = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 300);
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

function elementsFor(ctx: Ctx, type: string) {
  return type === '*' ? ctx.elements : ctx.elements.filter((e) => e.type === type);
}

function evaluate(rule: GovernanceRule, ctx: Ctx): Evaluation {
  const c = rule.config as Record<string, any>;
  const els = elementsFor(ctx, rule.entityType);
  const f = (el: StudyElement | null, description: string, detected: unknown, expected: string, detailKey = ''): QualityFinding => ({
    ruleId: rule.id,
    elementId: el?.id ?? null,
    elementType: el?.type ?? (rule.entityType === '*' ? null : rule.entityType),
    elementLabel: el?.label,
    detailKey,
    description,
    detectedValue: show(detected),
    expectedCondition: expected,
  });
  const fieldLabel = String(c.field ?? '');
  switch (rule.checkType) {
    case 'required':
      return { checked: els.length, findings: els.filter((e) => blank(e.content[c.field])).map((e) => f(e, `${e.label}: ${fieldLabel} is missing`, e.content[c.field], `${fieldLabel} is recorded`)) };
    case 'pattern': {
      const re = new RegExp(String(c.pattern), String(c.flags ?? ''));
      const vals = els.filter((e) => !blank(e.content[c.field]) && !/^[\s—–-]+$/.test(String(e.content[c.field])));
      return { checked: vals.length, findings: vals.filter((e) => !re.test(String(e.content[c.field]))).map((e) => f(e, `${e.label}: ${fieldLabel} '${show(e.content[c.field])}' has an invalid format`, e.content[c.field], c.expected ?? `Matches ${c.pattern}`)) };
    }
    case 'date': {
      const vals = els.filter((e) => !blank(e.content[c.field]));
      return { checked: vals.length, findings: vals.filter((e) => !isDate(String(e.content[c.field]))).map((e) => f(e, `${e.label}: ${fieldLabel} is not a valid date`, e.content[c.field], 'A real calendar date in YYYY-MM-DD format')) };
    }
    case 'numeric': {
      const vals = els.filter((e) => !blank(e.content[c.field]));
      return { checked: vals.length, findings: vals.filter((e) => !Number.isFinite(Number(e.content[c.field]))).map((e) => f(e, `${e.label}: ${fieldLabel} is not a number`, e.content[c.field], 'A number')) };
    }
    case 'max-length': {
      const vals = els.filter((e) => !blank(e.content[c.field]));
      return { checked: vals.length, findings: vals.filter((e) => String(e.content[c.field]).length > Number(c.max)).map((e) => f(e, `${e.label}: ${fieldLabel} is longer than ${c.max} characters`, `${String(e.content[c.field]).length} characters`, `At most ${c.max} characters`)) };
    }
    case 'allowed-values': {
      const allowed = (c.values as string[]).map((v) => v.toLowerCase());
      const vals = els.filter((e) => !blank(e.content[c.field]));
      return { checked: vals.length, findings: vals.filter((e) => !allowed.includes(String(e.content[c.field]).toLowerCase())).map((e) => f(e, `${e.label}: ${fieldLabel} '${show(e.content[c.field])}' is not an allowed value`, e.content[c.field], `One of: ${(c.values as string[]).join(', ')}`)) };
    }
    case 'min-count': {
      const where = (c.where ?? {}) as Record<string, unknown>;
      const matching = els.filter((e) => Object.entries(where).every(([k, v]) => e.content[k] === v) && (!c.nonEmpty || !blank(e.content[c.nonEmpty])));
      const what = Object.values(where).join(' ') || rule.entityType;
      return { checked: 1, findings: matching.length >= Number(c.min) ? [] : [f(null, `Fewer than ${c.min} ${what} ${rule.entityType}(s) with content`, `${matching.length} found`, `At least ${c.min}`)] };
    }
    case 'unique': {
      const vals = els.filter((e) => !blank(e.content[c.field]));
      const findings: QualityFinding[] = [];
      if (c.scope === 'all-studies') {
        for (const e of vals) {
          const others = db.prepare(`SELECT id, title FROM studies WHERE id != ? AND lower(trim(protocol_number)) = lower(trim(?))`).all(ctx.bundle.study.id, String(e.content[c.field])) as any[];
          if (others.length) findings.push(f(e, `${fieldLabel} '${show(e.content[c.field])}' is also used by ${others.length} other stud${others.length > 1 ? 'ies' : 'y'}`, e.content[c.field], 'Unique across all studies', others.map((o) => o.id).join(',')));
        }
      } else {
        const seen = new Map<string, StudyElement>();
        for (const e of vals) {
          const k = String(e.content[c.field]).trim().toLowerCase();
          const first = seen.get(k);
          if (first) findings.push(f(e, `${e.label}: ${fieldLabel} '${show(e.content[c.field])}' duplicates ${first.label}`, e.content[c.field], `Unique within the protocol`, first.id));
          else seen.set(k, e);
        }
      }
      return { checked: vals.length, findings };
    }
    case 'terminology': {
      if (!ctx.release) return { checked: 0, findings: [] };
      const vals = els.filter((e) => !blank(e.content[c.field]));
      const findings: QualityFinding[] = [];
      for (const e of vals) {
        const r = resolveTerm(ctx.release, String(c.domain), e.content[c.field], true);
        if (r.outcome === 'mapped' || r.outcome === 'provisional' || r.outcome === 'no-equivalent') continue;
        findings.push(
          f(e, `${e.label}: ${fieldLabel} '${show(e.content[c.field])}' has no approved controlled terminology mapping`, e.content[c.field], `Mapped to a term of the ${c.domain} terminology (USDM ${ctx.release.version})`),
        );
      }
      return { checked: vals.length, findings };
    }
    case 'builtin':
      return builtin(String(c.key), rule, ctx, f);
    default:
      throw new Error(`Unknown check type ${rule.checkType}`);
  }
}

type F = (el: StudyElement | null, description: string, detected: unknown, expected: string, detailKey?: string) => QualityFinding;

function builtin(key: string, rule: GovernanceRule, ctx: Ctx, f: F): Evaluation {
  const b = ctx.bundle;
  const visits = ctx.elements.filter((e) => e.type === 'visit');
  const activities = ctx.elements.filter((e) => e.type === 'activity');
  const visitIds = new Set(b.soa.visits.map((v) => v.id));
  switch (key) {
    case 'soa-required-information': {
      const out: QualityFinding[] = [];
      if (!b.soa.visits.length) out.push(f(null, 'The Schedule of Activities has no visits', '0 visits', 'At least one visit', 'no-visits'));
      if (!b.soa.activities.length) out.push(f(null, 'The Schedule of Activities has no assessments', '0 assessments', 'At least one assessment', 'no-activities'));
      for (const v of visits) if (blank(v.content.name)) out.push(f(v, 'A visit has no name', '', 'Every visit is named'));
      for (const a of activities) if (blank(a.content.name)) out.push(f(a, 'An assessment has no name', '', 'Every assessment is named'));
      return { checked: 2 + visits.length + activities.length, findings: out };
    }
    case 'conflicting-protocol-versions': {
      const rows = db.prepare(`SELECT id, version, status FROM protocols WHERE study_id = ? AND id != ?`).all(b.study.id, b.protocol.id) as any[];
      const same = rows.filter((r) => String(r.version).trim() && String(r.version).trim() === String(b.protocol.version).trim());
      const el = ctx.byId.get(b.protocol.id) ?? null;
      return { checked: 1, findings: same.length ? [f(el, `Another protocol of this study also has version '${b.protocol.version}'`, same.map((r) => `${r.version} (${r.status})`).join(', '), 'Each protocol version of a study has a distinct version number', same.map((r) => r.id).join(','))] : [] };
    }
    case 'inconsistent-visit-names': {
      const seen = new Map<string, StudyElement>();
      const out: QualityFinding[] = [];
      for (const v of visits) {
        const raw = String(v.content.name ?? '');
        const k = raw.trim().replace(/\s+/g, ' ').toLowerCase();
        if (!k) continue;
        const first = seen.get(k);
        if (first) out.push(f(v, `Visit name '${raw}' is used more than once`, raw, 'Visit names are unique', first.id));
        else seen.set(k, v);
        if (raw !== raw.trim() || /\s{2,}/.test(raw)) out.push(f(v, `Visit name '${raw}' has extra whitespace`, raw, 'Names without leading, trailing or repeated spaces', 'ws'));
      }
      return { checked: visits.length, findings: out };
    }
    case 'inconsistent-arm-references': {
      const out: QualityFinding[] = [];
      const arms = ctx.elements.filter((e) => e.type === 'arm');
      const names = new Map<string, StudyElement>();
      const byIntervention = new Map<string, StudyElement[]>();
      for (const a of arms) {
        const n = String(a.content.name ?? '').trim().toLowerCase();
        if (n) {
          const first = names.get(n);
          if (first) out.push(f(a, `Arm name '${a.content.name}' is used by more than one arm`, a.content.name, 'Arm names are unique', first.id));
          else names.set(n, a);
        }
        const iv = String(a.content.interventionName ?? '').trim().toLowerCase();
        if (iv) byIntervention.set(iv, [...(byIntervention.get(iv) ?? []), a]);
      }
      for (const [iv, list] of byIntervention) {
        const types = new Set(list.map((a) => String(a.content.armType)));
        if (types.size > 1) out.push(f(list[1], `Intervention '${list[0].content.interventionName}' is used in arms of different types (${[...types].join(', ')})`, [...types].join(', '), 'An intervention plays one role across arms', iv));
      }
      return { checked: arms.length, findings: out };
    }
    case 'endpoint-without-objective': {
      const cats = (rule.config.categories as string[] | undefined) ?? [];
      const objectiveIds = new Set(b.objectives.map((o) => o.id));
      const eps = b.endpoints.filter((e) => !cats.length || cats.includes(e.category));
      const out = eps.filter((e) => !e.objectiveIds.some((o) => objectiveIds.has(o))).map((e) => f(ctx.byId.get(e.id) ?? null, `Endpoint ${e.code || e.name || ''} is not linked to an objective`, e.objectiveIds.length ? 'links do not resolve' : 'no link', 'Linked to at least one objective'));
      return { checked: eps.length, findings: out };
    }
    case 'activity-nonexistent-visit': {
      const out: QualityFinding[] = [];
      for (const a of b.soa.activities)
        for (const [vid, mark] of Object.entries(a.cells)) if (mark && !visitIds.has(vid)) out.push(f(ctx.byId.get(a.id) ?? null, `Assessment '${a.name}' is scheduled at a visit that does not exist`, vid, 'Every scheduled cell refers to an existing visit', vid));
      return { checked: b.soa.activities.length, findings: out };
    }
    case 'invalid-relationship-references': {
      const out: QualityFinding[] = [];
      const objectiveIds = new Set(b.objectives.map((o) => o.id));
      const footnoteIds = new Set(b.soa.footnotes.map((x) => x.id));
      let checked = 0;
      for (const e of b.endpoints)
        for (const o of e.objectiveIds) {
          checked++;
          if (!objectiveIds.has(o)) out.push(f(ctx.byId.get(e.id) ?? null, `Endpoint ${e.code || e.name} refers to an objective that does not exist`, o, 'Objective links resolve', `obj:${o}`));
        }
      for (const x of [...b.soa.visits, ...b.soa.activities])
        for (const fid of x.footnoteIds) {
          checked++;
          if (!footnoteIds.has(fid)) out.push(f(ctx.byId.get(x.id) ?? null, `'${x.name}' refers to a footnote that does not exist`, fid, 'Footnote references resolve', `fn:${fid}`));
        }
      return { checked, findings: out };
    }
    case 'cross-section-conflict': {
      const out: QualityFinding[] = [];
      const visitText = b.soa.visits.map((v) => `${v.name} ${v.timing}`.toLowerCase());
      const eps = b.endpoints.filter((e) => !blank(e.timepoint));
      for (const e of eps) {
        const tokens = [...String(e.timepoint).matchAll(/\b(week|day)\s*(-?\d+)\b/gi)].map((m) => `${m[1].toLowerCase()} ${m[2]}`);
        const missing = tokens.filter((t) => !visitText.some((v) => v.replace(/\s+/g, ' ').includes(t)));
        if (missing.length) out.push(f(ctx.byId.get(e.id) ?? null, `Endpoint ${e.code || e.name} timepoint '${e.timepoint}' does not match a scheduled visit`, missing.join(', '), 'Endpoint timepoints correspond to visits in the Schedule of Activities'));
      }
      return { checked: eps.length, findings: out };
    }
    case 'activity-unscheduled': {
      const out = b.soa.activities.filter((a) => a.name.trim() && !Object.values(a.cells).some(Boolean)).map((a) => f(ctx.byId.get(a.id) ?? null, `Assessment '${a.name}' is not scheduled at any visit`, 'no marked cells', 'Scheduled at one or more visits'));
      return { checked: b.soa.activities.length, findings: out };
    }
    case 'numeric-fields': {
      const out: QualityFinding[] = [];
      let checked = 0;
      for (const s of b.sections.flatMap((x) => x.subsections))
        for (const fd of s.fields)
          if (fd.type === 'number' && !blank(s.content[fd.key])) {
            checked++;
            if (!Number.isFinite(Number(s.content[fd.key]))) out.push(f(ctx.byId.get(s.id) ?? null, `${s.subsectionNumber} ${fd.label} is not a number`, s.content[fd.key], 'A number', fd.key));
          }
      return { checked, findings: out };
    }
    case 'usdm-invalid-references':
    case 'usdm-schema-errors': {
      const run = db.prepare(`SELECT id, report_json FROM usdm_mapping_runs WHERE protocol_id = ? ORDER BY created_at DESC LIMIT 1`).get(b.protocol.id) as any;
      if (!run) return { checked: 0, findings: [] };
      const v = JSON.parse(run.report_json).validation;
      const list = key === 'usdm-schema-errors' ? v.schemaErrors.map((e: any) => ({ k: `${e.path}|${e.message}`, msg: `${e.usdmClass ?? 'USDM'} ${e.path}: ${e.message}`, d: e.path })) : [...v.referenceErrors.map((e: any) => ({ k: `${e.path}|${e.target}`, msg: `${e.usdmClass}.${e.property}: ${e.message}`, d: e.target })), ...v.duplicateIds.map((id: string) => ({ k: `dup|${id}`, msg: `Duplicate USDM id '${id}'`, d: id }))];
      return {
        checked: 1,
        findings: list.slice(0, 100).map((x: any) => f(null, `Latest USDM mapping run: ${x.msg}`, x.d, key === 'usdm-schema-errors' ? `Valid against the USDM ${v.releaseVersion} schema` : 'Every USDM reference resolves to a compatible object', x.k)),
      };
    }
    case 'missing-source-reference':
    case 'missing-page-number':
    case 'missing-source-section': {
      const digitised = [...ctx.lineage.values()].filter((l) => (l.source_type === 'digitisation' || l.source_type === 'ocr') && !l.deleted_at && l.extraction_method !== 'template-placeholder' && l.extraction_method !== 'pre-governance-record');
      const pool = key === 'missing-page-number' ? digitised.filter((l) => l.source_type === 'ocr') : digitised;
      const bad = pool.filter((l) => (key === 'missing-source-reference' ? !l.source_document_id : key === 'missing-page-number' ? l.source_page == null : !l.source_section));
      const what = key === 'missing-source-reference' ? 'source document' : key === 'missing-page-number' ? 'source page number' : 'source section';
      return { checked: pool.length, findings: bad.map((l) => f(ctx.byId.get(l.element_id) ?? null, `${l.label}: no ${what} recorded for a digitised element`, '', `Digitised elements record their ${what}`)) };
    }
    case 'missing-mapping-history': {
      const n = (db.prepare(`SELECT COUNT(*) AS n FROM usdm_mapping_runs WHERE protocol_id = ?`).get(b.protocol.id) as { n: number }).n;
      return { checked: 1, findings: n ? [] : [f(ctx.byId.get(b.study.id) ?? null, 'This protocol has never been mapped to USDM', '0 mapping runs', 'At least one USDM mapping run')] };
    }
    case 'missing-ownership': {
      const n = (db.prepare(`SELECT COUNT(*) AS n FROM data_owners WHERE study_id = ? AND responsibility = 'Owner'`).get(b.study.id) as { n: number }).n;
      return { checked: 1, findings: n ? [] : [f(ctx.byId.get(b.study.id) ?? null, 'No data owner is assigned to this study', 'none', 'A data owner is assigned')] };
    }
    case 'missing-review-history': {
      const types = (rule.config.types as string[] | undefined) ?? [];
      const pool = ctx.elements.filter((e) => !types.length || types.includes(e.type));
      const reviewed = new Set((db.prepare(`SELECT DISTINCT entity_id FROM approval_records WHERE entity_type = 'element' AND study_id = ?`).all(b.study.id) as { entity_id: string }[]).map((r) => r.entity_id));
      const bad = pool.filter((e) => !reviewed.has(e.id) && ctx.lineage.get(e.id)?.review_status !== 'Approved');
      return { checked: pool.length, findings: bad.map((e) => f(e, `${e.label} has never been reviewed`, ctx.lineage.get(e.id)?.review_status ?? 'no lineage', 'Reviewed (approved or rejected) at least once')) };
    }
    default:
      throw new Error(`Unknown built-in check '${key}'`);
  }
}

// ---------- Validation runs ----------

export interface ValidationRunResult {
  runId: string;
  studyId: string;
  protocolId: string;
  executedAt: string;
  rulesExecuted: number;
  rulesFailed: number;
  findings: number;
  bySeverity: Record<Severity, number>;
  score: number;
  issues: { opened: number; reopened: number; autoResolved: number };
}

const fingerprint = (protocolId: string, f: QualityFinding) => createHash('sha1').update(`${protocolId}|${f.ruleId}|${f.elementId ?? ''}|${f.detailKey ?? ''}`).digest('hex');

export function validateProtocol(protocolId: string): ValidationRunResult {
  const bundle = getBundle(protocolId);
  const flat = flattenBundle(bundle);
  const lineage = new Map((db.prepare(`SELECT * FROM lineage_records WHERE protocol_id = ?`).all(protocolId) as any[]).map((l) => [l.element_id, l]));
  let release: LoadedRelease | null = null;
  try {
    release = selectedRelease();
  } catch {
    release = null;
  }
  const ctx: Ctx = { bundle, elements: [...flat.elements.values()], byId: flat.elements, lineage, release };
  const rules = (db.prepare(`SELECT * FROM governance_rules WHERE active = 1 ORDER BY id`).all() as any[]).map(toRule);
  const actor = currentActor();
  const runId = randomUUID();
  const t = now();
  const studyId = bundle.study.id;
  const owner = db.prepare(`SELECT user_id FROM data_owners WHERE study_id = ? AND responsibility = 'Steward' ORDER BY entity_type = '*' LIMIT 1`).get(studyId) as { user_id: string } | undefined;
  const results: { rule: GovernanceRule; ev: Evaluation | null; error?: string }[] = [];
  for (const rule of rules) {
    try {
      results.push({ rule, ev: evaluate(rule, ctx) });
    } catch (e) {
      results.push({ rule, ev: null, error: (e as Error).message });
    }
  }
  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  let opened = 0;
  let reopened = 0;
  let autoResolved = 0;
  tx(() => {
    const seen = new Set<string>();
    for (const { rule, ev, error } of results) {
      db.prepare(`INSERT INTO governance_rule_runs (id, run_id, rule_id, rule_version, study_id, protocol_id, executed_by, executed_at, checked, findings, status, error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        randomUUID(),
        runId,
        rule.id,
        rule.version,
        studyId,
        protocolId,
        actor.userId,
        t,
        ev?.checked ?? 0,
        ev?.findings.length ?? 0,
        error ? 'error' : 'ok',
        error ?? null,
      );
      if (!ev) continue;
      for (const fd of ev.findings) {
        bySeverity[rule.severity]++;
        const fp = fingerprint(protocolId, fd);
        seen.add(fp);
        const existing = db.prepare(`SELECT * FROM governance_issues WHERE fingerprint = ?`).get(fp) as any;
        let issueId: string;
        let status: string;
        if (!existing) {
          issueId = randomUUID();
          status = owner ? 'Assigned' : 'Open';
          db.prepare(
            `INSERT INTO governance_issues (id, fingerprint, origin, study_id, protocol_id, element_id, element_type, rule_id, category, severity, title, description, detected_value, expected_condition, status, assigned_to, created_by, created_at, updated_at, last_detected_at)
             VALUES (?,?,'rule',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ).run(issueId, fp, studyId, protocolId, fd.elementId, fd.elementType, rule.id, rule.category, rule.severity, rule.name, fd.description, fd.detectedValue, fd.expectedCondition, status, owner?.user_id ?? null, actor.userId, t, t, t);
          opened++;
        } else {
          issueId = existing.id;
          status = existing.status;
          if (existing.status === 'Resolved') {
            status = 'Open';
            reopened++;
            db.prepare(`INSERT INTO governance_issue_comments (id, issue_id, user_id, text, created_at) VALUES (?,?,?,?,?)`).run(randomUUID(), issueId, 'system', `Reopened: detected again by validation run ${runId}`, t);
          }
          db.prepare(
            `UPDATE governance_issues SET severity = ?, category = ?, title = ?, description = ?, detected_value = ?, expected_condition = ?, status = ?, last_detected_at = ?, updated_at = ?,
               resolved_by = CASE WHEN ? = 'Open' AND status = 'Resolved' THEN NULL ELSE resolved_by END, resolved_at = CASE WHEN ? = 'Open' AND status = 'Resolved' THEN NULL ELSE resolved_at END WHERE id = ?`,
          ).run(rule.severity, rule.category, rule.name, fd.description, fd.detectedValue, fd.expectedCondition, status, t, t, status, status, issueId);
        }
        db.prepare(
          `INSERT INTO data_quality_results (id, run_id, study_id, protocol_id, element_id, element_type, rule_id, category, severity, description, detected_value, expected_condition, validated_at, issue_id, resolution_status, assigned_owner)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(randomUUID(), runId, studyId, protocolId, fd.elementId, fd.elementType, rule.id, rule.category, rule.severity, fd.description, fd.detectedValue, fd.expectedCondition, t, issueId, status, existing?.assigned_to ?? owner?.user_id ?? null);
      }
    }
    // Rule-detected issues of the executed rules that were not found again are resolved automatically.
    const executed = results.filter((r) => r.ev).map((r) => r.rule.id);
    if (executed.length) {
      const open = db
        .prepare(`SELECT id, fingerprint FROM governance_issues WHERE protocol_id = ? AND origin = 'rule' AND status IN ('Open','Assigned','In Progress') AND rule_id IN (${executed.map(() => '?').join(',')})`)
        .all(protocolId, ...executed) as { id: string; fingerprint: string }[];
      for (const i of open)
        if (!seen.has(i.fingerprint)) {
          db.prepare(`UPDATE governance_issues SET status = 'Resolved', resolved_by = 'system', resolved_at = ?, resolution = ?, updated_at = ? WHERE id = ?`).run(t, `Not detected by validation run ${runId}`, t, i.id);
          autoResolved++;
        }
    }
    audit({
      action: 'governance.validation.run',
      entityType: 'protocol',
      entityId: protocolId,
      studyId,
      next: { runId, rules: results.length, findings: Object.values(bySeverity).reduce((a, b) => a + b, 0), bySeverity, opened, reopened, autoResolved },
    });
  });
  const findings = Object.values(bySeverity).reduce((a, b) => a + b, 0);
  return {
    runId,
    studyId,
    protocolId,
    executedAt: t,
    rulesExecuted: results.filter((r) => r.ev).length,
    rulesFailed: results.filter((r) => r.error).length,
    findings,
    bySeverity,
    score: qualityScore(protocolId)?.score ?? 100,
    issues: { opened, reopened, autoResolved },
  };
}

export function validateStudy(studyId: string) {
  const protocols = db.prepare(`SELECT id FROM protocols WHERE study_id = ? ORDER BY created_at`).all(studyId) as { id: string }[];
  if (!protocols.length) throw new HttpError(404, 'Study not found');
  return protocols.map((p) => validateProtocol(p.id));
}

/** Quality score of a protocol's latest validation run (severity-weighted pass rate), or null if never validated. */
export function qualityScore(protocolId: string): { score: number; runId: string; executedAt: string } | null {
  const last = db.prepare(`SELECT run_id, executed_at FROM governance_rule_runs WHERE protocol_id = ? ORDER BY executed_at DESC LIMIT 1`).get(protocolId) as any;
  if (!last) return null;
  const rows = db
    .prepare(
      `SELECT rr.checked, rr.rule_id, r.severity, (SELECT COUNT(DISTINCT COALESCE(element_id, description)) FROM data_quality_results d WHERE d.run_id = rr.run_id AND d.rule_id = rr.rule_id) AS failed
       FROM governance_rule_runs rr JOIN governance_rules r ON r.id = rr.rule_id WHERE rr.run_id = ? AND rr.status = 'ok'`,
    )
    .all(last.run_id) as any[];
  let w = 0;
  let pass = 0;
  for (const r of rows) {
    const weight = SEVERITY_WEIGHT[r.severity as Severity] ?? 0;
    w += weight * Number(r.checked);
    pass += weight * Math.max(Number(r.checked) - Number(r.failed), 0);
  }
  return { score: w ? Math.round((pass / w) * 1000) / 10 : 100, runId: last.run_id, executedAt: last.executed_at };
}

export function qualityResults(f: { protocolId?: string; runId?: string; severity?: string; category?: string; page?: number; pageSize?: number }) {
  const where: string[] = [];
  const args: (string | number)[] = [];
  let runId = f.runId;
  if (!runId && f.protocolId) runId = (db.prepare(`SELECT run_id FROM governance_rule_runs WHERE protocol_id = ? ORDER BY executed_at DESC LIMIT 1`).get(f.protocolId) as any)?.run_id;
  if (!runId) return { items: [], total: 0, page: 1, pageSize: f.pageSize ?? 25, runId: null };
  where.push('d.run_id = ?');
  args.push(runId);
  if (f.severity) (where.push('d.severity = ?'), args.push(f.severity));
  if (f.category) (where.push('d.category = ?'), args.push(f.category));
  const pageSize = Math.min(Math.max(Number(f.pageSize) || 25, 1), 200);
  const page = Math.max(Number(f.page) || 1, 1);
  const w = where.join(' AND ');
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM data_quality_results d WHERE ${w}`).get(...args) as { n: number }).n;
  const items = (
    db
      .prepare(
        `SELECT d.*, r.name AS rule_name, s.title AS study_title, s.protocol_number, i.status AS issue_status, u.display_name AS owner_name
         FROM data_quality_results d LEFT JOIN governance_rules r ON r.id = d.rule_id LEFT JOIN studies s ON s.id = d.study_id LEFT JOIN governance_issues i ON i.id = d.issue_id LEFT JOIN users u ON u.id = d.assigned_owner
         WHERE ${w} ORDER BY CASE d.severity WHEN 'Critical' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 WHEN 'Low' THEN 3 ELSE 4 END, d.rule_id LIMIT ? OFFSET ?`,
      )
      .all(...args, pageSize, (page - 1) * pageSize) as any[]
  ).map((d) => ({
    validationId: d.id,
    runId: d.run_id,
    studyId: d.study_id,
    studyTitle: d.study_title,
    protocolNumber: d.protocol_number,
    protocolId: d.protocol_id,
    elementId: d.element_id,
    elementType: d.element_type,
    ruleId: d.rule_id,
    ruleName: d.rule_name,
    category: d.category,
    severity: d.severity,
    description: d.description,
    detectedValue: d.detected_value,
    expectedCondition: d.expected_condition,
    validatedAt: d.validated_at,
    issueId: d.issue_id,
    resolutionStatus: d.issue_status ?? d.resolution_status,
    assignedOwner: d.assigned_owner,
    assignedOwnerName: d.owner_name,
  }));
  return { items, total, page, pageSize, runId };
}
