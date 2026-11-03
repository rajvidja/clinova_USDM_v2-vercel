import { Router, type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { queryAudit, verifyAuditChain, audit } from '../audit.ts';
import { createUser, listUsers, permissionMatrix, requirePermission, updateUser } from '../auth.ts';
import { db } from '../db.ts';
import { HttpError } from '../repo.ts';
import { governanceDashboard } from './dashboard.ts';
import { createIssue, getIssue, listIssues, updateIssue } from './issues.ts';
import { elementLineage, lineageFor, reviewElements } from './lineage.ts';
import { BUILTIN_KEYS, CHECK_TYPES, createRule, getRule, listRules, qualityResults, qualityScore, ruleRuns, updateRule, validateProtocol, validateStudy } from './quality.ts';
import { assignOwner, listDictionary, listOwners, removeOwner, upsertDictionary } from './stewardship.ts';
import {
  approveChangeRequest,
  compareVersions,
  createChangeRequest,
  createVersion,
  decideVersion,
  getChangeRequest,
  listChangeRequests,
  listVersions,
  rejectChangeRequest,
  submitChangeRequest,
  requestVersionApproval,
  updateChangeRequest,
  withdrawChangeRequest,
} from './versions.ts';

// Data Governance API: dashboard, quality rules and results, issues, lineage, audit, versions, change control,
// ownership, data dictionary and user administration.

type Handler = (req: Request, res: Response) => unknown;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res)).catch(next);
const p = (req: Request, key: string) => String(req.params[key]);
const q = (req: Request, key: string) => (typeof req.query[key] === 'string' && req.query[key] ? String(req.query[key]) : undefined);
const num = (req: Request, key: string) => (q(req, key) ? Number(q(req, key)) : undefined);
const read = requirePermission('study.read');

const protocolOfStudy = (studyId: string, protocolId?: string) => {
  const row = protocolId
    ? (db.prepare(`SELECT id FROM protocols WHERE id = ? AND study_id = ?`).get(protocolId, studyId) as any)
    : (db.prepare(`SELECT id FROM protocols WHERE study_id = ? ORDER BY updated_at DESC LIMIT 1`).get(studyId) as any);
  if (!row) throw new HttpError(404, 'Protocol not found for this study');
  return row.id as string;
};

