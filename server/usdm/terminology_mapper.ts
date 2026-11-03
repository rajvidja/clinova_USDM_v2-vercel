import { randomUUID } from 'node:crypto';
import type { MappingStatus } from '../../shared/governance.ts';
import { audit } from '../audit.ts';
import { currentActor } from '../context.ts';
import { db, tx } from '../db.ts';
import { HttpError } from '../repo.ts';
import { CDISC_CODE_SYSTEM, SEED_TERMINOLOGY, type SeedTerminology } from './usdm_config.ts';
import { loadRelease, releaseId, type CtTerm, type LoadedRelease } from './usdm_version.ts';

// Controlled terminology mapping: ProtocolIQ values -> CDISC terms, per release and domain. Similar labels are never
// assumed equivalent: only curated entries, or exact matches to a CDISC submission value / preferred term / synonym in
// 'auto' domains, are applied. Every other value is recorded as unmatched and flagged for manual review.

export interface TerminologyEntry {
  id: string;
  releaseId: string;
  domain: string;
  sourceValue: string;
  sourceTerminology: string;
  targetCodelist: string | null;
  targetCode: string | null;
  targetDecode: string | null;
  preferredTerm: string | null;
  targetTerminology: string | null;
  version: string | null;
  effectiveDate: string | null;
  matchBasis: string;
  status: MappingStatus;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  notes: string;
}

export type TermResolution =
  | { outcome: 'mapped' | 'provisional'; entry: TerminologyEntry; term: CtTerm | null }
  | { outcome: 'no-equivalent' | 'review' | 'rejected' | 'unmatched' | 'empty' | 'unknown-domain'; entry: TerminologyEntry | null; term: null };

const now = () => new Date().toISOString();

const toEntry = (r: any): TerminologyEntry => ({
  id: r.id,
  releaseId: r.release_id,
  domain: r.domain,
  sourceValue: r.source_value,
  sourceTerminology: r.source_terminology,
  targetCodelist: r.target_codelist,
  targetCode: r.target_code,
  targetDecode: r.target_decode,
  preferredTerm: r.preferred_term,
  targetTerminology: r.target_terminology,
  version: r.version,
  effectiveDate: r.effective_date,
  matchBasis: r.match_basis,
  status: r.status,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedBy: r.updated_by,
  updatedAt: r.updated_at,
  reviewedBy: r.reviewed_by,
  reviewedAt: r.reviewed_at,
  notes: r.notes,
});

/** Terminology domains for a release (bundled releases have their own; others reuse the latest bundled set). */
export function domainsFor(release: LoadedRelease): SeedTerminology['domains'] {
  return (SEED_TERMINOLOGY[release.version] ?? Object.values(SEED_TERMINOLOGY).at(-1)!).domains;
}

function termOf(release: LoadedRelease, codelist: string | null, code: string | null): CtTerm | null {
  if (!codelist || !code) return null;
  return release.ct?.codelists[codelist]?.terms.find((t) => t.code === code) ?? null;
}

function targetColumns(release: LoadedRelease, codelist: string | null, code: string | null) {
  const cl = codelist ? release.ct?.codelists[codelist] : null;
  const term = termOf(release, codelist, code);
  return {
    target_codelist: codelist || null,
    target_code: code || null,
    target_decode: term?.submissionValue ?? null,
    preferred_term: term?.preferredTerm ?? null,
    target_terminology: cl ? `CDISC ${cl.package} Controlled Terminology` : null,
    version: cl?.packageVersion ?? null,
    effective_date: cl?.packageVersion ?? null,
  };
}

