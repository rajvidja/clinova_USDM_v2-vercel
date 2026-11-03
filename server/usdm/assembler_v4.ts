import type { FieldResult, MappedRecord, MapperOutput } from './entity_mapper.ts';
import { aliasCode } from './entity_mapper.ts';
import type { InternalModel } from './internal_model.ts';
import { RelationshipMapper, type RelationshipIssue, type RelationshipRecord } from './relationship_mapper.ts';
import { cdiscCode } from './terminology_mapper.ts';
import type { ParsedTiming } from './transforms.ts';
import { CDISC_CODE_SYSTEM, SYSTEM_NAME, SYSTEM_VERSION } from './usdm_config.ts';
import type { LoadedRelease } from './usdm_version.ts';

// Pipeline stage 3: USDM entity transformation for USDM 4.x. Builds the USDM object graph from the values produced
// by the mapping rules. Core objects are always emitted (missing required properties surface as schema errors);
// optional ancillary objects whose required properties cannot be filled are omitted and reported, never padded.

export type AssemblyIssue = RelationshipIssue;

export interface ElementTarget {
  elementId: string;
  recordId: string;
  entity: string;
  label: string;
  reviewStatus: string;
  usdm: { id: string; cls: string }[];
  status: 'emitted' | 'omitted';
  reason?: string;
}

export interface AssemblyResult {
  wrapper: Record<string, any>;
  issues: AssemblyIssue[];
  targets: ElementTarget[];
  relationships: RelationshipRecord[];
  relationshipSummary: ReturnType<RelationshipMapper['summary']>;
}

type Obj = Record<string, any>;

