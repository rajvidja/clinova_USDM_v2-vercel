import type {
  Attachment,
  FieldDef,
  FieldType,
  Protocol,
  ProtocolBundle,
  ProtocolStatus,
  ProtocolSummary,
  ProtocolTemplate,
  ProtocolVersionEntry,
  SaveRequest,
  SaveResponse,
  Study,
  ValidationReport,
} from '../../shared/types';
import { OCR_FORMATS, type OcrCorrection, type OcrDocument, type OcrElement, type OcrJobStatus, type OcrResult, type OcrStatus } from '../../shared/ocr';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = (await res.json()).error ?? message;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export interface DashboardStats {
  studies: number;
  protocols: number;
  builder: number;
  digitised: number;
  drafts: number;
  final: number;
  recent: ProtocolSummary[];
  recentDocuments: { id: string; filename: string; protocolId: string; uploadedAt: string }[];
}

export interface DigitisationReport {
  filename: string;
  blockCount: number;
  headingCount: number;
  metadata: Record<string, string>;
  mapped: { sourceHeading: string; templateKey: string; subsectionNumber: string; subsectionTitle: string; items: number }[];
  unmapped: { heading: string; preview: string; blocks: number }[];
  counts: { objectives: number; endpoints: number; inclusion: number; exclusion: number };
  notes: string[];
}

export const api = {
  dashboard: () => request<DashboardStats>('/api/dashboard'),
  templates: () => request<ProtocolTemplate[]>('/api/templates'),
  studies: () => request<(Study & { protocols: ProtocolSummary[] })[]>('/api/studies'),
  protocols: () => request<ProtocolSummary[]>('/api/protocols'),
  createProtocol: (body: Record<string, string>) => request<{ id: string }>('/api/protocols', json('POST', body)),
  bundle: (id: string, open = false) => request<ProtocolBundle>(`/api/protocols/${id}${open ? '?open=1' : ''}`),
  save: (id: string, body: SaveRequest, keepalive = false) => request<SaveResponse>(`/api/protocols/${id}/save`, { ...json('POST', body), keepalive }),
  setStatus: (id: string, status: ProtocolStatus) => request<Protocol>(`/api/protocols/${id}/status`, json('PATCH', { status })),
  deleteProtocol: (id: string) => request<void>(`/api/protocols/${id}`, { method: 'DELETE' }),
  duplicate: (id: string, mode: 'new-study' | 'new-version') => request<{ id: string }>(`/api/protocols/${id}/duplicate`, json('POST', { mode })),
  validation: (id: string) => request<ValidationReport>(`/api/protocols/${id}/validation`),
  addSubsection: (id: string, sectionId: string, title: string, contentType: FieldType, afterId?: string) =>
    request<{ id: string }>(`/api/protocols/${id}/sections/${sectionId}/subsections`, json('POST', { title, contentType, afterId })),
  updateSubsection: (subId: string, patch: { title?: string; fields?: FieldDef[] }) => request<void>(`/api/subsections/${subId}`, json('PATCH', patch)),
  deleteSubsection: (subId: string) => request<void>(`/api/subsections/${subId}`, { method: 'DELETE' }),
  duplicateSubsection: (subId: string) => request<{ id: string }>(`/api/subsections/${subId}/duplicate`, json('POST', {})),
  moveSubsection: (subId: string, direction: 'up' | 'down') => request<void>(`/api/subsections/${subId}/move`, json('POST', { direction })),
  versions: (id: string) => request<ProtocolVersionEntry[]>(`/api/protocols/${id}/versions`),
  createVersion: (id: string, note: string) => request<ProtocolVersionEntry>(`/api/protocols/${id}/versions`, json('POST', { note })),
  restoreVersion: (id: string, vid: string) => request<void>(`/api/protocols/${id}/versions/${vid}/restore`, json('POST', {})),
  uploadAttachment: (id: string, subsectionId: string, file: File) =>
    request<Attachment>(`/api/protocols/${id}/attachments?filename=${encodeURIComponent(file.name)}&subsectionId=${subsectionId}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    }),
  digitise: (file: File) =>
    request<{ protocolId: string; report: DigitisationReport }>(`/api/digitisation/upload?filename=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    }),
  sourceDocuments: () =>
    request<
      { id: string; kind: 'parsed' | 'ocr'; ocrStatus: OcrStatus | null; pageCount: number | null; protocolId: string | null; filename: string; size: number; uploadedAt: string; report: DigitisationReport | null }[]
    >('/api/digitisation/documents'),
};