function insertEntry(release: LoadedRelease, domain: string, source: string, codelist: string | null, code: string | null, status: MappingStatus, basis: string, by: string) {
  const id = randomUUID();
  const t = now();
  const cols = targetColumns(release, codelist, code);
  db.prepare(
    `INSERT INTO usdm_terminology (id, release_id, domain, source_value, target_codelist, target_code, target_decode, preferred_term, target_terminology, version, effective_date, match_basis, status, created_by, created_at, updated_by, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, release.id, domain, source, cols.target_codelist, cols.target_code, cols.target_decode, cols.preferred_term, cols.target_terminology, cols.version, cols.effective_date, basis, status, by, t, by, t);
  return id;
}

export function seedTerminology() {
  for (const [version, seed] of Object.entries(SEED_TERMINOLOGY)) {
    const rid = releaseId(version);
    if (!db.prepare(`SELECT 1 FROM usdm_releases WHERE id = ?`).get(rid)) continue;
    const release = loadRelease(rid);
    tx(() => {
      for (const e of seed.entries) {
        if (db.prepare(`SELECT 1 FROM usdm_terminology WHERE release_id = ? AND domain = ? AND source_value = ?`).get(rid, e.domain, e.source)) continue;
        const codelist = seed.domains[e.domain]?.codelist ?? null;
        if (e.code && !termOf(release, codelist, e.code)) throw new Error(`Seed terminology ${e.domain}/${e.source}: ${e.code} is not in codelist ${codelist}`);
        insertEntry(release, e.domain, e.source, codelist, e.code, e.status, e.basis, 'system');
      }
    });
  }
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

function exactCdiscMatches(release: LoadedRelease, codelist: string, value: string) {
  const terms = release.ct?.codelists[codelist]?.terms ?? [];
  const v = norm(value);
  const hits: { term: CtTerm; basis: string }[] = [];
  for (const t of terms) {
    if (norm(t.submissionValue) === v) hits.push({ term: t, basis: `Exact match to CDISC submission value '${t.submissionValue}'` });
    else if (norm(t.preferredTerm) === v) hits.push({ term: t, basis: `Exact match to NCI preferred term '${t.preferredTerm}'` });
    else {
      const syn = t.synonyms.find((s) => norm(s) === v);
      if (syn) hits.push({ term: t, basis: `Exact match to CDISC synonym '${syn}'` });
    }
  }
  return hits;
}

/**
 * Resolves a source value to a CDISC term. With record=true, values seen for the first time are stored: exact CDISC
 * matches as Mapped (auto domains) and everything else as an unmatched entry requiring review.
 */
export function resolveTerm(release: LoadedRelease, domain: string, raw: unknown, record = true): TermResolution {
  const value = typeof raw === 'string' ? raw.trim() : raw == null ? '' : String(raw);
  if (!value) return { outcome: 'empty', entry: null, term: null };
  const dom = domainsFor(release)[domain];
  if (!dom) return { outcome: 'unknown-domain', entry: null, term: null };
  let row = db.prepare(`SELECT * FROM usdm_terminology WHERE release_id = ? AND domain = ? AND source_value = ? COLLATE NOCASE`).get(release.id, domain, value) as any;
  if (!row && record) {
    const hits = dom.auto && dom.codelist ? exactCdiscMatches(release, dom.codelist, value) : [];
    const unique = hits.length === 1 ? hits[0] : null;
    const id = insertEntry(
      release,
      domain,
      value,
      unique ? dom.codelist : dom.codelist || null,
      unique ? unique.term.code : null,
      unique ? 'Mapped' : 'Requires Review',
      unique ? unique.basis : hits.length > 1 ? `Ambiguous: matches ${hits.map((h) => h.term.code).join(', ')}. Choose one manually.` : 'Unmatched: no curated mapping and no exact CDISC match. Flagged for manual review.',
      'system',
    );
    row = db.prepare(`SELECT * FROM usdm_terminology WHERE id = ?`).get(id);
  }
  if (!row) return { outcome: 'unmatched', entry: null, term: null };
  const entry = toEntry(row);
  const term = termOf(release, entry.targetCodelist, entry.targetCode);
  const hasTarget = !!entry.targetCode && (domain === 'biomedical_concept' || !!term);
  switch (entry.status) {
    case 'Mapped':
    case 'Validated':
      return hasTarget ? { outcome: 'mapped', entry, term } : { outcome: 'review', entry, term: null };
    case 'Requires Review':
      return hasTarget ? { outcome: 'provisional', entry, term } : { outcome: entry.matchBasis.startsWith('Unmatched') ? 'unmatched' : 'review', entry, term: null };
    case 'Not Mapped':
      return { outcome: 'no-equivalent', entry, term: null };
    default:
      return { outcome: 'rejected', entry, term: null };
  }
}

// ---------- USDM Code builders ----------

export function cdiscCode(release: LoadedRelease, codelist: string, code: string, id: string) {
  const cl = release.ct?.codelists[codelist];
  const term = cl?.terms.find((t) => t.code === code);
  if (!cl || !term) return null;
  return { id, code: term.code, codeSystem: CDISC_CODE_SYSTEM, codeSystemVersion: cl.packageVersion, decode: term.submissionValue, instanceType: 'Code' };
}

// ---------- Management ----------

export interface TerminologyFilter {
  releaseId: string;
  domain?: string;
  status?: string;
  q?: string;
}

export function listTerminology(f: TerminologyFilter): TerminologyEntry[] {
  const where = ['release_id = ?'];
  const args: string[] = [f.releaseId];
  if (f.domain) (where.push('domain = ?'), args.push(f.domain));
  if (f.status) (where.push('status = ?'), args.push(f.status));
  if (f.q) (where.push('(source_value LIKE ? OR target_decode LIKE ? OR target_code LIKE ?)'), args.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`));
  return (db.prepare(`SELECT * FROM usdm_terminology WHERE ${where.join(' AND ')} ORDER BY domain, source_value`).all(...args) as any[]).map(toEntry);
}

