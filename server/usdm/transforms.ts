import { escapeHtml, richTextToPlain, sanitizeRichText } from '../../shared/richtext.ts';
import type { FieldDef, ReferenceItem, TableValue } from '../../shared/types.ts';

// Deterministic value transformations used by 'direct' and 'value' mapping rules. Each returns either a value or a
// reason it could not convert; nothing is guessed.

export type TransformResult = { ok: true; value: unknown; note?: string } | { ok: false; status: 'empty' | 'unconverted'; message: string };

const ok = (value: unknown, note?: string): TransformResult => ({ ok: true, value, note });
const empty = (message = 'No value recorded'): TransformResult => ({ ok: false, status: 'empty', message });
const fail = (message: string): TransformResult => ({ ok: false, status: 'unconverted', message });

export const isBlank = (v: unknown) =>
  v === undefined || v === null || (typeof v === 'string' && (!v.trim() || /^[\s—–-]+$/.test(v))) || (Array.isArray(v) && v.length === 0);

export function plainText(v: unknown): TransformResult {
  if (isBlank(v)) return empty();
  const s = typeof v === 'string' ? (/<[a-z][\s\S]*>/i.test(v) ? richTextToPlain(v) : v).trim() : String(v);
  return s ? ok(s) : empty();
}

export function fillTemplate(template: string, fields: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => {
    const v = fields[k];
    if (k === 'type' && typeof v === 'string') return v.charAt(0).toUpperCase() + v.slice(1);
    return v == null ? '' : String(v);
  });
}

export function quantity(v: unknown): TransformResult {
  if (isBlank(v)) return empty();
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim());
  if (!Number.isFinite(n)) return fail(`'${v}' is not a number`);
  return ok({ value: n, instanceType: 'Quantity' });
}

/** '10 mg', '2.5 mg/kg' -> { value, unitText }. The unit is resolved against the UNIT codelist by the engine. */
export function parseAmount(v: unknown): { value: number; unitText: string } | TransformResult {
  if (isBlank(v)) return empty();
  const m = String(v)
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*([A-Za-zµμ%/²0-9.]+(?:\s*\/\s*[A-Za-z²0-9]+)?)?\s*$/);
  if (!m) return fail(`'${v}' is not in the form '<number> <unit>'`);
  return { value: Number(m[1]), unitText: (m[2] ?? '').replace(/μ/g, 'µ').trim() };
}

const DURATION_UNITS: Record<string, string> = { d: 'DAYS', day: 'DAYS', days: 'DAYS', w: 'WEEKS', wk: 'WEEKS', wks: 'WEEKS', week: 'WEEKS', weeks: 'WEEKS', month: 'MONTHS', months: 'MONTHS', year: 'YEARS', years: 'YEARS', h: 'HOURS', hour: 'HOURS', hours: 'HOURS' };

export function parseDuration(v: unknown): { value: number; unitText: string } | TransformResult {
  if (isBlank(v)) return empty();
  const m = String(v)
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*([a-z]+)\.?$/i);
  const unit = m ? DURATION_UNITS[m[2].toLowerCase()] : undefined;
  if (!m || !unit) return fail(`'${v}' is not in the form '<number> <days|weeks|months|years>'`);
  return { value: Number(m[1]), unitText: unit };
}

// ---------- Visit timing ----------

export interface ParsedTiming {
  kind: 'anchor' | 'before' | 'after';
  value: string;
  label: string;
}

const TIMING_RE = /^\s*(day|d|week|wk|w)\s*(-?\d+)\s*(.*)$/i;

/** Splits 'Week 4 ± 3 d' into the timepoint and an inline window. */
export function splitTiming(raw: string): { point: string; inlineWindow: string } {
  const m = raw.match(/^(.*?)(\s*(?:±|\+\/-|\+\/−|-\s*\d+\s*\/\s*\+).*)$/);
  return m && TIMING_RE.test(m[1]) ? { point: m[1].trim(), inlineWindow: m[2].trim() } : { point: raw.trim(), inlineWindow: '' };
}

export function isAnchorTiming(raw: unknown) {
  if (typeof raw !== 'string') return false;
  const m = splitTiming(raw).point.match(TIMING_RE);
  return !!m && /^d/i.test(m[1]) && Number(m[2]) === 1 && !m[3].trim();
}

/** 'Day N' / 'Week N' relative to Day 1. Day 1 = anchor; there is no Day 0; Week N = N weeks after Day 1. */
export function parseTiming(raw: unknown): ParsedTiming | TransformResult {
  if (isBlank(raw)) return empty('No visit timing recorded');
  const text = String(raw);
  const { point } = splitTiming(text);
  const m = point.match(TIMING_RE);
  if (!m) return fail(`'${text}' is not a 'Day N' or 'Week N' timepoint`);
  if (m[3].trim()) return fail(`'${text}' is a range or qualified timepoint; only single 'Day N' / 'Week N' values are converted`);
  const n = Number(m[2]);
  const isDay = /^d/i.test(m[1]);
  if (isDay) {
    if (n === 1) return { kind: 'anchor', value: 'P0D', label: point };
    if (n === 0) return fail(`'${text}': Day 0 is ambiguous (ProtocolIQ assumes there is no Day 0)`);
    return n > 1 ? { kind: 'after', value: `P${n - 1}D`, label: point } : { kind: 'before', value: `P${-n}D`, label: point };
  }
  if (n <= 0) return fail(`'${text}': Week ${n} is ambiguous relative to Day 1`);
  return { kind: 'after', value: `P${n}W`, label: point };
}

