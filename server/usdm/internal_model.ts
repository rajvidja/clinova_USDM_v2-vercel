import { getTemplate } from '../../shared/template/index.ts';
import type { FieldDef, ProtocolBundle } from '../../shared/types.ts';
import { db } from '../db.ts';
import { getBundle } from '../repo.ts';
import type { SourceEntity } from './mapping_registry.ts';

// Pipeline stage 1: the ProtocolIQ internal model. Reads the shared structured study database (both Builder and
// Digitisation protocols) and applies the review policy: by default only Approved elements are mapped; pending
// elements are either excluded or, when explicitly requested, included and flagged.

export interface InternalRecord {
  id: string;
  entity: SourceEntity;
  /** Governed element whose review status applies (singletons derived from several elements use their own id). */
  elementId: string;
  label: string;
  order: number;
  fields: Record<string, unknown>;
  /** For records assembled from several elements: which element each field came from. */
  fieldElements?: Record<string, string>;
  reviewStatus: 'Approved' | 'Pending' | 'Rejected';
}

export interface ElementRef {
  elementId: string;
  type: string;
  label: string;
  reviewStatus: string;
}

export interface InternalModel {
  studyId: string;
  protocolId: string;
  revision: number;
  includePending: boolean;
  bundle: ProtocolBundle;
  records: Record<SourceEntity, InternalRecord[]>;
  objectiveLinks: Map<string, string[]>;
  cells: { activityId: string; visitId: string; mark: string }[];
  visitFootnotes: Map<string, string[]>;
  activityFootnotes: Map<string, string[]>;
  /** Elements left out because they are not approved (approved-only runs). */
  excluded: ElementRef[];
  /** Elements included although not approved (include-pending runs). */
  pendingIncluded: ElementRef[];
  /** Root elements (study, protocol) that are not approved in an approved-only run: the run cannot be valid. */
  blockingPending: ElementRef[];
}

