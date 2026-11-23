import {
  Activity,
  ArrowLeft,
  BarChart3,
  BedDouble,
  Bell,
  Bot,
  Building2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Clock,
  Cpu,
  FileSpreadsheet,
  GitCompare,
  History,
  Home,
  LayoutDashboard,
  LogIn,
  LogOut,
  Menu,
  MessageSquarePlus,
  Radio,
  Search,
  Settings,
  ShieldCheck,
  Stethoscope,
  User,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../lib/api.ts';
import { useLiveEvents } from '../lib/useLiveEvents.ts';
import type { AdminSection, AppRoute, AuthUser, DashboardSummaryResponse } from '../types.ts';

interface AppShellProps {
  currentRoute: AppRoute;
  adminSection: AdminSection;
  user: AuthUser | null;
  compareCount: number;
  globalSearchQuery: string;
  onNavigate: (route: AppRoute) => void;
  onAdminSectionChange: (section: AdminSection) => void;
  onGlobalSearch: (query: string) => void;
  onOpenHospital: (hospitalId: number) => void;
  onLogout: () => void;
  children: React.ReactNode;
}

export function AppShell({
  currentRoute,
  adminSection,
  user,
  compareCount,
  globalSearchQuery,
  onNavigate,
  onAdminSectionChange,
  onGlobalSearch,
  onOpenHospital,
  onLogout,
  children,
}: AppShellProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [searchInput, setSearchInput] = useState(globalSearchQuery);
  const [notifOpen, setNotifOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [latestUpdates, setLatestUpdates] = useState<DashboardSummaryResponse['latest_updates']>([]);

  const notifRef = useRef<HTMLDivElement>(null);
  const profileRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSearchInput(globalSearchQuery);
  }, [globalSearchQuery]);

  const refreshNotifications = useCallback(() => {
    apiFetch<DashboardSummaryResponse>('/api/dashboard/summary')
      .then((res) => setLatestUpdates(res.latest_updates.slice(0, 4)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshNotifications();
  }, [currentRoute, refreshNotifications]);

  useLiveEvents((ev) => {
    if (ev.type === 'queue:updated' || ev.type === 'feed:synced') {
      refreshNotifications();
    }
  });

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setNotifOpen(false);
      }
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) {
        setProfileOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const todayIst = new Date().toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });

  const isAdminMode = currentRoute === 'admin' && user?.role === 'admin';

  const patientNavItems: Array<{
    id: AppRoute;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    badge?: string;
    requiresAuth?: boolean;
  }> = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'hospitals', label: 'Find Hospitals', icon: Search },
    { id: 'opd-queue', label: 'OPD Queue', icon: Clock },
    { id: 'beds', label: 'Bed Availability', icon: BedDouble },
    {
      id: 'compare',
      label: 'Compare Hospitals',
      icon: GitCompare,
      badge: compareCount > 0 ? String(compareCount) : undefined,
    },
    { id: 'submit', label: 'Submit Update', icon: MessageSquarePlus },
    { id: 'assistant', label: 'AI & Voice Assistant', icon: Bot },
    { id: 'ml-info', label: 'ML & Methodology', icon: Cpu },
    ...(user
      ? [
          { id: 'my-activity' as AppRoute, label: 'My Activity', icon: History },
          { id: 'profile' as AppRoute, label: 'Profile', icon: User },
        ]
      : []),
  ];

  const adminNavItems: Array<{
    id: AdminSection;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
  }> = [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard },
    { id: 'hospitals', label: 'Manage Hospitals', icon: Building2 },
    { id: 'departments', label: 'Manage Departments', icon: Stethoscope },
    { id: 'beds', label: 'Bed Records', icon: BedDouble },
    { id: 'crowd-updates', label: 'Crowd Updates', icon: Activity },
    { id: 'moderation', label: 'Moderation', icon: ClipboardCheck },
    { id: 'csv-import', label: 'CSV Import', icon: FileSpreadsheet },
    { id: 'live-feeds', label: 'Live HMS Feeds', icon: Radio },
    { id: 'ml-models', label: 'ML Model Management', icon: BarChart3 },
    { id: 'audit-logs', label: 'Audit Logs', icon: ShieldCheck },
    { id: 'settings', label: 'Settings', icon: Settings },
  ];

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onGlobalSearch(searchInput);
  };

  const handleSelectRoute = (next: AppRoute) => {
    setMobileMenuOpen(false);
    onNavigate(next);
  };

  const handleSelectAdminSection = (sec: AdminSection) => {
    setMobileMenuOpen(false);
    onAdminSectionChange(sec);
    if (currentRoute !== 'admin') {
      onNavigate('admin');
    }
  };

  const renderSidebarContent = (isMobile = false) => {
    const collapsed = !isMobile && sidebarCollapsed;
    return (
      <div className="flex h-full flex-col bg-[#12304A] text-white">
        {/* Brand Header */}
        <div className="flex h-16 items-center justify-between border-b border-white/10 px-4">
          <button
            type="button"
            onClick={() => handleSelectRoute('landing')}
            className="flex items-center gap-2.5 text-left focus:outline-none"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#16A6A1] text-white shadow-sm">
              <Stethoscope className="h-5 w-5" aria-hidden="true" />
            </div>
            {!collapsed && (
              <div className="leading-tight">
                <span className="font-display text-base font-bold tracking-tight text-white">
                  HospitEase AI
                </span>
                <span className="block text-[11px] font-medium text-sky-200/80">
                  {isAdminMode ? 'Admin Operations' : 'OPD & Bed Intelligence'}
                </span>
              </div>
            )}
          </button>

          {isMobile ? (
            <button
              type="button"
              onClick={() => setMobileMenuOpen(false)}
              aria-label="Close navigation menu"
              className="rounded-lg p-1.5 text-slate-300 hover:bg-white/10 hover:text-white"
            >
              <X className="h-5 w-5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setSidebarCollapsed((c) => !c)}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className="hidden rounded-lg p-1.5 text-slate-300 hover:bg-white/10 hover:text-white lg:inline-flex"
            >
              {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
            </button>
          )}
        </div>

        {/* Navigation Links */}
        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4" aria-label="Primary Sidebar">
          {!isAdminMode ? (
            <>
              <button
                type="button"
                onClick={() => handleSelectRoute('landing')}
                className="flex min-h-[42px] w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-white/10 hover:text-white"
              >
                <Home className="h-4 w-4 shrink-0" aria-hidden="true" />
                {!collapsed && <span className="truncate">Home Overview</span>}
              </button>

              {!collapsed && (
                <div className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-sky-200/60">
                  Patient Workspace
                </div>
              )}

              {patientNavItems.map((item) => {
                const Icon = item.icon;
                const active =
                  currentRoute === item.id ||
                  (item.id === 'hospitals' && currentRoute === 'hospital');
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleSelectRoute(item.id)}
                    title={collapsed ? item.label : undefined}
                    className={`flex min-h-[42px] w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                      active
                        ? 'bg-[#1769AA] text-white shadow-sm'
                        : 'text-slate-200 hover:bg-white/10 hover:text-white'
                    }`}
                  >
                    <span className="flex items-center gap-3 min-w-0">
                      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                      {!collapsed && <span className="truncate">{item.label}</span>}
                    </span>
                    {!collapsed && item.badge && (
                      <span className="rounded-md bg-[#16A6A1] px-1.5 py-0.5 font-mono text-xs font-semibold text-white tabular-nums">
                        {item.badge}
                      </span>
                    )}
                  </button>
                );
              })}

              {user?.role === 'admin' && (
                <>
                  {!collapsed && (
                    <div className="px-3 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wider text-sky-200/60">
                      Administration
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      onAdminSectionChange('overview');
                      handleSelectRoute('admin');
                    }}
                    className="flex min-h-[42px] w-full items-center gap-3 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm font-medium text-teal-200 transition-colors hover:bg-white/10 hover:text-white"
                  >
                    <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
                    {!collapsed && <span className="truncate">Admin Dashboard</span>}
                  </button>
                </>
              )}
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => handleSelectRoute('dashboard')}
                className="mb-2 flex min-h-[40px] w-full items-center gap-2.5 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-xs font-semibold text-sky-100 transition-colors hover:bg-white/10"
              >
                <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden="true" />
                {!collapsed && <span>Back to Patient Portal</span>}
              </button>

              {!collapsed && (
                <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-sky-200/60">
                  Admin Controls
                </div>
              )}

              {adminNavItems.map((item) => {
                const Icon = item.icon;
                const active = adminSection === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleSelectAdminSection(item.id)}
                    title={collapsed ? item.label : undefined}
                    className={`flex min-h-[40px] w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                      active
                        ? 'bg-[#1769AA] text-white shadow-sm'
                        : 'text-slate-200 hover:bg-white/10 hover:text-white'
                    }`}
                  >
                    <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                    {!collapsed && <span className="truncate">{item.label}</span>}
                  </button>
                );
              })}
            </>
          )}
        </nav>

        {/* Bottom Auth Action */}
        <div className="border-t border-white/10 p-3">
          {user ? (
            <button
              type="button"
              onClick={() => {
                setMobileMenuOpen(false);
                onLogout();
              }}
              className="flex min-h-[42px] w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-white/10 hover:text-white"
            >
              <LogOut className="h-4 w-4 shrink-0 text-rose-300" aria-hidden="true" />
              {!collapsed && <span>Logout</span>}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => handleSelectRoute('auth')}
              className="flex min-h-[42px] w-full items-center gap-3 rounded-lg bg-[#16A6A1] px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#138f8a]"
            >
              <LogIn className="h-4 w-4 shrink-0" aria-hidden="true" />
              {!collapsed && <span>Sign In / Register</span>}
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="flex min-h-screen bg-[#F5F8FC] text-[#243447]">
      {/* Desktop Sidebar */}
      <aside
        className={`hidden shrink-0 transition-all duration-200 lg:block ${
          sidebarCollapsed ? 'w-[74px]' : 'w-[252px]'
        }`}
      >
        <div className="sticky top-0 h-screen">{renderSidebarContent(false)}</div>
      </aside>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden" role="dialog" aria-modal="true">
          <div
            className="fixed inset-0 bg-[#12304A]/50 backdrop-blur-xs"
            onClick={() => setMobileMenuOpen(false)}
          />
          <div className="relative z-10 h-full w-72 max-w-[85vw] shadow-xl">
            {renderSidebarContent(true)}
          </div>
        </div>
      )}

      {/* Main Column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top Navigation Bar */}
        <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur-sm">
          <div className="flex h-16 items-center justify-between gap-3 px-4 sm:px-6">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <button
                type="button"
                onClick={() => setMobileMenuOpen(true)}
                aria-label="Open menu"
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-[#243447] hover:bg-slate-50 lg:hidden"
              >
                <Menu className="h-5 w-5" />
              </button>

              <form onSubmit={handleSearchSubmit} className="relative w-full max-w-md">
                <label htmlFor="topbar-search" className="sr-only">
                  Search hospitals, departments, or cities
                </label>
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#718096]"
                  aria-hidden="true"
                />
                <input
                  id="topbar-search"
                  type="search"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Search hospital, location, or department..."
                  className="h-10 w-full rounded-lg border border-slate-200 bg-[#F5F8FC] pl-9 pr-16 text-sm text-[#243447] placeholder:text-[#718096] focus:border-[#1769AA] focus:bg-white focus:outline-none"
                />
                <button
                  type="submit"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md bg-[#1769AA] px-2.5 py-1 text-xs font-medium text-white hover:bg-[#125388]"
                >
                  Search
                </button>
              </form>
            </div>

            <div className="flex items-center gap-2 sm:gap-3 shrink-0">
              {/* Current IST Date */}
              <div className="hidden items-center gap-1.5 rounded-lg border border-slate-200 bg-[#F5F8FC] px-3 py-1.5 text-xs font-medium text-[#718096] md:flex">
                <span className="font-mono text-[#243447] tabular-nums">{todayIst}</span>
                <span>IST</span>
              </div>

              {/* Notifications Popover */}
              <div className="relative" ref={notifRef}>
                <button
                  type="button"
                  onClick={() => setNotifOpen((o) => !o)}
                  aria-label="Queue notifications"
                  className="relative inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 bg-white text-[#243447] hover:bg-slate-50"
                >
                  <Bell className="h-4 w-4" />
                  {latestUpdates.length > 0 && (
                    <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-[#16A6A1]" />
                  )}
                </button>

                {notifOpen && (
                  <div className="absolute right-0 mt-2 w-80 rounded-xl border border-slate-200 bg-white p-3 shadow-lg">
                    <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                      <span className="font-display text-sm font-semibold text-[#12304A]">
                        Recent Queue Updates
                      </span>
                    </div>
                    <div className="mt-2 space-y-2">
                      {latestUpdates.length === 0 ? (
                        <p className="py-3 text-center text-xs text-[#718096]">
                          No recent crowd reports available.
                        </p>
                      ) : (
                        latestUpdates.map((u) => (
                          <button
                            key={u.update_id}
                            type="button"
                            onClick={() => {
                              setNotifOpen(false);
                              onOpenHospital(u.hospital_id);
                            }}
                            className="w-full rounded-lg border border-slate-100 bg-[#F5F8FC] p-2.5 text-left transition-colors hover:border-[#1769AA]/40"
                          >
                            <div className="flex items-center justify-between gap-2 text-xs font-semibold text-[#243447]">
                              <span className="truncate">{u.hospital_name}</span>
                              <span className="font-mono text-[#1769AA] tabular-nums">
                                {u.waiting_minutes} min
                              </span>
                            </div>
                            <div className="mt-0.5 text-[11px] text-[#718096]">
                              {u.department_name} · {u.queue_level} · {u.submitted_at_ist}
                            </div>
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* User Profile Dropdown */}
              <div className="relative" ref={profileRef}>
                <button
                  type="button"
                  onClick={() => setProfileOpen((o) => !o)}
                  className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 text-sm font-medium text-[#243447] hover:bg-slate-50"
                >
                  <div className="flex h-7 w-7 items-center justify-center rounded-md bg-[#1769AA]/10 text-[#1769AA]">
                    <User className="h-4 w-4" />
                  </div>
                  <div className="hidden text-left sm:block">
                    <div className="max-w-[120px] truncate text-xs font-semibold text-[#12304A]">
                      {user ? user.name : 'Guest Visitor'}
                    </div>
                    <div className="text-[10px] text-[#718096]">
                      {user ? (user.role === 'admin' ? 'Administrator' : 'Registered User') : 'Public Access'}
                    </div>
                  </div>
                  <ChevronDown className="h-3.5 w-3.5 text-[#718096]" />
                </button>

                {profileOpen && (
                  <div className="absolute right-0 mt-2 w-56 rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg">
                    <div className="border-b border-slate-100 px-3 py-2">
                      <p className="truncate text-xs font-semibold text-[#12304A]">
                        {user ? user.name : 'Guest Mode'}
                      </p>
                      <p className="truncate text-[11px] text-[#718096]">
                        {user ? user.email : 'Sign in to submit live queue updates'}
                      </p>
                    </div>
                    <div className="py-1">
                      <button
                        type="button"
                        onClick={() => {
                          setProfileOpen(false);
                          handleSelectRoute('dashboard');
                        }}
                        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-[#243447] hover:bg-[#F5F8FC]"
                      >
                        <LayoutDashboard className="h-4 w-4 text-[#1769AA]" />
                        <span>Dashboard</span>
                      </button>
                      {user && (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              setProfileOpen(false);
                              handleSelectRoute('my-activity');
                            }}
                            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-[#243447] hover:bg-[#F5F8FC]"
                          >
                            <History className="h-4 w-4 text-[#16A6A1]" />
                            <span>My Activity</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setProfileOpen(false);
                              handleSelectRoute('profile');
                            }}
                            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-[#243447] hover:bg-[#F5F8FC]"
                          >
                            <User className="h-4 w-4 text-[#718096]" />
                            <span>Profile &amp; Settings</span>
                          </button>
                        </>
                      )}
                      {user?.role === 'admin' && (
                        <button
                          type="button"
                          onClick={() => {
                            setProfileOpen(false);
                            onAdminSectionChange('overview');
                            handleSelectRoute('admin');
                          }}
                          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-[#1769AA] hover:bg-[#F5F8FC]"
                        >
                          <ShieldCheck className="h-4 w-4" />
                          <span>Admin Console</span>
                        </button>
                      )}
                    </div>
                    <div className="border-t border-slate-100 pt-1">
                      {user ? (
                        <button
                          type="button"
                          onClick={() => {
                            setProfileOpen(false);
                            onLogout();
                          }}
                          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-[#E05252] hover:bg-red-50"
                        >
                          <LogOut className="h-4 w-4" />
                          <span>Sign Out</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setProfileOpen(false);
                            handleSelectRoute('auth');
                          }}
                          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-semibold text-[#1769AA] hover:bg-[#F5F8FC]"
                        >
                          <LogIn className="h-4 w-4" />
                          <span>Sign In / Register</span>
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </header>

        {/* Page Body */}
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>

        {/* Footer */}
        <footer className="border-t border-slate-200 bg-white">
          <div className="mx-auto flex max-w-6xl flex-col justify-between gap-3 px-4 py-4 text-xs text-[#718096] sm:flex-row sm:items-center sm:px-6">
            <p>
              <span className="font-semibold text-[#12304A]">HospitEase AI</span> · Waiting times are estimates
              and may change depending on hospital conditions.{' '}
              <span className="font-medium text-[#A16207]">
                Not for medical emergencies — dial 112 (India).
              </span>
            </p>
            <div className="flex flex-wrap items-center gap-4 shrink-0">
              <button
                type="button"
                onClick={() => handleSelectRoute('landing')}
                className="font-medium text-[#1769AA] hover:underline"
              >
                Home
              </button>
              <button
                type="button"
                onClick={() => handleSelectRoute('ml-info')}
                className="font-medium text-[#1769AA] hover:underline"
              >
                ML &amp; Methodology
              </button>
              <button
                type="button"
                onClick={() => handleSelectRoute('hospitals')}
                className="font-medium text-[#243447] hover:underline"
              >
                Find Hospitals
              </button>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
