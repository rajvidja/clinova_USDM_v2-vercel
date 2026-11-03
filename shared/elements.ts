import { richTextToPlain } from './richtext.ts';
import type { ProtocolBundle } from './types.ts';

// A protocol bundle viewed as a flat set of governed study elements. Element ids are the ids of the underlying
// records, so lineage, versions, issues and USDM mappings all refer to the same identifiers.

export const ELEMENT_TYPES = ['study', 'protocol', 'subsection', 'objective', 'endpoint', 'arm', 'criterion', 'visit', 'activity', 'footnote'] as const;
export type ElementType = (typeof ELEMENT_TYPES)[number];
export const ELEMENT_TYPE_LABELS: Record<ElementType, string> = {
  study: 'Study',
  protocol: 'Protocol version',
  subsection: 'Protocol section',
  objective: 'Objective',
  endpoint: 'Endpoint',
  arm: 'Study arm / intervention',
  criterion: 'Eligibility criterion',
  visit: 'Encounter / visit',
  activity: 'Activity / assessment',
  footnote: 'SoA footnote',
};

export interface Relation {
  kind: 'objective-endpoint' | 'activity-visit' | 'visit-footnote' | 'activity-footnote';
  from: string;
  to: string;
  value?: string;
}

export interface StudyElement {
  id: string;
  type: ElementType;
  label: string;
  /** Normalised governed content; excludes derived fields such as completion status. */
  content: Record<string, unknown>;
  order: number;
}

export interface FlatProtocol {
  elements: Map<string, StudyElement>;
  relations: Relation[];
}

export function flattenBundle(b: ProtocolBundle): FlatProtocol {
  const elements = new Map<string, StudyElement>();
  const add = (e: StudyElement) => elements.set(e.id, e);
  const s = b.study;
  add({
    id: s.id,
    type: 'study',
    label: s.title || '[Untitled study]',
    content: { title: s.title, protocolNumber: s.protocolNumber, sponsorName: s.sponsorName, therapeuticArea: s.therapeuticArea, indication: s.indication, phase: s.phase, studyDesign: s.studyDesign },
    order: 0,
  });
  const p = b.protocol;
  add({
    id: p.id,
    type: 'protocol',
    label: `Protocol version ${p.version || '(no version)'}`,
    content: { version: p.version, protocolDate: p.protocolDate, amendmentNumber: p.amendmentNumber, amendmentDate: p.amendmentDate },
    order: 0,
  });
  let i = 0;
  for (const sec of b.sections)
    for (const sub of sec.subsections)
      add({ id: sub.id, type: 'subsection', label: `${sub.subsectionNumber} ${sub.subsectionTitle}`, content: { title: sub.subsectionTitle, number: sub.subsectionNumber, ...sub.content }, order: i++ });
  b.objectives.forEach((o, n) => add({ id: o.id, type: 'objective', label: `${o.code || 'Objective'} · ${o.category}`, content: { code: o.code, category: o.category, description: o.description }, order: n }));
  b.endpoints.forEach((e, n) =>
    add({
      id: e.id,
      type: 'endpoint',
      label: `${e.code || 'Endpoint'} · ${e.name || '[unnamed]'}`,
      content: { code: e.code, category: e.category, name: e.name, definition: e.definition, measurementMethod: e.measurementMethod, timepoint: e.timepoint },
      order: n,
    }),
  );
  b.arms.forEach((a, n) => {
    const { id, ...rest } = a;
    add({ id, type: 'arm', label: `${a.code || 'Arm'} · ${a.name || '[unnamed]'}`, content: rest, order: n });
  });
  b.criteria.forEach((c, n) => add({ id: c.id, type: 'criterion', label: `${c.code || (c.type === 'inclusion' ? 'Inclusion' : 'Exclusion')}`, content: { type: c.type, code: c.code, text: c.text }, order: n }));
  b.soa.visits.forEach((v, n) => add({ id: v.id, type: 'visit', label: v.name || '[unnamed visit]', content: { name: v.name, timing: v.timing, window: v.window, visitNumber: n + 1 }, order: n }));
  b.soa.activities.forEach((a, n) => add({ id: a.id, type: 'activity', label: a.name || '[unnamed assessment]', content: { name: a.name, category: a.category }, order: n }));
  b.soa.footnotes.forEach((f, n) => add({ id: f.id, type: 'footnote', label: `Footnote ${f.marker}`, content: { marker: f.marker, text: f.text }, order: n }));

  const relations: Relation[] = [];
  for (const e of b.endpoints) for (const o of e.objectiveIds) relations.push({ kind: 'objective-endpoint', from: o, to: e.id });
  for (const a of b.soa.activities) {
    for (const [v, mark] of Object.entries(a.cells)) if (mark) relations.push({ kind: 'activity-visit', from: a.id, to: v, value: mark });
    for (const f of a.footnoteIds) relations.push({ kind: 'activity-footnote', from: a.id, to: f });
  }
  for (const v of b.soa.visits) for (const f of v.footnoteIds) relations.push({ kind: 'visit-footnote', from: v.id, to: f });
  return { elements, relations };
}

