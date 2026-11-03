import { createHmac } from 'node:crypto';
import path from 'node:path';
import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  applyCorrections,
  ocrToMarkdown,
  tableText,
  type OcrCorrection,
  type OcrDocument,
  type OcrInspection,
  type OcrJobStatus,
  type OcrResult,
  type OcrStatus,
  type OcrTable,
} from '../shared/ocr.ts';
import { db } from './db.ts';
import { digitiseBlocks, type Block } from './digitise.ts';
import { recordCreation } from './governance/lineage.ts';
import { HttpError, uid } from './repo.ts';

// OCR documents are registered in source_documents (kind = 'ocr'). The PaddleOCR service (ocr_service/) runs on its
// own host and stores the original files and OCR output; this API keeps the document records and manual corrections.
// Browsers upload originals and load page images directly from the service through short-lived signed URLs, so large
// files never pass through this API (serverless request bodies are limited to a few MB).

const DEV_TOKEN = 'protocoliq-local-dev-token';
const OCR_URL = (process.env.OCR_SERVICE_URL ?? (process.env.VERCEL ? '' : 'http://127.0.0.1:4200')).replace(/\/$/, '');
const PUBLIC_URL = (process.env.OCR_PUBLIC_URL ?? OCR_URL).replace(/\/$/, '');
const TOKEN = process.env.OCR_API_TOKEN ?? (/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(OCR_URL) ? DEV_TOKEN : '');
const CONFIGURED = Boolean(OCR_URL && TOKEN);
const MAX_UPLOAD_MB = Number(process.env.OCR_MAX_UPLOAD_MB ?? 200);
const UPLOAD_LINK_SECONDS = 15 * 60;
const READ_LINK_SECONDS = 60 * 60;
const NOT_CONFIGURED = 'OCR is not configured for this deployment. Set OCR_SERVICE_URL and OCR_API_TOKEN to the hosted OCR service (see README).';

const FORMATS: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};

interface DocRow {
  id: string;
  filename: string;
  mime_type: string;
  size: number;
  uploaded_at: string;
  storage_path: string;
  ocr_status: OcrStatus;
  ocr_error: string | null;
  page_count: number | null;
  inspection_json: string | null;
  linked_protocol_id: string | null;
}

function getRow(id: string): DocRow {
  const row = db.prepare(`SELECT * FROM source_documents WHERE id = ? AND kind = 'ocr'`).get(id) as DocRow | undefined;
  if (!row) throw new HttpError(404, 'OCR document not found');
  return row;
}

async function service<T>(route: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  if (!CONFIGURED) throw new HttpError(503, NOT_CONFIGURED);
  let res: globalThis.Response;
  try {
    res = await fetch(OCR_URL + route, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
    });
  } catch (e) {
    const reason = (e as Error).name === 'TimeoutError' ? 'did not respond in time' : 'is not reachable';
    throw new HttpError(503, `The OCR service ${reason} at ${OCR_URL}. Check that it is running (locally: "npm run dev:ocr").`);
  }
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => ({}))) as { detail?: unknown };
  if (!res.ok) {
    if (res.status === 401) throw new HttpError(502, 'The OCR service rejected the API token. OCR_API_TOKEN must match on both sides.');
    const detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail ?? body);
    throw new HttpError(res.status >= 500 ? 502 : res.status, detail);
  }
  return body as T;
}

function signedUrl(scope: 'upload' | 'read', id: string, route: string, ttl: number, extra = '', query: Record<string, string> = {}) {
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const sig = createHmac('sha256', TOKEN).update(`${scope}:${id}:${extra}:${exp}`).digest('hex');
  return `${PUBLIC_URL}/v1/documents/${id}${route}?${new URLSearchParams({ ...query, exp: String(exp), sig })}`;
}

function setStatus(id: string, status: OcrStatus, error: string | null = null) {
  db.prepare(`UPDATE source_documents SET ocr_status = ?, ocr_error = ? WHERE id = ?`).run(status, error, id);
}

