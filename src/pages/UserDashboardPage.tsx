import {
  Activity,
  ArrowRight,
  BedDouble,
  Bookmark,
  Bot,
  Building2,
  Clock,
  Cpu,
  GitCompare,
  History,
  MessageSquarePlus,
  Search,
  Stethoscope,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  BedStatusIndicator,
  EmergencyNotice,
  QueueLevelBadge,
} from '../components/StatusIndicators.tsx';
import { useFirebase } from '../contexts/FirebaseContext.tsx';
import { getRecentlyViewedHospitals, getRecentSearches, type ViewedHospitalEntry } from '../lib/activity.ts';
import { apiFetch, ApiError } from '../lib/api.ts';
import { useLiveEvents } from '../lib/useLiveEvents.ts';
import type { AppRoute, AuthUser, DashboardSummaryResponse } from '../types.ts';

interface UserDashboardPageProps {
  user: AuthUser | null;
  onNavigate: (route: AppRoute) => void;
  onSearchHospitals: (query: string) => void;
  onOpenHospital: (hospitalId: number) => void;
}

export function UserDashboardPage({
  user,
  onNavigate,
  onSearchHospitals,
  onOpenHospital,
}: UserDashboardPageProps) {
  const { firebaseUser, savedHospitals, toggleSaveHospital, signInWithGoogle } = useFirebase();
  const [summary, setSummary] = useState<DashboardSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recentSearches] = useState<string[]>(() => getRecentSearches());
  const [recentHospitals] = useState<ViewedHospitalEntry[]>(() => getRecentlyViewedHospitals());

  const loadSummary = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const res = await apiFetch<DashboardSummaryResponse>('/api/dashboard/summary');
      setSummary(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to load dashboard summary.');
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSummary(true);
  }, [loadSummary]);

  useLiveEvents(() => {
    loadSummary(false);
  });

  const totalQueueBuckets = summary
    ? summary.queue_distribution.Low + summary.queue_distribution.Medium + summary.queue_distribution.High
    : 0;

  return (
    <div className="space-y-6">
      {/* Header Welcome Banner */}
      <section className="flex flex-col justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-6 sm:flex-row sm:items-center">
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="text-xs font-semibold uppercase tracking-wider text-[#16A6A1]">
              {user ? `Signed in as ${user.name}` : 'Guest Patient Workspace'}
            </span>
          </div>
          <h1 className="mt-1.5 font-display text-2xl font-bold text-[#12304A] sm:text-3xl">
            Welcome back! Your healthcare information at a glance.
          </h1>
          <p className="mt-1 text-sm text-[#718096]">
            Review hospital OPD queue distributions, bed occupancy summaries, and recent crowdsourced updates.
          </p>
        </div>

        <div className="flex flex-wrap gap-2.5 shrink-0">
          <button
            type="button"
            onClick={() => onNavigate('hospitals')}
            className="inline-flex min-h-[42px] items-center gap-2 rounded-xl bg-[#1769AA] px-4 py-2 text-sm font-semibold text-white hover:bg-[#125388]"
          >
            <Search className="h-4 w-4" />
            <span>Find Hospitals</span>
          </button>
          <button
            type="button"
            onClick={() => onNavigate('submit')}
            className="inline-flex min-h-[42px] items-center gap-2 rounded-xl border border-[#16A6A1] bg-[#16A6A1]/10 px-4 py-2 text-sm font-semibold text-[#117A76] hover:bg-[#16A6A1]/20"
          >
            <MessageSquarePlus className="h-4 w-4" />
            <span>Submit Update</span>
          </button>
        </div>
      </section>

      {error && (
        <div role="alert" className="rounded-xl border border-[#E05252]/40 bg-red-50 p-4 text-sm text-red-900">
          {error}
        </div>
      )}

      {/* 4 KPI Cards */}
      {loading && !summary ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map((n) => (
            <div key={n} className="h-28 animate-pulse rounded-xl border border-slate-200 bg-white p-5" />
          ))}
        </div>
      ) : (
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              label: 'Hospitals Available',
              value: summary?.counts.hospitals_available ?? 0,
              icon: Building2,
              tone: 'bg-[#1769AA]/10 text-[#1769AA]',
              onClick: () => onNavigate('hospitals'),
            },
            {
              label: 'OPD Departments',
              value: summary?.counts.opd_departments ?? 0,
              icon: Stethoscope,
              tone: 'bg-[#16A6A1]/12 text-[#117A76]',
              onClick: () => onNavigate('opd-queue'),
            },
            {
              label: 'Recent Queue Updates',
              value: summary?.counts.recent_queue_updates ?? 0,
              icon: Activity,
              tone: 'bg-[#16A36A]/10 text-[#117A4F]',
              onClick: () => onNavigate('submit'),
            },
            {
              label: 'Hospitals with Bed Information',
              value: summary?.counts.hospitals_with_beds ?? 0,
              icon: BedDouble,
              tone: 'bg-[#12304A]/10 text-[#12304A]',
              onClick: () => onNavigate('beds'),
            },
          ].map((kpi) => {
            const Icon = kpi.icon;
            return (
              <button
                key={kpi.label}
                type="button"
                onClick={kpi.onClick}
                className="flex items-start justify-between rounded-xl border border-slate-200 bg-white p-5 text-left shadow-xs transition-all hover:border-[#1769AA]/40 hover:shadow-sm"
              >
                <div>
                  <span className="text-xs font-medium text-[#718096]">{kpi.label}</span>
                  <div className="mt-2 font-mono text-3xl font-bold text-[#12304A] tabular-nums">
                    {kpi.value}
                  </div>
                </div>
                <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${kpi.tone}`}>
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </div>
              </button>
            );
          })}
        </section>
      )}

      {/* Quick Actions Strip */}
      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-[#718096]">
          Quick Actions
        </h2>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
          {[
            { label: 'Find Hospitals', route: 'hospitals' as AppRoute, icon: Search },
            { label: 'OPD Queue Gauge', route: 'opd-queue' as AppRoute, icon: Clock },
            { label: 'Bed Availability', route: 'beds' as AppRoute, icon: BedDouble },
            { label: 'Compare Hospitals', route: 'compare' as AppRoute, icon: GitCompare },
            { label: 'Submit Update', route: 'submit' as AppRoute, icon: MessageSquarePlus },
            { label: 'AI & Voice', route: 'assistant' as AppRoute, icon: Bot },
            { label: 'ML Information', route: 'ml-info' as AppRoute, icon: Cpu },
          ].map((act) => {
            const Icon = act.icon;
            return (
              <button
                key={act.label}
                type="button"
                onClick={() => onNavigate(act.route)}
                className="flex min-h-[46px] items-center gap-2 rounded-xl border border-slate-200 bg-[#F5F8FC] px-3 py-2.5 text-left text-xs font-semibold text-[#12304A] transition-colors hover:border-[#1769AA] hover:bg-white hover:text-[#1769AA]"
              >
                <Icon className="h-4 w-4 shrink-0 text-[#1769AA]" aria-hidden="true" />
                <span>{act.label}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Queue Status Overview & Hospital Bed Availability Overview */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Queue Status Overview */}
        <section className="rounded-xl border border-slate-200 bg-white p-6 lg:col-span-5">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <div>
              <h2 className="font-display text-lg font-semibold text-[#12304A]">Queue Status Overview</h2>
              <p className="text-xs text-[#718096]">Latest department waiting distribution</p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('opd-queue')}
              className="text-xs font-semibold text-[#1769AA] hover:underline"
            >
              Inspect Queue
            </button>
          </div>

          <div className="mt-5 space-y-4">
            {[
              {
                label: 'Low Queue (< 20 min)',
                count: summary?.queue_distribution.Low ?? 0,
                barColor: 'bg-[#16A36A]',
                textColor: 'text-[#117A4F]',
              },
              {
                label: 'Medium Queue (20–45 min)',
                count: summary?.queue_distribution.Medium ?? 0,
                barColor: 'bg-[#F59E0B]',
                textColor: 'text-[#A16207]',
              },
              {
                label: 'High Queue (> 45 min)',
                count: summary?.queue_distribution.High ?? 0,
                barColor: 'bg-[#E05252]',
                textColor: 'text-[#B91C1C]',
              },
            ].map((row) => {
              const pct = totalQueueBuckets > 0 ? Math.round((row.count / totalQueueBuckets) * 100) : 0;
              return (
                <div key={row.label} className="space-y-1.5">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium text-[#243447]">{row.label}</span>
                    <span className={`font-mono font-semibold tabular-nums ${row.textColor}`}>
                      {row.count} OPDs ({pct}%)
                    </span>
                  </div>
                  <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${row.barColor}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Hospital Bed Availability Overview */}
        <section className="rounded-xl border border-slate-200 bg-white p-6 lg:col-span-7">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <div>
              <h2 className="font-display text-lg font-semibold text-[#12304A]">
                Hospital Availability Overview
              </h2>
              <p className="text-xs text-[#718096]">Aggregated ward bed capacity across hospitals</p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('beds')}
              className="text-xs font-semibold text-[#1769AA] hover:underline"
            >
              All Wards
            </button>
          </div>

          <div className="mt-4 space-y-3">
            {(summary?.hospital_bed_overview || []).map((h) => {
              const barColor =
                h.availability_pct >= 30
                  ? 'bg-[#16A36A]'
                  : h.availability_pct >= 10
                    ? 'bg-[#F59E0B]'
                    : 'bg-[#E05252]';
              return (
                <div
                  key={h.hospital_id}
                  className="flex flex-col justify-between gap-2 rounded-xl border border-slate-100 bg-[#F5F8FC] p-3.5 sm:flex-row sm:items-center"
                >
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      onClick={() => onOpenHospital(h.hospital_id)}
                      className="truncate text-left text-sm font-semibold text-[#12304A] hover:text-[#1769AA] hover:underline"
                    >
                      {h.hospital_name}
                    </button>
                    <div className="mt-1.5 flex items-center gap-3">
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-200">
                        <div className={`h-full rounded-full ${barColor}`} style={{ width: `${h.availability_pct}%` }} />
                      </div>
                      <span className="font-mono text-xs font-semibold text-[#243447] tabular-nums">
                        {h.available_beds}/{h.total_beds} ({h.availability_pct}%)
                      </span>
                    </div>
                  </div>
                  <div className="shrink-0">
                    <BedStatusIndicator status={h.status} />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>

      {/* Recent Searches, Recently Viewed Hospitals & Latest Waiting-Time Updates */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Recent Searches & Recently Viewed */}
        <div className="space-y-6 lg:col-span-5">
          <section className="rounded-xl border border-slate-200 bg-white p-6">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-base font-semibold text-[#12304A]">Recent Searches</h2>
              <History className="h-4 w-4 text-[#718096]" aria-hidden="true" />
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {recentSearches.length === 0 ? (
                <p className="text-xs text-[#718096]">No recent searches recorded yet.</p>
              ) : (
                recentSearches.map((term) => (
                  <button
                    key={term}
                    type="button"
                    onClick={() => onSearchHospitals(term)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-[#F5F8FC] px-3 py-1.5 text-xs font-medium text-[#243447] hover:border-[#1769AA] hover:text-[#1769AA]"
                  >
                    <Search className="h-3 w-3 text-[#718096]" />
                    <span>{term}</span>
                  </button>
                ))
              )}
            </div>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-6">
            <h2 className="font-display text-base font-semibold text-[#12304A]">Recently Viewed Hospitals</h2>
            {recentHospitals.length === 0 ? (
              <div className="mt-3 rounded-lg border border-dashed border-slate-200 bg-[#F5F8FC] p-4 text-xs text-[#718096]">
                Hospitals you open in Find Hospitals will appear here for quick return access.
              </div>
            ) : (
              <div className="mt-3 space-y-2">
                {recentHospitals.map((h) => (
                  <button
                    key={h.hospital_id}
                    type="button"
                    onClick={() => onOpenHospital(h.hospital_id)}
                    className="flex w-full items-center justify-between rounded-lg border border-slate-100 bg-[#F5F8FC] px-3.5 py-2.5 text-left hover:border-[#1769AA]/40"
                  >
                    <div>
                      <div className="text-sm font-semibold text-[#12304A]">{h.name}</div>
                      <div className="text-xs text-[#718096]">
                        {h.type} · {h.city} · Viewed {h.viewedAtIst}
                      </div>
                    </div>
                    <ArrowRight className="h-4 w-4 text-[#1769AA]" />
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-6">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-base font-semibold text-[#12304A]">
                Saved Hospitals (Cloud Sync)
              </h2>
              <Bookmark className="h-4 w-4 text-[#1769AA]" aria-hidden="true" />
            </div>
            {!firebaseUser ? (
              <div className="mt-3 space-y-2.5 rounded-lg border border-dashed border-slate-200 bg-[#F5F8FC] p-4 text-xs text-[#718096]">
                <p>Sign in with Google to bookmark hospitals and sync them across devices.</p>
                <button
                  type="button"
                  onClick={() => void signInWithGoogle()}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-[#12304A] hover:bg-slate-50"
                >
                  Continue with Google
                </button>
              </div>
            ) : savedHospitals.length === 0 ? (
              <div className="mt-3 rounded-lg border border-dashed border-slate-200 bg-[#F5F8FC] p-4 text-xs text-[#718096]">
                No bookmarked hospitals yet. Click Save on any hospital card in Find Hospitals.
              </div>
            ) : (
              <div className="mt-3 space-y-2">
                {savedHospitals.map((h) => (
                  <div
                    key={h.id}
                    className="flex items-center justify-between gap-2 rounded-lg border border-slate-100 bg-[#F5F8FC] px-3.5 py-2.5"
                  >
                    <button
                      type="button"
                      onClick={() => onOpenHospital(h.hospitalId)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="truncate text-sm font-semibold text-[#12304A] hover:text-[#1769AA]">
                        {h.hospitalName}
                      </div>
                      <div className="text-xs text-[#718096]">
                        {h.hospitalType ? `${h.hospitalType} · ` : ''}
                        {h.city}
                      </div>
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove ${h.hospitalName}`}
                      onClick={() =>
                        void toggleSaveHospital({
                          hospital_id: h.hospitalId,
                          name: h.hospitalName,
                          city: h.city,
                          type: h.hospitalType,
                        })
                      }
                      className="rounded p-1.5 text-[#718096] hover:bg-red-50 hover:text-[#E05252]"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* Latest Waiting-Time Updates */}
        <section className="rounded-xl border border-slate-200 bg-white p-6 lg:col-span-7">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <div>
              <h2 className="font-display text-lg font-semibold text-[#12304A]">
                Latest Waiting-Time Updates
              </h2>
              <p className="text-xs text-[#718096]">Anonymised accepted/approved crowd reports</p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('submit')}
              className="text-xs font-semibold text-[#1769AA] hover:underline"
            >
              Add Report
            </button>
          </div>

          <div className="mt-4 space-y-2.5">
            {(summary?.latest_updates || []).length === 0 ? (
              <p className="py-6 text-center text-sm text-[#718096]">No recent queue updates yet.</p>
            ) : (
              summary?.latest_updates.map((u) => (
                <button
                  key={u.update_id}
                  type="button"
                  onClick={() => onOpenHospital(u.hospital_id)}
                  className="flex w-full flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-100 bg-[#F5F8FC] p-3.5 text-left transition-colors hover:border-[#1769AA]/40"
                >
                  <div>
                    <div className="text-sm font-semibold text-[#12304A]">{u.hospital_name}</div>
                    <div className="text-xs text-[#718096]">
                      {u.department_name} · Reported {u.submitted_at_ist}
                    </div>
                  </div>
                  <div className="flex items-center gap-2.5">
                    <QueueLevelBadge level={u.queue_level} />
                    <span className="font-mono text-sm font-bold text-[#12304A] tabular-nums">
                      {u.waiting_minutes} min
                    </span>
                  </div>
                </button>
              ))
            )}
          </div>
        </section>
      </div>

      <EmergencyNotice compact />
    </div>
  );
}
