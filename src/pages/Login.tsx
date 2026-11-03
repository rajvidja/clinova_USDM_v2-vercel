import { useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { ROLE_LABELS, type Role } from '../../shared/governance';
import { Button, Card, inputCls, Notice, Spinner } from '../components/ui';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';

export function Login() {
  const auth = useAuth();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (auth.loading) return <Spinner />;
  if (auth.user) return <Navigate to={(location.state as { from?: string } | null)?.from || '/'} replace />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await auth.login(username, password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <div className="w-full max-w-md space-y-4">
        <div className="text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-lg bg-brand-600 text-lg font-bold text-white">PQ</div>
          <h1 className="text-xl font-semibold text-slate-900">ProtocolIQ</h1>
          <p className="mt-1 text-sm text-slate-500">Sign in to the structured protocol platform</p>
        </div>
        <Card className="p-6">
          <form className="space-y-3" onSubmit={submit}>
            <label className="block text-sm">
              <span className="mb-1 block text-slate-600">Username</span>
              <input className={inputCls} autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-slate-600">Password</span>
              <input className={inputCls} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </label>
            {error && <Notice tone="error">{error}</Notice>}
            <Button type="submit" variant="primary" className="w-full" loading={busy}>
              Sign in
            </Button>
          </form>
        </Card>
        {auth.demo && auth.demo.accounts.length > 0 && (
          <Card className="p-4 text-sm">
            <div className="mb-2 font-medium text-slate-800">Demo accounts</div>
            <p className="mb-3 text-xs text-slate-500">Synthetic roles for evaluation. Password for all: <code className="rounded bg-slate-100 px-1">{auth.demo.password}</code></p>
            <ul className="space-y-1.5">
              {auth.demo.accounts.map((a) => (
                <li key={a.username}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between rounded-md border border-slate-200 px-3 py-2 text-left hover:bg-slate-50"
                    onClick={() => {
                      setUsername(a.username);
                      setPassword(auth.demo!.password);
                    }}
                  >
                    <span>
                      <span className="font-medium text-slate-800">{a.displayName}</span>
                      <span className="ml-2 text-xs text-slate-500">{a.roles.map((r) => ROLE_LABELS[r as Role] ?? r).join(', ')}</span>
                    </span>
                    <span className="text-xs text-brand-700">{a.username}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        )}
        <p className="text-center text-[11px] text-slate-500">Prototype uses synthetic data. Not GxP validated or suitable for production clinical trial data.</p>
      </div>
    </div>
  );
}
