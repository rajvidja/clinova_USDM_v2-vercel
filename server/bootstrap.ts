import { isValueFilled, isWidget } from '../shared/completion.ts';
import type { FieldDef } from '../shared/types.ts';
import { seedAccessControl } from './auth.ts';
import { runAs, SYSTEM_ACTOR } from './context.ts';
import { db } from './db.ts';
import { backfillLineage, recordCreation } from './governance/lineage.ts';
import { seedRules } from './governance/quality.ts';
import { seedDictionary } from './governance/stewardship.ts';
import { migrate } from './migrations.ts';
import { getBundle, saveProtocol } from './repo.ts';
import { seedExample } from './seed.ts';
import { seedMappings, setManualValue } from './usdm/mapping_registry.ts';
import { seedTerminology } from './usdm/terminology_mapper.ts';
import { releaseId, seedReleases } from './usdm/usdm_version.ts';

// Startup: schema migrations, then idempotent seeding of access control, USDM releases, mapping rules,
// terminology, governance rules and the data dictionary. Existing records are never modified by seeding.

let done = false;
export function bootstrap() {
  if (done) return;
  done = true;
  migrate();
  runAs(SYSTEM_ACTOR, () => {
    seedAccessControl();
    seedReleases();
    seedMappings();
    seedTerminology();
    seedRules();
    seedDictionary();
    backfillLineage();
  });
}

const PLACEHOLDER = 'Synthetic placeholder content for demonstration only.';

function placeholderFor(field: FieldDef): unknown {
  switch (field.type) {
    case 'richtext':
      return `<p>${PLACEHOLDER}</p>`;
    case 'number':
      return field.key.toLowerCase().includes('sample') ? 120 : 1;
    case 'date':
      return '2026-01-15';
    case 'select':
      return field.options?.[0] ?? PLACEHOLDER;
    case 'list':
      return [PLACEHOLDER];
    case 'table': {
      const cols = field.columns ?? [];
      return { rows: [Object.fromEntries(cols.map((c) => [c.key, PLACEHOLDER]))] };
    }
    case 'references':
      return [{ citation: 'Synthetic reference (demo only).' }];
    default:
      return PLACEHOLDER;
  }
}

/** Completes empty required ICH fields so the synthetic example can be marked Final in demos and tests. */
function fillDemoContent(protocolId: string) {
  const b = getBundle(protocolId);
  const subsections: { id: string; content: Record<string, unknown> }[] = [];
  for (const sec of b.sections) {
    for (const sub of sec.subsections) {
      const content = { ...sub.content };
      let changed = false;
      for (const f of sub.fields) {
        if (isWidget(f) || !f.required) continue;
        if (!isValueFilled(f, content[f.key])) {
          content[f.key] = placeholderFor(f);
          changed = true;
        }
      }
      if (changed) subsections.push({ id: sub.id, content });
    }
  }
  // Named safety-methods check in validation looks for any filled content in that subsection.
  const safetyMethods = b.sections.flatMap((s) => s.subsections).find((s) => s.templateKey === 'safety.methods');
  if (safetyMethods) {
    const field = safetyMethods.fields.find((f) => !isWidget(f)) ?? safetyMethods.fields[0];
    if (field) {
      const content = { ...(subsections.find((s) => s.id === safetyMethods.id)?.content ?? safetyMethods.content) };
      if (!isValueFilled(field, content[field.key])) {
        content[field.key] = `<p>${PLACEHOLDER} Adverse events are assessed at every visit (synthetic).</p>`;
        const existing = subsections.find((s) => s.id === safetyMethods.id);
        if (existing) existing.content = content;
        else subsections.push({ id: safetyMethods.id, content });
      }
    }
  }
  if (subsections.length) saveProtocol(protocolId, { subsections }, { allowFinal: true });
}

/**
 * Creates the SYNTHETIC example protocol with lineage, plus study-scoped manual USDM values for properties that the
 * protocol does not capture (sponsor identifier, organisation type, ...). These are fictional demo values, recorded
 * as manual mappings with a reason so they are visible and editable in the Mapping Studio.
 */
export function seedDemo(): string {
  return runAs(SYSTEM_ACTOR, () => {
    const id = seedExample();
    fillDemoContent(id);
    recordCreation('protocol.created', id, { sourceType: 'builder', extractionMethod: 'synthetic example seed' }, 'Synthetic example protocol');
    const b = getBundle(id);
    const R = releaseId('4.0.0');
    const reason = 'Synthetic demo configuration (fictional values for the example study)';
    const set = (sourceEntity: string, targetEntity: string, targetProperty: string, value: unknown, valueType: string, codelist?: string, elementId?: string) =>
      setManualValue(R, { studyId: b.study.id, elementId, sourceEntity, targetEntity, targetProperty, value, valueType, codelist }, reason);
    set('study', 'Organization', 'identifier', 'SYN-000000', 'string');
    set('study', 'Organization', 'identifierScheme', 'Synthetic registry (fictional)', 'string');
    set('study', 'Organization', 'type', 'C54149', 'code', 'C188724');
    set('design', 'StudyDesignPopulation', 'includesHealthySubjects', false, 'boolean');
    set('study', 'Indication', 'isRareDisease', false, 'boolean');
    for (const ep of b.endpoints) {
      set('endpoint', 'Endpoint', 'purpose', ep.category === 'Safety' ? 'Safety' : 'Efficacy', 'string', undefined, ep.id);
      // ProtocolIQ "Safety" is a purpose, not a CDISC Endpoint Level; map the level separately to Secondary.
      if (ep.category === 'Safety') set('endpoint', 'Endpoint', 'level', 'C139173', 'code', 'C188726', ep.id);
    }
    set('arm', 'StudyIntervention', 'type', 'C1909', 'code', 'C99078');
    set('arm', 'Duration', 'durationWillVary', false, 'boolean');
    set('soa', 'ScheduleTimeline', 'entryCondition', 'Signed informed consent', 'string');
    return id;
  });
}

export const hasProtocols = () => !!db.prepare('SELECT 1 FROM protocols LIMIT 1').get();
