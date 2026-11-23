import { Menu, X } from 'lucide-react';
import { useState } from 'react';
import type { AuthUser } from '../types.ts';

export type AppRoute =
  | 'home'
  | 'hospital'
  | 'compare'
  | 'submit'
  | 'my-updates'
  | 'help'
  | 'auth'
  | 'admin';

interface TopBarProps {
  currentRoute: AppRoute;
  user: AuthUser | null;
  compareCount: number;
  onNavigate: (route: AppRoute) => void;
  onLogout: () => void;
}

export function TopBar({ currentRoute, user, compareCount, onNavigate, onLogout }: TopBarProps) {
  const [mobileOpen, setMobileOpen] = useState(false);

  const navItems: Array<{ route: AppRoute; label: string }> = [
    { route: 'home', label: 'Hospitals' },
    { route: 'compare', label: compareCount > 0 ? `Compare (${compareCount})` : 'Compare' },
    { route: 'submit', label: 'Submit Update' },
    ...(user?.role === 'admin'
      ? [{ route: 'admin' as AppRoute, label: 'Admin Console' }]
      : user
        ? [{ route: 'my-updates' as AppRoute, label: 'My Updates' }]
        : []),
    { route: 'help', label: 'How It Works' },
  ];

  const handleNav = (route: AppRoute) => {
    setMobileOpen(false);
    onNavigate(route);
  };

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-8 px-4 py-3.5 sm:px-6">
        {/* Zone 1: Single-line brand wordmark */}
        <button
          type="button"
          onClick={() => handleNav('home')}
          className="font-display text-xl font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-teal-700"
        >
          HospitEase AI
        </button>

        {/* Zone 2: Clean single-line navigation links */}
        <nav aria-label="Primary" className="hidden md:flex items-center gap-6">
          {navItems.map((item) => {
            const active =
              currentRoute === item.route || (item.route === 'home' && currentRoute === 'hospital');
            return (
              <button
                key={item.route}
                type="button"
                onClick={() => handleNav(item.route)}
                className={`min-h-[40px] border-b-2 px-1 text-sm font-medium transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-teal-700 ${
                  active
                    ? 'border-teal-700 text-teal-800'
                    : 'border-transparent text-slate-600 hover:border-slate-300 hover:text-slate-900'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </nav>

        {/* Zone 3: Single primary action */}
        <div className="hidden md:flex items-center gap-3 shrink-0">
          {user ? (
            <button
              type="button"
              onClick={onLogout}
              className="min-h-[40px] rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 transition-colors hover:bg-slate-50 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
            >
              Sign Out ({user.name.split(' ')[0]})
            </button>
          ) : (
            <button
              type="button"
              onClick={() => handleNav('auth')}
              className="min-h-[40px] rounded-lg bg-teal-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-teal-800 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
            >
              Sign In
            </button>
          )}
        </div>

        {/* Mobile menu toggle (>= 44px touch target) */}
        <button
          type="button"
          aria-label={mobileOpen ? 'Close navigation menu' : 'Open navigation menu'}
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen((v) => !v)}
          className="flex h-11 w-11 items-center justify-center rounded-lg border border-slate-200 text-slate-700 md:hidden"
        >
          {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {/* Mobile navigation drawer */}
      {mobileOpen && (
        <div className="border-t border-slate-200 bg-white px-4 py-3 md:hidden">
          <div className="flex flex-col gap-1">
            {navItems.map((item) => {
              const active =
                currentRoute === item.route || (item.route === 'home' && currentRoute === 'hospital');
              return (
                <button
                  key={item.route}
                  type="button"
                  onClick={() => handleNav(item.route)}
                  className={`min-h-[44px] rounded-lg px-3 text-left text-base font-medium ${
                    active ? 'bg-teal-50 text-teal-800' : 'text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
            <div className="mt-2 border-t border-slate-100 pt-2">
              {user ? (
                <button
                  type="button"
                  onClick={() => {
                    setMobileOpen(false);
                    onLogout();
                  }}
                  className="min-h-[44px] w-full rounded-lg border border-slate-300 px-3 text-left text-base font-medium text-slate-800"
                >
                  Sign Out ({user.name})
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => handleNav('auth')}
                  className="min-h-[44px] w-full rounded-lg bg-teal-700 px-3 text-center text-base font-medium text-white"
                >
                  Sign In / Register
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
