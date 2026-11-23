import { ArrowUpDown, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  BedStatusIndicator,
  ConfidenceText,
  EmergencyNotice,
  QueueLevelBadge,
} from '../components/StatusIndicators.tsx';
import { apiFetch, ApiError } from '../lib/api.ts';
import type { CompareColumn, HospitalListItem } from '../types.ts';

interface ComparePageProps {
  selectedIds: number[];
  onUpdateSelectedIds: (ids: number[]) => void;
  onOpenHospital: (hospitalId: number) => void;
}

interface CompareResponse {
  department: string;
  available_departments: string[];
  columns: CompareColumn[];
  disclaimer: string;
}

export function ComparePage({
  selectedIds,
  onUpdateSelectedIds,
  onOpenHospital,
}: ComparePageProps) {
  const [allHospitals, setAllHospitals] = useState<HospitalListItem[]>([]);
  const [department, setDepartment] = useState('General Medicine');
  const [sortByWait, setSortByWait] = useState(false);
  const [compareData, setCompareData] = useState<CompareResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ hospitals: HospitalListItem[] }>('/api/hospitals?page=1&limit=100')
      .then((res) => {
        setAllHospitals(res.hospitals);
        if (selectedIds.length === 0 && res.hospitals.length >= 2) {
          onUpdateSelectedIds([res.hospitals[0].hospital_id, res.hospitals[1].hospital_id]);
        }
      })
      .catch(() => {});
  }, [selectedIds.length, onUpdateSelectedIds]);

  useEffect(() => {
    if (selectedIds.length < 2) {
      setCompareData(null);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({
      hospitals: selectedIds.join(','),
      department,
    });
    apiFetch<CompareResponse>(`/api/compare?${params.toString()}`)
      .then((res) => {
        if (active) setCompareData(res);
      })
      .catch((err) => {
        if (active) setError(err instanceof ApiError ? err.message : 'Unable to compare hospitals.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selectedIds, department]);

  const handleAddHospital = (id: number) => {
    if (selectedIds.includes(id) || selectedIds.length >= 4) return;
    onUpdateSelectedIds([...selectedIds, id]);
  };

  const handleRemoveHospital = (id: number) => {
    onUpdateSelectedIds(selectedIds.filter((x) => x !== id));
  };

  const columns = [...(compareData?.columns || [])];
  if (sortByWait) {
    columns.sort((a, b) => {
      const aLow = a.estimate?.is_open_now && a.estimate.range_low !== null ? a.estimate.range_low : 9999;
      const bLow = b.estimate?.is_open_now && b.estimate.range_low !== null ? b.estimate.range_low : 9999;
      return aLow - bLow;
    });
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="font-display text-2xl font-bold text-[#12304A]">
            Compare Hospitals Side by Side
          </h1>
        </div>
        <p className="mt-1.5 text-sm text-[#718096]">
          Select 2 to 4 participating hospitals and a department to compare OPD timings, waiting ranges, available
          departments, and bed status. Metrics are presented neutrally without clinical recommendations.
        </p>

        {/* Controls */}
        <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-12">
          <div className="md:col-span-4">
            <label htmlFor="compare-dept" className="block text-xs font-semibold uppercase tracking-wider text-[#718096]">
              Department
            </label>
            <select
              id="compare-dept"
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
              className="mt-1.5 min-h-[42px] w-full rounded-xl border border-slate-200 bg-[#F5F8FC] px-3.5 text-sm font-medium text-[#12304A]"
            >
              {(compareData?.available_departments || [
                'General Medicine',
                'Pediatrics',
                'Orthopedics',
                'Cardiology',
                'ENT',
                'Gynecology',
                'Dermatology',
                'Ophthalmology',
              ]).map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-5">
            <label htmlFor="add-compare-hospital" className="block text-xs font-semibold uppercase tracking-wider text-[#718096]">
              Add Hospital ({selectedIds.length}/4 selected)
            </label>
            <select
              id="add-compare-hospital"
              value=""
              disabled={selectedIds.length >= 4}
              onChange={(e) => {
                const id = Number(e.target.value);
                if (id) handleAddHospital(id);
              }}
              className="mt-1.5 min-h-[42px] w-full rounded-xl border border-slate-200 bg-[#F5F8FC] px-3.5 text-sm text-[#12304A] disabled:opacity-50"
            >
              <option value="">
                {selectedIds.length >= 4 ? 'Maximum 4 hospitals selected' : 'Choose a hospital to add...'}
              </option>
              {allHospitals
                .filter((h) => !selectedIds.includes(h.hospital_id))
                .map((h) => (
                  <option key={h.hospital_id} value={h.hospital_id}>
                    {h.name} ({h.type})
                  </option>
                ))}
            </select>
          </div>

          <div className="flex items-end md:col-span-3">
            <button
              type="button"
              onClick={() => setSortByWait((s) => !s)}
              className={`inline-flex min-h-[42px] w-full items-center justify-center gap-2 rounded-xl border px-4 py-2 text-xs font-semibold transition-colors ${
                sortByWait
                  ? 'border-[#16A6A1] bg-[#16A6A1]/10 text-[#117A76]'
                  : 'border-slate-200 bg-white text-[#243447] hover:bg-slate-50'
              }`}
            >
              <ArrowUpDown className="h-4 w-4" aria-hidden="true" />
              <span>{sortByWait ? 'Sorted by Wait (Low→High)' : 'Sort by Wait Lower Bound'}</span>
            </button>
          </div>
        </div>

        {/* Selected hospitals removable pills */}
        <div className="mt-4 flex flex-wrap gap-2">
          {selectedIds.map((id) => {
            const h = allHospitals.find((item) => item.hospital_id === id);
            return (
              <div
                key={id}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-[#F5F8FC] px-3 py-1.5 text-xs font-semibold text-[#12304A]"
              >
                <span>{h?.name || `Hospital #${id}`}</span>
                <button
                  type="button"
                  aria-label={`Remove ${h?.name || id} from comparison`}
                  onClick={() => handleRemoveHospital(id)}
                  className="rounded p-0.5 text-[#718096] hover:bg-slate-200 hover:text-[#12304A]"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      </section>

      {selectedIds.length < 2 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-[#718096]">
          <Plus className="mx-auto h-6 w-6 text-[#1769AA]" aria-hidden="true" />
          <p className="mt-2 font-semibold text-[#12304A]">Select at least 2 hospitals to compare</p>
          <p className="mt-1 text-sm">Use the dropdown above to choose between 2 and 4 hospitals.</p>
        </div>
      ) : loading ? (
        <div className="h-72 animate-pulse rounded-2xl border border-slate-200 bg-white" />
      ) : error ? (
        <div className="rounded-xl border border-[#E05252]/40 bg-red-50 p-5 text-red-900">{error}</div>
      ) : (
        <>
          {/* Desktop comparison table */}
          <div className="hidden overflow-x-auto rounded-2xl border border-slate-200 bg-white sm:block">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-[#F5F8FC]">
                  <th className="w-48 px-5 py-4 font-semibold text-[#12304A]">Metric ({department})</th>
                  {columns.map((col) => (
                    <th key={col.hospital_id} className="min-w-[210px] px-5 py-4 align-top">
                      <button
                        type="button"
                        onClick={() => onOpenHospital(col.hospital_id)}
                        className="text-left font-display text-base font-bold text-[#1769AA] hover:underline"
                      >
                        {col.hospital_name}
                      </button>
                      <div className="mt-0.5 text-xs font-normal text-[#718096]">
                        {col.type} · {col.city}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                <tr>
                  <td className="px-5 py-3.5 font-medium text-[#718096]">Available Departments</td>
                  {columns.map((col) => {
                    const hosp = allHospitals.find((h) => h.hospital_id === col.hospital_id);
                    return (
                      <td key={col.hospital_id} className="px-5 py-3.5 text-xs text-[#243447]">
                        {hosp ? hosp.department_names.join(', ') : col.department_name}
                      </td>
                    );
                  })}
                </tr>
                <tr>
                  <td className="px-5 py-3.5 font-medium text-[#718096]">Queue Level</td>
                  {columns.map((col) => (
                    <td key={col.hospital_id} className="px-5 py-3.5">
                      {!col.department_found || !col.estimate ? (
                        <span className="text-[#718096]">Not available</span>
                      ) : !col.estimate.is_open_now ? (
                        <span className="font-medium text-[#243447]">OPD closed</span>
                      ) : col.estimate.queue_level ? (
                        <QueueLevelBadge level={col.estimate.queue_level} />
                      ) : (
                        <span className="text-[#718096]">Not available</span>
                      )}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td className="px-5 py-3.5 font-medium text-[#718096]">Estimated Wait Range</td>
                  {columns.map((col) => (
                    <td key={col.hospital_id} className="px-5 py-3.5 font-mono font-bold text-[#12304A] tabular-nums">
                      {!col.department_found || !col.estimate ? (
                        <span className="font-sans font-normal text-[#718096]">Not available</span>
                      ) : !col.estimate.is_open_now ? (
                        <span className="font-sans text-xs font-normal text-[#718096]">
                          Opens {col.estimate.next_opening_text}
                        </span>
                      ) : (
                        `${col.estimate.range_low}–${col.estimate.range_high} min`
                      )}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td className="px-5 py-3.5 font-medium text-[#718096]">Recent Reports (2h)</td>
                  {columns.map((col) => (
                    <td key={col.hospital_id} className="px-5 py-3.5 tabular-nums text-[#243447]">
                      {!col.department_found || !col.estimate || !col.estimate.is_open_now ? (
                        <span className="text-[#718096]">Not available</span>
                      ) : col.estimate.recent_reports_count > 0 ? (
                        `${col.estimate.recent_reports_count} reports`
                      ) : (
                        'Historical data only'
                      )}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td className="px-5 py-3.5 font-medium text-[#718096]">Confidence</td>
                  {columns.map((col) => (
                    <td key={col.hospital_id} className="px-5 py-3.5">
                      {col.estimate?.is_open_now && col.estimate.confidence ? (
                        <ConfidenceText confidence={col.estimate.confidence} />
                      ) : (
                        <span className="text-[#718096]">Not available</span>
                      )}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td className="px-5 py-3.5 font-medium text-[#718096]">Last Updated (IST)</td>
                  {columns.map((col) => (
                    <td key={col.hospital_id} className="px-5 py-3.5 font-mono text-xs text-[#243447] tabular-nums">
                      {col.estimate?.last_updated_ist || 'Not available'}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td className="px-5 py-3.5 font-medium text-[#718096]">OPD Timings</td>
                  {columns.map((col) => (
                    <td key={col.hospital_id} className="px-5 py-3.5 text-xs text-[#243447]">
                      {col.estimate?.opd_timings_label || 'Not available'}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td className="px-5 py-3.5 font-medium text-[#718096]">Overall Bed Availability</td>
                  {columns.map((col) => (
                    <td key={col.hospital_id} className="px-5 py-3.5">
                      {col.bed_summary ? (
                        <div className="space-y-1">
                          <BedStatusIndicator status={col.bed_summary.status} />
                          <div className="font-mono text-xs text-[#718096] tabular-nums">
                            {col.bed_summary.as_of_ist}
                            {col.bed_summary.is_outdated ? ' · Outdated' : ''}
                          </div>
                        </div>
                      ) : (
                        <span className="text-[#718096]">Not available</span>
                      )}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>

          {/* Mobile stacked comparison cards */}
          <div className="space-y-4 sm:hidden">
            {columns.map((col) => (
              <div key={col.hospital_id} className="rounded-xl border border-slate-200 bg-white p-5">
                <button
                  type="button"
                  onClick={() => onOpenHospital(col.hospital_id)}
                  className="text-left font-display text-lg font-bold text-[#1769AA]"
                >
                  {col.hospital_name}
                </button>
                <p className="text-xs text-[#718096]">
                  {col.type} · {col.city}
                </p>

                <dl className="mt-4 space-y-2.5 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-[#718096]">Queue ({department})</dt>
                    <dd>
                      {!col.department_found || !col.estimate ? (
                        <span className="text-[#718096]">Not available</span>
                      ) : !col.estimate.is_open_now ? (
                        <span>OPD closed</span>
                      ) : (
                        col.estimate.queue_level && <QueueLevelBadge level={col.estimate.queue_level} />
                      )}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-[#718096]">Wait Range</dt>
                    <dd className="font-mono font-bold text-[#12304A] tabular-nums">
                      {col.estimate?.is_open_now
                        ? `${col.estimate.range_low}–${col.estimate.range_high} min`
                        : 'Not available'}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-[#718096]">Last Updated</dt>
                    <dd className="font-mono text-xs text-[#243447] tabular-nums">
                      {col.estimate?.last_updated_ist || 'Not available'}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-[#718096]">Beds</dt>
                    <dd>
                      {col.bed_summary ? (
                        <BedStatusIndicator status={col.bed_summary.status} />
                      ) : (
                        <span className="text-[#718096]">Not available</span>
                      )}
                    </dd>
                  </div>
                </dl>
              </div>
            ))}
          </div>

          <p className="text-xs leading-relaxed text-[#718096]">
            Waiting times are estimates and may change depending on hospital conditions.
          </p>
          <EmergencyNotice compact />
        </>
      )}
    </div>
  );
}
