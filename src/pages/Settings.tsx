import { useEffect, useState } from 'react';
import { ROLE_LABELS, type Role } from '../../shared/governance';
import { Page } from '../components/Layout';
import { Button, Card, inputCls, Notice, PageHeader, Spinner } from '../components/ui';
import { ApiError, govApi } from '../lib/api';
import { useAuth } from '../lib/auth';
import { download } from '../lib/format';

export function Settings() {
  const auth = useAuth();
  const [users, setUsers] = useState<any[] | null>(null);
  const [matrix, setMatrix] = useState<any>(null);
  const [password, setPassword] = useState({ current: '', next: '' });
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newUser, setNewUser] = useState({ username: '', displayName: '', password: '', roles: ['VIEWER'] as Role[] });

  useEffect(() => {
    void govApi.permissions().then(setMatrix);
    if (auth.can('users.manage')) void govApi.adminUsers().then(setUsers);
    else void govApi.users().then(setUsers);
  }, [auth.user?.id]);

  return (
    <Page>
      <PageHeader title="Settings" subtitle="Users, roles, password and database backup. Prototype disclaimer applies." />
      {error && <Notice tone="error" className="mb-4">{error}</Notice>}
      {message && <Notice tone="success" className="mb-4">{message}</Notice>}

      <Card className="mb-6 p-5">
        <h3 className="mb-1 text-sm font-semibold">Signed in as</h3>
        <p className="text-sm text-slate-600">
          {auth.user?.displayName} ({auth.user?.username}) · {auth.user?.roles.map((r) => ROLE_LABELS[r]).join(', ')}
        </p>
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          <input className={inputCls} type="password" placeholder="Current password" value={password.current} onChange={(e) => setPassword({ ...password, current: e.target.value })} />
          <input className={inputCls} type="password" placeholder="New password (10+ chars)" value={password.next} onChange={(e) => setPassword({ ...password, next: e.target.value })} />
        </div>
        <Button
          className="mt-3"
          onClick={async () => {
            try {
              await govApi.changePassword(password.current, password.next);
              setMessage('Password updated. Sign in again.');
              await auth.logout();
            } catch (e) {
              setError(e instanceof ApiError ? e.message : 'Password change failed');
            }
          }}
        >
          Change password
        </Button>
      </Card>

      <Card className="mb-6 overflow-auto">
        <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold">Users</div>
        {!users ? (
          <Spinner />
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-2">User</th>
                <th className="px-2 py-2">Roles</th>
                <th className="px-2 py-2">Active</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="px-4 py-2">
                    <div className="font-medium">{u.displayName}</div>
                    <div className="text-xs text-slate-500">{u.username}</div>
                  </td>
                  <td className="px-2 py-2 text-xs">{(u.roles as Role[]).map((r) => ROLE_LABELS[r] ?? r).join(', ')}</td>
                  <td className="px-2 py-2">{u.active === false ? 'No' : 'Yes'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {auth.can('users.manage') && (
        <Card className="mb-6 space-y-2 p-4">
          <h3 className="text-sm font-semibold">Create user</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            <input className={inputCls} placeholder="Username" value={newUser.username} onChange={(e) => setNewUser({ ...newUser, username: e.target.value })} />
            <input className={inputCls} placeholder="Display name" value={newUser.displayName} onChange={(e) => setNewUser({ ...newUser, displayName: e.target.value })} />
            <input className={inputCls} type="password" placeholder="Password" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} />
            <select className={inputCls} value={newUser.roles[0]} onChange={(e) => setNewUser({ ...newUser, roles: [e.target.value as Role] })}>
              {Object.entries(ROLE_LABELS).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <Button
            variant="primary"
            onClick={async () => {
              try {
                await govApi.createUser(newUser);
                setUsers(await govApi.adminUsers());
                setMessage('User created');
              } catch (e) {
                setError(e instanceof ApiError ? e.message : 'Create failed');
              }
            }}
          >
            Create
          </Button>
        </Card>
      )}

      {matrix && (
        <Card className="mb-6 overflow-auto">
          <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold">Permission matrix</div>
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-left uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2">Permission</th>
                {matrix.roles.map((r: Role) => (
                  <th key={r} className="px-2 py-2">
                    {ROLE_LABELS[r]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {matrix.permissions.map((p: any) => (
                <tr key={p.id}>
                  <td className="px-3 py-2 text-slate-700">{p.label}</td>
                  {matrix.roles.map((r: Role) => (
                    <td key={r} className="px-2 py-2 text-center">
                      {p.roles.includes(r) ? '✓' : ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {auth.can('system.backup') && (
        <Card className="p-4">
          <h3 className="mb-1 text-sm font-semibold">Database backup</h3>
          <p className="mb-3 text-xs text-slate-500">Downloads a SQLite snapshot. Audited.</p>
          <Button onClick={() => download(govApi.backupUrl)}>Download backup</Button>
        </Card>
      )}

      <Notice tone="warn" className="mt-6">
        This MVP uses synthetic data. It is not GxP validated, not 21 CFR Part 11 compliant, and not suitable for production clinical trial data without a separate validation and security program.
      </Notice>
    </Page>
  );
}
