import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { buildDocModel } from '../shared/docModel.ts';
import { TEMPLATES } from '../shared/template/index.ts';
import type { FieldType, ProtocolStatus, SaveRequest } from '../shared/types.ts';
import { validateProtocol } from '../shared/validation.ts';
import { audit } from './audit.ts';
import { authenticate, can, changeOwnPassword, demoAccounts, login, logout, requireAuth, requirePermission, sameOrigin } from './auth.ts';
import { bootstrap, hasProtocols, seedDemo } from './bootstrap.ts';
import { digitiseDocument, listSourceDocuments } from './digitise.ts';
import { renderDocx } from './export/docx.ts';
import { renderJson } from './export/json.ts';
import { renderPdf } from './export/pdf.ts';
import { governanceRouter } from './governance/routes.ts';
import { recordCreation, track } from './governance/lineage.ts';
import { changeStatus, createVersion } from './governance/versions.ts';
import { ocrRouter } from './ocr.ts';
import * as repo from './repo.ts';
import { usdmRouter } from './usdm/routes.ts';

bootstrap();

// Demo deployments (e.g. Vercel) run on a temporary database; give each fresh instance the synthetic example.
const DEMO = process.env.PROTOCOLIQ_DEMO === '1';
if (DEMO && !hasProtocols()) seedDemo();

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '25mb' }));
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

type Handler = (req: Request, res: Response) => unknown | Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res)).catch(next);
const p = (req: Request, key: string) => String(req.params[key]);
const need = requirePermission;

const safeName = (s: string) => (s || 'protocol').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
const protocolOfSubsection = (id: string) => {
  const row = repo.subsectionProtocol(id);
  if (!row) throw new repo.HttpError(404, 'Subsection not found');
  return row;
};

app.get('/api/health', (_req, res) => res.json({ ok: true, demo: DEMO }));

// ----- Authentication -----
app.use('/api', authenticate, sameOrigin);
app.post('/api/auth/login', h((req, res) => res.json(login(req, res))));
app.post('/api/auth/logout', h((req, res) => {
  logout(req, res, req.body?.everywhere === true);
  res.json({ ok: true });
}));
app.get('/api/auth/me', h((req, res) => {
  if (!req.user) throw new repo.HttpError(401, 'Sign in required');
  res.json(req.user);
}));
app.get('/api/auth/demo-accounts', h((_req, res) => res.json(demoAccounts())));
app.use('/api', requireAuth);
app.post('/api/auth/password', h((req, res) => {
  changeOwnPassword(req.actor!, req.body?.currentPassword, req.body?.newPassword);
  logout(req, res);
  res.json({ ok: true });
}));

app.get('/api/dashboard', need('study.read'), h((_req, res) => res.json(repo.dashboardStats())));
app.get('/api/templates', need('study.read'), h((_req, res) => res.json(TEMPLATES)));
app.get('/api/studies', need('study.read'), h((_req, res) => res.json(repo.listStudies())));

// ----- Protocols -----
app.get('/api/protocols', need('study.read'), h((_req, res) => res.json(repo.listSummaries())));
app.post('/api/protocols', need('protocol.create'), h(async (req, res) => {
  const id = repo.createProtocol(req.body ?? {}, 'builder');
  recordCreation('protocol.created', id, { sourceType: 'builder', extractionMethod: 'manual entry (Protocol Builder)' });
  res.status(201).json({ id });
}));
app.get('/api/protocols/:id', need('study.read'), h((req, res) => {
  const id = p(req, 'id');
  const bundle = repo.getBundle(id);
  if (req.query.open) repo.touchOpened(id);
  res.json(bundle);
}));
app.post('/api/protocols/:id/save', need('protocol.edit'), h(async (req, res) => {
  const id = p(req, 'id');
  res.json(await track('protocol.saved', id, () => repo.saveProtocol(id, (req.body ?? {}) as SaveRequest), { reason: req.body?.changeReason }));
}));
app.patch('/api/protocols/:id/status', need('study.read'), h((req, res) => {
  const status = req.body?.status as ProtocolStatus;
  const required = status === 'Final' ? 'protocol.approve' : status === 'In Review' ? 'protocol.submit' : 'protocol.edit';
  if (!can(req.actor, required)) throw new repo.HttpError(403, `Your role does not allow moving a protocol to ${status}.`);
  res.json(changeStatus(p(req, 'id'), status, String(req.body?.reason ?? '')).protocol);
}));
app.delete('/api/protocols/:id', need('protocol.delete'), h(async (req, res) => {
  const id = p(req, 'id');
  await track('protocol.deleted', id, () => repo.deleteProtocol(id), { reason: req.body?.reason });
  res.status(204).end();
}));
app.post('/api/protocols/:id/duplicate', need('protocol.create'), h((req, res) => {
  const source = p(req, 'id');
  const mode = req.body?.mode === 'new-version' ? 'new-version' : 'new-study';
  const id = repo.duplicateProtocol(source, mode);
  recordCreation('protocol.duplicated', id, { sourceType: 'builder', extractionMethod: `duplicated from protocol ${source} (${mode})` });
  res.status(201).json({ id });
}));
app.get('/api/protocols/:id/validation', need('study.read'), h((req, res) => res.json(validateProtocol(repo.getBundle(p(req, 'id'))))));