export function governanceRouter(): Router {
  const r = Router();

  r.get('/dashboard', read, h((_req, res) => res.json(governanceDashboard())));

  // ----- Rules -----
  r.get('/rules', read, h((_req, res) => res.json({ rules: listRules(), checkTypes: CHECK_TYPES, builtinKeys: BUILTIN_KEYS })));
  r.get('/rules/:id', read, h((req, res) => res.json({ ...getRule(p(req, 'id')), runs: ruleRuns(p(req, 'id')) })));
  r.post('/rules', requirePermission('rules.manage'), h((req, res) => res.status(201).json(createRule(req.body ?? {}))));
  r.put('/rules/:id', requirePermission('rules.manage'), h((req, res) => res.json(updateRule(p(req, 'id'), req.body ?? {}, req.body?.changeReason))));

  // ----- Validation and results -----
  r.post('/validate/:studyId', requirePermission('governance.validate'), h((req, res) => {
    const studyId = p(req, 'studyId');
    if (req.body?.protocolId) return res.json({ runs: [validateProtocol(protocolOfStudy(studyId, String(req.body.protocolId)))] });
    res.json({ runs: validateStudy(studyId) });
  }));
  r.get('/results', read, h((req, res) =>
    res.json(qualityResults({ protocolId: q(req, 'protocolId'), runId: q(req, 'runId'), severity: q(req, 'severity'), category: q(req, 'category'), page: num(req, 'page'), pageSize: num(req, 'pageSize') })),
  ));
  r.get('/score/:protocolId', read, h((req, res) => res.json(qualityScore(p(req, 'protocolId')))));

  // ----- Issues -----
  r.get('/issues', read, h((req, res) =>
    res.json(
      listIssues({
        studyId: q(req, 'studyId'),
        protocolId: q(req, 'protocolId'),
        status: q(req, 'status'),
        severity: q(req, 'severity'),
        category: q(req, 'category'),
        ruleId: q(req, 'ruleId'),
        assignedTo: q(req, 'assignedTo'),
        elementType: q(req, 'elementType'),
        q: q(req, 'q'),
        page: num(req, 'page'),
        pageSize: num(req, 'pageSize'),
      }),
    ),
  ));
  r.get('/issues/:id', read, h((req, res) => res.json(getIssue(p(req, 'id')))));
  r.post('/issues', requirePermission('issue.create'), h((req, res) => res.status(201).json(createIssue(req.body ?? {}))));
  // Fine-grained checks (assign/resolve/exception) are applied inside updateIssue.
  r.put('/issues/:id', read, h((req, res) => res.json(updateIssue(p(req, 'id'), req.body ?? {}))));

  // ----- Lineage and element review -----
  r.get('/lineage/:elementId', read, h((req, res) => res.json(elementLineage(p(req, 'elementId')))));
  r.get('/protocols/:protocolId/lineage', read, h((req, res) => res.json(lineageFor(p(req, 'protocolId'), q(req, 'includeDeleted') === '1'))));
  r.post('/protocols/:protocolId/review', requirePermission('element.review'), h((req, res) => {
    const decision = req.body?.decision;
    if (decision !== 'Approved' && decision !== 'Rejected') throw new HttpError(400, 'Decision must be Approved or Rejected');
    const comment = String(req.body?.comment ?? '');
    if (decision === 'Rejected' && !comment.trim()) throw new HttpError(400, 'A comment is required when rejecting elements');
    const ids = req.body?.elementIds === 'all-pending' ? 'all-pending' : Array.isArray(req.body?.elementIds) ? req.body.elementIds.map(String) : null;
    if (!ids || (Array.isArray(ids) && !ids.length)) throw new HttpError(400, 'Select at least one element');
    res.json({ reviewed: reviewElements(p(req, 'protocolId'), ids, decision, comment) });
  }));

  // ----- Audit trail (read-only; there is no update or delete route) -----
  r.get('/audit', requirePermission('audit.read'), h((req, res) =>
    res.json(
      queryAudit({
        studyId: q(req, 'studyId'),
        entityType: q(req, 'entityType'),
        entityId: q(req, 'entityId'),
        userId: q(req, 'userId'),
        action: q(req, 'action'),
        q: q(req, 'q'),
        from: q(req, 'from'),
        to: q(req, 'to'),
        page: num(req, 'page'),
        pageSize: num(req, 'pageSize'),
      }),
    ),
  ));
  r.get('/audit/verify', requirePermission('audit.read'), h((_req, res) => res.json(verifyAuditChain())));

  // ----- Versions and change control -----
  r.get('/versions/:studyId', read, h((req, res) => res.json(listVersions(p(req, 'studyId')))));
  r.post('/protocols/:protocolId/versions', requirePermission('protocol.edit'), h((req, res) => res.status(201).json(createVersion(p(req, 'protocolId'), String(req.body?.note ?? ''), { changeReason: req.body?.changeReason }))));
  r.post('/versions/:versionId/submit', requirePermission('protocol.submit'), h((req, res) => res.json(requestVersionApproval(p(req, 'versionId'), String(req.body?.note ?? '')))));
  r.post('/versions/:versionId/approve', requirePermission('protocol.approve'), h((req, res) => res.json(decideVersion(p(req, 'versionId'), 'Approved', String(req.body?.comment ?? '')))));
  r.post('/versions/:versionId/reject', requirePermission('protocol.approve'), h((req, res) => res.json(decideVersion(p(req, 'versionId'), 'Rejected', String(req.body?.comment ?? '')))));
  r.get('/protocols/:protocolId/compare', read, h((req, res) => {
    const from = q(req, 'from');
    if (!from) throw new HttpError(400, 'Choose a version to compare from');
    res.json(compareVersions(p(req, 'protocolId'), from, q(req, 'to') ?? 'current'));
  }));
  r.get('/change-requests', read, h((req, res) => res.json(listChangeRequests({ studyId: q(req, 'studyId'), protocolId: q(req, 'protocolId'), status: q(req, 'status') }))));
  r.get('/change-requests/:id', read, h((req, res) => res.json(getChangeRequest(p(req, 'id')))));
  r.post('/change-requests', requirePermission('change.propose'), h((req, res) => res.status(201).json(createChangeRequest(req.body ?? {}))));
  r.put('/change-requests/:id', requirePermission('change.propose'), h((req, res) => res.json(updateChangeRequest(p(req, 'id'), req.body ?? {}))));
  r.post('/change-requests/:id/submit', requirePermission('change.propose'), h((req, res) => res.json(submitChangeRequest(p(req, 'id')))));
  r.post('/change-requests/:id/withdraw', requirePermission('change.propose'), h((req, res) => res.json(withdrawChangeRequest(p(req, 'id')))));
  r.post('/approve/:requestId', requirePermission('change.approve'), h((req, res) => res.json(approveChangeRequest(p(req, 'requestId'), String(req.body?.comment ?? '')))));
  r.post('/reject/:requestId', requirePermission('change.approve'), h((req, res) => res.json(rejectChangeRequest(p(req, 'requestId'), String(req.body?.comment ?? '')))));

  // ----- Ownership and data dictionary -----
  r.get('/owners', read, h((req, res) => res.json(listOwners(q(req, 'studyId')))));
  r.post('/owners', requirePermission('owners.manage'), h((req, res) => res.status(201).json(assignOwner(req.body ?? {}))));
  r.delete('/owners/:id', requirePermission('owners.manage'), h((req, res) => {
    removeOwner(p(req, 'id'));
    res.status(204).end();
  }));
  r.get('/dictionary', read, h((req, res) => res.json(listDictionary(q(req, 'q')))));
  r.put('/dictionary/:id', requirePermission('dictionary.manage'), h((req, res) => res.json(upsertDictionary({ ...(req.body ?? {}), id: p(req, 'id') }))));
  r.post('/dictionary', requirePermission('dictionary.manage'), h((req, res) => {
    if (db.prepare(`SELECT 1 FROM data_dictionary WHERE id = ?`).get(String(req.body?.id ?? ''))) throw new HttpError(409, 'An entry with this id already exists');
    res.status(201).json(upsertDictionary(req.body ?? {}));
  }));

  // ----- Users, roles and permissions -----
  r.get('/users', read, h((_req, res) => res.json(listUsers().map((u) => ({ id: u.id, username: u.username, displayName: u.displayName, roles: u.roles, active: u.active })))));
  r.get('/admin/users', requirePermission('users.manage'), h((_req, res) => res.json(listUsers())));
  r.post('/admin/users', requirePermission('users.manage'), h((req, res) => res.status(201).json(createUser(req.body ?? {}))));
  r.put('/admin/users/:id', requirePermission('users.manage'), h((req, res) => res.json(updateUser(p(req, 'id'), req.body ?? {}, req.actor!))));
  r.get('/permissions', read, h((_req, res) => res.json(permissionMatrix())));

  // ----- Backup -----
  r.get('/backup', requirePermission('system.backup'), h((_req, res) => {
    const file = path.join(os.tmpdir(), `protocoliq-backup-${randomUUID()}.db`);
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    audit({ action: 'system.backup', entityType: 'system', entityId: 'database', next: { bytes: fs.statSync(file).size } });
    res.setHeader('Content-Type', 'application/vnd.sqlite3');
    res.setHeader('Content-Disposition', `attachment; filename="protocoliq-${new Date().toISOString().slice(0, 10)}.db"`);
    res.sendFile(file, () => fs.rm(file, { force: true }, () => {}));
  }));

  return r;
}
