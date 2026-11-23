import {
  ArrowLeft,
  BedDouble,
  Bookmark,
  Check,
  Clock,
  ExternalLink,
  Globe,
  Info,
  Loader2,
  MapPin,
  MessageSquarePlus,
  Phone,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ResilientImage } from '../components/ResilientImage.tsx';
import {
  BedStatusIndicator,
  ConfidenceText,
  EmergencyNotice,
  QueueLevelBadge,
} from '../components/StatusIndicators.tsx';
import { useFirebase } from '../contexts/FirebaseContext.tsx';
import { recordViewedHospital } from '../lib/activity.ts';
import { apiFetch, ApiError } from '../lib/api.ts';
import { formatDataSourceLabel, useLiveEvents } from '../lib/useLiveEvents.ts';
import type {
  AnonymisedRecentUpdate,
  DepartmentEstimate,
  DepartmentSummary,
  GroundedSource,
  WardBedInfo,
} from '../types.ts';

interface HospitalDetailPageProps {
  hospitalId: number;
  isCompared: boolean;
  canAddCompare: boolean;
  onBack: () => void;
  onToggleCompare: (hospitalId: number) => void;
  onReportQueue: (hospitalId: number, departmentId: number) => void;
}

interface HospitalDetailResponse {
  hospital: {
    hospital_id: number;
    name: string;
    address: string;
    city: string;
    contact: string;
    type: string;
  };
  departments: DepartmentSummary[];
  recent_updates: AnonymisedRecentUpdate[];
}

interface BedsResponse {
  hospital_id: number;
  hospital_name: string;
  wards: WardBedInfo[];
  advice: string;
  non_emergency_notice: string;
}

