import {
  ArrowRight,
  BedDouble,
  Bookmark,
  Check,
  Clock,
  LayoutGrid,
  List,
  MapPin,
  Phone,
  Plus,
  Search,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ResilientImage } from '../components/ResilientImage.tsx';
import {
  BedStatusIndicator,
  EmergencyNotice,
  QueueLevelBadge,
} from '../components/StatusIndicators.tsx';
import { useFirebase } from '../contexts/FirebaseContext.tsx';
import { recordRecentSearch } from '../lib/activity.ts';
import { apiFetch, ApiError } from '../lib/api.ts';
import type { DashboardSummaryResponse, HospitalListItem } from '../types.ts';

interface HomeSearchPageProps {
  initialQuery?: string;
  compareIds: number[];
  onToggleCompare: (hospitalId: number) => void;
  onOpenHospital: (hospitalId: number) => void;
  onGoToCompare: () => void;
}

interface HospitalsResponse {
  hospitals: HospitalListItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
  };
  filters: {
    cities: string[];
    types: string[];
  };
}

type SortOption = 'name_asc' | 'wait_asc' | 'open_desc' | 'reports_desc';

export function HomeSearchPage({
  initialQuery = '',
  compareIds,
  onToggleCompare,
  onOpenHospital,
  onGoToCompare,
}: HomeSearchPageProps) {
  const [query, setQuery] = useState(initialQuery);
  const [city, setCity] = useState('');
  const [type, setType] = useState('');
  const [departmentFilter, setDepartmentFilter] = useState('');
  const [sortBy, setSortBy] = useState<SortOption>('name_asc');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [page, setPage] = useState(1);

  const [data, setData] = useState<HospitalsResponse | null>(null);
  const [bedOverviewMap, setBedOverviewMap] = useState<
    Record<number, DashboardSummaryResponse['hospital_bed_overview'][number]>
  >({});
  const { firebaseUser, isHospitalSaved, toggleSaveHospital, signInWithGoogle } = useFirebase();
  const [savingId, setSavingId] = useState<number | null>(null);
  const [savePrompt, setSavePrompt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setQuery(initialQuery);
    setPage(1);
  }, [initialQuery]);

  useEffect(() => {
    apiFetch<DashboardSummaryResponse>('/api/dashboard/summary')
      .then((res) => {
        const map: Record<number, DashboardSummaryResponse['hospital_bed_overview'][number]> = {};
        for (const row of res.hospital_bed_overview) {
          map[row.hospital_id] = row;
        }
        setBedOverviewMap(map);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let active = true;
    const timer = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (query.trim()) {
          params.set('q', query.trim().slice(0, 100));
          recordRecentSearch(query.trim());
        }
        if (city) params.set('city', city);
        if (type) params.set('type', type);
        params.set('page', String(page));

        const res = await apiFetch<HospitalsResponse>(`/api/hospitals?${params.toString()}`);
        if (active) setData(res);
      } catch (err) {
        if (active) {
          setError(err instanceof ApiError ? err.message : 'Unable to load hospitals right now.');
        }
      } finally {
        if (active) setLoading(false);
      }
    }, 150);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, city, type, page]);

  const allDepartments = useMemo(() => {
    const set = new Set<string>();
    for (const h of data?.hospitals || []) {
      for (const d of h.department_names) set.add(d);
    }
    return Array.from(set).sort();
  }, [data]);

  const displayedHospitals = useMemo(() => {
    let list = [...(data?.hospitals || [])];
    if (departmentFilter) {
      list = list.filter((h) => h.department_names.includes(departmentFilter));
    }
    list.sort((a, b) => {
      if (sortBy === 'wait_asc') {
        const aWait = a.summary_range_low ?? 9999;
        const bWait = b.summary_range_low ?? 9999;
        return aWait - bWait;
      }
      if (sortBy === 'open_desc') {
        return b.open_departments_count - a.open_departments_count;
      }
      if (sortBy === 'reports_desc') {
        return b.recent_reports_count - a.recent_reports_count;
      }
      return a.name.localeCompare(b.name);
    });
    return list;
  }, [data, departmentFilter, sortBy]);

  const handleResetFilters = () => {
    setQuery('');
    setCity('');
    setType('');
    setDepartmentFilter('');
    setSortBy('name_asc');
    setPage(1);
  };

  const handleBookmarkClick = async (h: HospitalListItem) => {
    setSavePrompt(null);
    if (!firebaseUser) {
      setSavePrompt('Sign in with Google to bookmark hospitals across devices.');
      return;
    }
    setSavingId(h.hospital_id);
    try {
      await toggleSaveHospital({
        hospital_id: h.hospital_id,
        name: h.name,
        city: h.city,
        type: h.type,
      });
    } catch (err) {
      setSavePrompt(err instanceof Error ? err.message : 'Unable to update saved hospital.');
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header & Search Filter Toolbar */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="font-display text-2xl font-bold text-[#12304A]">Find Hospitals</h1>
            </div>
            <p className="mt-1 text-sm text-[#718096]">
              Search hospitals by name, city, or department, compare queue estimates, and view ward bed summaries.
            </p>
          </div>

          <div className="inline-flex rounded-lg border border-slate-200 bg-[#F5F8FC] p-1">
            <button
              type="button"
              onClick={() => setViewMode('grid')}
              aria-label="Grid view"
              className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-md px-3 text-xs font-semibold transition-colors ${
                viewMode === 'grid' ? 'bg-white text-[#1769AA] shadow-xs' : 'text-[#718096]'
              }`}
            >
              <LayoutGrid className="h-4 w-4" />
              <span>Grid</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode('list')}
              aria-label="List view"
              className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-md px-3 text-xs font-semibold transition-colors ${
                viewMode === 'list' ? 'bg-white text-[#1769AA] shadow-xs' : 'text-[#718096]'
              }`}
            >
              <List className="h-4 w-4" />
              <span>List</span>
            </button>
          </div>
        </div>

        {/* Search & Filters Grid */}
        <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-12">
          <div className="relative md:col-span-4">
            <label htmlFor="find-hosp-search" className="sr-only">
              Search hospitals
            </label>
            <Search
              className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#718096]"
              aria-hidden="true"
            />
            <input
              id="find-hosp-search"
              type="search"
              maxLength={100}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
              placeholder="Search hospital, city, or department..."
              className="min-h-[42px] w-full rounded-xl border border-slate-200 bg-[#F5F8FC] pl-10 pr-3 text-sm text-[#243447] focus:border-[#1769AA] focus:bg-white focus:outline-none"
            />
          </div>

          <div className="md:col-span-2">
            <select
              aria-label="Filter by city"
              value={city}
              onChange={(e) => {
                setCity(e.target.value);
                setPage(1);
              }}
              className="min-h-[42px] w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-[#243447]"
            >
              <option value="">All cities</option>
              {(data?.filters.cities || []).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-2">
            <select
              aria-label="Filter by department"
              value={departmentFilter}
              onChange={(e) => setDepartmentFilter(e.target.value)}
              className="min-h-[42px] w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-[#243447]"
            >
              <option value="">All departments</option>
              {allDepartments.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-2">
            <select
              aria-label="Filter by hospital type"
              value={type}
              onChange={(e) => {
                setType(e.target.value);
                setPage(1);
              }}
              className="min-h-[42px] w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-[#243447]"
            >
              <option value="">All types</option>
              {(data?.filters.types || []).map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-2">
            <select
              aria-label="Sort hospital results"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortOption)}
              className="min-h-[42px] w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-[#243447]"
            >
              <option value="name_asc">Sort: Name (A–Z)</option>
              <option value="wait_asc">Sort: Shortest Wait</option>
              <option value="open_desc">Sort: Most Open OPDs</option>
              <option value="reports_desc">Sort: Most Reports</option>
            </select>
          </div>
        </div>

        {(query || city || type || departmentFilter) && (
          <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3 text-xs text-[#718096]">
            <span>
              Showing <strong className="text-[#12304A]">{displayedHospitals.length}</strong> matching
              hospitals
            </span>
            <button
              type="button"
              onClick={handleResetFilters}
              className="inline-flex items-center gap-1 font-semibold text-[#1769AA] hover:underline"
            >
              <X className="h-3.5 w-3.5" />
              <span>Clear all filters</span>
            </button>
          </div>
        )}
      </section>

      {/* Compare Bar */}
      {compareIds.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-[#16A6A1]/40 bg-[#16A6A1]/10 px-5 py-3.5">
          <div className="text-sm text-[#12304A]">
            <span className="font-mono font-bold tabular-nums">{compareIds.length} of 4</span> hospitals
            selected for comparison.
            {compareIds.length < 2 && ' Select at least 1 more hospital to compare side by side.'}
          </div>
          <button
            type="button"
            disabled={compareIds.length < 2}
            onClick={onGoToCompare}
            className="min-h-[40px] rounded-xl bg-[#1769AA] px-4 py-2 text-sm font-semibold text-white hover:bg-[#125388] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Compare Hospitals
          </button>
        </div>
      )}

      {savePrompt && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#1769AA]/30 bg-[#1769AA]/8 px-5 py-3.5 text-sm text-[#12304A]">
          <span>{savePrompt}</span>
          <div className="flex items-center gap-2">
            {!firebaseUser && (
              <button
                type="button"
                onClick={() => {
                  setSavePrompt(null);
                  void signInWithGoogle().catch((err) => {
                    setSavePrompt(err instanceof Error ? err.message : 'Google Sign-In failed.');
                  });
                }}
                className="min-h-[36px] rounded-lg bg-[#1769AA] px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-[#125388]"
              >
                Continue with Google
              </button>
            )}
            <button
              type="button"
              onClick={() => setSavePrompt(null)}
              className="rounded-lg p-1.5 text-[#718096] hover:bg-white"
              aria-label="Dismiss notice"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-[#E05252]/40 bg-red-50 p-5 text-sm text-red-900">{error}</div>
      )}

      {/* Results */}
      {loading && !data ? (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {[1, 2, 3, 4].map((n) => (
            <div key={n} className="h-56 animate-pulse rounded-xl border border-slate-200 bg-white p-6" />
          ))}
        </div>
      ) : displayedHospitals.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-10 text-center">
          <h2 className="font-display text-lg font-semibold text-[#12304A]">No hospitals found</h2>
          <p className="mt-2 text-sm text-[#718096]">
            Try searching with a shorter hospital name, a department like General Medicine, or clear active filters.
          </p>
          <button
            type="button"
            onClick={handleResetFilters}
            className="mt-5 min-h-[42px] rounded-xl bg-[#1769AA] px-5 py-2 text-sm font-semibold text-white hover:bg-[#125388]"
          >
            Show All Hospitals
          </button>
        </div>
      ) : (
        <div className={viewMode === 'grid' ? 'grid grid-cols-1 gap-5 lg:grid-cols-2' : 'space-y-4'}>
          {displayedHospitals.map((h) => {
            const isSelected = compareIds.includes(h.hospital_id);
            const canAdd = isSelected || compareIds.length < 4;
            const bedInfo = bedOverviewMap[h.hospital_id];

            return (
              <article
                key={h.hospital_id}
                className={`overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xs transition-all hover:border-[#1769AA]/40 hover:shadow-sm ${
                  viewMode === 'list' ? 'flex flex-col md:flex-row' : 'flex flex-col justify-between'
                }`}
              >
                <div className={viewMode === 'list' ? 'flex flex-1 flex-col sm:flex-row' : ''}>
                  <div
                    className={
                      viewMode === 'list'
                        ? 'aspect-[4/3] w-full shrink-0 sm:w-52 sm:aspect-auto'
                        : 'aspect-[16/7] w-full overflow-hidden'
                    }
                  >
                    <ResilientImage
                      src="/src/assets/images/hospital_campus_exterior_1795182663768.jpg"
                      alt={`${h.name} hospital facility`}
                      fallbackTitle={h.city}
                      className="h-full w-full object-cover"
                    />
                  </div>

                  <div className="flex-1 p-5">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#718096]">
                      <span>
                        {h.type} · {h.city}
                      </span>
                      <span className="font-medium text-[#16A6A1] tabular-nums">
                        {h.open_departments_count} of {h.department_count} OPDs open
                      </span>
                    </div>

                    <h2 className="mt-1.5 font-display text-lg font-bold text-[#12304A]">{h.name}</h2>
                    <p className="mt-1 flex items-start gap-1.5 text-xs text-[#718096]">
                      <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span>{h.address}</span>
                    </p>

                    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#243447]">
                      <span>
                        <strong className="text-[#718096]">Departments:</strong>{' '}
                        {h.department_names.slice(0, 4).join(', ')}
                        {h.department_names.length > 4 ? ` +${h.department_names.length - 4} more` : ''}
                      </span>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-[#718096]">
                      <span className="inline-flex items-center gap-1">
                        <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>OPD: Mon–Sat morning/evening</span>
                      </span>
                      <a
                        href={`tel:${h.contact}`}
                        className="inline-flex items-center gap-1 font-mono text-[#1769AA] hover:underline"
                      >
                        <Phone className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>{h.contact}</span>
                      </a>
                    </div>

                    {/* Queue & Bed Summary */}
                    <div className="mt-4 grid grid-cols-1 gap-2.5 rounded-xl border border-slate-100 bg-[#F5F8FC] p-3 sm:grid-cols-2">
                      <div>
                        <span className="block text-[11px] font-medium text-[#718096]">
                          Est. OPD Wait ({h.summary_department_name || 'General'})
                        </span>
                        {h.summary_queue_level && h.summary_range_low !== null ? (
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            <QueueLevelBadge level={h.summary_queue_level} />
                            <span className="font-mono text-sm font-bold text-[#12304A] tabular-nums">
                              {h.summary_range_low}–{h.summary_range_high} min
                            </span>
                          </div>
                        ) : (
                          <span className="mt-1 block text-xs font-medium text-[#718096]">
                            Outside OPD hours
                          </span>
                        )}
                      </div>

                      <div>
                        <span className="block text-[11px] font-medium text-[#718096]">
                          Bed Availability Summary
                        </span>
                        {bedInfo ? (
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            <BedStatusIndicator status={bedInfo.status} />
                            <span className="inline-flex items-center gap-1 font-mono text-xs font-semibold text-[#243447] tabular-nums">
                              <BedDouble className="h-3.5 w-3.5 text-[#16A6A1]" />
                              {bedInfo.available_beds}/{bedInfo.total_beds}
                            </span>
                          </div>
                        ) : (
                          <span className="mt-1 block text-xs text-[#718096]">View details</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Action Footer */}
                <div
                  className={`flex items-center justify-between gap-2 border-slate-100 bg-white px-5 py-3.5 ${
                    viewMode === 'list' ? 'border-t md:w-52 md:flex-col md:justify-center md:border-l md:border-t-0' : 'border-t'
                  }`}
                >
                  <div className={`flex items-center gap-2 ${viewMode === 'list' ? 'w-full flex-col' : ''}`}>
                    <button
                      type="button"
                      disabled={savingId === h.hospital_id}
                      onClick={() => void handleBookmarkClick(h)}
                      aria-label={isHospitalSaved(h.hospital_id) ? 'Remove hospital bookmark' : 'Bookmark hospital'}
                      className={`inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors whitespace-nowrap ${
                        viewMode === 'list' ? 'w-full' : ''
                      } ${
                        isHospitalSaved(h.hospital_id)
                          ? 'border-[#1769AA] bg-[#1769AA]/10 text-[#1769AA]'
                          : 'border-slate-200 bg-white text-[#243447] hover:bg-slate-50'
                      }`}
                    >
                      <Bookmark
                        className={`h-3.5 w-3.5 ${isHospitalSaved(h.hospital_id) ? 'fill-current' : ''}`}
                        aria-hidden="true"
                      />
                      <span>{isHospitalSaved(h.hospital_id) ? 'Saved' : 'Save'}</span>
                    </button>

                    <button
                      type="button"
                      disabled={!canAdd}
                      onClick={() => onToggleCompare(h.hospital_id)}
                      className={`inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-xl border px-3.5 py-2 text-xs font-semibold transition-colors whitespace-nowrap ${
                        viewMode === 'list' ? 'w-full' : ''
                      } ${
                        isSelected
                          ? 'border-[#16A6A1] bg-[#16A6A1]/10 text-[#117A76]'
                          : 'border-slate-200 bg-white text-[#243447] hover:bg-slate-50 disabled:opacity-40'
                      }`}
                    >
                      {isSelected ? (
                        <>
                          <Check className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Selected</span>
                        </>
                      ) : (
                        <>
                          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Compare</span>
                        </>
                      )}
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={() => onOpenHospital(h.hospital_id)}
                    className={`inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-xl bg-[#1769AA] px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-[#125388] whitespace-nowrap ${
                      viewMode === 'list' ? 'w-full' : ''
                    }`}
                  >
                    <span>View Details</span>
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {data && data.pagination.total_pages > 1 && (
        <div className="flex items-center justify-between border-t border-slate-200 pt-4 text-sm text-[#718096]">
          <span className="tabular-nums">
            Page {data.pagination.page} of {data.pagination.total_pages}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="min-h-[40px] rounded-lg border border-slate-300 bg-white px-4 py-2 font-medium text-[#243447] disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={page >= data.pagination.total_pages}
              onClick={() => setPage((p) => p + 1)}
              className="min-h-[40px] rounded-lg border border-slate-300 bg-white px-4 py-2 font-medium text-[#243447] disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}

      <EmergencyNotice compact />
    </div>
  );
}
