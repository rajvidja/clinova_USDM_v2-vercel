import schema400 from './releases/4.0.0/USDM_API.json' with { type: 'json' };
import model400 from './releases/4.0.0/model.json' with { type: 'json' };
import release400 from './releases/4.0.0/release.json' with { type: 'json' };
import ct400 from './releases/4.0.0/terminology.json' with { type: 'json' };
import activityRules from './rules/activity_mapping.json' with { type: 'json' };
import designRules from './rules/design_mapping.json' with { type: 'json' };
import eligibilityRules from './rules/eligibility_mapping.json' with { type: 'json' };
import encounterRules from './rules/encounter_mapping.json' with { type: 'json' };
import endpointRules from './rules/endpoint_mapping.json' with { type: 'json' };
import interventionRules from './rules/intervention_mapping.json' with { type: 'json' };
import objectiveRules from './rules/objective_mapping.json' with { type: 'json' };
import soaRules from './rules/soa_mapping.json' with { type: 'json' };
import studyRules from './rules/study_mapping.json' with { type: 'json' };
import terminologyMappings from './rules/terminology_mapping.json' with { type: 'json' };

// USDM configuration. Release packages (official schema, model and controlled terminology) and the seeded mapping
// rules are versioned files; the database holds the editable registry built from them.

export const SYSTEM_NAME = 'ProtocolIQ';
export const SYSTEM_VERSION = '2.0.0';
export const CDISC_CODE_SYSTEM = 'http://www.cdisc.org';

export interface ReleasePackage {
  version: string;
  name: string;
  description: string;
  schemaLocation: string;
  rootSchema: string;
  sources: unknown[];
  schema: unknown;
  model: unknown;
  ct: unknown;
}

export interface RuleFile {
  group: string;
  description?: string;
  rules: SeedRule[];
}

export interface SeedRule {
  sourceEntity: string;
  sourceField: string;
  targetEntity: string | null;
  targetProperty: string | null;
  type: 'direct' | 'value' | 'terminology' | 'relationship' | 'manual' | 'unsupported';
  status: 'Not Mapped' | 'Mapped' | 'Requires Review' | 'Validated' | 'Rejected';
  rule?: Record<string, unknown>;
  reason?: string;
}

export const BUNDLED_RELEASES: ReleasePackage[] = [
  {
    version: release400.version,
    name: release400.name,
    description: release400.description,
    schemaLocation: release400.schemaLocation,
    rootSchema: release400.rootSchema,
    sources: release400.sources,
    schema: schema400,
    model: model400,
    ct: ct400,
  },
];

/** Seed mapping rules per bundled release. A new 4.x release can start from a copy of these (see copyMappings). */
export const SEED_RULES: Record<string, RuleFile[]> = {
  '4.0.0': [studyRules, designRules, interventionRules, objectiveRules, endpointRules, eligibilityRules, encounterRules, activityRules, soaRules] as RuleFile[],
};

export interface SeedTerminology {
  domains: Record<string, { codelist: string; label: string; auto?: boolean; description?: string }>;
  entries: { domain: string; source: string; code: string | null; status: SeedRule['status']; basis: string }[];
}
export const SEED_TERMINOLOGY: Record<string, SeedTerminology> = { '4.0.0': terminologyMappings as SeedTerminology };

/** Structural assemblers by USDM major version. A new major release needs a new assembler; minor releases reuse it. */
export const SUPPORTED_MAJOR_VERSIONS = ['4'];

export const CONFORMANCE_NOTE =
  'Validated against the official USDM API JSON schema for the selected release plus ProtocolIQ referential-integrity checks derived from the USDM model. CDISC CORE conformance rules are not executed by ProtocolIQ.';