export function HospitalDetailPage({
  hospitalId,
  isCompared,
  canAddCompare,
  onBack,
  onToggleCompare,
  onReportQueue,
}: HospitalDetailPageProps) {
  const [activeTab, setActiveTab] = useState<'opd' | 'beds' | 'updates'>('opd');
  const [detail, setDetail] = useState<HospitalDetailResponse | null>(null);
  const [selectedDeptId, setSelectedDeptId] = useState<number | null>(null);
  const [estimate, setEstimate] = useState<DepartmentEstimate | null>(null);
  const [bedsData, setBedsData] = useState<BedsResponse | null>(null);

  const { firebaseUser, isHospitalSaved, toggleSaveHospital, signInWithGoogle } = useFirebase();
  const [savingBookmark, setSavingBookmark] = useState(false);
  const [bookmarkNotice, setBookmarkNotice] = useState<string | null>(null);

  const [groundingLoading, setGroundingLoading] = useState<'search' | 'maps' | null>(null);
  const [groundingResult, setGroundingResult] = useState<{
    mode: 'search' | 'maps';
    reply: string;
    sources: GroundedSource[];
  } | null>(null);
  const [groundingError, setGroundingError] = useState<string | null>(null);

  const [loadingDetail, setLoadingDetail] = useState(true);
  const [loadingEstimate, setLoadingEstimate] = useState(false);
  const [loadingBeds, setLoadingBeds] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoadingDetail(true);
    setError(null);
    setBedsData(null);
    apiFetch<HospitalDetailResponse>(`/api/hospitals/${hospitalId}`)
      .then((res) => {
        if (!active) return;
        setDetail(res);
        recordViewedHospital({
          hospital_id: res.hospital.hospital_id,
          name: res.hospital.name,
          city: res.hospital.city,
          type: res.hospital.type,
        });
        const firstOpen = res.departments.find((d) => d.is_open_now) || res.departments[0];
        if (firstOpen) {
          setSelectedDeptId(firstOpen.department_id);
        }
      })
      .catch((err) => {
        if (active) setError(err instanceof ApiError ? err.message : 'Unable to load hospital details.');
      })
      .finally(() => {
        if (active) setLoadingDetail(false);
      });
    return () => {
      active = false;
    };
  }, [hospitalId]);

  const fetchEstimate = useCallback(async (deptId: number) => {
    setLoadingEstimate(true);
    try {
      const res = await apiFetch<DepartmentEstimate>(`/api/departments/${deptId}/estimate`);
      setEstimate(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to load queue estimate.');
    } finally {
      setLoadingEstimate(false);
    }
  }, []);

  useEffect(() => {
    if (selectedDeptId !== null) {
      fetchEstimate(selectedDeptId);
    }
  }, [selectedDeptId, fetchEstimate]);

  const refreshBeds = useCallback(() => {
    setLoadingBeds(true);
    apiFetch<BedsResponse>(`/api/hospitals/${hospitalId}/beds`)
      .then((res) => setBedsData(res))
      .catch(() => {})
      .finally(() => setLoadingBeds(false));
  }, [hospitalId]);

  useEffect(() => {
    if (!bedsData) {
      refreshBeds();
    }
  }, [bedsData, refreshBeds]);

  useLiveEvents((ev) => {
    if (ev.hospital_id !== 0 && ev.hospital_id !== hospitalId) return;
    if ((ev.type === 'queue:updated' || ev.type === 'feed:synced') && selectedDeptId !== null) {
      fetchEstimate(selectedDeptId);
    }
    if (ev.type === 'beds:updated' || ev.type === 'feed:synced') {
      refreshBeds();
    }
  });

  if (loadingDetail) {
    return (
      <div className="space-y-4">
        <div className="h-36 animate-pulse rounded-xl border border-slate-200 bg-white p-6" />
        <div className="h-80 animate-pulse rounded-xl border border-slate-200 bg-white p-6" />
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="rounded-xl border border-[#E05252]/40 bg-red-50 p-6 text-red-900">
        <p className="font-medium">{error || 'Hospital not found.'}</p>
        <button
          type="button"
          onClick={onBack}
          className="mt-4 inline-flex min-h-[42px] items-center gap-2 rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-900"
        >
          <ArrowLeft className="h-4 w-4" />
          <span>Back to Find Hospitals</span>
        </button>
      </div>
    );
  }

  const { hospital, departments, recent_updates } = detail;

  return (
    <div className="space-y-6">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex min-h-[40px] items-center gap-1.5 text-sm font-medium text-[#718096] hover:text-[#12304A]"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        <span>Back to hospital directory</span>
      </button>

      {/* Hospital Overview Header */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6">
        <div className="flex flex-col justify-between gap-5 md:flex-row md:items-start">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <div className="aspect-[4/3] w-full overflow-hidden rounded-xl border border-slate-200 sm:w-40 shrink-0">
              <ResilientImage
                src="/src/assets/images/hospital_campus_exterior_1795182663768.jpg"
                alt={`${hospital.name} campus`}
                fallbackTitle={hospital.city}
                className="h-full w-full object-cover"
              />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-[#718096]">
                <span className="font-semibold text-[#16A6A1]">{hospital.type}</span>
                <span aria-hidden="true">·</span>
                <span>{hospital.city}</span>
              </div>
              <h1 className="mt-1.5 font-display text-2xl font-bold text-[#12304A] sm:text-3xl">
                {hospital.name}
              </h1>
              <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-[#718096]">
                <span className="inline-flex items-center gap-1.5">
                  <MapPin className="h-4 w-4 shrink-0 text-[#1769AA]" aria-hidden="true" />
                  <span>{hospital.address}</span>
                </span>
                <a
                  href={`tel:${hospital.contact}`}
                  className="inline-flex items-center gap-1.5 font-mono font-medium text-[#1769AA] hover:underline"
                >
                  <Phone className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{hospital.contact}</span>
                </a>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <button
              type="button"
              disabled={savingBookmark}
              onClick={async () => {
                setBookmarkNotice(null);
                if (!firebaseUser) {
                  setBookmarkNotice('Sign in with Google to bookmark hospitals across devices.');
                  return;
                }
                setSavingBookmark(true);
                try {
                  await toggleSaveHospital({
                    hospital_id: hospital.hospital_id,
                    name: hospital.name,
                    city: hospital.city,
                    type: hospital.type,
                  });
                } catch (err) {
                  setBookmarkNotice(err instanceof Error ? err.message : 'Unable to save hospital.');
                } finally {
                  setSavingBookmark(false);
                }
              }}
              className={`inline-flex min-h-[42px] items-center gap-1.5 rounded-xl border px-4 py-2 text-sm font-semibold whitespace-nowrap ${
                isHospitalSaved(hospital.hospital_id)
                  ? 'border-[#1769AA] bg-[#1769AA]/10 text-[#1769AA]'
                  : 'border-slate-300 bg-white text-[#243447] hover:bg-slate-50'
              }`}
            >
              <Bookmark
                className={`h-4 w-4 ${isHospitalSaved(hospital.hospital_id) ? 'fill-current' : ''}`}
              />
              <span>{isHospitalSaved(hospital.hospital_id) ? 'Saved' : 'Save Hospital'}</span>
            </button>

            <button
              type="button"
              disabled={!isCompared && !canAddCompare}
              onClick={() => onToggleCompare(hospital.hospital_id)}
              className={`inline-flex min-h-[42px] items-center gap-1.5 rounded-xl border px-4 py-2 text-sm font-semibold whitespace-nowrap ${
                isCompared
                  ? 'border-[#16A6A1] bg-[#16A6A1]/10 text-[#117A76]'
                  : 'border-slate-300 bg-white text-[#243447] hover:bg-slate-50 disabled:opacity-40'
              }`}
            >
              {isCompared ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
              <span>{isCompared ? 'Added to Compare' : 'Add to Compare'}</span>
            </button>

            {selectedDeptId && (
              <button
                type="button"
                onClick={() => onReportQueue(hospital.hospital_id, selectedDeptId)}
                className="inline-flex min-h-[42px] items-center gap-1.5 rounded-xl bg-[#1769AA] px-4 py-2 text-sm font-semibold text-white hover:bg-[#125388] whitespace-nowrap"
              >
                <MessageSquarePlus className="h-4 w-4" />
                <span>Submit Queue Update</span>
              </button>
            )}
          </div>
        </div>

        {bookmarkNotice && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#1769AA]/30 bg-[#1769AA]/8 px-4 py-2.5 text-xs text-[#12304A]">
            <span>{bookmarkNotice}</span>
            {!firebaseUser && (
              <button
                type="button"
                onClick={() => {
                  setBookmarkNotice(null);
                  void signInWithGoogle().catch((err) => {
                    setBookmarkNotice(err instanceof Error ? err.message : 'Google Sign-In failed.');
                  });
                }}
                className="rounded-lg bg-[#1769AA] px-3 py-1.5 font-semibold text-white hover:bg-[#125388]"
              >
                Continue with Google
              </button>
            )}
          </div>
        )}

        {/* Navigation Tabs */}
        <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
          <div className="inline-flex flex-wrap rounded-xl bg-[#F5F8FC] p-1">
            <button
              type="button"
              onClick={() => setActiveTab('opd')}
              className={`min-h-[38px] rounded-lg px-4 py-1.5 text-sm font-semibold transition-colors whitespace-nowrap ${
                activeTab === 'opd' ? 'bg-white text-[#1769AA] shadow-xs' : 'text-[#718096] hover:text-[#12304A]'
              }`}
            >
              OPD Schedules &amp; Wait Estimates ({departments.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('beds')}
              className={`min-h-[38px] rounded-lg px-4 py-1.5 text-sm font-semibold transition-colors whitespace-nowrap ${
                activeTab === 'beds' ? 'bg-white text-[#1769AA] shadow-xs' : 'text-[#718096] hover:text-[#12304A]'
              }`}
            >
              Ward Bed Availability
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('updates')}
              className={`min-h-[38px] rounded-lg px-4 py-1.5 text-sm font-semibold transition-colors whitespace-nowrap ${
                activeTab === 'updates' ? 'bg-white text-[#1769AA] shadow-xs' : 'text-[#718096] hover:text-[#12304A]'
              }`}
            >
              Recent Crowdsourced Updates ({recent_updates.length})
            </button>
          </div>
        </div>
      </section>

      {activeTab === 'opd' && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          {/* Department list */}
          <aside className="rounded-2xl border border-slate-200 bg-white p-4 lg:col-span-4">
            <h2 className="px-2 font-display text-base font-semibold text-[#12304A]">
              Available Departments &amp; OPD Timings
            </h2>
            <div className="mt-3 space-y-1.5">
              {departments.map((dept) => {
                const selected = dept.department_id === selectedDeptId;
                return (
                  <button
                    key={dept.department_id}
                    type="button"
                    onClick={() => setSelectedDeptId(dept.department_id)}
                    className={`w-full rounded-xl border px-3.5 py-3 text-left transition-colors ${
                      selected
                        ? 'border-[#1769AA] bg-[#1769AA]/6'
                        : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-[#F5F8FC]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-[#12304A]">{dept.name}</span>
                      <span
                        className={`text-xs font-semibold ${
                          dept.is_open_now ? 'text-[#16A36A]' : 'text-[#718096]'
                        }`}
                      >
                        {dept.is_open_now ? 'Open now' : 'OPD closed'}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-[#718096]">{dept.opd_timings_label}</p>
                  </button>
                );
              })}
            </div>
          </aside>

          {/* Prominent Waiting-Time Information Card */}
          <section className="rounded-2xl border border-slate-200 bg-white p-6 lg:col-span-8">
            {loadingEstimate || !estimate ? (
              <div className="h-64 animate-pulse rounded-xl bg-slate-100" />
            ) : !estimate.is_open_now ? (
              <div className="space-y-5">
                <div className="flex items-center justify-between border-b border-slate-100 pb-4">
                  <div>
                    <p className="text-sm text-[#718096]">{hospital.name}</p>
                    <h2 className="font-display text-2xl font-bold text-[#12304A]">
                      {estimate.department_name}
                    </h2>
                  </div>
                  <span className="rounded-lg border border-slate-300 bg-slate-100 px-3 py-1.5 text-sm font-semibold text-[#243447]">
                    OPD closed
                  </span>
                </div>

                <div className="rounded-xl border border-slate-200 bg-[#F5F8FC] p-5">
                  <div className="flex items-start gap-3">
                    <Clock className="mt-0.5 h-5 w-5 shrink-0 text-[#1769AA]" aria-hidden="true" />
                    <div>
                      <p className="text-base font-semibold text-[#12304A]">
                        This OPD is currently outside consultation hours
                      </p>
                      <p className="mt-1 text-sm text-[#243447]">
                        Next opening: <span className="font-semibold">{estimate.next_opening_text}</span>
                      </p>
                      <p className="mt-1 text-xs text-[#718096]">
                        Schedule: {estimate.opd_timings_label}
                      </p>
                    </div>
                  </div>
                </div>

                <p className="flex items-start gap-2 text-xs leading-relaxed text-[#718096]">
                  <Info className="mt-0.5 h-4 w-4 shrink-0 text-[#1769AA]" aria-hidden="true" />
                  <span>Waiting times are estimates and may change depending on hospital conditions.</span>
                </p>
                <EmergencyNotice compact />
              </div>
            ) : (
              <div className="space-y-6">
                <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 pb-4">
                  <div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-[#718096]">
                      <span className="font-semibold text-[#16A36A]">{estimate.opd_status_label}</span>
                      {estimate.current_session_text && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>{estimate.current_session_text}</span>
                        </>
                      )}
                    </div>
                    <h2 className="mt-1 font-display text-2xl font-bold text-[#12304A]">
                      {estimate.department_name}
                    </h2>
                  </div>

                  <button
                    type="button"
                    onClick={() => fetchEstimate(estimate.department_id)}
                    className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-[#243447] hover:bg-slate-50"
                  >
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Refresh</span>
                  </button>
                </div>

                {/* Prominent Waiting-Time Information Card */}
                <div className="grid grid-cols-1 gap-4 rounded-2xl border border-[#1769AA]/25 bg-gradient-to-br from-[#F5F8FC] to-white p-5 sm:grid-cols-2">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-[#718096]">
                      Current Queue Status
                    </p>
                    <div className="mt-2">
                      {estimate.queue_level && <QueueLevelBadge level={estimate.queue_level} />}
                    </div>
                    {estimate.confidence && (
                      <p className="mt-2.5 text-sm text-[#718096]">
                        <ConfidenceText confidence={estimate.confidence} />
                      </p>
                    )}
                  </div>

                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-[#718096]">
                      Estimated Waiting Range
                    </p>
                    <p className="mt-1 font-mono text-3xl font-bold tracking-tight text-[#12304A] tabular-nums">
                      {estimate.range_low}–{estimate.range_high} min
                    </p>
                    <p className="mt-1.5 text-xs text-[#718096]">
                      Calibrated range from historical records &amp; recent validated updates
                    </p>
                  </div>
                </div>

                <dl className="grid grid-cols-1 gap-4 border-t border-slate-100 pt-4 text-sm sm:grid-cols-3">
                  <div>
                    <dt className="text-xs text-[#718096]">Last Updated Timestamp (IST)</dt>
                    <dd className="mt-0.5 font-mono font-semibold text-[#12304A] tabular-nums">
                      {estimate.last_updated_ist}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-[#718096]">Recent Reports (Last 2h)</dt>
                    <dd className="mt-0.5 font-semibold text-[#12304A] tabular-nums">
                      {estimate.recent_reports_count > 0
                        ? `${estimate.recent_reports_count} validated ${
                            estimate.recent_reports_count === 1 ? 'report' : 'reports'
                          }`
                        : 'Historical data only'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-[#718096]">Prediction Model &amp; Source</dt>
                    <dd className="mt-0.5 font-semibold text-[#12304A]">
                      {estimate.basis} {estimate.model_version ? `(${estimate.model_version})` : ''} ·{' '}
                      {formatDataSourceLabel(estimate.data_source)}
                    </dd>
                  </div>
                </dl>

                {/* Exact Requested Disclaimer */}
                <div className="space-y-3 border-t border-slate-100 pt-4">
                  <p className="flex items-start gap-2 rounded-lg border border-slate-200 bg-[#F5F8FC] px-3.5 py-2.5 text-xs font-medium leading-relaxed text-[#243447]">
                    <Info className="mt-0.5 h-4 w-4 shrink-0 text-[#1769AA]" aria-hidden="true" />
                    <span>Waiting times are estimates and may change depending on hospital conditions.</span>
                  </p>
                  <EmergencyNotice compact />
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {activeTab === 'beds' && (
        <section className="rounded-2xl border border-slate-200 bg-white p-6">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-4">
            <div className="flex items-center gap-2.5">
              <BedDouble className="h-5 w-5 text-[#16A6A1]" aria-hidden="true" />
              <h2 className="font-display text-xl font-semibold text-[#12304A]">
                Ward-Wise Bed Availability
              </h2>
            </div>
            <p className="text-xs font-medium text-[#718096]">
              {bedsData?.advice || 'Call the hospital to confirm bed availability before travelling.'}
            </p>
          </div>

          {loadingBeds ? (
            <div className="h-48 animate-pulse rounded-xl bg-slate-100" />
          ) : !bedsData || bedsData.wards.length === 0 ? (
            <div className="rounded-xl border border-slate-200 bg-[#F5F8FC] p-8 text-center text-[#718096]">
              No ward bed availability records are currently stored for this hospital.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {bedsData.wards.map((w) => {
                const pct = w.total_beds > 0 ? Math.round((w.available_beds / w.total_beds) * 100) : 0;
                const barColor =
                  pct >= 30 ? 'bg-[#16A36A]' : pct >= 10 ? 'bg-[#F59E0B]' : 'bg-[#E05252]';
                return (
                  <div key={w.ward_type} className="rounded-xl border border-slate-200 bg-[#F5F8FC] p-4">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="font-display text-base font-semibold text-[#12304A]">{w.ward_type}</h3>
                      <BedStatusIndicator status={w.status} />
                    </div>
                    <div className="mt-3 flex items-baseline justify-between font-mono text-sm tabular-nums">
                      <span className="text-xl font-bold text-[#12304A]">
                        {w.available_beds} <span className="text-xs font-normal text-[#718096]">/ {w.total_beds} free</span>
                      </span>
                      <span className="font-semibold text-[#1769AA]">{pct}%</span>
                    </div>
                    <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-200">
                      <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
                    </div>
                    <div className="mt-3 flex items-center justify-between gap-2 text-[11px] text-[#718096]">
                      <span>
                        <span className="font-mono tabular-nums">{w.record_time_ist}</span>
                        <span className="mx-1" aria-hidden="true">·</span>
                        <span>{formatDataSourceLabel(w.data_source)}</span>
                      </span>
                      {w.is_outdated && (
                        <span className="font-semibold text-[#E05252]">Outdated (&gt;24h)</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="mt-6">
            <EmergencyNotice compact />
          </div>
        </section>
      )}

      {activeTab === 'updates' && (
        <section className="rounded-2xl border border-slate-200 bg-white p-6">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
            <div>
              <h2 className="font-display text-xl font-semibold text-[#12304A]">
                Recent Crowdsourced Updates
              </h2>
              <p className="text-xs text-[#718096]">
                Anonymised validated updates from patients who recently visited {hospital.name}. Submitter identity is
                never displayed.
              </p>
            </div>
            {selectedDeptId && (
              <button
                type="button"
                onClick={() => onReportQueue(hospital.hospital_id, selectedDeptId)}
                className="min-h-[38px] rounded-lg bg-[#1769AA] px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-[#125388]"
              >
                Submit New Update
              </button>
            )}
          </div>

          {recent_updates.length === 0 ? (
            <div className="mt-4 rounded-xl border border-slate-200 bg-[#F5F8FC] p-8 text-center text-sm text-[#718096]">
              No validated crowd updates have been logged for this hospital yet.
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              {recent_updates.map((u) => (
                <div
                  key={u.update_id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-100 bg-[#F5F8FC] p-4"
                >
                  <div>
                    <div className="font-semibold text-[#12304A]">{u.department_name}</div>
                    <div className="mt-0.5 font-mono text-xs text-[#718096] tabular-nums">
                      Submitted {u.submitted_at_ist} · Status: {u.validation_status}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <QueueLevelBadge level={u.queue_level} />
                    <span className="font-mono text-base font-bold text-[#12304A] tabular-nums">
                      {u.waiting_minutes} min
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Grounded Google Search & Google Maps Lookup */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-lg font-semibold text-[#12304A]">
              Live Web &amp; Google Maps Information Lookup
            </h2>
            <p className="text-xs text-[#718096]">
              Verify official notices, campus address, or Google Maps directions &amp; visitor reviews for{' '}
              <span className="font-semibold text-[#12304A]">{hospital.name}</span>.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={groundingLoading !== null}
              onClick={async () => {
                setGroundingError(null);
                setGroundingLoading('search');
                try {
                  const res = await apiFetch<{
                    reply: string;
                    sources: GroundedSource[];
                  }>('/api/ai/chat', {
                    method: 'POST',
                    body: JSON.stringify({
                      mode: 'search',
                      systemRole: 'guide',
                      focusHospitalId: hospital.hospital_id,
                      message: `Look up official OPD registration details, helpline information, and recent public notices for ${hospital.name} in ${hospital.city}.`,
                    }),
                  });
                  setGroundingResult({ mode: 'search', reply: res.reply, sources: res.sources });
                } catch (err) {
                  setGroundingError(
                    err instanceof ApiError ? err.message : 'Unable to fetch grounded web info.',
                  );
                } finally {
                  setGroundingLoading(null);
                }
              }}
              className="inline-flex min-h-[38px] items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3.5 py-1.5 text-xs font-semibold text-[#12304A] hover:bg-slate-50 disabled:opacity-50"
            >
              {groundingLoading === 'search' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-[#1769AA]" />
              ) : (
                <Globe className="h-3.5 w-3.5 text-[#1769AA]" />
              )}
              <span>Google Search Info</span>
            </button>
            <button
              type="button"
              disabled={groundingLoading !== null}
              onClick={async () => {
                setGroundingError(null);
                setGroundingLoading('maps');
                try {
                  const res = await apiFetch<{
                    reply: string;
                    sources: GroundedSource[];
                  }>('/api/ai/chat', {
                    method: 'POST',
                    body: JSON.stringify({
                      mode: 'maps',
                      systemRole: 'navigator',
                      focusHospitalId: hospital.hospital_id,
                      message: `Find Google Maps place details, directions landmarks, and visitor review highlights for ${hospital.name}, ${hospital.address}, ${hospital.city}.`,
                    }),
                  });
                  setGroundingResult({ mode: 'maps', reply: res.reply, sources: res.sources });
                } catch (err) {
                  setGroundingError(
                    err instanceof ApiError ? err.message : 'Unable to fetch Google Maps grounding.',
                  );
                } finally {
                  setGroundingLoading(null);
                }
              }}
              className="inline-flex min-h-[38px] items-center gap-1.5 rounded-xl bg-[#16A6A1] px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-[#128783] disabled:opacity-50"
            >
              {groundingLoading === 'maps' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <MapPin className="h-3.5 w-3.5" />
              )}
              <span>Google Maps &amp; Reviews</span>
            </button>
          </div>
        </div>

        {groundingError && (
          <div role="alert" className="rounded-xl border border-[#E05252]/40 bg-red-50 px-4 py-2.5 text-xs text-red-900">
            {groundingError}
          </div>
        )}

        {groundingResult && (
          <div className="rounded-xl border border-slate-200 bg-[#F5F8FC] p-4 space-y-3">
            <div className="whitespace-pre-wrap text-sm leading-relaxed text-[#243447]">
              {groundingResult.reply}
            </div>
            {groundingResult.sources.length > 0 && (
              <div className="border-t border-slate-200 pt-2.5 space-y-1.5">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-[#718096]">
                  {groundingResult.mode === 'maps'
                    ? 'Google Maps Links & Reviews'
                    : 'Verified Web Citations'}
                </p>
                <ul className="space-y-1">
                  {groundingResult.sources.map((src, idx) => (
                    <li key={`${src.uri}_${idx}`} className="text-xs">
                      <a
                        href={src.uri}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 font-semibold text-[#1769AA] hover:underline"
                      >
                        {src.sourceType === 'maps' ? (
                          <MapPin className="h-3.5 w-3.5 text-[#16A6A1]" />
                        ) : (
                          <Globe className="h-3.5 w-3.5 text-[#1769AA]" />
                        )}
                        <span>{src.title}</span>
                        <ExternalLink className="h-3 w-3" />
                      </a>
                      {src.snippet && (
                        <p className="mt-0.5 pl-5 text-[11px] text-[#718096]">{src.snippet}</p>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
