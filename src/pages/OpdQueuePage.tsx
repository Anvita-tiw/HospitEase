import { Clock, Info, MessageSquarePlus, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  ConfidenceText,
  EmergencyNotice,
  QueueLevelBadge,
} from '../components/StatusIndicators.tsx';
import { apiFetch, ApiError } from '../lib/api.ts';
import { formatDataSourceLabel, useLiveEvents } from '../lib/useLiveEvents.ts';
import type {
  AnonymisedRecentUpdate,
  DepartmentEstimate,
  DepartmentSummary,
  HospitalListItem,
} from '../types.ts';

interface OpdQueuePageProps {
  onReportQueue: (hospitalId: number, departmentId: number) => void;
}

export function OpdQueuePage({ onReportQueue }: OpdQueuePageProps) {
  const [hospitals, setHospitals] = useState<HospitalListItem[]>([]);
  const [selectedHospitalId, setSelectedHospitalId] = useState<number>(1);
  const [departments, setDepartments] = useState<DepartmentSummary[]>([]);
  const [selectedDeptId, setSelectedDeptId] = useState<number>(0);
  const [estimate, setEstimate] = useState<DepartmentEstimate | null>(null);
  const [recentUpdates, setRecentUpdates] = useState<AnonymisedRecentUpdate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ hospitals: HospitalListItem[] }>('/api/hospitals?page=1&limit=100')
      .then((res) => {
        setHospitals(res.hospitals);
        if (res.hospitals.length > 0) {
          setSelectedHospitalId(res.hospitals[0].hospital_id);
        }
      })
      .catch(() => {});
  }, []);

  const loadHospitalDetails = useCallback((hid: number, keepDept = false) => {
    if (!hid) return;
    apiFetch<{
      departments: DepartmentSummary[];
      recent_updates: AnonymisedRecentUpdate[];
    }>(`/api/hospitals/${hid}`)
      .then((res) => {
        setDepartments(res.departments);
        setRecentUpdates(res.recent_updates || []);
        if (!keepDept) {
          const firstOpen = res.departments.find((d) => d.is_open_now) || res.departments[0];
          if (firstOpen) setSelectedDeptId(firstOpen.department_id);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadHospitalDetails(selectedHospitalId, false);
  }, [selectedHospitalId, loadHospitalDetails]);

  const loadEstimate = useCallback(async (deptId: number) => {
    if (!deptId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<DepartmentEstimate>(`/api/departments/${deptId}/estimate`);
      setEstimate(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to load queue prediction.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedDeptId) loadEstimate(selectedDeptId);
  }, [selectedDeptId, loadEstimate]);

  useLiveEvents((ev) => {
    if (
      (ev.type === 'queue:updated' || ev.type === 'feed:synced') &&
      (ev.hospital_id === 0 || ev.hospital_id === selectedHospitalId)
    ) {
      loadHospitalDetails(selectedHospitalId, true);
      if (selectedDeptId) loadEstimate(selectedDeptId);
    }
  });

  const midpointWait =
    estimate && estimate.range_low !== null && estimate.range_high !== null
      ? Math.round((estimate.range_low + estimate.range_high) / 2)
      : 0;

  const gaugePct = Math.min(100, Math.round((midpointWait / 90) * 100));
  const gaugeColor =
    estimate?.queue_level === 'Low'
      ? '#16A36A'
      : estimate?.queue_level === 'Medium'
        ? '#F59E0B'
        : '#E05252';

  const circumference = 2 * Math.PI * 52;
  const strokeOffset = circumference - (gaugePct / 100) * circumference;

  return (
    <div className="space-y-6">
      {/* Header & Selectors */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="font-display text-2xl font-bold text-[#12304A]">
                OPD Queue &amp; Waiting-Time Dashboard
              </h1>
            </div>
            <p className="mt-1 text-sm text-[#718096]">
              Estimates are generated using historical waiting-time records and recent validated user updates.
            </p>
          </div>

          {selectedDeptId > 0 && (
            <button
              type="button"
              onClick={() => onReportQueue(selectedHospitalId, selectedDeptId)}
              className="inline-flex min-h-[42px] items-center gap-2 rounded-xl bg-[#1769AA] px-4 py-2 text-sm font-semibold text-white hover:bg-[#125388]"
            >
              <MessageSquarePlus className="h-4 w-4" />
              <span>Report Queue Here</span>
            </button>
          )}
        </div>

        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="opd-hosp-select" className="block text-xs font-semibold uppercase tracking-wider text-[#718096]">
              Hospital Selector
            </label>
            <select
              id="opd-hosp-select"
              value={selectedHospitalId}
              onChange={(e) => setSelectedHospitalId(Number(e.target.value))}
              className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-200 bg-[#F5F8FC] px-3.5 text-sm font-medium text-[#12304A]"
            >
              {hospitals.map((h) => (
                <option key={h.hospital_id} value={h.hospital_id}>
                  {h.name} ({h.city})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="opd-dept-select" className="block text-xs font-semibold uppercase tracking-wider text-[#718096]">
              Department Selector
            </label>
            <select
              id="opd-dept-select"
              value={selectedDeptId}
              onChange={(e) => setSelectedDeptId(Number(e.target.value))}
              className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-200 bg-[#F5F8FC] px-3.5 text-sm font-medium text-[#12304A]"
            >
              {departments.map((d) => (
                <option key={d.department_id} value={d.department_id}>
                  {d.name} ({d.is_open_now ? 'Open now' : 'OPD closed'})
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      {error && (
        <div role="alert" className="rounded-xl border border-[#E05252]/40 bg-red-50 p-4 text-sm text-red-900">
          {error}
        </div>
      )}

      {/* Main Queue Gauge & Breakdown */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <section className="rounded-2xl border border-slate-200 bg-white p-6 lg:col-span-7">
          {loading || !estimate ? (
            <div className="h-64 animate-pulse rounded-xl bg-slate-100" />
          ) : !estimate.is_open_now ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between border-b border-slate-100 pb-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-[#718096]">
                    {estimate.hospital_name}
                  </p>
                  <h2 className="font-display text-2xl font-bold text-[#12304A]">
                    {estimate.department_name}
                  </h2>
                </div>
                <span className="rounded-lg border border-slate-300 bg-slate-100 px-3 py-1 text-xs font-semibold text-[#243447]">
                  OPD closed
                </span>
              </div>

              <div className="rounded-xl border border-slate-200 bg-[#F5F8FC] p-5">
                <div className="flex items-start gap-3">
                  <Clock className="mt-0.5 h-5 w-5 text-[#1769AA]" />
                  <div>
                    <p className="font-semibold text-[#12304A]">Currently Outside Consultation Hours</p>
                    <p className="mt-1 text-sm text-[#243447]">
                      Next opening: <span className="font-semibold">{estimate.next_opening_text}</span>
                    </p>
                    <p className="mt-1 text-xs text-[#718096]">Schedule: {estimate.opd_timings_label}</p>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-[#16A6A1]">
                    {estimate.hospital_name}
                  </p>
                  <h2 className="mt-0.5 font-display text-2xl font-bold text-[#12304A]">
                    {estimate.department_name}
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => loadEstimate(selectedDeptId)}
                  className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-slate-200 bg-[#F5F8FC] px-3 py-1.5 text-xs font-semibold text-[#243447] hover:bg-slate-100"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  <span>Refresh</span>
                </button>
              </div>

              {/* Visual Queue Gauge + Wait Range */}
              <div className="flex flex-col items-center gap-6 rounded-2xl border border-slate-200 bg-[#F5F8FC] p-6 sm:flex-row">
                <div className="relative flex h-36 w-36 shrink-0 items-center justify-center">
                  <svg className="h-36 w-36 -rotate-90" viewBox="0 0 120 120">
                    <circle
                      cx="60"
                      cy="60"
                      r="52"
                      fill="none"
                      stroke="#E2E8F0"
                      strokeWidth="10"
                    />
                    <circle
                      cx="60"
                      cy="60"
                      r="52"
                      fill="none"
                      stroke={gaugeColor}
                      strokeWidth="10"
                      strokeLinecap="round"
                      strokeDasharray={circumference}
                      strokeDashoffset={strokeOffset}
                      className="transition-all duration-500"
                    />
                  </svg>
                  <div className="absolute text-center">
                    <div className="font-mono text-xl font-bold text-[#12304A] tabular-nums">
                      ~{midpointWait}m
                    </div>
                    <div className="text-[11px] font-medium text-[#718096]">Est. Mid</div>
                  </div>
                </div>

                <div className="flex-1 space-y-3 text-center sm:text-left">
                  <div className="flex flex-wrap items-center justify-center gap-2.5 sm:justify-start">
                    {estimate.queue_level && <QueueLevelBadge level={estimate.queue_level} />}
                    {estimate.confidence && <ConfidenceText confidence={estimate.confidence} />}
                  </div>

                  <div>
                    <div className="text-xs font-medium text-[#718096]">Estimated Waiting-Time Range</div>
                    <div className="font-mono text-3xl font-bold text-[#12304A] tabular-nums">
                      {estimate.range_low}–{estimate.range_high} min
                    </div>
                  </div>

                  {/* Queue Level Threshold Legend */}
                  <div className="space-y-1.5 pt-1">
                    <div className="grid grid-cols-3 gap-1.5 text-[11px] font-medium">
                      <div className="rounded bg-[#16A36A]/15 px-2 py-1 text-center text-[#117A4F]">
                        LOW &lt; 20m
                      </div>
                      <div className="rounded bg-[#F59E0B]/15 px-2 py-1 text-center text-[#A16207]">
                        MED 20–45m
                      </div>
                      <div className="rounded bg-[#E05252]/15 px-2 py-1 text-center text-[#B91C1C]">
                        HIGH &gt; 45m
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-xs text-[#718096]">Last Updated Time (IST)</dt>
                  <dd className="mt-0.5 font-mono font-semibold text-[#12304A] tabular-nums">
                    {estimate.last_updated_ist}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-[#718096]">Validated Crowd Reports (2h)</dt>
                  <dd className="mt-0.5 font-semibold text-[#12304A] tabular-nums">
                    {estimate.recent_reports_count > 0
                      ? `${estimate.recent_reports_count} reports`
                      : 'Historical data only'}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-[#718096]">Active Model &amp; Source</dt>
                  <dd className="mt-0.5 font-semibold text-[#12304A]">
                    {estimate.basis} ({estimate.model_version}) · {formatDataSourceLabel(estimate.data_source)}
                  </dd>
                </div>
              </dl>

              <p className="flex items-start gap-2 rounded-xl border border-slate-200 bg-[#F5F8FC] px-3.5 py-2.5 text-xs text-[#243447]">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-[#1769AA]" />
                <span>
                  Estimates are generated using historical waiting-time records and recent validated user updates.
                  Waiting times are estimates and may change depending on hospital conditions.
                </span>
              </p>
            </div>
          )}
        </section>

        {/* Recent Validated Update History */}
        <section className="rounded-2xl border border-slate-200 bg-white p-6 lg:col-span-5">
          <h2 className="font-display text-lg font-semibold text-[#12304A]">
            Recent Validated Update History
          </h2>
          <p className="mt-0.5 text-xs text-[#718096]">
            Anonymised Accepted/Approved submissions for this hospital
          </p>

          <div className="mt-4 space-y-2.5">
            {recentUpdates.length === 0 ? (
              <div className="rounded-xl border border-slate-200 bg-[#F5F8FC] p-6 text-center text-xs text-[#718096]">
                No recent validated reports for this hospital yet.
              </div>
            ) : (
              recentUpdates.map((u) => (
                <div
                  key={u.update_id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-[#F5F8FC] p-3.5"
                >
                  <div>
                    <div className="text-sm font-semibold text-[#12304A]">{u.department_name}</div>
                    <div className="font-mono text-[11px] text-[#718096] tabular-nums">
                      {u.submitted_at_ist}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <QueueLevelBadge level={u.queue_level} />
                    <span className="font-mono text-sm font-bold text-[#12304A] tabular-nums">
                      {u.waiting_minutes}m
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      <EmergencyNotice compact />
    </div>
  );
}