export function assembleV4(release: LoadedRelease, model: InternalModel, mapped: MapperOutput): AssemblyResult {
  const rel = new RelationshipMapper(release, mapped);
  const issues: AssemblyIssue[] = [];
  const targets = new Map<string, ElementTarget>();
  const schemas = release.schema.components.schemas;
  const required = (cls: string): string[] => (schemas[`${cls}-Input`]?.required ?? []).filter((p: string) => p !== 'instanceType');

  const target = (m: MappedRecord) => {
    let t = targets.get(m.record.id);
    if (!t) {
      t = { elementId: m.record.elementId, recordId: m.record.id, entity: m.record.entity, label: m.record.label, reviewStatus: m.record.reviewStatus, usdm: [], status: 'emitted' };
      targets.set(m.record.id, t);
    }
    return t;
  };
  const vals = (m: MappedRecord | undefined, cls: string): Obj => (m?.values[cls] ? { ...m.values[cls] } : {});
  const merge = (cls: string, ...ms: (MappedRecord | undefined)[]): Obj => Object.assign({}, ...ms.map((m) => vals(m, cls)).reverse());
  const hint = (ms: (MappedRecord | undefined)[], cls: string, prop: string) => {
    for (const m of ms) {
      const f = m?.fields.find((x: FieldResult) => x.targetEntity === cls && x.targetProperty === prop && x.outcome !== 'mapped' && x.outcome !== 'provisional');
      if (f) return `${f.message ?? f.outcome} (rule ${f.ruleId})`;
    }
    return 'No mapping rule produced a value';
  };

  /** Creates and registers a USDM object. Optional objects missing required properties are omitted and reported. */
  const make = (cls: string, id: string, props: Obj, src: MappedRecord | MappedRecord[] | undefined, opts: { optional?: boolean; container?: string } = {}): Obj | null => {
    const o: Obj = { id };
    for (const [k, v] of Object.entries(props)) if (v !== undefined && v !== null && v !== '') o[k] = v;
    o.instanceType = cls;
    const srcs = (Array.isArray(src) ? src : src ? [src] : []) as MappedRecord[];
    if (opts.optional) {
      const missing = required(cls).filter((p) => o[p] === undefined && !REF_PROPS.has(p));
      if (missing.length) {
        const why = missing.map((p) => `${p}: ${hint(srcs, cls, p)}`).join('; ');
        issues.push({ level: 'warning', code: 'omitted-optional', message: `${cls} not emitted${opts.container ? ` in ${opts.container}` : ''}: missing ${why}`, elementId: srcs[0]?.record.elementId, usdmClass: cls, usdmId: id });
        for (const s of srcs) {
          const t = target(s);
          if (!t.usdm.length) {
            t.status = 'omitted';
            t.reason = `${cls} not emitted: missing ${missing.join(', ')}`;
          }
        }
        return null;
      }
    }
    rel.register(id, cls, o, srcs[0]?.record.elementId);
    for (const s of srcs) {
      const t = target(s);
      t.usdm.push({ id, cls });
      t.status = 'emitted';
      t.reason = undefined;
    }
    return o;
  };
  const code = (codelist: string, c: string, id: string) => cdiscCode(release, codelist, c, id);

  const R = mapped.byEntity;
  const st = R.study[0];
  const pr = R.protocol[0];
  const de = R.design[0];
  const soa = R.soa[0];
  const sid = model.studyId;
  const pid = model.protocolId;

  // ---------- Organisation, identifiers, titles ----------
  const orgV = merge('Organization', st);
  const org = orgV.name ? make('Organization', `${sid}:sponsor`, orgV, st) : null;
  if (!org) issues.push({ level: 'error', code: 'missing-sponsor', message: 'Sponsor name is empty: no Organization can scope the study identifier', elementId: sid, usdmClass: 'Organization' });
  const ident = make('StudyIdentifier', `${sid}:identifier`, merge('StudyIdentifier', st), st);
  if (ident && org) rel.link('identifier-scope', ident.id, 'scopeId', org.id, { elementId: sid });
  const title = make('StudyTitle', `${sid}:title`, merge('StudyTitle', st), st);

  // ---------- Narrative content ----------
  const contents: Obj[] = [];
  const contentItems: Obj[] = [];
  for (const m of R.section) {
    const sub = m.record;
    const ncV = vals(m, 'NarrativeContent');
    const itemV = vals(m, 'NarrativeContentItem');
    const nc = make('NarrativeContent', `${sub.id}:content`, { name: `Section ${sub.fields.subsectionNumber}`, ...ncV, displaySectionTitle: true, displaySectionNumber: true, childIds: [] }, m)!;
    contents.push(nc);
    if (itemV.text) {
      const item = make('NarrativeContentItem', `${sub.id}:text`, { name: `Section ${sub.fields.subsectionNumber} text`, text: itemV.text }, m)!;
      contentItems.push(item);
      rel.link('narrative-item', nc.id, 'contentItemId', item.id, { elementId: sub.id });
    }
  }
  rel.chain('narrative-order', contents.map((c) => c.id));

  // ---------- Protocol document ----------
  const govDateV = merge('GovernanceDate', pr);
  const scopeV = merge('GeographicScope', pr);
  const scope = scopeV.type ? { id: `${pid}:protocol-date:scope`, type: scopeV.type, instanceType: 'GeographicScope' } : null;
  const govDate = govDateV.dateValue
    ? make('GovernanceDate', `${pid}:protocol-date`, { name: 'Protocol date', ...govDateV, geographicScopes: scope ? [scope] : undefined }, pr, { optional: true, container: 'StudyDefinitionDocumentVersion.dateValues' })
    : null;
  const docVersion = make('StudyDefinitionDocumentVersion', `${pid}:document-version`, { ...merge('StudyDefinitionDocumentVersion', pr), dateValues: govDate ? [govDate] : [], contents, notes: [] }, pr)!;
  const doc = make('StudyDefinitionDocument', `${pid}:document`, { ...merge('StudyDefinitionDocument', pr, st), versions: [docVersion], childIds: [], notes: [] }, [pr, st].filter(Boolean) as MappedRecord[])!;

  // ---------- Population and eligibility ----------
  const criteria: Obj[] = [];
  const criterionItems: Obj[] = [];
  for (const m of R.criterion) {
    const c = make('EligibilityCriterion', m.record.id, { ...vals(m, 'EligibilityCriterion'), notes: [] }, m)!;
    const item = make('EligibilityCriterionItem', `${m.record.id}:item`, { ...vals(m, 'EligibilityCriterionItem'), notes: [] }, m)!;
    criteria.push(c);
    criterionItems.push(item);
    rel.link('criterion-item', c.id, 'criterionItemId', item.id, { elementId: m.record.id });
  }
  rel.chain('criterion-order', criteria.map((c) => c.id));
  const popV = merge('StudyDesignPopulation', de, st);
  const population = make('StudyDesignPopulation', `${pid}:population`, { ...popV, notes: [], cohorts: [] }, [de, st].filter(Boolean) as MappedRecord[])!;
  if (criteria.length) rel.link('population-criteria', population.id, 'criterionIds', criteria.map((c) => c.id), { many: true });

  // ---------- Objectives and endpoints ----------
  const objectives: Obj[] = [];
  const objectiveById = new Map<string, Obj>();
  for (const m of R.objective) {
    const o = make('Objective', m.record.id, { ...vals(m, 'Objective'), endpoints: [], notes: [] }, m)!;
    objectives.push(o);
    objectiveById.set(m.record.id, o);
  }
  const nestEndpoints = rel.allowed('objective-endpoints');
  for (const m of R.endpoint) {
    const links = model.objectiveLinks.get(m.record.id) ?? [];
    const present = [...new Set(links)].filter((id) => objectiveById.has(id));
    const missing = links.filter((id) => !objectiveById.has(id));
    for (const id of missing)
      rel.rejected('objective-endpoints', id, 'endpoints', m.record.id, `Endpoint '${m.record.label}' is linked to an objective that is not in this mapping (deleted or excluded pending review)`, 'warning', m.record.id);
    if (!nestEndpoints || !present.length) {
      const t = target(m);
      t.status = 'omitted';
      t.reason = nestEndpoints ? 'Endpoint is not linked to an objective; USDM nests endpoints in objectives' : 'Objective–endpoint relationship rule is not active';
      issues.push({ level: 'warning', code: 'endpoint-not-placed', message: `Endpoint '${m.record.label}' not emitted: ${t.reason}`, elementId: m.record.id, usdmClass: 'Endpoint' });
      continue;
    }
    const e = make('Endpoint', m.record.id, { ...vals(m, 'Endpoint'), notes: [] }, m)!;
    objectiveById.get(present[0])!.endpoints.push(e);
    rel.contained('objective-endpoints', present[0], 'endpoints', e.id, m.record.id);
    for (const extra of present.slice(1))
      rel.rejected('objective-endpoints', extra, 'endpoints', e.id, `Endpoint '${m.record.label}' is also linked to another objective; USDM nests an endpoint in one objective only`, 'warning', m.record.id);
  }

  // ---------- Arms, interventions, administrations ----------
  const arms: Obj[] = [];
  for (const m of R.arm) arms.push(make('StudyArm', m.record.id, { ...vals(m, 'StudyArm'), notes: [], populationIds: [] }, m)!);
  const interventions = new Map<string, { obj: Obj; roles: Set<string>; arms: string[] }>();
  for (const m of R.arm) {
    const iv = vals(m, 'StudyIntervention');
    if (!iv.name) continue;
    const key = String(iv.name).trim().toLowerCase();
    let entry = interventions.get(key);
    if (!entry) {
      const obj = make('StudyIntervention', `${pid}:intervention:${interventions.size + 1}`, { ...iv, codes: [], notes: [], administrations: [] }, m)!;
      entry = { obj, roles: new Set(), arms: [] };
      interventions.set(key, entry);
    } else {
      target(m).usdm.push({ id: entry.obj.id, cls: 'StudyIntervention' });
      for (const [k, v] of Object.entries(iv)) if (entry.obj[k] === undefined && v !== undefined) entry.obj[k] = v;
    }
    if (iv.role?.code) entry.roles.add(iv.role.code);
    entry.arms.push(m.record.label);
    const durV = vals(m, 'Duration');
    const duration = durV.durationWillVary !== undefined ? { id: `${m.record.id}:administration:duration`, ...durV, instanceType: 'Duration' } : undefined;
    const adm = make(
      'Administration',
      `${m.record.id}:administration`,
      { name: `${iv.name} (${m.record.fields.code || m.record.fields.name || 'arm'})`, ...vals(m, 'Administration'), duration, notes: [] },
      m,
      { optional: true, container: `StudyIntervention '${iv.name}'` },
    );
    if (adm) entry.obj.administrations.push(adm);
  }
  for (const { obj, roles, arms: names } of interventions.values())
    if (roles.size > 1) issues.push({ level: 'warning', code: 'intervention-role-conflict', message: `Intervention '${obj.name}' is used in arms with different roles (${names.join(', ')}); the first role was used`, usdmId: obj.id, usdmClass: 'StudyIntervention' });
  if (R.arm.length) rel.rejected('arm-intervention', `${pid}:design`, 'studyCells', '', 'Arms are not linked to interventions: USDM requires study cells/elements within epochs, which ProtocolIQ does not model', 'info');

  // ---------- Schedule of activities ----------
  const encounters: Obj[] = [];
  const instances: Obj[] = [];
  const instanceByVisit = new Map<string, Obj>();
  const timings: Obj[] = [];
  for (const m of R.visit) {
    const enc = make('Encounter', m.record.id, { ...vals(m, 'Encounter'), notes: [], environmentalSettings: [], contactModes: [] }, m)!;
    encounters.push(enc);
    const sai = make('ScheduledActivityInstance', `${m.record.id}:instance`, { name: `${enc.name} instance`, activityIds: [] }, m)!;
    instances.push(sai);
    instanceByVisit.set(m.record.id, sai);
    rel.link('instance-encounter', sai.id, 'encounterId', enc.id, { elementId: m.record.id });
  }
  rel.chain('encounter-order', encounters.map((e) => e.id));
  const anchor = R.visit.find((m) => (m.values.Timing?.value as ParsedTiming | undefined)?.kind === 'anchor');
  const timingTypes: Record<ParsedTiming['kind'], string> = { anchor: 'C201358', before: 'C201357', after: 'C201356' };
  for (const m of R.visit) {
    const tv = vals(m, 'Timing');
    const parsed = tv.value as ParsedTiming | undefined;
    if (!parsed) continue;
    if (!anchor) {
      issues.push({ level: 'warning', code: 'timing-no-anchor', message: `Timing of '${m.record.label}' not emitted: no visit is scheduled at 'Day 1' to anchor relative timings`, elementId: m.record.id, usdmClass: 'Timing' });
      continue;
    }
    const id = `${m.record.id}:timing`;
    const t = make(
      'Timing',
      id,
      {
        name: `${m.record.label} timing`,
        type: code('C201264', timingTypes[parsed.kind], `${id}:type`),
        relativeToFrom: code('C201265', 'C201355', `${id}:relativeToFrom`),
        value: parsed.value,
        valueLabel: parsed.label,
        windowLabel: tv.windowLabel,
        windowLower: tv.windowLower,
        windowUpper: tv.windowUpper,
      },
      m,
    )!;
    timings.push(t);
    rel.link('encounter-timing', t.id, 'relativeFromScheduledInstanceId', instanceByVisit.get(m.record.id)!.id, { elementId: m.record.id });
    if (parsed.kind !== 'anchor') rel.link('encounter-timing', t.id, 'relativeToScheduledInstanceId', instanceByVisit.get(anchor.record.id)!.id, { elementId: m.record.id });
    rel.link('encounter-timing', m.record.id, 'scheduledAtId', t.id, { elementId: m.record.id });
  }

  const activities: Obj[] = [];
  const bcs = new Map<string, Obj>();
  for (const m of R.activity) {
    const av = vals(m, 'Activity');
    const bcRefs = (av.biomedicalConceptIds as { bcEntry: any }[] | undefined) ?? [];
    delete av.biomedicalConceptIds;
    const a = make('Activity', m.record.id, { ...av, notes: [], definedProcedures: [], biomedicalConceptIds: [], childIds: [], bcCategoryIds: [], bcSurrogateIds: [] }, m)!;
    activities.push(a);
    const bcIds: string[] = [];
    for (const { bcEntry } of bcRefs) {
      const id = `bc:${bcEntry.targetCode}`;
      if (!bcs.has(id)) {
        const c = { id: `${id}:code`, code: bcEntry.targetCode, codeSystem: CDISC_CODE_SYSTEM, codeSystemVersion: bcEntry.version ?? '', decode: bcEntry.targetDecode ?? bcEntry.targetCode, instanceType: 'Code' };
        const bc = make('BiomedicalConcept', id, { name: bcEntry.targetDecode ?? bcEntry.targetCode, label: bcEntry.preferredTerm ?? undefined, synonyms: [], reference: bcEntry.notes, code: aliasCode(c), properties: [], notes: [] }, m, {
          optional: true,
          container: 'StudyVersion.biomedicalConcepts',
        });
        if (bc) bcs.set(id, bc);
      }
      if (bcs.has(id)) bcIds.push(id);
    }
    if (bcIds.length) rel.link('activity-biomedical-concepts', a.id, 'biomedicalConceptIds', bcIds, { many: true, elementId: m.record.id });
  }
  rel.chain('activity-order', activities.map((a) => a.id));
  const activityIds = new Set(R.activity.map((m) => m.record.id));
  const optionalCells: string[] = [];
  const cellsByVisit = new Map<string, string[]>();
  for (const c of model.cells) {
    if (!instanceByVisit.has(c.visitId) || !activityIds.has(c.activityId)) {
      const why = !instanceByVisit.has(c.visitId) ? 'visit' : 'activity';
      rel.rejected('instance-activities', `${c.visitId}:instance`, 'activityIds', c.activityId, `SoA cell refers to a ${why} that is not in this mapping (nonexistent, deleted or excluded pending review)`, 'warning', c.activityId);
      continue;
    }
    if (c.mark === 'optional') optionalCells.push(`${c.activityId}@${c.visitId}`);
    const arr = cellsByVisit.get(c.visitId) ?? [];
    arr.push(c.activityId);
    cellsByVisit.set(c.visitId, arr);
  }
  for (const [visitId, acts] of cellsByVisit) rel.link('instance-activities', instanceByVisit.get(visitId)!.id, 'activityIds', acts, { many: true, elementId: visitId });
  if (optionalCells.length)
    issues.push({ level: 'info', code: 'optional-cells', message: `${optionalCells.length} SoA cell(s) marked 'optional' are scheduled like required cells (USDM 4.0.0 has no optional marker)`, usdmClass: 'ScheduledActivityInstance' });

  // Footnotes become comment annotations owned by each referencing visit/activity.
  const footnotes = new Map(R.footnote.map((m) => [m.record.id, m]));
  const attached = new Set<string>();
  const annotate = (key: string, ownerId: string, owner: Obj | undefined, ids: string[]) => {
    if (!owner) return;
    for (const fid of ids) {
      const f = footnotes.get(fid);
      if (!f) {
        rel.rejected(key, ownerId, 'notes', fid, 'Footnote reference does not resolve (deleted or excluded pending review)', 'warning', ownerId);
        continue;
      }
      if (!rel.allowed(key, { fromId: ownerId, fromClass: owner.instanceType, property: 'notes', elementId: fid })) continue;
      const note = make('CommentAnnotation', `${fid}@${ownerId}`, { text: vals(f, 'CommentAnnotation').text, codes: [] }, f)!;
      owner.notes.push(note);
      rel.contained(key, ownerId, 'notes', note.id, fid);
      attached.add(fid);
    }
  };
  for (const m of R.visit) annotate('encounter-footnotes', m.record.id, encounters.find((e) => e.id === m.record.id), model.visitFootnotes.get(m.record.id) ?? []);
  for (const m of R.activity) annotate('activity-footnotes', m.record.id, activities.find((a) => a.id === m.record.id), model.activityFootnotes.get(m.record.id) ?? []);
  const designNotes: Obj[] = [];
  for (const f of R.footnote)
    if (!attached.has(f.record.id)) {
      const note = make('CommentAnnotation', `${f.record.id}@design`, { text: vals(f, 'CommentAnnotation').text, codes: [] }, f);
      if (note) designNotes.push(note);
      issues.push({ level: 'info', code: 'footnote-unattached', message: `Footnote ${f.record.fields.marker} is not referenced by any visit or activity; attached to the study design notes`, elementId: f.record.id });
    }

  let timeline: Obj | null = null;
  if (encounters.length) {
    timeline = make('ScheduleTimeline', `${pid}:timeline`, { ...vals(soa, 'ScheduleTimeline'), instances, timings, exits: [] }, soa)!;
    rel.link('timeline-entry', timeline.id, 'entryId', instances[0].id);
  } else issues.push({ level: 'warning', code: 'no-visits', message: 'The Schedule of Activities has no visits; no schedule timeline is emitted', usdmClass: 'ScheduleTimeline' });

  // ---------- Study design ----------
  const indicationV = merge('Indication', st);
  const indication = indicationV.name ? make('Indication', `${sid}:indication`, { ...indicationV, codes: [], notes: [] }, st, { optional: true, container: 'InterventionalStudyDesign.indications' }) : null;
  const designV = merge('InterventionalStudyDesign', de, st);
  const design = make(
    'InterventionalStudyDesign',
    `${pid}:design`,
    {
      ...designV,
      characteristics: designV.characteristics ?? [],
      therapeuticAreas: [],
      arms,
      studyCells: [],
      epochs: [],
      population,
      eligibilityCriteria: criteria,
      objectives,
      encounters,
      activities,
      scheduleTimelines: timeline ? [timeline] : [],
      indications: indication ? [indication] : [],
      notes: designNotes,
      estimands: [],
      elements: [],
      biospecimenRetentions: [],
      analysisPopulations: [],
      documentVersionIds: [],
      studyInterventionIds: [],
      subTypes: [],
      intentTypes: [],
    },
    [de, st].filter(Boolean) as MappedRecord[],
  )!;
  if (interventions.size) rel.link('design-interventions', design.id, 'studyInterventionIds', [...interventions.values()].map((i) => i.obj.id), { many: true });

  // ---------- Study version and study ----------
  const version = make(
    'StudyVersion',
    pid,
    {
      ...merge('StudyVersion', pr, de),
      titles: title ? [title] : [],
      studyIdentifiers: ident ? [ident] : [],
      organizations: org ? [org] : [],
      studyDesigns: [design],
      eligibilityCriterionItems: criterionItems,
      narrativeContentItems: contentItems,
      studyInterventions: [...interventions.values()].map((i) => i.obj),
      biomedicalConcepts: [...bcs.values()],
      documentVersionIds: [],
      notes: [],
      dateValues: [],
      amendments: [],
      businessTherapeuticAreas: [],
      referenceIdentifiers: [],
      abbreviations: [],
      roles: [],
      administrableProducts: [],
      medicalDevices: [],
      productOrganizationRoles: [],
      bcCategories: [],
      bcSurrogates: [],
      dictionaries: [],
      conditions: [],
    },
    [pr, de].filter(Boolean) as MappedRecord[],
  )!;
  rel.link('document-version', version.id, 'documentVersionIds', [docVersion.id], { many: true });
  const study = make('Study', sid, { ...merge('Study', st), versions: [version], documentedBy: [doc] }, st)!;

  rel.apply();
  assignNestedIds(study, sid);

  // Required properties of every emitted object (after relationships are applied).
  for (const [id, r] of rel.registered()) {
    for (const p of required(r.cls)) {
      if (r.obj[p] !== undefined) continue;
      const srcs = [...targets.values()].filter((t) => t.usdm.some((u) => u.id === id)).map((t) => mapped.records.get(t.recordId)!);
      issues.push({ level: 'error', code: 'missing-required', message: `${r.cls}.${p} is required: ${hint(srcs, r.cls, p)}`, elementId: r.elementId, usdmId: id, usdmClass: r.cls, property: p });
    }
  }

  for (const m of mapped.records.values()) target(m);
  return {
    wrapper: { study, usdmVersion: release.version, systemName: SYSTEM_NAME, systemVersion: SYSTEM_VERSION },
    issues: [...issues, ...rel.issues],
    targets: [...targets.values()],
    relationships: rel.records,
    relationshipSummary: rel.summary(),
  };
}

/** Gives value objects created by transformations (Code, AliasCode, Quantity, ...) deterministic path-based ids. */
function assignNestedIds(node: unknown, ownerId: string) {
  if (Array.isArray(node)) return node.forEach((x) => assignNestedIds(x, ownerId));
  if (!node || typeof node !== 'object') return;
  const o = node as Obj;
  const id = typeof o.id === 'string' && o.id ? o.id : ownerId;
  for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v))
      v.forEach((x, i) => {
        if (x && typeof x === 'object' && (x as Obj).instanceType && !(x as Obj).id) (x as Obj).id = `${id}:${k}:${i + 1}`;
        assignNestedIds(x, id);
      });
    else if (v && typeof v === 'object') {
      if ((v as Obj).instanceType && !(v as Obj).id) (v as Obj).id = `${id}:${k}`;
      assignNestedIds(v, id);
    }
  }
}

/** Reference properties are checked after relationships are applied, not when deciding to omit an optional object. */
const REF_PROPS = new Set(['scopeId', 'criterionItemId', 'entryId', 'relativeFromScheduledInstanceId']);
