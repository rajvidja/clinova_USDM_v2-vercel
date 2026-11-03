import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { OcrDocument, OcrElement, OcrJobStatus, OcrResult, OcrTable } from '../shared/ocr.ts';

// The Node routes are tested against a stub of the hosted OCR service (same /v1 HTTP API, token and signed URLs),
// so these tests run without PaddleOCR installed.

const dir = mkdtempSync(join(tmpdir(), 'protocoliq-ocr-test-'));
process.env.PROTOCOLIQ_DB = join(dir, 'test.db');
process.env.PROTOCOLIQ_NO_LISTEN = '1';
process.env.OCR_API_TOKEN = 'test-token';

const soa: OcrTable = {
  rows: 4,
  cols: 4,
  headerRows: 2,
  cells: [
    { row: 0, col: 0, rowSpan: 2, colSpan: 1, text: 'Assessment', header: true },
    { row: 0, col: 1, rowSpan: 1, colSpan: 2, text: 'Treatment', header: true },
    { row: 0, col: 3, rowSpan: 2, colSpan: 1, text: 'Follow-up', header: true },
    { row: 1, col: 1, rowSpan: 1, colSpan: 1, text: 'Day 1', header: true },
    { row: 1, col: 2, rowSpan: 1, colSpan: 1, text: 'Week 4', header: true },
    { row: 2, col: 0, rowSpan: 1, colSpan: 1, text: 'Vital signs', header: false },
    { row: 2, col: 1, rowSpan: 1, colSpan: 1, text: 'X', header: false },
    { row: 2, col: 2, rowSpan: 1, colSpan: 1, text: 'X.', header: false, confidence: 0.6 },
    { row: 2, col: 3, rowSpan: 1, colSpan: 1, text: '', header: false },
    { row: 3, col: 0, rowSpan: 1, colSpan: 1, text: 'ECG a', header: false },
    { row: 3, col: 1, rowSpan: 1, colSpan: 1, text: 'X', header: false },
    { row: 3, col: 2, rowSpan: 1, colSpan: 1, text: '', header: false },
    { row: 3, col: 3, rowSpan: 1, colSpan: 1, text: 'X', header: false },
  ],
  caption: 'Table 2: Schedule of Activities',
  kind: 'schedule_of_activities',
  footnoteIds: ['p1-e4'],
  referencedBy: [],
};

function fakeResult(documentId: string, documentName: string): OcrResult {
  const el = (i: number, type: OcrElement['type'], text: string, extra: Partial<OcrElement> = {}): OcrElement => ({
    id: `p1-e${i}`,
    documentId,
    documentName,
    page: 1,
    order: i,
    type,
    text,
    bbox: [10, 10 + i * 50, 500, 40 + i * 50],
    confidence: 0.95,
    source: 'ocr',
    ...extra,
  });
  return {
    schemaVersion: 1,
    documentId,
    documentName,
    mimeType: 'image/png',
    pageCount: 1,
    pages: [{ page: 1, width: 600, height: 800, unit: 'px', method: 'ocr', classification: 'scanned', textChars: 0, imageCoverage: 1, image: null, imageWidth: 600, imageHeight: 800, meanConfidence: 0.95, durationMs: 10 }],
    elements: [
      el(0, 'heading', '1 INCLUSION CRITERIA', { level: 1 }),
      el(1, 'list_item', '1. Adults aged 18 years or older.'),
      el(2, 'caption', 'Table 2: Schedule of Activities'),
      el(3, 'table', 'Assessment | Treatment', { table: soa }),
      el(4, 'footnote', 'a. ECG performed in triplicate.'),
      el(5, 'page_number', 'Page 1 of 1'),
    ],
    engine: { name: 'stub' },
    options: {},
    createdAt: new Date().toISOString(),
  };
}

let stub: Server;
let base = '';
let close: () => void = () => {};
const stubCalls: string[] = [];

