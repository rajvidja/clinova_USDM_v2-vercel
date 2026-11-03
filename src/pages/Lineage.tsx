import { useEffect, useState } from 'react';
import { Page } from '../components/Layout';
import { Button, Card, inputCls, Notice, PageHeader, Spinner } from '../components/ui';
import { api, govApi } from '../lib/api';
import { useAuth } from '../lib/auth';

export function LineagePage() {
  const auth = useAuth();
  const [protocols, setProtocols] = useState<any[]>([]);
  const [protocolId, setProtocolId] = useState('');
  const [rows, setRows] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [filter, setFilter] = useState({ type: '', review: '', q: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.protocols().then((p) => {
      setProtocols(p);
      if (p[0]) setProtocolId(p[0].id);
    });
  }, []);

  useEffect(() => {
    if (!protocolId) return;
    void govApi
      .protocolLineage(protocolId)
      .then(setRows)
      .catch((e) => setError(e.message));
    setSelected(null);
  }, [protocolId]);

  const visible = rows.filter((r) => {
    if (filter.type && r.elementType !== filter.type) return false;
    if (filter.review && r.reviewStatus !== filter.review) return false;
    if (filter.q && !`${r.label} ${r.sourceSection ?? ''} ${r.sourceText ?? ''}`.toLowerCase().includes(filter.q.toLowerCase())) return false;
    return true;
  });

  const open = async (elementId: string) => {
    setSelected(await govApi.lineage(elementId));
  };

  const review = async (decision: 'Approved' | 'Rejected') => {
    const comment = decision === 'Rejected' ? prompt('Rejection comment') || '' : 'Approved in lineage viewer';
    if (decision === 'Rejected' && !comment) return;
    setBusy(true);
    try {
      await govApi.reviewElements(protocolId, { elementIds: 'all-pending', decision, comment });
      setRows(await govApi.protocolLineage(protocolId));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page wide>
      <PageHeader title="Data Lineage" subtitle="Source document, extraction method, authorship, review status, version history and USDM mapping for every study element." />
      {error && <Notice tone="error" className="mb-4">{error}</Notice>}
      <div className="mb-4 flex flex-wrap gap-2">
        <select className={inputCls + ' w-72'} value={protocolId} onChange={(e) => setProtocolId(e.target.value)}>
          {protocols.map((p) => (
            <option key={p.id} value={p.id}>
              {p.protocolNumber || p.title} ({p.source})
            </option>
          ))}
        </select>
        <select className={inputCls + ' w-40'} value={filter.type} onChange={(e) => setFilter({ ...filter, type: e.target.value })}>
          <option value="">All types</option>
          {[...new Set(rows.map((r) => r.elementType))].map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <select className={inputCls + ' w-40'} value={filter.review} onChange={(e) => setFilter({ ...filter, review: e.target.value })}>
          <option value="">All reviews</option>
          <option>Pending</option>
          <option>Approved</option>
          <option>Rejected</option>
        </select>
        <input className={inputCls + ' w-56'} placeholder="Search…" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} />
        {auth.can('element.review') && (
          <>
            <Button loading={busy} onClick={() => review('Approved')}>
              Approve all pending
            </Button>
            <Button loading={busy} variant="danger" onClick={() => review('Rejected')}>
              Reject pending…
            </Button>
          </>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="max-h-[70vh] overflow-auto">
          {!rows.length ? (
            <Spinner />
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-2">Element</th>
                  <th className="px-2 py-2">Source</th>
                  <th className="px-2 py-2">Review</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visible.map((r) => (
                  <tr key={r.elementId} className="cursor-pointer hover:bg-slate-50" onClick={() => void open(r.elementId)}>
                    <td className="px-3 py-2">
                      <div className="font-medium text-slate-800">{r.label}</div>
                      <div className="text-xs text-slate-500">{r.elementType}</div>
                    </td>
                    <td className="px-2 py-2 text-xs">
                      {r.sourceType}
                      {r.sourceDocumentName ? ` · ${r.sourceDocumentName}` : ''}
                      {r.sourcePage ? ` · p.${r.sourcePage}` : ''}
                    </td>
                    <td className="px-2 py-2 text-xs">{r.reviewStatus}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card className="max-h-[70vh] overflow-auto p-4 text-sm">
          {!selected ? (
            <p className="text-slate-500">Select an element to inspect its lineage.</p>
          ) : (
            <div className="space-y-4">
              <div>
                <h3 className="font-semibold text-slate-900">{selected.lineage.label}</h3>
                <p className="text-xs text-slate-500">
                  {selected.lineage.elementType} · created by {selected.lineage.createdByName} · {selected.lineage.extractionMethod}
                </p>
              </div>
              <Block title="Source">
                <div>Type: {selected.lineage.sourceType}</div>
                {selected.lineage.sourceDocumentName && <div>Document: {selected.lineage.sourceDocumentName}</div>}
                {selected.lineage.sourceSection && <div>Section: {selected.lineage.sourceSection}</div>}
                {selected.lineage.sourcePage != null && <div>Page: {selected.lineage.sourcePage}</div>}
                {selected.lineage.sourceText && <pre className="mt-1 whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs">{selected.lineage.sourceText}</pre>}
              </Block>
              <Block title="Current content">
                <pre className="overflow-auto rounded bg-slate-50 p-2 text-xs">{JSON.stringify(selected.current?.content ?? {}, null, 2)}</pre>
              </Block>
              <Block title="Relationships">
                {selected.relations.length ? selected.relations.map((r: any, i: number) => (
                  <div key={i} className="text-xs">
                    {r.direction} {r.kind} → {r.otherLabel}
                  </div>
                )) : 'None'}
              </Block>
              <Block title="Versions">
                {selected.versions.map((v: any) => (
                  <div key={v.id} className="border-b border-slate-100 py-1 text-xs">
                    v{v.version} · {v.changeType} · {v.changedByName} · {new Date(v.changedAt).toLocaleString()}
                    {v.changeRequestId && <span className="text-brand-700"> · change request</span>}
                  </div>
                ))}
              </Block>
              <Block title="USDM">
                {selected.usdm ? (
                  <div className="text-xs">
                    Run {selected.usdm.runId} · {selected.usdm.runStatus} / {selected.usdm.runReviewStatus}
                    <pre className="mt-1 overflow-auto rounded bg-slate-50 p-2">{JSON.stringify(selected.usdm.record ?? selected.usdm.rule, null, 2)}</pre>
                  </div>
                ) : (
                  'Not mapped in a stored run yet'
                )}
              </Block>
            </div>
          )}
        </Card>
      </div>
    </Page>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h4>
      <div className="text-slate-700">{children}</div>
    </div>
  );
}
