import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { MAPPING_STATUSES, TRANSFORMATION_LABELS, type MappingStatus } from '../../shared/governance';
import { Page } from '../components/Layout';
import { Button, Card, inputCls, Notice, PageHeader, Tabs } from '../components/ui';
import { ApiError, api, usdmApi } from '../lib/api';
import { useAuth } from '../lib/auth';
import { download } from '../lib/format';

type Tab = 'overview' | 'mappings' | 'unmapped' | 'terminology' | 'releases' | 'export';

export function UsdmStudio() {
  const auth = useAuth();
  const [tab, setTab] = useState<Tab>('overview');
  const [releases, setReleases] = useState<any[]>([]);
  const [note, setNote] = useState('');
  const [protocols, setProtocols] = useState<any[]>([]);
  const [studyId, setStudyId] = useState('');
  const [run, setRun] = useState<any>(null);
  const [mappings, setMappings] = useState<any[]>([]);
  const [entities, setEntities] = useState<{ id: string; label: string }[]>([]);
  const [filter, setFilter] = useState({ status: '', sourceEntity: '', q: '' });
  const [terms, setTerms] = useState<{ domains: any[]; items: any[] }>({ domains: [], items: [] });
  const [exports, setExports] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState({ targetEntity: '', targetProperty: '', sourceEntity: 'study', value: '', valueType: 'string', reason: '' });

  const selected = releases.find((r) => r.isSelected);

  const refresh = async () => {
    const [r, p] = await Promise.all([usdmApi.releases(), api.protocols()]);
    setReleases(r.releases);
    setNote(r.conformanceNote);
    setProtocols(p);
    if (!studyId && p[0]) setStudyId(p[0].studyId);
  };

  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!selected) return;
    void usdmApi.mappings({ status: filter.status || undefined, sourceEntity: filter.sourceEntity || undefined, q: filter.q || undefined, studyId, scope: 'all' }).then((m) => {
      setMappings(m.items);
      setEntities(m.sourceEntities);
    });
    void usdmApi.terminology({}).then((t) => setTerms({ domains: t.domains, items: t.items }));
    if (studyId) void usdmApi.exports({ studyId }).then((e) => setExports(e.items));
  }, [selected?.id, filter.status, filter.sourceEntity, filter.q, studyId]);

  const counts = useMemo(() => {
    const c: Record<string, number> = Object.fromEntries(MAPPING_STATUSES.map((s) => [s, 0]));
    for (const m of mappings) c[m.status] = (c[m.status] ?? 0) + 1;
    return c;
  }, [mappings]);

  const mapStudy = async () => {
    if (!studyId) return;
    setBusy(true);
    setError(null);
    try {
      setRun(await usdmApi.mapStudy(studyId, { includePending: true }));
      setTab('overview');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Mapping failed');
    } finally {
      setBusy(false);
    }
  };

  const unmapped = mappings.filter((m) => m.status === 'Not Mapped' || m.transformationType === 'manual' || m.transformationType === 'unsupported');

  return (
    <Page wide>
      <PageHeader
        title="USDM Mapping Studio"
        subtitle="Deterministic, rule-based mapping of structured study data to the selected USDM release. Fields without a valid equivalent stay unmapped."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <select className={inputCls + ' w-64'} value={studyId} onChange={(e) => setStudyId(e.target.value)}>
              <option value="">Select study…</option>
              {[...new Map(protocols.map((p) => [p.studyId, p])).values()].map((p: any) => (
                <option key={p.studyId} value={p.studyId}>
                  {p.protocolNumber || p.title}
                </option>
              ))}
            </select>
            {auth.can('usdm.map') && (
              <Button variant="primary" loading={busy} disabled={!studyId} onClick={mapStudy}>
                Map study
              </Button>
            )}
          </div>
        }
      />
      {error && <Notice tone="error" className="mb-4">{error}</Notice>}
      <Tabs
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'mappings', label: 'Entity explorer' },
          { id: 'unmapped', label: `Unmapped / manual (${unmapped.length})` },
          { id: 'terminology', label: 'Terminology' },
          { id: 'releases', label: 'Releases' },
          { id: 'export', label: 'Export' },
        ]}
        value={tab}
        onChange={(id) => setTab(id as Tab)}
      />

      {tab === 'overview' && (
        <div className="mt-5 space-y-4">
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {MAPPING_STATUSES.map((s) => (
              <Card key={s} className="p-3">
                <div className="text-xl font-semibold text-slate-900">{counts[s] ?? 0}</div>
                <div className="text-xs text-slate-500">{s}</div>
              </Card>
            ))}
          </div>
          <Card className="p-4 text-sm text-slate-600">
            Active release: <strong>{selected?.version ?? '—'}</strong> · {selected?.name}
            <div className="mt-1 text-xs text-slate-500">{note}</div>
          </Card>
          {run && (
            <Card className="space-y-3 p-5">
              <div className="flex flex-wrap items-center gap-3">
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${run.status === 'valid' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>{run.status}</span>
                <span className="text-sm text-slate-600">Review: {run.reviewStatus}</span>
                {run.stale && <Notice tone="warn">Stale: {run.staleReason}</Notice>}
              </div>
              <p className="text-sm text-slate-700">{run.report?.conformance?.label}</p>
              <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                {Object.entries(run.counts ?? {}).map(([k, v]) => (
                  <div key={k} className="rounded border border-slate-100 px-2 py-1">
                    <span className="text-slate-500">{k}</span>: <strong>{String(v)}</strong>
                  </div>
                ))}
              </div>
              {auth.can('usdm.mapping.review') && run.reviewStatus === 'Pending Review' && (
                <div className="flex gap-2">
                  <Button
                    variant="primary"
                    onClick={async () => {
                      setRun(await usdmApi.reviewRun(run.id, 'Approved', 'Reviewed in Mapping Studio'));
                    }}
                  >
                    Approve run
                  </Button>
                  <Button
                    onClick={async () => {
                      const comment = prompt('Rejection comment') || '';
                      if (!comment) return;
                      setRun(await usdmApi.reviewRun(run.id, 'Rejected', comment));
                    }}
                  >
                    Reject
                  </Button>
                </div>
              )}
            </Card>
          )}
        </div>
      )}

      {tab === 'mappings' && (
        <div className="mt-5 space-y-3">
          <div className="flex flex-wrap gap-2">
            <select className={inputCls + ' w-40'} value={filter.sourceEntity} onChange={(e) => setFilter({ ...filter, sourceEntity: e.target.value })}>
              <option value="">All entities</option>
              {entities.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
            </select>
            <select className={inputCls + ' w-44'} value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}>
              <option value="">All statuses</option>
              {MAPPING_STATUSES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <input className={inputCls + ' w-56'} placeholder="Search…" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} />
          </div>
          <Card className="overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-2">Source</th>
                  <th className="px-3 py-2">Target</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Reason</th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {mappings.map((m) => (
                  <tr key={m.id}>
                    <td className="px-3 py-2">
                      <div className="font-medium text-slate-800">
                        {m.sourceEntity}.{m.sourceField}
                      </div>
                      {m.scopeStudyId && <div className="text-[11px] text-amber-700">Study-scoped{m.scopeElementId ? ' · element' : ''}</div>}
                    </td>
                    <td className="px-3 py-2 text-slate-600">
                      {m.targetEntity}
                      {m.targetProperty ? `.${m.targetProperty}` : ''}
                    </td>
                    <td className="px-3 py-2">{TRANSFORMATION_LABELS[m.transformationType as keyof typeof TRANSFORMATION_LABELS] ?? m.transformationType}</td>
                    <td className="px-3 py-2">
                      <StatusPill status={m.status} />
                    </td>
                    <td className="max-w-xs truncate px-3 py-2 text-xs text-slate-500" title={m.reason}>
                      {m.reason || '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {auth.can('usdm.mapping.review') && m.status === 'Requires Review' && (
                        <Button
                          size="sm"
                          onClick={async () => {
                            await usdmApi.reviewMapping(m.id, 'Validated');
                            setFilter({ ...filter });
                          }}
                        >
                          Validate
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!mappings.length && <p className="p-6 text-sm text-slate-500">No mapping rules match these filters.</p>}
          </Card>
        </div>
      )}

      {tab === 'unmapped' && (
        <div className="mt-5 space-y-4">
          <Card className="p-4">
            <h3 className="mb-2 text-sm font-semibold">Configure a manual value</h3>
            <p className="mb-3 text-xs text-slate-500">Sets a study-scoped override. Global rules are not changed. A reason is required.</p>
            <div className="grid gap-2 sm:grid-cols-3">
              {(['sourceEntity', 'targetEntity', 'targetProperty', 'valueType', 'value', 'reason'] as const).map((k) => (
                <input key={k} className={inputCls} placeholder={k} value={(manual as any)[k]} onChange={(e) => setManual({ ...manual, [k]: e.target.value })} />
              ))}
            </div>
            {auth.can('usdm.mapping.manage') && (
              <Button
                className="mt-3"
                variant="primary"
                disabled={!studyId}
                onClick={async () => {
                  await usdmApi.manualValue({ ...manual, studyId, value: manual.valueType === 'boolean' ? manual.value === 'true' : manual.value });
                  setFilter({ ...filter });
                }}
              >
                Save manual value
              </Button>
            )}
          </Card>
          <Card className="overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-2">Source / target</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {unmapped.map((m) => (
                  <tr key={m.id}>
                    <td className="px-3 py-2">
                      {m.sourceEntity}.{m.sourceField} → {m.targetEntity}
                      {m.targetProperty ? `.${m.targetProperty}` : ''}
                    </td>
                    <td className="px-3 py-2">{m.transformationType}</td>
                    <td className="px-3 py-2">
                      <StatusPill status={m.status} />
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500">{m.reason || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      )}

      {tab === 'terminology' && (
        <div className="mt-5 space-y-3">
          <Card className="overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-2">Domain</th>
                  <th className="px-3 py-2">Source</th>
                  <th className="px-3 py-2">Target</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Basis</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {terms.items.map((t) => (
                  <tr key={t.id}>
                    <td className="px-3 py-2">{t.domain}</td>
                    <td className="px-3 py-2">{t.sourceValue}</td>
                    <td className="px-3 py-2">
                      {t.targetCode ? `${t.targetCode} · ${t.targetDecode}` : '—'}
                    </td>
                    <td className="px-3 py-2">
                      <StatusPill status={t.status} />
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500">{t.matchBasis}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      )}

      {tab === 'releases' && (
        <div className="mt-5 space-y-3">
          {releases.map((r) => (
            <Card key={r.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <div className="font-semibold text-slate-900">
                  USDM {r.version} {r.isSelected && <span className="ml-2 text-xs font-medium text-brand-700">Selected</span>}
                </div>
                <div className="text-sm text-slate-500">
                  {r.name} · {r.status} · assembler {r.assemblerSupported ? 'supported' : 'unsupported'}
                </div>
              </div>
              {auth.can('usdm.release.manage') && !r.isSelected && r.status === 'Active' && (
                <Button onClick={() => usdmApi.updateRelease(r.id, { select: true, reason: 'Selected in Mapping Studio' }).then(refresh)}>Select</Button>
              )}
            </Card>
          ))}
        </div>
      )}

      {tab === 'export' && (
        <div className="mt-5 space-y-4">
          <Notice tone="info">Export requires an Active release, a valid approved non-stale mapping run, and no open Critical governance issues. The label never claims “USDM-compliant”.</Notice>
          {auth.can('usdm.export') && (
            <Button
              variant="primary"
              disabled={!studyId}
              onClick={() => {
                try {
                  download(usdmApi.exportUrl(studyId));
                } catch (e) {
                  setError(e instanceof Error ? e.message : 'Export failed');
                }
              }}
            >
              Download USDM JSON
            </Button>
          )}
          <Card className="overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Conformance</th>
                  <th className="px-3 py-2">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {exports.map((e) => (
                  <tr key={e.id}>
                    <td className="px-3 py-2">{new Date(e.exportedAt).toLocaleString()}</td>
                    <td className="px-3 py-2">{e.status}</td>
                    <td className="max-w-md truncate px-3 py-2 text-xs">{e.conformanceLabel}</td>
                    <td className="max-w-xs truncate px-3 py-2 text-xs text-slate-500">{e.reason || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!exports.length && <p className="p-6 text-sm text-slate-500">No export attempts yet for this study.</p>}
          </Card>
          <Link className="text-sm text-brand-700 hover:underline" to="/export">
            Open Export Center
          </Link>
        </div>
      )}
    </Page>
  );
}

function StatusPill({ status }: { status: MappingStatus | string }) {
  const tone =
    status === 'Validated' || status === 'Mapped'
      ? 'bg-emerald-50 text-emerald-700'
      : status === 'Requires Review'
        ? 'bg-amber-50 text-amber-700'
        : status === 'Rejected'
          ? 'bg-red-50 text-red-700'
          : 'bg-slate-100 text-slate-600';
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}>{status}</span>;
}