const getEntry = (id: string) => {
  const r = db.prepare(`SELECT * FROM usdm_terminology WHERE id = ?`).get(id);
  if (!r) throw new HttpError(404, 'Terminology entry not found');
  return toEntry(r);
};

export function upsertTerminology(
  releaseIdValue: string,
  input: { id?: string; domain: string; sourceValue: string; targetCode?: string | null; targetDecode?: string | null; status?: MappingStatus; matchBasis?: string; notes?: string },
): TerminologyEntry {
  const release = loadRelease(releaseIdValue);
  const dom = domainsFor(release)[input.domain];
  if (!dom) throw new HttpError(400, `Unknown terminology domain '${input.domain}'`);
  const source = String(input.sourceValue ?? '').trim();
  if (!source || source.length > 300) throw new HttpError(400, 'Source value is required (max 300 characters)');
  const status = input.status ?? 'Requires Review';
  if (status === 'Validated') throw new HttpError(400, 'Terminology entries are validated through review');
  const code = input.targetCode?.trim() || null;
  const isBc = input.domain === 'biomedical_concept';
  if (code && !isBc && !termOf(release, dom.codelist, code)) throw new HttpError(400, `${code} is not a term in codelist ${dom.codelist} (${release.ct?.codelists[dom.codelist]?.name ?? 'unknown'})`);
  if (status === 'Mapped' && !code) throw new HttpError(400, "Choose a target term, or use status 'Not Mapped' to record that no equivalent exists");
  if (!input.matchBasis?.trim() && code) throw new HttpError(400, 'Record the basis for this terminology match');
  if (isBc && code && !/^https?:\/\/\S+$/.test(String(input.notes ?? '').trim())) throw new HttpError(400, 'Biomedical concept links need the concept reference URL in notes');
  const actor = currentActor();
  const t = now();
  const existing = input.id
    ? getEntry(input.id)
    : (db.prepare(`SELECT * FROM usdm_terminology WHERE release_id = ? AND domain = ? AND source_value = ? COLLATE NOCASE`).get(releaseIdValue, input.domain, source) as any);
  const before = existing ? (input.id ? (existing as TerminologyEntry) : toEntry(existing)) : null;
  const cols = isBc
    ? { target_codelist: null, target_code: code, target_decode: input.targetDecode?.trim() || null, preferred_term: input.targetDecode?.trim() || null, target_terminology: 'CDISC Biomedical Concepts', version: null, effective_date: null }
    : targetColumns(release, dom.codelist, code);
  let id = before?.id;
  tx(() => {
    if (before) {
      db.prepare(
        `UPDATE usdm_terminology SET target_codelist = ?, target_code = ?, target_decode = ?, preferred_term = ?, target_terminology = ?, version = ?, effective_date = ?, match_basis = ?, status = ?, notes = ?,
           updated_by = ?, updated_at = ?, reviewed_by = NULL, reviewed_at = NULL WHERE id = ?`,
      ).run(cols.target_codelist, cols.target_code, cols.target_decode, cols.preferred_term, cols.target_terminology, cols.version, cols.effective_date, input.matchBasis?.trim() || before.matchBasis, status, input.notes ?? before.notes, actor.userId, t, before.id);
    } else {
      id = insertEntry(release, input.domain, source, cols.target_codelist, cols.target_code, status, input.matchBasis?.trim() || 'Manual entry', actor.userId);
      if (isBc) db.prepare(`UPDATE usdm_terminology SET target_decode = ?, preferred_term = ?, target_terminology = ?, notes = ? WHERE id = ?`).run(cols.target_decode, cols.preferred_term, cols.target_terminology, input.notes ?? '', id);
      else if (input.notes) db.prepare(`UPDATE usdm_terminology SET notes = ? WHERE id = ?`).run(input.notes, id);
    }
    audit({ action: before ? 'usdm.terminology.updated' : 'usdm.terminology.created', entityType: 'usdm_terminology', entityId: id!, previous: before, next: getEntry(id!) });
  });
  return getEntry(id!);
}

