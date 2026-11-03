import { SEVERITIES, RULE_CATEGORIES } from '../../shared/governance.ts';
import { db } from '../db.ts';
import { qualityScore } from './quality.ts';

// Governance dashboard metrics. Everything is computed from the database at request time.

const n = (sql: string, ...args: (string | number)[]) => Number((db.prepare(sql).get(...args) as { n: number }).n);

export function governanceDashboard() {
  const protocols = db
    .prepare(
      `SELECT p.id, p.study_id, p.version, p.status, p.source, p.revision, s.title, s.protocol_number FROM protocols p JOIN studies s ON s.id = p.study_id ORDER BY s.title, p.created_at`,
    )
    .all() as any[];

  const studies = protocols.map((p) => {
    const q = qualityScore(p.id);
    const run = db.prepare(`SELECT id, status, review_status, protocol_revision, report_json, created_at FROM usdm_mapping_runs WHERE protocol_id = ? ORDER BY created_at DESC LIMIT 1`).get(p.id) as any;
    const counts = run ? JSON.parse(run.report_json).counts : null;
    const lineage = db.prepare(`SELECT review_status, COUNT(*) AS n FROM lineage_records WHERE protocol_id = ? AND deleted_at IS NULL GROUP BY review_status`).all(p.id) as any[];
    const review = Object.fromEntries(lineage.map((l) => [l.review_status, Number(l.n)]));
    const totalEls = Object.values(review).reduce((a: number, b) => a + Number(b), 0) as number;
    const exported = db.prepare(`SELECT exported_at FROM usdm_export_records WHERE protocol_id = ? AND status = 'exported' ORDER BY exported_at DESC LIMIT 1`).get(p.id) as any;
    return {
      protocolId: p.id,
      studyId: p.study_id,
      title: p.title,
      protocolNumber: p.protocol_number,
      version: p.version,
      status: p.status,
      source: p.source,
      qualityScore: q?.score ?? null,
      lastValidatedAt: q?.executedAt ?? null,
      openIssues: n(`SELECT COUNT(*) AS n FROM governance_issues WHERE protocol_id = ? AND status IN ('Open','Assigned','In Progress')`, p.id),
      criticalIssues: n(`SELECT COUNT(*) AS n FROM governance_issues WHERE protocol_id = ? AND severity = 'Critical' AND status IN ('Open','Assigned','In Progress')`, p.id),
      review: { approved: review.Approved ?? 0, pending: review.Pending ?? 0, rejected: review.Rejected ?? 0, total: totalEls },
      mapping: run
        ? {
            runId: run.id,
            valid: run.status === 'valid',
            reviewStatus: run.review_status,
            current: Number(run.protocol_revision) === Number(p.revision),
            completeness: counts.elements ? Math.round(((counts.mapped + counts.validated) / counts.elements) * 1000) / 10 : 0,
            schemaErrors: counts.schemaErrors,
            createdAt: run.created_at,
          }
        : null,
      lastExportAt: exported?.exported_at ?? null,
    };
  });

  const issuesBySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, n(`SELECT COUNT(*) AS n FROM governance_issues WHERE severity = ? AND status IN ('Open','Assigned','In Progress')`, s)]));
  const issuesByCategory = Object.fromEntries(RULE_CATEGORIES.map((c) => [c, n(`SELECT COUNT(*) AS n FROM governance_issues WHERE category = ? AND status IN ('Open','Assigned','In Progress')`, c)]));
  const issuesByStatus = Object.fromEntries((db.prepare(`SELECT status, COUNT(*) AS n FROM governance_issues GROUP BY status`).all() as any[]).map((r) => [r.status, Number(r.n)]));
  const review = Object.fromEntries((db.prepare(`SELECT review_status, COUNT(*) AS n FROM lineage_records WHERE deleted_at IS NULL GROUP BY review_status`).all() as any[]).map((r) => [r.review_status, Number(r.n)]));
  const bySource = Object.fromEntries((db.prepare(`SELECT source_type, COUNT(*) AS n FROM lineage_records WHERE deleted_at IS NULL GROUP BY source_type`).all() as any[]).map((r) => [r.source_type, Number(r.n)]));

  const since = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
  const perDay = new Map((db.prepare(`SELECT substr(created_at, 1, 10) AS d, COUNT(*) AS n FROM audit_logs WHERE created_at >= ? GROUP BY d`).all(since) as any[]).map((r) => [r.d, Number(r.n)]));
  const changes = new Map((db.prepare(`SELECT substr(changed_at, 1, 10) AS d, COUNT(*) AS n FROM element_versions WHERE changed_at >= ? GROUP BY d`).all(since) as any[]).map((r) => [r.d, Number(r.n)]));
  const activity = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(Date.now() - (29 - i) * 86_400_000).toISOString().slice(0, 10);
    return { date: d, auditEvents: perDay.get(d) ?? 0, elementChanges: changes.get(d) ?? 0 };
  });

  const scored = studies.filter((s) => s.qualityScore !== null);
  const mappingTotals = db.prepare(`SELECT r.status, COUNT(*) AS n FROM usdm_mapping_registry r JOIN usdm_releases u ON u.id = r.release_id WHERE u.is_selected = 1 AND r.active = 1 AND r.scope_study_id IS NULL GROUP BY r.status`).all() as any[];
  const terminology = db.prepare(`SELECT t.status, COUNT(*) AS n FROM usdm_terminology t JOIN usdm_releases u ON u.id = t.release_id WHERE u.is_selected = 1 GROUP BY t.status`).all() as any[];
  return {
    generatedAt: new Date().toISOString(),
    totals: {
      studies: n(`SELECT COUNT(*) AS n FROM studies`),
      protocols: protocols.length,
      averageQuality: scored.length ? Math.round((scored.reduce((a, s) => a + (s.qualityScore ?? 0), 0) / scored.length) * 10) / 10 : null,
      validatedProtocols: scored.length,
      openIssues: n(`SELECT COUNT(*) AS n FROM governance_issues WHERE status IN ('Open','Assigned','In Progress')`),
      criticalIssues: issuesBySeverity.Critical,
      acceptedExceptions: issuesByStatus['Accepted Exception'] ?? 0,
      pendingChangeRequests: n(`SELECT COUNT(*) AS n FROM change_requests WHERE status = 'Pending Review'`),
      pendingMappingRuns: n(`SELECT COUNT(*) AS n FROM usdm_mapping_runs WHERE review_status = 'Pending Review'`),
      exports: n(`SELECT COUNT(*) AS n FROM usdm_export_records WHERE status = 'exported'`),
      rejectedExports: n(`SELECT COUNT(*) AS n FROM usdm_export_records WHERE status = 'rejected'`),
      studiesWithOwner: n(`SELECT COUNT(DISTINCT study_id) AS n FROM data_owners WHERE responsibility = 'Owner'`),
      validMappings: studies.filter((s) => s.mapping?.valid).length,
    },
    issuesBySeverity,
    issuesByCategory,
    issuesByStatus,
    reviewStatus: { Approved: review.Approved ?? 0, Pending: review.Pending ?? 0, Rejected: review.Rejected ?? 0 },
    elementsBySource: bySource,
    mappingRules: Object.fromEntries(mappingTotals.map((r) => [r.status, Number(r.n)])),
    terminology: Object.fromEntries(terminology.map((r) => [r.status, Number(r.n)])),
    activity,
    studies,
  };
}
