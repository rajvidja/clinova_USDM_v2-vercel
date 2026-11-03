import { Router, type NextFunction, type Request, type Response } from 'express';
import { MAPPING_STATUSES } from '../../shared/governance.ts';
import { requirePermission } from '../auth.ts';
import { HttpError } from '../repo.ts';
import { getMapping, listMappings, mappingHistory, copyMappings, createMapping, reviewMapping, setManualValue, SOURCE_ENTITIES, SOURCE_ENTITY_LABELS, updateMapping } from './mapping_registry.ts';
import { getRun, listRuns, mapStudy, resolveProtocol, reviewRun, runPipeline } from './mapping_engine.ts';
import { domainsFor, listTerminology, reviewTerminology, searchCodelist, upsertTerminology } from './terminology_mapper.ts';
import { CONFORMANCE_NOTE } from './usdm_config.ts';
import { exportFile, exportStudy, listExports } from './usdm_exporter.ts';
import { compatibility, listReleases, loadRelease, registerRelease, resolveRelease, updateRelease } from './usdm_version.ts';

// USDM Mapping Studio API. Every route requires a signed-in user; mutations need the matching permission.

type Handler = (req: Request, res: Response) => unknown;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res)).catch(next);
const p = (req: Request, key: string) => String(req.params[key]);
const q = (req: Request, key: string) => (typeof req.query[key] === 'string' && req.query[key] ? String(req.query[key]) : undefined);
const num = (req: Request, key: string) => (q(req, key) ? Number(q(req, key)) : undefined);
const decision = <T extends string>(v: unknown, allowed: readonly T[]): T => {
  if (!allowed.includes(v as T)) throw new HttpError(400, `Decision must be one of ${allowed.join(', ')}`);
  return v as T;
};

const read = requirePermission('study.read');