before(async () => {
  const files = new Map<string, Buffer>();
  const results = new Map<string, OcrResult>();
  stub = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://stub');
      stubCalls.push(`${req.method} ${url.pathname}`);
      const send = (code: number, payload: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (url.pathname === '/health') return send(200, { ok: true, warming: false, device: 'cpu' });
      const m = /^\/v1\/documents\/([^/]+)(\/.*)?$/.exec(url.pathname);
      if (!m) return send(404, { detail: 'not found' });
      const [, id, rest = ''] = m;
      if (rest === '/file' && req.method === 'PUT') {
        const sig = createHmac('sha256', 'test-token').update(`upload:${id}:${url.searchParams.get('ext')}:${url.searchParams.get('exp')}`).digest('hex');
        if (sig !== url.searchParams.get('sig')) return send(403, { detail: 'bad signature' });
        files.set(id, Buffer.concat(chunks));
        return send(200, { size: files.get(id)!.length });
      }
      if (req.headers.authorization !== 'Bearer test-token') return send(401, { detail: 'token' });
      const data = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      if (rest === '/inspect') {
        if (!files.has(id)) return send(404, { detail: 'Document not found' });
        return send(200, { pageCount: 1, kind: 'image', size: files.get(id)!.length, pages: [{ page: 1, classification: 'scanned', textChars: 0, imageCoverage: 1, image: null }] });
      }
      const now = new Date().toISOString();
      const done: OcrJobStatus = { documentId: id, status: 'completed', stage: 'done', message: 'Processed 1 page(s)', pagesDone: 1, pageCount: 1, currentPage: null, pageErrors: [], startedAt: now, updatedAt: now, finishedAt: now };
      if (rest === '/jobs' && req.method === 'POST') {
        results.set(id, fakeResult(id, data.document_name));
        return send(202, done);
      }
      if (rest === '/status') return results.has(id) ? send(200, done) : send(404, { detail: 'not processed' });
      if (rest === '/result') return results.has(id) ? send(200, results.get(id)) : send(404, { detail: 'no result' });
      if (req.method === 'DELETE' && rest === '') {
        files.delete(id);
        results.delete(id);
        res.writeHead(204).end();
        return;
      }
      send(404, { detail: 'not found' });
    });
  });
  stub.listen(0, '127.0.0.1');
  await new Promise((r) => stub.once('listening', r));
  process.env.OCR_SERVICE_URL = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;

  const { app } = await import('../server/index.ts');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  close = () => server.close();
});

