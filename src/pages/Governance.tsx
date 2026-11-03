import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Page } from '../components/Layout';
import { Button, Card, inputCls, Notice, PageHeader, Spinner } from '../components/ui';
import { api, govApi } from '../lib/api';
import { useAuth } from '../lib/auth';

export function Governance() {
  const auth = useAuth();
  const [dash, setDash] = useState<any>(null);
  const [owners, setOwners] = useState<any[]>([]);
  const [dict, setDict] = useState<any[]>([]);
  const [studies, setStudies] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [assign, setAssign] = useState({ studyId: '', userId: '', responsibility: 'Owner' });
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    const [d, o, dictEntries, s, u] = await Promise.all([govApi.dashboard(), govApi.owners(), govApi.dictionary(q || undefined), api.studies(), govApi.users()]);
    setDash(d);
    setOwners(o);
    setDict(dictEntries);
    setStudies(s);
    setUsers(u);
  };

  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, [q]);

  if (!dash) return <Spinner />;

  return (
    <Page wide>
      <PageHeader title="Data Governance" subtitle="Quality scores, open issues, mapping completeness, ownership and the data dictionary — all computed from stored records." />
      {error && <Notice tone="error" className="mb-4">{error}</Notice>}

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
        {[
          ['Studies', dash.totals.studies],
          ['Avg quality', dash.totals.averageQuality ?? '—'],
          ['Open issues', dash.totals.openIssues],
          ['Critical', dash.totals.criticalIssues],
          ['Valid mappings', dash.totals.validMappings],
          ['Exports', dash.totals.exports],
        ].map(([label, value]) => (
          <Card key={String(label)} className="p-4">
            <div className="text-2xl font-semibold text-slate-900">{value}</div>
            <div className="text-xs text-slate-500">{label}</div>
          </Card>
        ))}
      </div>

      <div className="mb-8 grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <h3 className="mb-3 text-sm font-semibold">Open issues by severity</h3>
          <BarMap data={dash.issuesBySeverity} />
        </Card>
        <Card className="p-4">
          <h3 className="mb-3 text-sm font-semibold">Element review status</h3>
          <BarMap data={dash.reviewStatus} />
        </Card>
      </div>

      <Card className="mb-8 overflow-auto">
        <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold">Quality by study</div>
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-2">Study</th>
              <th className="px-2 py-2">Status</th>
              <th className="px-2 py-2">Quality</th>
              <th className="px-2 py-2">Open issues</th>
              <th className="px-2 py-2">Mapping</th>
              <th className="px-2 py-2">Review</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {dash.studies.map((s: any) => (
              <tr key={s.protocolId}>
                <td className="px-4 py-2">
                  <div className="font-medium text-slate-800">{s.protocolNumber || s.title}</div>
                  <div className="text-xs text-slate-500">{s.title}</div>
                </td>
                <td className="px-2 py-2">{s.status}</td>
                <td className="px-2 py-2">{s.qualityScore ?? '—'}</td>
                <td className="px-2 py-2">
                  {s.openIssues}
                  {s.criticalIssues ? <span className="ml-1 text-red-600">({s.criticalIssues} critical)</span> : null}
                </td>
                <td className="px-2 py-2 text-xs">
                  {s.mapping ? (
                    <>
                      {s.mapping.valid ? 'valid' : 'invalid'} · {s.mapping.completeness}% · {s.mapping.reviewStatus}
                      {!s.mapping.current && <span className="text-amber-700"> · stale</span>}
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="px-2 py-2 text-xs">
                  {s.review.approved}/{s.review.total} approved
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <section className="mb-8">
        <div className="mb-3 flex items-end justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Data owners</h2>
          <Link to="/quality" className="text-sm text-brand-700 hover:underline">
            Open data quality
          </Link>
        </div>
        {auth.can('owners.manage') && (
          <Card className="mb-3 flex flex-wrap gap-2 p-3">
            <select className={inputCls + ' w-56'} value={assign.studyId} onChange={(e) => setAssign({ ...assign, studyId: e.target.value })}>
              <option value="">Study…</option>
              {studies.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.protocolNumber || s.title}
                </option>
              ))}
            </select>
            <select className={inputCls + ' w-44'} value={assign.userId} onChange={(e) => setAssign({ ...assign, userId: e.target.value })}>
              <option value="">User…</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName}
                </option>
              ))}
            </select>
            <select className={inputCls + ' w-32'} value={assign.responsibility} onChange={(e) => setAssign({ ...assign, responsibility: e.target.value })}>
              <option>Owner</option>
              <option>Steward</option>
            </select>
            <Button
              variant="primary"
              onClick={async () => {
                await govApi.assignOwner(assign);
                await refresh();
              }}
            >
              Assign
            </Button>
          </Card>
        )}
        <Card className="overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-2">Study</th>
                <th className="px-2 py-2">Role</th>
                <th className="px-2 py-2">User</th>
                <th className="px-2 py-2">Entity</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {owners.map((o) => (
                <tr key={o.id}>
                  <td className="px-4 py-2">{o.protocolNumber || o.studyTitle}</td>
                  <td className="px-2 py-2">{o.responsibility}</td>
                  <td className="px-2 py-2">{o.userName}</td>
                  <td className="px-2 py-2">{o.entityType}</td>
                  <td className="px-2 py-2 text-right">
                    {auth.can('owners.manage') && (
                      <Button size="sm" variant="danger" onClick={() => govApi.removeOwner(o.id).then(refresh)}>
                        Remove
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!owners.length && <p className="p-4 text-sm text-slate-500">No owners assigned yet.</p>}
        </Card>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Data dictionary</h2>
          <input className={inputCls + ' w-56'} placeholder="Search dictionary…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Card className="overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-2">Field</th>
                <th className="px-2 py-2">Type</th>
                <th className="px-2 py-2">Required</th>
                <th className="px-2 py-2">USDM</th>
                <th className="px-2 py-2">Rules</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {dict.map((e) => (
                <tr key={e.id}>
                  <td className="px-4 py-2">
                    <div className="font-medium text-slate-800">{e.name}</div>
                    <div className="text-xs text-slate-500">
                      {e.id} · {e.definition}
                    </div>
                  </td>
                  <td className="px-2 py-2">{e.dataType}</td>
                  <td className="px-2 py-2">{e.required ? 'Yes' : 'No'}</td>
                  <td className="px-2 py-2 text-xs">{e.usdmMappings.map((m: any) => `${m.target} (${m.status})`).join('; ') || '—'}</td>
                  <td className="px-2 py-2 text-xs">{e.validationRules.map((r: any) => r.id).join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </section>
    </Page>
  );
}

function BarMap({ data }: { data: Record<string, number> }) {
  const max = Math.max(1, ...Object.values(data));
  return (
    <ul className="space-y-2">
      {Object.entries(data).map(([k, v]) => (
        <li key={k} className="flex items-center gap-3 text-sm">
          <span className="w-28 shrink-0 text-slate-600">{k}</span>
          <div className="h-2 flex-1 rounded bg-slate-100">
            <div className="h-2 rounded bg-brand-500" style={{ width: `${(Number(v) / max) * 100}%` }} />
          </div>
          <span className="w-8 text-right tabular-nums text-slate-700">{v}</span>
        </li>
      ))}
    </ul>
  );
}