const ACTIVE: OcrStatus[] = ['queued', 'processing'];

async function jobStatus(row: DocRow): Promise<OcrJobStatus | null> {
  if (row.ocr_status === 'uploaded' || !CONFIGURED) return null;
  const status = await service<OcrJobStatus>(`/v1/documents/${row.id}/status`, { timeoutMs: 8000 }).catch((e: HttpError) => {
    if (e.status === 404) return null;
    throw e;
  });
  if (status && status.status !== row.ocr_status) {
    setStatus(row.id, status.status, status.status === 'failed' ? status.message : null);
    row.ocr_status = status.status;
  }
  return status;
}

async function toDocument(row: DocRow, { live = true } = {}): Promise<OcrDocument> {
  let job: OcrJobStatus | null = null;
  let error = row.ocr_error;
  if (live) {
    try {
      job = await jobStatus(row);
    } catch (e) {
      error = (e as Error).message;
    }
  }
  const protocolExists = row.linked_protocol_id ? !!db.prepare(`SELECT 1 FROM protocols WHERE id = ?`).get(row.linked_protocol_id) : false;
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mime_type,
    size: row.size,
    uploadedAt: row.uploaded_at,
    status: row.ocr_status,
    pageCount: row.page_count,
    error: row.ocr_status === 'failed' ? (job?.message ?? error) : error,
    protocolId: protocolExists ? row.linked_protocol_id : null,
    inspection: row.inspection_json ? (JSON.parse(row.inspection_json) as OcrInspection) : null,
    job,
  };
}

async function inspect(row: DocRow): Promise<OcrInspection> {
  const inspection = await service<OcrInspection & { size: number }>(`/v1/documents/${row.id}/inspect`, { method: 'POST', timeoutMs: 120_000 }).catch((e: HttpError) => {
    if (e.status === 404) throw new HttpError(409, 'The file has not been uploaded to the OCR service yet (or it has expired). Upload it again.');
    throw e;
  });
  db.prepare(`UPDATE source_documents SET inspection_json = ?, page_count = ?, size = ?, ocr_error = NULL WHERE id = ?`).run(
    JSON.stringify({ pageCount: inspection.pageCount, kind: inspection.kind, pages: inspection.pages }),
    inspection.pageCount,
    inspection.size,
    row.id,
  );
  return inspection;
}

async function startJob(row: DocRow, options: Record<string, unknown>) {
  if (ACTIVE.includes(row.ocr_status)) {
    const live = await jobStatus(row);
    if (live && ACTIVE.includes(live.status)) throw new HttpError(409, 'This document is already being processed.');
  }
  const status = await service<OcrJobStatus>(`/v1/documents/${row.id}/jobs`, {
    method: 'POST',
    body: JSON.stringify({ document_name: row.filename, mime_type: row.mime_type, options }),
  });
  setStatus(row.id, status.status);
  return status;
}

function corrections(id: string) {
  const rows = db.prepare(`SELECT element_id, text, table_json, updated_at FROM ocr_corrections WHERE document_id = ?`).all(id) as {
    element_id: string;
    text: string | null;
    table_json: string | null;
    updated_at: string;
  }[];
  return new Map(
    rows.map((r) => [
      r.element_id,
      { ...(r.text !== null ? { text: r.text } : {}), ...(r.table_json ? { table: JSON.parse(r.table_json) as OcrTable } : {}), updatedAt: r.updated_at },
    ]),
  );
}

async function loadResult(id: string, { raw = false } = {}): Promise<OcrResult> {
  const result = await service<OcrResult>(`/v1/documents/${id}/result`, { timeoutMs: 60_000 }).catch((e: HttpError) => {
    if (e.status === 404) throw new HttpError(409, 'No OCR results yet. Process the document first.');
    throw e;
  });
  return raw ? result : applyCorrections(result, corrections(id));
}

