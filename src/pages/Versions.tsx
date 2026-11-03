import { useEffect, useState } from 'react';
import { Page } from '../components/Layout';
import { Button, Card, inputCls, Notice, PageHeader, Spinner } from '../components/ui';
import { ApiError, api, govApi } from '../lib/api';
import { useAuth } from '../lib/auth';

export function VersionsPage() {
  const auth = useAuth();
  const [protocols, setProtocols] = useState<any[]>([]);
  const [studyId, setStudyId] = useState('');
  const [protocolId, setProtocolId] = useState('');
  const [data, setData] = useState<{ versions: any[]; changeRequests: any[] } | null>(null);
  const [compare, setCompare] = useState<any>(null);
  const [fromId, setFromId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [cr, setCr] = useState({ title: '', justification: '', field: 'indication', value: '' });

  useEffect(() => {
    void api.protocols().then((p) => {
      setProtocols(p);
      if (p[0]) {
        setStudyId(p[0].studyId);
        setProtocolId(p[0].id);
      }
    });
  }, []);

  const refresh = async () => {
    if (!studyId) return;
    setData(await govApi.versions(studyId));
  };

  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, [studyId]);

  const onStudy = (sid: string) => {
    setStudyId(sid);
    const p = protocols.find((x) => x.studyId === sid);
    setProtocolId(p?.id ?? '');
    setCompare(null);
  };

  return (
    <Page wide>
      <PageHeader title="Version History" subtitle="Protocol versions, amendments, change requests and before/after comparison. Approved versions are immutable." />
      {error && <Notice tone="error" className="mb-4">{error}</Notice>}
      <select className={inputCls + ' mb-4 w-80'} value={studyId} onChange={(e) => onStudy(e.target.value)}>
        {[...new Map(protocols.map((p) => [p.studyId, p])).values()].map((p: any) => (
          <option key={p.studyId} value={p.studyId}>
            {p.protocolNumber || p.title}
          </option>
        ))}
      </select>

      {!data ? (
        <Spinner />
      ) : (
        <div className="space-y-6">
          <Card className="overflow-auto">
            <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold">Versions</div>
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-2">When</th>
                  <th className="px-2 py-2">Label</th>
                  <th className="px-2 py-2">Revision</th>
                  <th className="px-2 py-2">Approval</th>
                  <th className="px-2 py-2">Author</th>
                  <th className="px-2 py-2">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.versions.map((v) => (
                  <tr key={v.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setFromId(v.id)}>
                    <td className="px-4 py-2 text-xs">{new Date(v.createdAt).toLocaleString()}</td>
                    <td className="px-2 py-2">{v.versionLabel || '—'}</td>
                    <td className="px-2 py-2">#{v.revision}</td>
                    <td className="px-2 py-2">{v.approvalStatus}</td>
                    <td className="px-2 py-2 text-xs">{v.authorName || '—'}</td>
                    <td className="max-w-xs truncate px-2 py-2 text-xs text-slate-500">{v.changeReason || v.note || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!data.versions.length && <p className="p-4 text-sm text-slate-500">No versions recorded yet.</p>}
          </Card>

          <Card className="p-4">
            <h3 className="mb-2 text-sm font-semibold">Compare</h3>
            <div className="mb-3 flex flex-wrap gap-2">
              <select className={inputCls + ' w-64'} value={fromId} onChange={(e) => setFromId(e.target.value)}>
                <option value="">From version…</option>
                {data.versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    #{v.revision} · {v.versionLabel || v.approvalStatus}
                  </option>
                ))}
              </select>
              <Button
                disabled={!fromId || !protocolId}
                onClick={async () => setCompare(await govApi.compare(protocolId, fromId, 'current'))}
              >
                Compare to current
              </Button>
            </div>
            {compare && (
              <div className="space-y-2 text-sm">
                <div className="text-xs text-slate-500">
                  Added {compare.diff.summary.added} · Modified {compare.diff.summary.modified} · Deleted {compare.diff.summary.deleted} · Relations {compare.diff.summary.relationsChanged}
                </div>
                {compare.diff.elements.map((e: any) => (
                  <div key={e.id} className="rounded border border-slate-100 px-3 py-2 text-xs">
                    <strong>{e.change}</strong> {e.type}: {e.label}
                    {e.fields?.map((f: any) => (
                      <div key={f.field} className="text-slate-500">
                        {f.field}: {JSON.stringify(f.before)} → {JSON.stringify(f.after)}
                      </div>
                    ))}
                  </div>
                ))}
                {!compare.diff.elements.length && <p className="text-slate-500">No element differences.</p>}
              </div>
            )}
          </Card>

          <Card className="overflow-auto">
            <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold">Change requests</div>
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-2">Title</th>
                  <th className="px-2 py-2">Status</th>
                  <th className="px-2 py-2">Proposed by</th>
                  <th className="px-2 py-2">Decision</th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.changeRequests.map((c) => (
                  <tr key={c.id}>
                    <td className="px-4 py-2">
                      <div className="font-medium">{c.title}</div>
                      <div className="text-xs text-slate-500">{c.justification}</div>
                    </td>
                    <td className="px-2 py-2">{c.status}</td>
                    <td className="px-2 py-2 text-xs">{c.proposedByName}</td>
                    <td className="px-2 py-2 text-xs">{c.decisionComment || '—'}</td>
                    <td className="px-2 py-2 text-right">
                      {auth.can('change.approve') && c.status === 'Pending Review' && (
                        <div className="flex justify-end gap-1">
                          <Button
                            size="sm"
                            variant="primary"
                            onClick={async () => {
                              await govApi.approveChangeRequest(c.id, 'Approved');
                              await refresh();
                            }}
                          >
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={async () => {
                              const comment = prompt('Rejection comment') || '';
                              if (!comment) return;
                              await govApi.rejectChangeRequest(c.id, comment);
                              await refresh();
                            }}
                          >
                            Reject
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {auth.can('change.propose') && (
            <Card className="space-y-2 p-4">
              <h3 className="text-sm font-semibold">Propose a change (Final protocols)</h3>
              <p className="text-xs text-slate-500">Direct edits to Final protocols are locked. Submit a change request with a justification; a reviewer must approve it.</p>
              <input className={inputCls} placeholder="Title" value={cr.title} onChange={(e) => setCr({ ...cr, title: e.target.value })} />
              <textarea className={inputCls + ' min-h-16'} placeholder="Justification" value={cr.justification} onChange={(e) => setCr({ ...cr, justification: e.target.value })} />
              <div className="flex gap-2">
                <select className={inputCls + ' w-40'} value={cr.field} onChange={(e) => setCr({ ...cr, field: e.target.value })}>
                  <option value="indication">indication</option>
                  <option value="therapeuticArea">therapeuticArea</option>
                  <option value="sponsorName">sponsorName</option>
                </select>
                <input className={inputCls} placeholder="New value" value={cr.value} onChange={(e) => setCr({ ...cr, value: e.target.value })} />
              </div>
              <Button
                variant="primary"
                onClick={async () => {
                  try {
                    await govApi.createChangeRequest({
                      protocolId,
                      title: cr.title,
                      justification: cr.justification,
                      payload: { meta: { [cr.field]: cr.value } },
                      submit: true,
                    });
                    setCr({ title: '', justification: '', field: 'indication', value: '' });
                    await refresh();
                  } catch (e) {
                    setError(e instanceof ApiError ? e.message : 'Change request failed');
                  }
                }}
              >
                Submit change request
              </Button>
            </Card>
          )}
        </div>
      )}
    </Page>
  );
}