export function loadInternalModel(protocolId: string, includePending: boolean): InternalModel {
  const bundle = getBundle(protocolId);
  const review = new Map(
    (db.prepare(`SELECT element_id, review_status FROM lineage_records WHERE protocol_id = ? AND deleted_at IS NULL`).all(protocolId) as { element_id: string; review_status: string }[]).map((r) => [
      r.element_id,
      r.review_status as InternalRecord['reviewStatus'],
    ]),
  );
  const statusOf = (id: string): InternalRecord['reviewStatus'] => review.get(id) ?? 'Pending';
  const excluded: ElementRef[] = [];
  const pendingIncluded: ElementRef[] = [];
  const blockingPending: ElementRef[] = [];
  /** Applies the review policy to one element; returns whether it is mapped. */
  const admit = (id: string, type: string, label: string, root = false) => {
    const st = statusOf(id);
    if (st === 'Approved') return true;
    const ref = { elementId: id, type, label, reviewStatus: st };
    if (includePending) {
      pendingIncluded.push(ref);
      return true;
    }
    if (root) {
      blockingPending.push(ref);
      return true;
    }
    excluded.push(ref);
    return false;
  };

  const records = Object.fromEntries(
    ['study', 'protocol', 'design', 'section', 'arm', 'objective', 'endpoint', 'criterion', 'visit', 'activity', 'footnote', 'soa'].map((k) => [k, [] as InternalRecord[]]),
  ) as Record<SourceEntity, InternalRecord[]>;
  const s = bundle.study;
  const p = bundle.protocol;
  admit(s.id, 'study', 'Study metadata', true);
  records.study.push({
    id: s.id,
    entity: 'study',
    elementId: s.id,
    label: s.title || 'Study',
    order: 0,
    fields: { title: s.title, protocolNumber: s.protocolNumber, sponsorName: s.sponsorName, therapeuticArea: s.therapeuticArea, indication: s.indication, phase: s.phase, studyDesign: s.studyDesign },
    reviewStatus: statusOf(s.id),
  });
  admit(p.id, 'protocol', 'Protocol version metadata', true);
  const template = getTemplate(p.templateId, p.templateVersion) ?? getTemplate(p.templateId);
  records.protocol.push({
    id: p.id,
    entity: 'protocol',
    elementId: p.id,
    label: `Protocol version ${p.version || '(none)'}`,
    order: 0,
    fields: {
      version: p.version,
      protocolDate: p.protocolDate,
      amendmentNumber: p.amendmentNumber,
      amendmentDate: p.amendmentDate,
      status: p.status,
      templateName: template ? `${template.name} v${template.version}` : `${p.templateId} v${p.templateVersion}`,
    },
    reviewStatus: statusOf(p.id),
  });

  const design: InternalRecord = { id: `${p.id}:design`, entity: 'design', elementId: `${p.id}:design`, label: 'Study design', order: 0, fields: {}, fieldElements: {}, reviewStatus: 'Approved' };
  let order = 0;
  for (const sec of bundle.sections)
    for (const sub of sec.subsections) {
      const label = `${sub.subsectionNumber} ${sub.subsectionTitle}`;
      if (!admit(sub.id, 'subsection', label)) continue;
      if (sub.templateKey)
        for (const f of sub.fields) {
          design.fields[`${sub.templateKey}#${f.key}`] = sub.content[f.key];
          design.fieldElements![`${sub.templateKey}#${f.key}`] = sub.id;
        }
      records.section.push({
        id: sub.id,
        entity: 'section',
        elementId: sub.id,
        label,
        order: order++,
        fields: {
          subsectionTitle: sub.subsectionTitle,
          subsectionNumber: sub.subsectionNumber,
          sectionNumber: sec.sectionNumber,
          sectionTitle: sec.sectionTitle,
          '(all fields)': { defs: sub.fields as FieldDef[], content: sub.content },
        },
        reviewStatus: statusOf(sub.id),
      });
    }
  records.design.push(design);

  bundle.arms.forEach((a, n) => {
    const label = `${a.code || 'Arm'} ${a.name}`.trim();
    if (admit(a.id, 'arm', label)) records.arm.push({ id: a.id, entity: 'arm', elementId: a.id, label, order: n, fields: { ...a, n: n + 1 }, reviewStatus: statusOf(a.id) });
  });
  bundle.objectives.forEach((o, n) => {
    const label = `${o.code || 'Objective'} (${o.category})`;
    if (admit(o.id, 'objective', label)) records.objective.push({ id: o.id, entity: 'objective', elementId: o.id, label, order: n, fields: { ...o, n: n + 1 }, reviewStatus: statusOf(o.id) });
  });
  const objectiveLinks = new Map<string, string[]>();
  bundle.endpoints.forEach((e, n) => {
    const label = `${e.code || 'Endpoint'} ${e.name}`.trim();
    if (!admit(e.id, 'endpoint', label)) return;
    records.endpoint.push({ id: e.id, entity: 'endpoint', elementId: e.id, label, order: n, fields: { ...e, n: n + 1 }, reviewStatus: statusOf(e.id) });
    objectiveLinks.set(e.id, e.objectiveIds);
  });
  const perType = { inclusion: 0, exclusion: 0 };
  bundle.criteria.forEach((c, n) => {
    const k = ++perType[c.type];
    const label = c.code || `${c.type === 'inclusion' ? 'Inclusion' : 'Exclusion'} ${k}`;
    if (admit(c.id, 'criterion', label))
      records.criterion.push({
        id: c.id,
        entity: 'criterion',
        elementId: c.id,
        label,
        order: n,
        fields: { ...c, n: k, type: c.type, typeInitial: c.type === 'inclusion' ? 'I' : 'E' },
        reviewStatus: statusOf(c.id),
      });
  });
  const visitFootnotes = new Map<string, string[]>();
  bundle.soa.visits.forEach((v, n) => {
    const label = v.name || `Visit ${n + 1}`;
    if (!admit(v.id, 'visit', label)) return;
    records.visit.push({ id: v.id, entity: 'visit', elementId: v.id, label, order: n, fields: { name: v.name, timing: v.timing, window: v.window, visitNumber: n + 1 }, reviewStatus: statusOf(v.id) });
    visitFootnotes.set(v.id, v.footnoteIds);
  });
  const activityFootnotes = new Map<string, string[]>();
  const cells: InternalModel['cells'] = [];
  bundle.soa.activities.forEach((a, n) => {
    const label = a.name || `Activity ${n + 1}`;
    if (!admit(a.id, 'activity', label)) return;
    records.activity.push({ id: a.id, entity: 'activity', elementId: a.id, label, order: n, fields: { name: a.name, category: a.category, n: n + 1 }, reviewStatus: statusOf(a.id) });
    activityFootnotes.set(a.id, a.footnoteIds);
    for (const [visitId, mark] of Object.entries(a.cells)) if (mark) cells.push({ activityId: a.id, visitId, mark });
  });
  bundle.soa.footnotes.forEach((f, n) => {
    const label = `Footnote ${f.marker}`;
    if (admit(f.id, 'footnote', label)) records.footnote.push({ id: f.id, entity: 'footnote', elementId: f.id, label, order: n, fields: { marker: f.marker, text: f.text }, reviewStatus: statusOf(f.id) });
  });
  records.soa.push({ id: `${p.id}:soa`, entity: 'soa', elementId: `${p.id}:soa`, label: 'Schedule of Activities', order: 0, fields: {}, reviewStatus: 'Approved' });

  return {
    studyId: s.id,
    protocolId: p.id,
    revision: p.revision,
    includePending,
    bundle,
    records,
    objectiveLinks,
    cells,
    visitFootnotes,
    activityFootnotes,
    excluded,
    pendingIncluded,
    blockingPending,
  };
}
