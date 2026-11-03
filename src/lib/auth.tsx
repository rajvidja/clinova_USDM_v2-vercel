import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Permission, SessionUser } from '../../shared/governance';
import { ApiError, request } from './api';

interface AuthState {
  user: SessionUser | null;
  loading: boolean;
  demo: { password: string; accounts: { username: string; displayName: string; roles: string[] }[] } | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  can: (permission: Permission) => boolean;
}

const AuthCtx = createContext<AuthState | null>(null);

async function me(): Promise<SessionUser | null> {
  try {
    return await request<SessionUser>('/api/auth/me');
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null;
    throw e;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [demo, setDemo] = useState<AuthState['demo']>(null);

  const refresh = async () => {
    setUser(await me());
  };

  useEffect(() => {
    void (async () => {
      try {
        const [u, d] = await Promise.all([me(), request<AuthState['demo']>('/api/auth/demo-accounts').catch(() => null)]);
        setUser(u);
        setDemo(d);
      } finally {
        setLoading(false);
      }
    })();
    const onUnauth = () => setUser(null);
    window.addEventListener('piq:unauthorized', onUnauth);
    return () => window.removeEventListener('piq:unauthorized', onUnauth);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      loading,
      demo,
      refresh,
      can: (p) => !!user && (user.permissions.includes(p) || user.roles.includes('ADMIN')),
      login: async (username, password) => {
        const u = await request<SessionUser>('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
        setUser(u);
      },
      logout: async () => {
        await request('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => undefined);
        setUser(null);
      },
    }),
    [user, loading, demo],
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error('useAuth requires AuthProvider');
  return ctx;
}
