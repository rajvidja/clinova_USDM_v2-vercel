import { useEffect, useState } from 'react';
import { Page } from '../components/Layout';
import { Button, Card, inputCls, Notice, PageHeader, Spinner } from '../components/ui';
import { govApi } from '../lib/api';

export function Audit() {
  const [page, setPage] = useState({ items: [] as any[], total: 0, page: 1, pageSize: 50 });
  const [filter, setFilter] = useState({ q: '', action: '', entityType: '', page: 1 });
  const [verify, setVerify] = useState<{ ok: boolean; records: number; brokenAt: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void govApi
      .audit({ q: filter.q || undefined, action: filter.action || undefined, entityType: filter.entityType || undefined, page: filter.page, pageSize: 50 })
      .then(setPage)
      .catch((e) => setError(e.message));
  }, [filter]);

  return (
    <Page wide>
      <PageHeader
        title="Audit Trail"
        subtitle="Append-only history of authentication, protocol changes, mapping, reviews, exports and administration. Records cannot be edited or deleted."
        actions={
          <Button onClick={() => govApi.auditVerify().then(setVerify)}>Verify chain</Button>
        }
      />
      {error && <Notice tone="error" className="mb-4">{error}</Notice>}
      {verify && (
        <Notice tone={verify.ok ? 'success' : 'error'} className="mb-4">
          {verify.ok ? `Chain intact across ${verify.records} records.` : `Chain broken at sequence ${verify.brokenAt}.`}
        </Notice>
      )}
      <div className="mb-3 flex flex-wrap gap-2">
        <input className={inputCls + ' w-56'} placeholder="Search…" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value, page: 1 })} />
        <input className={inputCls + ' w-44'} placeholder="Action prefix" value={filter.action} onChange={(e) => setFilter({ ...filter, action: e.target.value, page: 1 })} />
        <input className={inputCls + ' w-44'} placeholder="Entity type" value={filter.entityType} onChange={(e) => setFilter({ ...filter, entityType: e.target.value, page: 1 })} />
      </div>
      {!page.items ? (
        <Spinner />
      ) : (
        <Card className="overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2">When</th>
                <th className="px-2 py-2">User</th>
                <th className="px-2 py-2">Action</th>
                <th className="px-2 py-2">Entity</th>
                <th className="px-2 py-2">Reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {page.items.map((a) => (
                <tr key={a.id}>
                  <td className="whitespace-nowrap px-3 py-2 text-xs">{new Date(a.createdAt).toLocaleString()}</td>
                  <td className="px-2 py-2">{a.username}</td>
                  <td className="px-2 py-2 font-medium text-slate-800">{a.action}</td>
                  <td className="px-2 py-2 text-xs">
                    {a.entityType}
                    {a.entityId ? ` · ${a.entityId}` : ''}
                  </td>
                  <td className="max-w-xs truncate px-2 py-2 text-xs text-slate-500" title={a.reason ?? ''}>
                    {a.reason || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!page.items.length && <p className="p-6 text-sm text-slate-500">No audit entries match.</p>}
        </Card>
      )}
      <div className="mt-3 flex items-center gap-2 text-sm">
        <Button size="sm" disabled={filter.page <= 1} onClick={() => setFilter({ ...filter, page: filter.page - 1 })}>
          Previous
        </Button>
        <span>
          Page {page.page} · {page.total} total
        </span>
        <Button size="sm" disabled={filter.page * page.pageSize >= page.total} onClick={() => setFilter({ ...filter, page: filter.page + 1 })}>
          Next
        </Button>
      </div>
    </Page>
  );
}