// ----- Subsection structure (locked while Final) -----
app.post('/api/protocols/:id/sections/:sectionId/subsections', need('protocol.edit'), h(async (req, res) => {
  const pid = p(req, 'id');
  const id = await track('section.added', pid, () => repo.addSubsection(pid, p(req, 'sectionId'), req.body?.title, req.body?.contentType as FieldType, req.body?.afterId));
  res.status(201).json({ id });
}));
app.patch('/api/subsections/:id', need('protocol.edit'), h(async (req, res) => {
  await track('section.updated', protocolOfSubsection(p(req, 'id')), () => repo.updateSubsectionMeta(p(req, 'id'), { title: req.body?.title, fields: req.body?.fields }));
  res.json({ ok: true });
}));
app.delete('/api/subsections/:id', need('protocol.edit'), h(async (req, res) => {
  await track('section.deleted', protocolOfSubsection(p(req, 'id')), () => repo.deleteSubsection(p(req, 'id')));
  res.status(204).end();
}));
app.post('/api/subsections/:id/duplicate', need('protocol.edit'), h(async (req, res) => {
  const id = await track('section.duplicated', protocolOfSubsection(p(req, 'id')), () => repo.duplicateSubsection(p(req, 'id')));
  res.status(201).json({ id });
}));
app.post('/api/subsections/:id/move', need('protocol.edit'), h(async (req, res) => {
  await track('section.moved', protocolOfSubsection(p(req, 'id')), () => repo.moveSubsection(p(req, 'id'), req.body?.direction === 'down' ? 'down' : 'up'));
  res.json({ ok: true });
}));

// ----- Versions -----
app.get('/api/protocols/:id/versions', need('study.read'), h((req, res) => res.json(repo.listSnapshots(p(req, 'id')))));
app.post('/api/protocols/:id/versions', need('protocol.edit'), h((req, res) => res.status(201).json(createVersion(p(req, 'id'), String(req.body?.note ?? ''), { changeReason: req.body?.changeReason }))));
app.get('/api/protocols/:id/versions/:vid', need('study.read'), h((req, res) => res.json(repo.getSnapshot(p(req, 'id'), p(req, 'vid')))));
app.post('/api/protocols/:id/versions/:vid/restore', need('protocol.edit'), h(async (req, res) => {
  const id = p(req, 'id');
  await track('protocol.restored', id, () => repo.restoreSnapshot(id, p(req, 'vid')), { reason: req.body?.reason ?? `Restored version ${p(req, 'vid')}` });
  res.json({ ok: true });
}));

