import { ArrowRight, BedDouble, Phone, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BedStatusIndicator,
  EmergencyNotice,
} from '../components/StatusIndicators.tsx';
import { apiFetch, ApiError } from '../lib/api.ts';
import { formatDataSourceLabel, useLiveEvents } from '../lib/useLiveEvents.ts';
import type { BedStatus, GlobalBedWardItem, HospitalListItem } from '../types.ts';

interface BedAvailabilityPageProps {
  onOpenHospital: (hospitalId: number) => void;
}

export function BedAvailabilityPage({ onOpenHospital }: BedAvailabilityPageProps) {
  const [wards, setWards] = useState<GlobalBedWardItem[]>([]);
  const [hospitals, setHospitals] = useState<HospitalListItem[]>([]);
  const [selectedHospitalId, setSelectedHospitalId] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [query, setQuery] = useState('');
  const [advice, setAdvice] = useState('Call the hospital to confirm bed availability before travelling.');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ hospitals: HospitalListItem[] }>('/api/hospitals?page=1&limit=100')
      .then((res) => setHospitals(res.hospitals))
      .catch(() => {});
  }, []);

  const loadWards = useCallback(
    async (showLoader = false) => {
      if (showLoader) setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      if (selectedHospitalId) params.set('hospital_id', selectedHospitalId);
      if (query.trim()) params.set('q', query.trim());

      try {
        const res = await apiFetch<{ wards: GlobalBedWardItem[]; advice: string }>(
          `/api/beds?${params.toString()}`,
        );
        setWards(res.wards);
        if (res.advice) setAdvice(res.advice);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Unable to load ward bed records.');
      } finally {
        if (showLoader) setLoading(false);
      }
    },
    [selectedHospitalId, query],
  );

  useEffect(() => {
    loadWards(true);
  }, [loadWards]);

  useLiveEvents((ev) => {
    if (ev.type === 'beds:updated' || ev.type === 'feed:synced') {
      loadWards(false);
    }
  });

  const filteredWards = useMemo(() => {
    if (!statusFilter) return wards;
    return wards.filter((w) => w.status === (statusFilter as BedStatus));
  }, [wards, statusFilter]);

  return (
    <div className="space-y-6">
      {/* Header & Filters */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="font-display text-2xl font-bold text-[#12304A]">
                Hospital Bed Availability
              </h1>
            </div>
            <p className="mt-1 text-sm text-[#718096]">
              Ward-wise bed occupancy across General Ward, ICU, Maternity Ward, and Pediatric Ward. {advice}
            </p>
          </div>
          <div className="inline-flex items-center gap-2 rounded-xl border border-[#16A6A1]/30 bg-[#16A6A1]/10 px-3.5 py-2 text-xs font-semibold text-[#117A76]">
            <Phone className="h-3.5 w-3.5" />
            <span>Confirm beds by calling hospital before travel</span>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-12">
          <div className="relative md:col-span-5">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#718096]" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search hospital or ward type (e.g. ICU, Maternity)..."
              className="min-h-[42px] w-full rounded-xl border border-slate-200 bg-[#F5F8FC] pl-10 pr-3 text-sm text-[#243447] focus:border-[#1769AA] focus:bg-white focus:outline-none"
            />
          </div>

          <div className="md:col-span-4">
            <select
              aria-label="Filter by hospital"
              value={selectedHospitalId}
              onChange={(e) => setSelectedHospitalId(e.target.value)}
              className="min-h-[42px] w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-[#243447]"
            >
              <option value="">All participating hospitals</option>
              {hospitals.map((h) => (
                <option key={h.hospital_id} value={h.hospital_id}>
                  {h.name}
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-3">
            <select
              aria-label="Filter by bed status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="min-h-[42px] w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-[#243447]"
            >
              <option value="">All availability statuses</option>
              <option value="Available">Available (≥ 30%)</option>
              <option value="Limited Availability">Limited Availability (10–30%)</option>
              <option value="Likely Unavailable">Likely Unavailable (&lt; 10%)</option>
            </select>
          </div>
        </div>
      </section>

      {error && (
        <div role="alert" className="rounded-xl border border-[#E05252]/40 bg-red-50 p-4 text-sm text-red-900">
          {error}
        </div>
      )}

      {/* Ward-Wise Cards */}
      {loading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <div key={n} className="h-48 animate-pulse rounded-xl border border-slate-200 bg-white p-5" />
          ))}
        </div>
      ) : filteredWards.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-sm text-[#718096]">
          No ward bed records match your current filter.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filteredWards.map((w) => {
            const barColor =
              w.availability_pct >= 30
                ? 'bg-[#16A36A]'
                : w.availability_pct >= 10
                  ? 'bg-[#F59E0B]'
                  : 'bg-[#E05252]';
            return (
              <article
                key={`${w.hospital_id}-${w.ward_type}`}
                className="flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-5 shadow-xs transition-all hover:border-[#1769AA]/40 hover:shadow-sm"
              >
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#16A6A1]/10 text-[#16A6A1]">
                        <BedDouble className="h-4 w-4" aria-hidden="true" />
                      </div>
                      <div>
                        <h2 className="font-display text-base font-bold text-[#12304A]">{w.ward_type}</h2>
                        <p className="text-xs text-[#718096]">{w.hospital_name}</p>
                      </div>
                    </div>
                    <BedStatusIndicator status={w.status} />
                  </div>

                  {/* Bed Metrics */}
                  <div className="mt-4 grid grid-cols-3 gap-2 rounded-xl bg-[#F5F8FC] p-3 text-center">
                    <div>
                      <div className="text-[11px] text-[#718096]">Total</div>
                      <div className="font-mono text-base font-bold text-[#12304A] tabular-nums">
                        {w.total_beds}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] text-[#718096]">Available</div>
                      <div className="font-mono text-base font-bold text-[#16A36A] tabular-nums">
                        {w.available_beds}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] text-[#718096]">Occupied</div>
                      <div className="font-mono text-base font-bold text-[#243447] tabular-nums">
                        {w.occupied_beds}
                      </div>
                    </div>
                  </div>

                  {/* Availability Percentage Bar */}
                  <div className="mt-3 space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-[#718096]">Availability</span>
                      <span className="font-mono font-bold text-[#12304A] tabular-nums">
                        {w.availability_pct}%
                      </span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                      <div
                        className={`h-full rounded-full transition-all duration-300 ${barColor}`}
                        style={{ width: `${w.availability_pct}%` }}
                      />
                    </div>
                  </div>
                </div>

                <div className="mt-4 flex items-center justify-between gap-2 border-t border-slate-100 pt-3 text-xs">
                  <div className="text-[#718096]">
                    <span className="font-mono tabular-nums">{w.record_time_ist}</span>
                    <span className="mx-1.5" aria-hidden="true">·</span>
                    <span>{formatDataSourceLabel(w.data_source)}</span>
                    {w.is_outdated && (
                      <span className="ml-1.5 font-semibold text-[#E05252]">Outdated (&gt;24h)</span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => onOpenHospital(w.hospital_id)}
                    className="inline-flex items-center gap-1 font-semibold text-[#1769AA] hover:underline"
                  >
                    <span>Hospital</span>
                    <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <EmergencyNotice compact />
    </div>
  );
}