export interface OcrProcessOptions {
  mode?: 'structure' | 'text';
  forceOcr?: boolean;
  autoRotate?: boolean;
  ocrEmbeddedImages?: boolean;
  dpi?: number;
  device?: string;
  keepCorrections?: boolean;
}

export interface OcrHealth {
  configured?: boolean;
  serviceUrl?: string;
  ok?: boolean;
  warming?: boolean;
  device?: string;
  profile?: string;
  modelsDownloaded?: string[];
  activeJobs?: number;
  versions?: Record<string, string>;
  error?: string;
}

export const ocrApi = {
  health: () => request<OcrHealth>('/api/ocr/health'),
  document: (id: string) => request<OcrDocument>(`/api/ocr/documents/${id}`),
  /** Registers the document, uploads the file straight to the OCR service through a signed URL, then starts processing. */
  upload: async (file: File, process = true) => {
    const { documentId, uploadUrl } = await request<{ documentId: string; uploadUrl: string }>('/api/ocr/uploads', json('POST', { filename: file.name, size: file.size }));
    try {
      let res: Response;
      try {
        res = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      } catch {
        throw new ApiError(503, 'The upload to the OCR service failed. Check that the service is running and allows this site (OCR_CORS_ORIGINS).');
      }
      if (!res.ok) throw new ApiError(res.status, ((await res.json().catch(() => ({}))) as { detail?: string }).detail ?? 'Upload failed');
    } catch (e) {
      await fetch(`/api/ocr/documents/${documentId}`, { method: 'DELETE' }).catch(() => undefined);
      throw e;
    }
    return request<OcrDocument>(`/api/ocr/uploads/${documentId}/complete`, json('POST', { process }));
  },
  process: (id: string, options: OcrProcessOptions = {}) => request<OcrJobStatus>(`/api/ocr/process/${id}`, json('POST', options)),
  cancel: (id: string) => request<OcrJobStatus>(`/api/ocr/cancel/${id}`, json('POST', {})),
  status: (id: string) => request<OcrJobStatus>(`/api/ocr/status/${id}`),
  results: (id: string) => request<OcrResult>(`/api/ocr/results/${id}`),
  correct: (id: string, elementId: string, body: OcrCorrection) => request<OcrElement>(`/api/ocr/results/${id}/elements/${encodeURIComponent(elementId)}`, json('PUT', body)),
  revert: (id: string, elementId: string) => request<OcrElement | null>(`/api/ocr/results/${id}/elements/${encodeURIComponent(elementId)}`, { method: 'DELETE' }),
  digitise: (id: string) => request<{ protocolId: string; report: DigitisationReport }>(`/api/ocr/documents/${id}/digitise`, json('POST', {})),
  remove: (id: string) => request<void>(`/api/ocr/documents/${id}`, { method: 'DELETE' }),
};

export const ocrPageImageUrl = (id: string, page: number, version = '') => `/api/ocr/documents/${id}/pages/${page}/image${version ? `?v=${encodeURIComponent(version)}` : ''}`;
export const ocrFileUrl = (id: string) => `/api/ocr/documents/${id}/file`;
export const ocrExportUrl = (id: string, format: 'json' | 'markdown') => `/api/ocr/results/${id}?download=1${format === 'markdown' ? '&format=markdown' : ''}`;
export const isOcrFile = (name: string) => (OCR_FORMATS as readonly string[]).includes(name.slice(name.lastIndexOf('.')).toLowerCase());

export const exportUrl = (id: string, format: 'pdf' | 'docx' | 'json', inline = false) => `/api/protocols/${id}/export/${format}${inline ? '?inline=1' : ''}`;
export const attachmentUrl = (id: string, download = false) => `/api/attachments/${id}${download ? '?download=1' : ''}`;
