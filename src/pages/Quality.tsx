import { useEffect, useState } from 'react';
import { ISSUE_STATUSES, SEVERITIES, type IssueStatus } from '../../shared/governance';
import { Page } from '../components/Layout';
import { Button, Card, inputCls, Modal, Notice, PageHeader, Spinner } from '../components/ui';
import { ApiError, api, govApi } from '../lib/api';
import { useAuth } from '../lib/auth';

export function Quality() {
  const auth = useAuth();
  const [tab, setTab] = useState<'issues' | 'rules'>('issues');
  const [issues, setIssues] = useState<any>(null);
  const [rules, setRules] = useState<any[]>([]);
  const [protocols, setProtocols] = useState<any[]>([]);
  const [filter, setFilter] = useState({ studyId: '', status: 'unresolved', severity: '', page: 1 });
  const [selected, setSelected] = useState<any>(null);
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadIssues = async () => {
    setIssues(await govApi.issues({ ...filter, pageSize: 25 }));
  };

  useEffect(() => {
    void api.protocols().then(setProtocols);
    void govApi.rules().then((r) => setRules(r.rules));
  }, []);

  useEffect(() => {
    void loadIssues().catch((e) => setError(e.message));
  }, [filter.studyId, filter.status, filter.severity, filter.page]);

  const validate = async () => {
    if (!filter.studyId) return setError('Choose a study to validate');
    setBusy(true);
    try {
      await govApi.validate(filter.studyId);
      await loadIssues();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page wide>
      <PageHeader
        title="Data Quality"
        subtitle="Governance issues from rule-based validation, with assignment, resolution and accepted exceptions."
        actions={
          <div className="flex gap-2">
            <Button variant={tab === 'issues' ? 'primary' : 'secondary'} onClick={() => setTab('issues')}>
              Issues
            </Button>
            <Button variant={tab === 'rules' ? 'primary' : 'secondary'} onClick={() => setTab('rules')}>
              Rules
            </Button>
            {auth.can('governance.validate') && (
              <Button loading={busy} onClick={validate}>
                Run validation
              </Button>
            )}
          </div>
        }
      />
      {error && <Notice tone="error" className="mb-4">{error}</Notice>}

      {tab === 'issues' && (
        <>
          <div className="mb-3 flex flex-wrap gap-2">
            <select className={inputCls + ' w-64'} value={filter.studyId} onChange={(e) => setFilter({ ...filter, studyId: e.target.value, page: 1 })}>
              <option value="">All studies</option>
              {[...new Map(protocols.map((p) => [p.studyId, p])).values()].map((p: any) => (
                <option key={p.studyId} value={p.studyId}>
                  {p.protocolNumber || p.title}
                </option>
              ))}
            </select>
            <select className={inputCls + ' w-44'} value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value, page: 1 })}>
              <option value="unresolved">Unresolved</option>
              <option value="">All statuses</option>
              {ISSUE_STATUSES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <select className={inputCls + ' w-40'} value={filter.severity} onChange={(e) => setFilter({ ...filter, severity: e.target.value, page: 1 })}>
              <option value="">All severities</option>
              {SEVERITIES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
          {!issues ? (
            <Spinner />
          ) : (
            <>
              <div className="mb-3 flex flex-wrap gap-2 text-xs">
                {Object.entries(issues.counts || {}).map(([k, v]) => (
                  <span key={k} className="rounded-full bg-slate-100 px-2 py-1 text-slate-600">
                    {k}: {String(v)}
                  </span>
                ))}
              </div>
              <Card className="overflow-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                    <tr>
                      <th className="px-3 py-2">Issue</th>
                      <th className="px-2 py-2">Severity</th>
                      <th className="px-2 py-2">Status</th>
                      <th className="px-2 py-2">Assignee</th>
                      <th className="px-2 py-2">Study</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {issues.items.map((i: any) => (
                      <tr key={i.id} className="cursor-pointer hover:bg-slate-50" onClick={() => govApi.issue(i.id).then(setSelected)}>
                        <td className="px-3 py-2">
                          <div className="font-medium text-slate-800">{i.title}</div>
                          <div className="text-xs text-slate-500">{i.elementLabel || i.elementType || i.category}</div>
                        </td>
                        <td className="px-2 py-2">{i.severity}</td>
                        <td className="px-2 py-2">{i.status}</td>
                        <td className="px-2 py-2">{i.assignedToName || '—'}</td>
                        <td className="px-2 py-2 text-xs">{i.protocolNumber || i.studyTitle}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!issues.items.length && <p className="p-6 text-sm text-slate-500">No issues match these filters.</p>}
              </Card>
              <div className="mt-3 flex items-center gap-2 text-sm">
                <Button size="sm" disabled={filter.page <= 1} onClick={() => setFilter({ ...filter, page: filter.page - 1 })}>
                  Previous
                </Button>
                <span>
                  Page {issues.page} · {issues.total} total
                </span>
                <Button size="sm" disabled={filter.page * issues.pageSize >= issues.total} onClick={() => setFilter({ ...filter, page: filter.page + 1 })}>
                  Next
                </Button>
              </div>
            </>
          )}
        </>
      )}

      {tab === 'rules' && (
        <Card className="overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2">Rule</th>
                <th className="px-2 py-2">Category</th>
                <th className="px-2 py-2">Severity</th>
                <th className="px-2 py-2">Entity</th>
                <th className="px-2 py-2">Active</th>
                <th className="px-2 py-2">Last run</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rules.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-2">
                    <div className="font-medium">{r.id}</div>
                    <div className="text-xs text-slate-500">{r.name}</div>
                  </td>
                  <td className="px-2 py-2">{r.category}</td>
                  <td className="px-2 py-2">{r.severity}</td>
                  <td className="px-2 py-2">{r.entityType}</td>
                  <td className="px-2 py-2">{r.active ? 'Yes' : 'No'}</td>
                  <td className="px-2 py-2 text-xs">{r.lastRun ? `${r.lastRun.findings} finding(s) · ${new Date(r.lastRun.executedAt).toLocaleString()}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Modal open={!!selected} onClose={() => setSelected(null)} title={selected?.title || 'Issue'} wide footer={
        selected && (
          <div className="flex flex-wrap gap-2">
            {auth.can('issue.manage') && (
              <>
                <Button
                  onClick={async () => {
                    await govApi.updateIssue(selected.id, { assignedTo: 'usr-steward', comment: comment || 'Assigned' });
                    setSelected(await govApi.issue(selected.id));
                    await loadIssues();
                  }}
                >
                  Assign to steward
                </Button>
                <Button
                  onClick={async () => {
                    const resolution = comment || prompt('Resolution') || '';
                    if (!resolution) return;
                    await govApi.updateIssue(selected.id, { status: 'Resolved' as IssueStatus, resolution });
                    setSelected(null);
                    await loadIssues();
                  }}
                >
                  Resolve
                </Button>
              </>
            )}
            {auth.can('exception.approve') && selected.exceptionAllowed && (
              <Button
                variant="danger"
                onClick={async () => {
                  const reason = comment || prompt('Exception reason') || '';
                  if (!reason) return;
                  try {
                    await govApi.updateIssue(selected.id, { status: 'Accepted Exception', exceptionReason: reason });
                    setSelected(null);
                    await loadIssues();
                  } catch (e) {
                    setError(e instanceof ApiError ? e.message : 'Exception failed');
                  }
                }}
              >
                Accept exception
              </Button>
            )}
          </div>
        )
      }>
        {selected && (
          <div className="space-y-3 text-sm">
            <div>
              <strong>{selected.severity}</strong> · {selected.status} · {selected.category}
            </div>
            <p>{selected.description}</p>
            {selected.detectedValue && <p className="text-xs text-slate-500">Detected: {selected.detectedValue}</p>}
            {selected.expectedCondition && <p className="text-xs text-slate-500">Expected: {selected.expectedCondition}</p>}
            <textarea className={inputCls + ' min-h-20'} placeholder="Comment / resolution / exception reason" value={comment} onChange={(e) => setComment(e.target.value)} />
            <div>
              <h4 className="text-xs font-semibold uppercase text-slate-500">Comments</h4>
              {selected.comments?.map((c: any) => (
                <div key={c.id} className="border-b border-slate-100 py-1 text-xs">
                  {c.userName}: {c.text}
                </div>
              ))}
            </div>
          </div>
        )}
      </Modal>
    </Page>
  );
}