const WINDOW_UNIT: Record<string, string> = { d: 'D', day: 'D', days: 'D', w: 'W', wk: 'W', week: 'W', weeks: 'W', h: 'H', hr: 'H', hour: 'H', hours: 'H' };
const iso = (n: number, u: string) => (u === 'H' ? `PT${n}H` : `P${n}${u}`);

export function parseWindow(raw: unknown): { lower: string; upper: string; label: string } | TransformResult {
  if (isBlank(raw)) return empty('No visit window recorded');
  const text = String(raw).trim();
  let m = text.match(/^(?:±|\+\/-|\+\/−)\s*(\d+)\s*([a-z]+)\.?$/i);
  if (m && WINDOW_UNIT[m[2].toLowerCase()]) {
    const u = WINDOW_UNIT[m[2].toLowerCase()];
    return { lower: `-${iso(Number(m[1]), u)}`, upper: iso(Number(m[1]), u), label: text };
  }
  m = text.match(/^-\s*(\d+)\s*\/\s*\+\s*(\d+)\s*([a-z]+)\.?$/i);
  if (m && WINDOW_UNIT[m[3].toLowerCase()]) {
    const u = WINDOW_UNIT[m[3].toLowerCase()];
    return { lower: `-${iso(Number(m[1]), u)}`, upper: iso(Number(m[2]), u), label: text };
  }
  return fail(`'${text}' is not a '± N days' or '-N/+M days' window`);
}

/** The window of a visit: the window column, or a window written after the timing ('Week 4 ± 3 d'). */
export function visitWindowText(fields: Record<string, unknown>): string {
  const w = typeof fields.window === 'string' ? fields.window.trim() : '';
  if (w) return w;
  return typeof fields.timing === 'string' ? splitTiming(fields.timing).inlineWindow : '';
}

// ---------- Narrative XHTML ----------

const STRUCTURED = new Set(['objectives', 'endpoints', 'arms', 'criteria', 'soa']);

export function sectionXhtml(defs: FieldDef[], content: Record<string, unknown>): { html: string; structuredOnly: boolean } {
  const parts: string[] = [];
  const composite = defs.filter((d) => !STRUCTURED.has(d.type)).length > 1;
  let structured = false;
  for (const d of defs) {
    if (STRUCTURED.has(d.type)) {
      structured = true;
      continue;
    }
    const v = content[d.key];
    if (isBlank(v)) continue;
    const label = composite ? `<p><strong>${escapeHtml(d.label)}</strong></p>` : '';
    switch (d.type) {
      case 'richtext':
        parts.push(label + sanitizeRichText(String(v)));
        break;
      case 'list': {
        const items = (Array.isArray(v) ? v : []).filter((x) => typeof x === 'string' && x.trim());
        if (items.length) parts.push(label + `<ul>${items.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>`);
        break;
      }
      case 'table': {
        const t = v as TableValue;
        const cols = t.columns ?? d.columns ?? [];
        const rows = (t.rows ?? []).filter((r) => Object.values(r).some((x) => String(x ?? '').trim()));
        if (rows.length)
          parts.push(
            label +
              `<table><thead><tr>${cols.map((c) => `<th>${escapeHtml(c.label)}</th>`).join('')}</tr></thead><tbody>${rows
                .map((r) => `<tr>${cols.map((c) => `<td>${escapeHtml(String(r[c.key] ?? ''))}</td>`).join('')}</tr>`)
                .join('')}</tbody></table>`,
          );
        break;
      }
      case 'references': {
        const refs = (Array.isArray(v) ? (v as ReferenceItem[]) : []).filter((r) => r.citation?.trim());
        if (refs.length) parts.push(label + `<ol>${refs.map((r) => `<li>${escapeHtml(r.citation)}${r.link ? ` (${escapeHtml(r.link)})` : ''}</li>`).join('')}</ol>`);
        break;
      }
      case 'file': {
        const files = Array.isArray(v) ? (v as { filename?: string }[]) : [];
        if (files.length) parts.push(label + `<p>${files.map((f) => `Attachment: ${escapeHtml(f.filename ?? 'file')} (not embedded)`).join('<br/>')}</p>`);
        break;
      }
      default: {
        const s = String(v).trim();
        if (s) parts.push(composite ? `<p><strong>${escapeHtml(d.label)}:</strong> ${escapeHtml(s)}</p>` : `<p>${escapeHtml(s)}</p>`);
      }
    }
  }
  return { html: parts.length ? `<div xmlns="http://www.w3.org/1999/xhtml">${parts.join('')}</div>` : '', structuredOnly: structured && !parts.length };
}