/** Deterministic JSON (sorted keys) for hashing and comparison. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface ElementChange {
  id: string;
  type: ElementType;
  label: string;
  change: 'added' | 'modified' | 'deleted';
  fields: FieldChange[];
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

export interface RelationChange {
  change: 'added' | 'removed' | 'changed';
  relation: Relation;
  previousValue?: string;
  fromLabel: string;
  toLabel: string;
}

export interface ProtocolDiff {
  elements: ElementChange[];
  relations: RelationChange[];
  summary: { added: number; modified: number; deleted: number; relationsChanged: number };
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

export function diffFlat(a: FlatProtocol | null, b: FlatProtocol | null): ProtocolDiff {
  const before = a?.elements ?? new Map<string, StudyElement>();
  const after = b?.elements ?? new Map<string, StudyElement>();
  const elements: ElementChange[] = [];
  for (const [id, e] of after) {
    const old = before.get(id);
    if (!old) {
      elements.push({ id, type: e.type, label: e.label, change: 'added', fields: [], after: e.content });
      continue;
    }
    const keys = new Set([...Object.keys(old.content), ...Object.keys(e.content)]);
    const fields: FieldChange[] = [];
    for (const k of keys) {
      const x = old.content[k];
      const y = e.content[k];
      if (isEmpty(x) && isEmpty(y)) continue;
      if (canonical(x) !== canonical(y)) fields.push({ field: k, before: x ?? null, after: y ?? null });
    }
    if (fields.length) elements.push({ id, type: e.type, label: e.label, change: 'modified', fields, before: old.content, after: e.content });
  }
  for (const [id, e] of before) if (!after.has(id)) elements.push({ id, type: e.type, label: e.label, change: 'deleted', fields: [], before: e.content });

  const label = (id: string) => after.get(id)?.label ?? before.get(id)?.label ?? id;
  const key = (r: Relation) => `${r.kind}|${r.from}|${r.to}`;
  const ra = new Map((a?.relations ?? []).map((r) => [key(r), r]));
  const rb = new Map((b?.relations ?? []).map((r) => [key(r), r]));
  const relations: RelationChange[] = [];
  for (const [k, r] of rb) {
    const old = ra.get(k);
    if (!old) relations.push({ change: 'added', relation: r, fromLabel: label(r.from), toLabel: label(r.to) });
    else if ((old.value ?? '') !== (r.value ?? '')) relations.push({ change: 'changed', relation: r, previousValue: old.value, fromLabel: label(r.from), toLabel: label(r.to) });
  }
  for (const [k, r] of ra) if (!rb.has(k)) relations.push({ change: 'removed', relation: r, fromLabel: label(r.from), toLabel: label(r.to) });

  return {
    elements,
    relations,
    summary: {
      added: elements.filter((e) => e.change === 'added').length,
      modified: elements.filter((e) => e.change === 'modified').length,
      deleted: elements.filter((e) => e.change === 'deleted').length,
      relationsChanged: relations.length,
    },
  };
}

export const diffBundles = (a: ProtocolBundle | null, b: ProtocolBundle | null) => diffFlat(a ? flattenBundle(a) : null, b ? flattenBundle(b) : null);

/** Readable one-line value for display (rich text is reduced to plain text). */
export function displayValue(v: unknown, max = 300): string {
  if (isEmpty(v)) return '—';
  let s: string;
  if (typeof v === 'string') s = /<[a-z][\s\S]*>/i.test(v) ? richTextToPlain(v) : v;
  else s = JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