/** OCR elements → digitisation blocks, so the existing rule-based template mapping can consume OCR output. */
function toBlocks(result: OcrResult): Block[] {
  const blocks: Block[] = [];
  const ordered = [...result.elements].sort((a, b) => a.page - b.page || a.order - b.order);
  for (const el of ordered) {
    const text = el.text.replace(/\s+/g, ' ').trim();
    switch (el.type) {
      case 'title':
      case 'heading':
        if (text) blocks.push({ kind: 'heading', text, level: el.level ?? undefined, page: el.page });
        break;
      case 'list_item':
        if (text) blocks.push({ kind: 'item', text, page: el.page });
        break;
      case 'paragraph':
      case 'reference':
      case 'caption':
      case 'footnote':
        if (text) blocks.push({ kind: 'para', text, page: el.page });
        break;
      case 'table': {
        if (!el.table) break;
        const rows = tableText(el.table).split('\n');
        rows.forEach((r, i) => blocks.push({ kind: 'para', text: r, tableHeader: i < el.table!.headerRows || undefined, page: el.page }));
        break;
      }
      default:
        break;
    }
  }
  return blocks;
}

function safeName(name: string) {
  return path.basename(name).replace(/[^\w.\- ()]+/g, '_').slice(0, 180) || 'document';
}

type Handler = (req: Request, res: Response) => unknown;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res)).catch(next);
const param = (req: Request, key: string) => String(req.params[key]);