export function reviewTerminology(id: string, decision: 'Validated' | 'Rejected', comment: string): TerminologyEntry {
  const before = getEntry(id);
  const actor = currentActor();
  if (decision === 'Rejected' && !comment?.trim()) throw new HttpError(400, 'A comment is required when rejecting a terminology mapping');
  if (decision === 'Validated' && !before.targetCode) throw new HttpError(400, "An entry without a target term cannot be validated; set a target or mark it 'Not Mapped'");
  if (before.updatedBy === actor.userId && before.updatedBy !== 'system') throw new HttpError(403, 'A terminology mapping must be reviewed by someone other than its last editor');
  tx(() => {
    db.prepare(`UPDATE usdm_terminology SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?`).run(decision, actor.userId, now(), id);
    db.prepare(`INSERT INTO approval_records (id, entity_type, entity_id, study_id, decision, decided_by, comment, created_at) VALUES (?,?,?,NULL,?,?,?,?)`).run(
      randomUUID(),
      'usdm_terminology',
      id,
      decision,
      actor.userId,
      comment ?? '',
      now(),
    );
    audit({ action: 'usdm.terminology.reviewed', entityType: 'usdm_terminology', entityId: id, previous: { status: before.status }, next: { status: decision }, reason: comment });
  });
  return getEntry(id);
}

/** Codelist browser for choosing target terms. */
export function searchCodelist(release: LoadedRelease, codelist: string, q = '', limit = 50) {
  const cl = release.ct?.codelists[codelist];
  if (!cl) throw new HttpError(404, `Codelist ${codelist} is not in the USDM ${release.version} terminology package`);
  const v = q.trim().toLowerCase();
  const terms = v
    ? cl.terms.filter((t) => t.code.toLowerCase().includes(v) || t.submissionValue.toLowerCase().includes(v) || t.preferredTerm.toLowerCase().includes(v) || t.synonyms.some((s) => s.toLowerCase().includes(v)))
    : cl.terms;
  return { code: cl.code, name: cl.name, extensible: cl.extensible, package: cl.package, packageVersion: cl.packageVersion, total: terms.length, terms: terms.slice(0, limit) };
}