export function usdmRouter(): Router {
  const r = Router();

  // ----- Releases -----
  r.get('/releases', read, h((_req, res) => res.json({ releases: listReleases(), conformanceNote: CONFORMANCE_NOTE })));
  r.post('/releases', requirePermission('usdm.release.manage'), h((req, res) => res.status(201).json(registerRelease(req.body ?? {}))));
  r.patch('/releases/:id', requirePermission('usdm.release.manage'), h((req, res) => res.json(updateRelease(p(req, 'id'), req.body ?? {}))));
  r.get('/releases/:id/compatibility', read, h((req, res) => res.json(compatibility(p(req, 'id')))));
  r.get('/releases/:id/classes', read, h((req, res) => {
    const rel = loadRelease(p(req, 'id'));
    const classes = Object.entries(rel.schema.components.schemas as Record<string, any>)
      .filter(([k]) => k.endsWith('-Input'))
      .map(([k, s]) => ({ name: k.replace(/-Input$/, ''), required: s.required ?? [], properties: Object.keys(s.properties ?? {}).filter((x) => x !== 'instanceType'), definition: rel.model?.classes?.[k.replace(/-Input$/, '')]?.definition ?? '' }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json(classes);
  }));
  r.post('/releases/:id/copy-mappings', requirePermission('usdm.release.manage'), h((req, res) => res.status(201).json(copyMappings(String(req.body?.fromReleaseId ?? ''), p(req, 'id'), String(req.body?.reason ?? '')))));

  // ----- Mapping registry -----
  r.get('/mappings', read, h((req, res) => {
    const release = resolveRelease(q(req, 'releaseId'));
    const scope = q(req, 'scope');
    const items = listMappings({
      releaseId: release.id,
      sourceEntity: q(req, 'sourceEntity'),
      status: q(req, 'status'),
      type: q(req, 'type'),
      q: q(req, 'q'),
      studyId: q(req, 'studyId'),
      includeInactive: q(req, 'includeInactive') === '1',
      scope: scope === 'study' || scope === 'all' ? scope : 'global',
    });
    res.json({ releaseId: release.id, version: release.version, items, sourceEntities: SOURCE_ENTITIES.map((id) => ({ id, label: SOURCE_ENTITY_LABELS[id] })), statuses: MAPPING_STATUSES });
  }));
  r.get('/mappings/:id', read, h((req, res) => res.json({ ...getMapping(p(req, 'id')), history: mappingHistory(p(req, 'id')) })));
  r.post('/mappings', requirePermission('usdm.mapping.manage'), h((req, res) => {
    const release = resolveRelease(req.body?.releaseId);
    res.status(201).json(createMapping(release.id, req.body ?? {}, String(req.body?.reason ?? '')));
  }));
  r.put('/mappings/:id', requirePermission('usdm.mapping.manage'), h((req, res) => res.json(updateMapping(p(req, 'id'), req.body ?? {}, String(req.body?.changeReason ?? req.body?.reason ?? '')))));
  r.post('/mappings/:id/review', requirePermission('usdm.mapping.review'), h((req, res) => res.json(reviewMapping(p(req, 'id'), decision(req.body?.decision, ['Validated', 'Rejected'] as const), String(req.body?.comment ?? '')))));
  r.post('/mappings/manual-value', requirePermission('usdm.mapping.manage'), h((req, res) => {
    const release = resolveRelease(req.body?.releaseId);
    res.status(201).json(setManualValue(release.id, req.body ?? {}, String(req.body?.reason ?? '')));
  }));

  // ----- Controlled terminology -----
  r.get('/terminology', read, h((req, res) => {
    const release = resolveRelease(q(req, 'releaseId'));
    const domains = domainsFor(release);
    res.json({
      releaseId: release.id,
      domains: Object.entries(domains).map(([id, d]) => ({ id, ...d, codelistName: release.ct?.codelists[d.codelist]?.name ?? null, ctVersion: release.ct?.codelists[d.codelist]?.packageVersion ?? null })),
      items: listTerminology({ releaseId: release.id, domain: q(req, 'domain'), status: q(req, 'status'), q: q(req, 'q') }),
    });
  }));
  r.post('/terminology', requirePermission('usdm.terminology.manage'), h((req, res) => res.status(201).json(upsertTerminology(resolveRelease(req.body?.releaseId).id, req.body ?? {}))));
  r.put('/terminology/:id', requirePermission('usdm.terminology.manage'), h((req, res) => res.json(upsertTerminology(resolveRelease(req.body?.releaseId).id, { ...(req.body ?? {}), id: p(req, 'id') }))));
  r.post('/terminology/:id/review', requirePermission('usdm.mapping.review'), h((req, res) => res.json(reviewTerminology(p(req, 'id'), decision(req.body?.decision, ['Validated', 'Rejected'] as const), String(req.body?.comment ?? '')))));
  r.get('/codelists/:code', read, h((req, res) => res.json(searchCodelist(resolveRelease(q(req, 'releaseId')), p(req, 'code'), q(req, 'q') ?? '', num(req, 'limit') ?? 50))));

  // ----- Mapping runs -----
  r.post('/map-study/:studyId', requirePermission('usdm.map'), h((req, res) =>
    res.status(201).json(mapStudy(p(req, 'studyId'), { protocolId: req.body?.protocolId, releaseId: req.body?.releaseId, includePending: req.body?.includePending !== false })),
  ));
  // Validates either a stored run (runId) or the current data without storing a run.
  r.post('/validate/:studyId', requirePermission('usdm.map'), h((req, res) => {
    if (req.body?.runId) {
      const run = getRun(String(req.body.runId));
      if (run.studyId !== p(req, 'studyId')) throw new HttpError(404, 'Mapping run not found for this study');
      return res.json({ runId: run.id, stored: true, validation: run.report.validation, conformance: run.report.conformance, valid: run.report.valid, stale: run.stale, staleReason: run.staleReason });
    }
    const protocolId = resolveProtocol(p(req, 'studyId'), req.body?.protocolId);
    const { report } = runPipeline(protocolId, { releaseId: req.body?.releaseId, includePending: req.body?.includePending !== false });
    res.json({ runId: null, stored: false, validation: report.validation, conformance: report.conformance, valid: report.valid, counts: report.counts, issues: report.issues });
  }));
  r.get('/runs', read, h((req, res) => res.json(listRuns({ studyId: q(req, 'studyId'), protocolId: q(req, 'protocolId'), page: num(req, 'page'), pageSize: num(req, 'pageSize') }))));
  r.get('/runs/:id', read, h((req, res) => {
    const run = getRun(p(req, 'id'));
    res.json(q(req, 'output') === '0' ? { ...run, output: undefined } : run);
  }));
  r.post('/runs/:id/review', requirePermission('usdm.mapping.review'), h((req, res) => res.json(reviewRun(p(req, 'id'), decision(req.body?.decision, ['Approved', 'Rejected'] as const), String(req.body?.comment ?? '')))));

  // ----- Export -----
  r.get('/export/:studyId', requirePermission('usdm.export'), h((req, res) => {
    const { record, body, filename } = exportStudy(p(req, 'studyId'), { runId: q(req, 'runId'), protocolId: q(req, 'protocolId') });
    res.setHeader('X-Export-Id', record.id);
    res.setHeader('X-Conformance', encodeURIComponent(record.conformanceLabel));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `${q(req, 'inline') ? 'inline' : 'attachment'}; filename="${filename}"`);
    res.send(body);
  }));
  r.get('/exports', read, h((req, res) => res.json(listExports({ studyId: q(req, 'studyId'), status: q(req, 'status'), page: num(req, 'page'), pageSize: num(req, 'pageSize') }))));
  r.get('/exports/:id/file', requirePermission('usdm.export'), h((req, res) => {
    const { body, filename } = exportFile(p(req, 'id'));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(body);
  }));

  return r;
}