export function ocrRouter(): Router {
  const r = Router();

  r.get('/health', h(async (_req, res) => {
    if (!CONFIGURED) return res.json({ ok: false, configured: false, error: NOT_CONFIGURED });
    const health = await service<Record<string, unknown>>('/health', { timeoutMs: 8000 }).catch((e: Error) => ({ ok: false, error: e.message }));
    res.json({ configured: true, serviceUrl: OCR_URL, ...health });
  }));

  r.get('/documents', h(async (_req, res) => {
    const rows = db.prepare(`SELECT * FROM source_documents WHERE kind = 'ocr' ORDER BY uploaded_at DESC`).all() as unknown as DocRow[];
    res.json(await Promise.all(rows.map((row) => toDocument(row, { live: false }))));
  }));

  r.get('/documents/:id', h(async (req, res) => res.json(await toDocument(getRow(param(req, 'id'))))));

  // Step 1 of an upload: register the document and hand the browser a signed upload URL on the OCR service.
  r.post('/uploads', h((req, res) => {
    if (!CONFIGURED) throw new HttpError(503, NOT_CONFIGURED);
    const filename = safeName(String(req.body?.filename ?? ''));
    const ext = path.extname(filename).toLowerCase();
    const mime = FORMATS[ext];
    if (!mime) throw new HttpError(415, `Unsupported file type "${ext || 'none'}". OCR accepts PDF, PNG, JPG/JPEG and TIFF.`);
    const size = Number(req.body?.size ?? 0);
    if (!size) throw new HttpError(400, 'Empty upload');
    if (size > MAX_UPLOAD_MB * 1024 * 1024) throw new HttpError(413, `The file is larger than ${MAX_UPLOAD_MB} MB.`);
    const id = uid();
    db.prepare(
      `INSERT INTO source_documents (id, filename, mime_type, size, parse_report_json, uploaded_at, kind, storage_path, ocr_status)
       VALUES (?, ?, ?, ?, 'null', ?, 'ocr', ?, 'uploaded')`,
    ).run(id, filename, mime, size, new Date().toISOString(), `ocr-service:${id}`);
    res.status(201).json({ documentId: id, uploadUrl: signedUrl('upload', id, '/file', UPLOAD_LINK_SECONDS, ext, { ext }), method: 'PUT' });
  }));

  // Step 2: the browser finished uploading; inspect the file and optionally start processing.
  r.post('/uploads/:id/complete', h(async (req, res) => {
    const row = getRow(param(req, 'id'));
    await inspect(row);
    if (req.body?.process === true) {
      try {
        await startJob(getRow(row.id), {});
      } catch (e) {
        db.prepare(`UPDATE source_documents SET ocr_error = ? WHERE id = ?`).run((e as Error).message, row.id);
      }
    }
    res.json(await toDocument(getRow(row.id)));
  }));

  r.post('/process/:id', h(async (req, res) => {
    const row = getRow(param(req, 'id'));
    if (!row.inspection_json) await inspect(row);
    const { mode, forceOcr, dpi, ocrEmbeddedImages, autoRotate, device, keepCorrections } = (req.body ?? {}) as Record<string, unknown>;
    const options: Record<string, unknown> = {};
    if (mode === 'structure' || mode === 'text') options.mode = mode;
    if (typeof forceOcr === 'boolean') options.force_ocr = forceOcr;
    if (typeof ocrEmbeddedImages === 'boolean') options.ocr_embedded_images = ocrEmbeddedImages;
    if (typeof autoRotate === 'boolean') options.auto_rotate = autoRotate;
    if (typeof dpi === 'number' && dpi >= 72 && dpi <= 400) options.dpi = Math.round(dpi);
    if (typeof device === 'string' && /^(auto|cpu|gpu(:\d+)?)$/.test(device)) options.device = device;
    const status = await startJob(getRow(row.id), options);
    // Element ids can change between runs, so manual corrections only survive a reprocess when asked to.
    if (keepCorrections !== true) db.prepare(`DELETE FROM ocr_corrections WHERE document_id = ?`).run(row.id);
    res.status(202).json(status);
  }));

  r.post('/cancel/:id', h(async (req, res) => {
    const row = getRow(param(req, 'id'));
    res.json(await service<OcrJobStatus>(`/v1/documents/${row.id}/cancel`, { method: 'POST' }));
  }));

  r.get('/status/:id', h(async (req, res) => {
    const row = getRow(param(req, 'id'));
    const job = await jobStatus(row);
    res.json(
      job ?? {
        documentId: row.id,
        status: row.ocr_status,
        stage: 'idle',
        message: row.ocr_error ?? 'Not processed yet',
        pagesDone: 0,
        pageCount: row.page_count ?? 0,
        currentPage: null,
        pageErrors: [],
        startedAt: null,
        updatedAt: row.uploaded_at,
        finishedAt: null,
      },
    );
  }));

  r.get('/results/:id', h(async (req, res) => {
    const id = getRow(param(req, 'id')).id;
    const result = await loadResult(id, { raw: req.query.raw === '1' });
    const format = String(req.query.format ?? 'json');
    const base = path.parse(result.documentName).name;
    if (format === 'markdown' || format === 'md') {
      if (req.query.download === '1') res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(base)}.ocr.md"`);
      res.type('text/markdown; charset=utf-8').send(ocrToMarkdown(result));
      return;
    }
    if (req.query.page) {
      const page = Number(req.query.page);
      res.json({ ...result, pages: result.pages.filter((p) => p.page === page), elements: result.elements.filter((e) => e.page === page) });
      return;
    }
    if (req.query.download === '1') res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(base)}.ocr.json"`);
    res.json(result);
  }));

  r.get('/tables/:id', h(async (req, res) => {
    const result = await loadResult(getRow(param(req, 'id')).id);
    res.json(
      result.elements
        .filter((e) => e.type === 'table' && e.table)
        .map((e) => ({ id: e.id, documentId: e.documentId, documentName: e.documentName, page: e.page, bbox: e.bbox, confidence: e.confidence, source: e.source, corrected: !!e.corrected, table: e.table })),
    );
  }));

  r.put('/results/:id/elements/:elementId', h(async (req, res) => {
    const id = getRow(param(req, 'id')).id;
    const elementId = param(req, 'elementId');
    const raw = await loadResult(id, { raw: true });
    const original = raw.elements.find((e) => e.id === elementId);
    if (!original) throw new HttpError(404, 'Element not found');
    const body = (req.body ?? {}) as OcrCorrection;
    const text = typeof body.text === 'string' ? body.text : null;
    let table: OcrTable | null = null;
    if (body.table) {
      if (!original.table) throw new HttpError(400, 'This element is not a table');
      const t = body.table;
      if (!Array.isArray(t.cells) || !t.cells.every((c) => Number.isInteger(c.row) && Number.isInteger(c.col) && typeof c.text === 'string')) {
        throw new HttpError(400, 'Invalid table structure');
      }
      table = { ...original.table, ...t, cells: t.cells.map((c) => ({ ...c, rowSpan: Math.max(1, c.rowSpan ?? 1), colSpan: Math.max(1, c.colSpan ?? 1), header: !!c.header })) };
    }
    if (text === null && !table) throw new HttpError(400, 'Provide corrected text or table');
    db.prepare(
      `INSERT INTO ocr_corrections (document_id, element_id, text, table_json, updated_at) VALUES (?,?,?,?,?)
       ON CONFLICT(document_id, element_id) DO UPDATE SET text = COALESCE(excluded.text, text), table_json = COALESCE(excluded.table_json, table_json), updated_at = excluded.updated_at`,
    ).run(id, elementId, text, table ? JSON.stringify(table) : null, new Date().toISOString());
    res.json(applyCorrections(raw, corrections(id)).elements.find((e) => e.id === elementId));
  }));

  r.delete('/results/:id/elements/:elementId', h(async (req, res) => {
    const id = getRow(param(req, 'id')).id;
    db.prepare(`DELETE FROM ocr_corrections WHERE document_id = ? AND element_id = ?`).run(id, param(req, 'elementId'));
    res.json((await loadResult(id)).elements.find((e) => e.id === param(req, 'elementId')) ?? null);
  }));

  r.get('/documents/:id/file', h((req, res) => {
    const row = getRow(param(req, 'id'));
    if (!CONFIGURED) throw new HttpError(503, NOT_CONFIGURED);
    res.redirect(302, signedUrl('read', row.id, '/file', READ_LINK_SECONDS));
  }));

  r.get('/documents/:id/pages/:page/image', h((req, res) => {
    const row = getRow(param(req, 'id'));
    const page = Number(param(req, 'page'));
    if (!Number.isInteger(page) || page < 1 || (row.page_count && page > row.page_count)) throw new HttpError(404, 'Page not found');
    if (!CONFIGURED) throw new HttpError(503, NOT_CONFIGURED);
    res.redirect(302, signedUrl('read', row.id, `/pages/${page}/image`, READ_LINK_SECONDS, '', req.query.v ? { v: String(req.query.v) } : {}));
  }));

  r.post('/documents/:id/digitise', h(async (req, res) => {
    const row = getRow(param(req, 'id'));
    const blocks = toBlocks(await loadResult(row.id));
    if (!blocks.length) throw new HttpError(422, 'The OCR result contains no text to structure.');
    const result = digitiseBlocks(blocks, { filename: row.filename, mimeType: row.mime_type, size: row.size, sourceDocumentId: row.id });
    recordCreation('protocol.digitised', result.protocolId, result.provenance, `OCR digitisation of ${row.filename}`);
    res.status(201).json(result);
  }));

  r.delete('/documents/:id', h(async (req, res) => {
    const row = getRow(param(req, 'id'));
    if (CONFIGURED) await service(`/v1/documents/${row.id}`, { method: 'DELETE', timeoutMs: 8000 }).catch(() => null);
    db.prepare(`DELETE FROM source_documents WHERE id = ?`).run(row.id);
    res.status(204).end();
  }));

  return r;
}