after(() => {
  close();
  stub.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call<T>(path: string, init?: RequestInit, expected = 200): Promise<T> {
  const res = await fetch(base + path, { headers: { 'content-type': 'application/json' }, ...init });
  assert.equal(res.status, expected, `${init?.method ?? 'GET'} ${path} → ${res.status}`);
  if (res.status === 204) return undefined as T;
  return (res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text()) as T;
}

const png = readFileSync(new URL('./fixtures/ocr/soa-page.png', import.meta.url));
async function upload(name: string, body: Buffer, process = false) {
  const reg = await fetch(`${base}/ocr/uploads`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filename: name, size: body.length }) });
  if (reg.status !== 201) return reg;
  const { documentId, uploadUrl } = (await reg.json()) as { documentId: string; uploadUrl: string };
  const put = await fetch(uploadUrl, { method: 'PUT', body: new Blob([new Uint8Array(body)]) });
  assert.equal(put.status, 200, 'signed upload accepted');
  return fetch(`${base}/ocr/uploads/${documentId}/complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ process }) });
}

test('upload registration rejects unsupported types, empty and oversized files', async () => {
  assert.equal((await upload('notes.docx', png)).status, 415);
  assert.equal((await upload('empty.png', Buffer.alloc(0))).status, 400);
  const big = await fetch(`${base}/ocr/uploads`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filename: 'huge.pdf', size: 10 * 1024 ** 3 }) });
  assert.equal(big.status, 413);
});

test('upload links are signed for one document and file type', async () => {
  const reg = await call<{ documentId: string; uploadUrl: string }>('/ocr/uploads', { method: 'POST', body: JSON.stringify({ filename: 'a.pdf', size: 10 }) }, 201);
  const url = new URL(reg.uploadUrl);
  assert.equal(url.searchParams.get('ext'), '.pdf');
  url.searchParams.set('ext', '.png');
  assert.equal((await fetch(url, { method: 'PUT', body: 'x' })).status, 403, 'changing the file type breaks the signature');
  await call(`/ocr/documents/${reg.documentId}`, { method: 'DELETE' }, 204);
});

let docId = '';

test('upload stores the file in the existing document registry and processes it', async () => {
  const res = await upload('soa page.png', png, true);
  assert.equal(res.status, 200);
  const doc = (await res.json()) as OcrDocument;
  docId = doc.id;
  assert.equal(doc.filename, 'soa page.png');
  assert.equal(doc.pageCount, 1);
  assert.equal(doc.inspection?.pages[0].classification, 'scanned');
  assert.equal(doc.size, png.length, 'size comes from the stored file');
  assert.ok(stubCalls.includes(`PUT /v1/documents/${docId}/file`), 'the file went straight to the OCR service');

  const status = await call<OcrJobStatus>(`/ocr/status/${docId}`);
  assert.equal(status.status, 'completed');

  const history = await call<{ id: string; kind: string; ocrStatus: string; report: unknown }[]>('/digitisation/documents');
  const entry = history.find((d) => d.id === docId);
  assert.equal(entry?.kind, 'ocr', 'OCR uploads share the digitisation document list');
  assert.equal(entry?.ocrStatus, 'completed');
  assert.equal(entry?.report, null);
});

test('results, tables and markdown preserve structure', async () => {
  const result = await call<OcrResult>(`/ocr/results/${docId}`);
  assert.equal(result.elements.length, 6);
  assert.ok(result.elements.every((e) => e.documentId === docId && e.page === 1));

  const tables = await call<{ id: string; table: OcrTable }[]>(`/ocr/tables/${docId}`);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].table.kind, 'schedule_of_activities');
  assert.equal(tables[0].table.cells.find((c) => c.text === 'Treatment')?.colSpan, 2);

  const md = await call<string>(`/ocr/results/${docId}?format=markdown`);
  assert.match(md, /<th colspan="2">Treatment<\/th>/);
  assert.match(md, /<th rowspan="2">Assessment<\/th>/);
  assert.equal(md.match(/Table 2: Schedule of Activities/g)?.length, 1, 'caption is not duplicated');
  assert.doesNotMatch(md, /Page 1 of 1/, 'page numbers are left out of the markdown');

  const download = await fetch(`${base}/ocr/results/${docId}?download=1`);
  assert.match(download.headers.get('content-disposition') ?? '', /soa%20page\.ocr\.json/);
});

test('manual corrections are stored separately and merged on read', async () => {
  await call(`/ocr/results/${docId}/elements/p1-e1`, { method: 'PUT', body: JSON.stringify({ text: '1. Adults aged ≥18 years.' }) });
  const table = { ...soa, cells: soa.cells.map((c) => (c.text === 'X.' ? { ...c, text: 'X' } : c)) };
  await call(`/ocr/results/${docId}/elements/p1-e3`, { method: 'PUT', body: JSON.stringify({ table }) });
  await call(`/ocr/results/${docId}/elements/p1-e3`, { method: 'PUT', body: JSON.stringify({ table: { cells: [{ row: 'a' }] } }) }, 400);
  await call(`/ocr/results/${docId}/elements/p1-e0`, { method: 'PUT', body: JSON.stringify({ table }) }, 400);
  await call(`/ocr/results/${docId}/elements/nope`, { method: 'PUT', body: JSON.stringify({ text: 'x' }) }, 404);

  const merged = await call<OcrResult>(`/ocr/results/${docId}`);
  assert.ok(merged.correctedAt);
  assert.equal(merged.elements[1].text, '1. Adults aged ≥18 years.');
  assert.equal(merged.elements[1].corrected, true);
  assert.ok(!merged.elements[3].table!.cells.some((c) => c.text === 'X.'));

  const raw = await call<OcrResult>(`/ocr/results/${docId}?raw=1`);
  assert.equal(raw.elements[1].text, '1. Adults aged 18 years or older.', 'raw output is untouched');

  const reverted = await call<OcrElement>(`/ocr/results/${docId}/elements/p1-e1`, { method: 'DELETE' });
  assert.equal(reverted.text, '1. Adults aged 18 years or older.');
});

test('OCR output feeds the existing rule-based digitisation', async () => {
  const { protocolId, report } = await call<{ protocolId: string; report: { blockCount: number } }>(`/ocr/documents/${docId}/digitise`, { method: 'POST', body: '{}' }, 201);
  assert.ok(protocolId);
  assert.ok(report.blockCount > 0);
  const doc = await call<OcrDocument>(`/ocr/documents/${docId}`);
  assert.equal(doc.protocolId, protocolId);
  const history = await call<{ id: string; protocolId: string }[]>('/digitisation/documents');
  assert.equal(history.filter((d) => d.id === docId).length, 1, 'no duplicate document record is created');
});

test('reprocessing discards corrections unless asked to keep them', async () => {
  await call(`/ocr/results/${docId}/elements/p1-e1`, { method: 'PUT', body: JSON.stringify({ text: 'edited' }) });
  await call(`/ocr/process/${docId}`, { method: 'POST', body: JSON.stringify({ keepCorrections: true, mode: 'text', dpi: 9999 }) }, 202);
  assert.equal((await call<OcrResult>(`/ocr/results/${docId}`)).elements[1].text, 'edited');
  await call(`/ocr/process/${docId}`, { method: 'POST', body: '{}' }, 202);
  assert.equal((await call<OcrResult>(`/ocr/results/${docId}`)).elements[1].text, '1. Adults aged 18 years or older.');
});

test('a stopped OCR service gives a clear 503', async () => {
  await new Promise((r) => {
    stub.close(r);
    stub.closeAllConnections();
  });
  const { documentId } = await call<{ documentId: string }>('/ocr/uploads', { method: 'POST', body: JSON.stringify({ filename: 'later.png', size: png.length }) }, 201);
  const complete = await fetch(`${base}/ocr/uploads/${documentId}/complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(complete.status, 503);
  assert.match((await complete.json()).error, /not reachable/);
  assert.equal((await call<{ ok: boolean }>('/ocr/health')).ok, false);

  await call(`/ocr/documents/${documentId}`, { method: 'DELETE' }, 204);
  await call(`/ocr/documents/${documentId}`, undefined, 404);
});
