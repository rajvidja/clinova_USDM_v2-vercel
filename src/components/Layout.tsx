import clsx from 'clsx';
import {
  CalendarRange,
  ClipboardCheck,
  Compass,
  Download,
  FilePlus2,
  FileScan,
  FolderKanban,
  GitBranch,
  History,
  LayoutDashboard,
  LogOut,
  Network,
  Scale,
  Settings,
  ShieldCheck,
  Shuffle,
} from 'lucide-react';
import { useEffect, useState, type ComponentType } from 'react';
import { NavLink, Navigate, Outlet, useLocation } from 'react-router-dom';
import type { Permission } from '../../shared/governance';
import { ROLE_LABELS } from '../../shared/governance';
import { useAuth } from '../lib/auth';
import { Login } from '../pages/Login';
import { Spinner } from './ui';

type NavItem = { to: string; label: string; icon: ComponentType<{ className?: string }>; end?: boolean; permission?: Permission };
type NavGroup = { label: string; items: NavItem[] };

const NAV: NavGroup[] = [
  {
    label: 'Workspace',
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
      { to: '/studies', label: 'Studies', icon: FolderKanban },
      { to: '/digitisation', label: 'Protocol Digitisation', icon: FileScan, permission: 'protocol.create' },
      { to: '/builder', label: 'Protocol Builder', icon: FilePlus2, permission: 'protocol.create' },
      { to: '/explorer', label: 'Protocol Explorer', icon: Compass },
      { to: '/soa', label: 'Schedule of Activities', icon: CalendarRange },
      { to: '/relationships', label: 'Relationship Map', icon: Network },
    ],
  },
  {
    label: 'USDM & Governance',
    items: [
      { to: '/usdm', label: 'USDM Mapping Studio', icon: Shuffle },
      { to: '/governance', label: 'Data Governance', icon: ShieldCheck },
      { to: '/lineage', label: 'Data Lineage', icon: GitBranch },
      { to: '/quality', label: 'Data Quality', icon: Scale },
      { to: '/review', label: 'Review & Validation', icon: ClipboardCheck },
      { to: '/audit', label: 'Audit Trail', icon: History, permission: 'audit.read' },
      { to: '/versions', label: 'Version History', icon: History },
      { to: '/export', label: 'Export Center', icon: Download },
    ],
  },
  {
    label: 'System',
    items: [{ to: '/settings', label: 'Settings', icon: Settings }],
  },
];

export function Layout() {
  const auth = useAuth();
  const location = useLocation();
  const [demo, setDemo] = useState(false);
  useEffect(() => {
    void fetch('/api/health')
      .then((r) => r.json())
      .then((h: { demo?: boolean }) => setDemo(!!h.demo))
      .catch(() => undefined);
  }, []);

  if (auth.loading) return <Spinner />;
  if (!auth.user) {
    if (location.pathname === '/login') return <Login />;
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  const visible = NAV.map((g) => ({ ...g, items: g.items.filter((i) => !i.permission || auth.can(i.permission) || auth.can('study.read')) })).filter((g) => g.items.length);

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col bg-navy-900 text-slate-300">
        <div className="flex items-center gap-2 px-5 py-5">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-brand-500 text-sm font-bold text-white">PQ</div>
          <div>
            <div className="text-[15px] font-semibold leading-tight text-white">ProtocolIQ</div>
            <div className="text-[11px] text-slate-400">Structured protocol platform</div>
          </div>
        </div>
        <nav className="flex-1 space-y-4 overflow-y-auto px-3 py-2">
          {visible.map((group) => (
            <div key={group.label}>
              <div className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-wider text-slate-500">{group.label}</div>
              <div className="space-y-0.5">
                {group.items.map(({ to, label, icon: Icon, end }) => (
                  <NavLink
                    key={to}
                    to={to}
                    end={end}
                    className={({ isActive }) =>
                      clsx('flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors', isActive ? 'bg-navy-700 font-medium text-white' : 'hover:bg-navy-800 hover:text-white')
                    }
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    {label}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>
        <div className="border-t border-navy-700 px-4 py-3">
          <div className="truncate text-sm font-medium text-white">{auth.user.displayName}</div>
          <div className="truncate text-[11px] text-slate-400">{auth.user.roles.map((r) => ROLE_LABELS[r] ?? r).join(', ')}</div>
          <button type="button" onClick={() => void auth.logout()} className="mt-2 inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-white">
            <LogOut className="h-3.5 w-3.5" /> Sign out
          </button>
        </div>
        <div className="border-t border-navy-700 px-5 py-3 text-[11px] leading-relaxed text-slate-500">Rule-based authoring and USDM mapping. No generative AI.</div>
      </aside>
      <main className="min-w-0 flex-1">
        {demo && (
          <div className="border-b border-amber-200 bg-amber-50 px-8 py-2 text-xs text-amber-800">
            Demo deployment: data is stored temporarily and resets when the server restarts. Synthetic data only — not for production clinical trial use.
          </div>
        )}
        <Outlet />
      </main>
    </div>
  );
}

export function Page({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return <div className={clsx('mx-auto px-8 py-8', wide ? 'max-w-[1600px]' : 'max-w-6xl')}>{children}</div>;
}