// ----- Attachments: raw body upload, filename in query string -----
const UPLOAD_TYPES = /^(application\/pdf|image\/(png|jpeg|gif|webp|tiff)|text\/(plain|csv)|application\/(msword|vnd\.openxmlformats-officedocument\.[a-z.]+|vnd\.ms-excel|octet-stream))$/i;
app.post('/api/protocols/:id/attachments', need('protocol.edit'), express.raw({ type: () => true, limit: '20mb' }), h((req, res) => {
  const filename = String(req.query.filename ?? 'file');
  const subsectionId = req.query.subsectionId ? String(req.query.subsectionId) : null;
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || !body.length) throw new repo.HttpError(400, 'Empty upload');
  const type = String(req.headers['content-type'] ?? 'application/octet-stream').split(';')[0].trim();
  if (!UPLOAD_TYPES.test(type)) throw new repo.HttpError(415, `File type ${type} is not accepted`);
  const att = repo.addAttachment(p(req, 'id'), subsectionId, filename, type, body);
  audit({ action: 'attachment.uploaded', entityType: 'attachment', entityId: att.id, studyId: repo.studyOfProtocol(p(req, 'id')), next: { filename: att.filename, size: att.size, mimeType: type } });
  res.status(201).json(att);
}));
app.get('/api/attachments/:id', need('study.read'), h((req, res) => {
  const att = repo.getAttachment(p(req, 'id'));
  if (!att) throw new repo.HttpError(404, 'Attachment not found');
  res.setHeader('Content-Type', att.mimeType);
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${safeName(att.filename)}"`);
  res.send(Buffer.from(att.data));
}));

// ----- Document exports -----
app.get('/api/protocols/:id/export/:format', need('study.read'), h(async (req, res) => {
  const bundle = repo.getBundle(p(req, 'id'));
  const format = p(req, 'format');
  const base = safeName(`${bundle.study.protocolNumber || 'protocol'}_v${bundle.protocol.version || 'draft'}`);
  const disposition = req.query.inline ? 'inline' : 'attachment';
  if (!['json', 'pdf', 'docx'].includes(format)) throw new repo.HttpError(400, 'Unknown export format');
  audit({ action: 'protocol.exported', entityType: 'protocol', entityId: bundle.protocol.id, studyId: bundle.study.id, next: { format, revision: bundle.protocol.revision } });
  if (format === 'json') {
    res.setHeader('Content-Disposition', `${disposition}; filename="${base}.json"`);
    return res.json(renderJson(bundle));
  }
  const model = buildDocModel(bundle);
  if (format === 'pdf') {
    const buf = await renderPdf(model);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${disposition}; filename="${base}.pdf"`);
    return res.send(buf);
  }
  const buf = await renderDocx(model);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${base}.docx"`);
  return res.send(buf);
}));

// ----- Protocol Digitisation -----
app.get('/api/digitisation/documents', need('study.read'), h((_req, res) => res.json(listSourceDocuments())));
app.post('/api/digitisation/upload', need('protocol.create'), express.raw({ type: () => true, limit: '30mb' }), h(async (req, res) => {
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || !body.length) throw new repo.HttpError(400, 'Empty upload');
  const filename = String(req.query.filename ?? 'document.txt');
  const result = await digitiseDocument(filename, String(req.headers['content-type'] ?? ''), body);
  recordCreation('protocol.digitised', result.protocolId, result.provenance, `Digitisation of ${filename}`);
  res.status(201).json(result);
}));

// OCR (PDF, scanned PDF and image documents) via the PaddleOCR service. Reads need study.read; any change needs protocol.create.
app.use('/api/ocr', (req, res, next) => need(['GET', 'HEAD'].includes(req.method) ? 'study.read' : 'protocol.create')(req, res, next), ocrRouter());

// ----- USDM mapping and data governance -----
app.use('/api/usdm', usdmRouter());
app.use('/api/governance', governanceRouter());

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// Production: serve the built client.
const dist = path.resolve(process.cwd(), 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use((err: Error & { status?: number; details?: unknown; record?: unknown; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof repo.HttpError ? err.status : err.type === 'entity.parse.failed' ? 400 : err.status ?? 500;
  if (status >= 500) console.error(err);
  const message = status >= 500 && !(err instanceof repo.HttpError) ? 'Server error' : err.message || 'Server error';
  res.status(status).json({ error: message, ...(err.details ? { details: err.details } : {}), ...(err.record ? { record: err.record } : {}) });
});

const port = Number(process.env.PORT ?? 4100);
if (process.env.PROTOCOLIQ_NO_LISTEN !== '1') {
  app.listen(port, () => console.log(`ProtocolIQ API listening on http://localhost:${port}`));
}

export { app };
