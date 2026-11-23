import { CheckCircle2, Clock, LogOut, Search, ShieldCheck, User } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { EmergencyNotice, QueueLevelBadge } from '../components/StatusIndicators.tsx';
import {
  getRecentlyViewedHospitals,
  getRecentSearches,
  type ViewedHospitalEntry,
} from '../lib/activity.ts';
import { apiFetch, ApiError } from '../lib/api.ts';
import type {
  AuthUser,
  DepartmentSummary,
  HospitalListItem,
  MyUpdateItem,
  QueueLevel,
} from '../types.ts';

interface SubmitUpdatePageProps {
  user: AuthUser | null;
  initialHospitalId: number | null;
  initialDepartmentId: number | null;
  defaultTab?: 'submit' | 'mine' | 'account';
  onRequireAuth: () => void;
  onAuthChange: (user: AuthUser | null, token?: string) => void;
  onSearchHospitals?: (query: string) => void;
  onOpenHospital?: (hospitalId: number) => void;
}

function toLocalDatetimeInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export function SubmitUpdatePage({
  user,
  initialHospitalId,
  initialDepartmentId,
  defaultTab = 'submit',
  onRequireAuth,
  onAuthChange,
  onSearchHospitals,
  onOpenHospital,
}: SubmitUpdatePageProps) {
  const [tab, setTab] = useState<'submit' | 'mine' | 'account'>(defaultTab);
  const [hospitals, setHospitals] = useState<HospitalListItem[]>([]);
  const [departments, setDepartments] = useState<DepartmentSummary[]>([]);

  const [hospitalId, setHospitalId] = useState<number>(initialHospitalId || 0);
  const [departmentId, setDepartmentId] = useState<number>(initialDepartmentId || 0);
  const [waitingMinutes, setWaitingMinutes] = useState<string>('25');
  const [queueLevel, setQueueLevel] = useState<QueueLevel>('Medium');
  const [visitTime, setVisitTime] = useState<string>(() => toLocalDatetimeInputValue(new Date()));

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState<{ status: string; message: string } | null>(null);

  const [myUpdates, setMyUpdates] = useState<MyUpdateItem[]>([]);
  const [loadingMine, setLoadingMine] = useState(false);
  const [recentSearches] = useState<string[]>(() => getRecentSearches());
  const [recentHospitals] = useState<ViewedHospitalEntry[]>(() => getRecentlyViewedHospitals());

  // Account management state
  const [profileName, setProfileName] = useState(user?.name || '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [accountMsg, setAccountMsg] = useState<string | null>(null);
  const [accountErr, setAccountErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setTab(defaultTab);
  }, [defaultTab]);

  useEffect(() => {
    if (user) setProfileName(user.name);
  }, [user]);

  useEffect(() => {
    apiFetch<{ hospitals: HospitalListItem[] }>('/api/hospitals?page=1&limit=100')
      .then((res) => {
        setHospitals(res.hospitals);
        if (!hospitalId && res.hospitals.length > 0) {
          setHospitalId(initialHospitalId || res.hospitals[0].hospital_id);
        }
      })
      .catch(() => {});
  }, [hospitalId, initialHospitalId]);

  useEffect(() => {
    if (!hospitalId) return;
    apiFetch<{ departments: DepartmentSummary[] }>(`/api/hospitals/${hospitalId}/departments`)
      .then((res) => {
        setDepartments(res.departments);
        if (
          initialDepartmentId &&
          res.departments.some((d) => d.department_id === initialDepartmentId)
        ) {
          setDepartmentId(initialDepartmentId);
        } else if (res.departments.length > 0) {
          setDepartmentId((prev) =>
            res.departments.some((d) => d.department_id === prev)
              ? prev
              : res.departments[0].department_id,
          );
        } else {
          setDepartmentId(0);
        }
      })
      .catch(() => {});
  }, [hospitalId, initialDepartmentId]);

  const loadMyUpdates = useCallback(async () => {
    if (!user) return;
    setLoadingMine(true);
    try {
      const res = await apiFetch<{ updates: MyUpdateItem[] }>('/api/updates/mine');
      setMyUpdates(res.updates);
    } catch {
      // ignore
    } finally {
      setLoadingMine(false);
    }
  }, [user]);

  useEffect(() => {
    if (user && (tab === 'mine' || submitSuccess)) {
      loadMyUpdates();
    }
  }, [user, tab, submitSuccess, loadMyUpdates]);

  const handleMinutesChange = (val: string) => {
    setWaitingMinutes(val);
    const num = Number.parseInt(val, 10);
    if (Number.isFinite(num)) {
      if (num < 20) setQueueLevel('Low');
      else if (num <= 45) setQueueLevel('Medium');
      else setQueueLevel('High');
    }
  };

  const handleSubmitUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    setSubmitSuccess(null);

    const mins = Number.parseInt(waitingMinutes, 10);
    if (!Number.isInteger(mins) || mins < 0 || mins > 360) {
      setSubmitError('Please enter waiting time as a whole number between 0 and 360 minutes.');
      return;
    }

    setSubmitting(true);
    try {
      const visitIso = new Date(visitTime).toISOString();
      const res = await apiFetch<{
        update_id: number;
        validation_status: string;
        message: string;
      }>('/api/updates', {
        method: 'POST',
        body: JSON.stringify({
          hospital_id: hospitalId,
          department_id: departmentId,
          queue_level: queueLevel,
          waiting_minutes: mins,
          visit_time: visitIso,
        }),
      });

      setSubmitSuccess({ status: res.validation_status, message: res.message });
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : 'Could not submit queue update.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleUpdateName = async (e: React.FormEvent) => {
    e.preventDefault();
    setAccountMsg(null);
    setAccountErr(null);
    try {
      const res = await apiFetch<{ token: string; user: AuthUser }>('/api/auth/profile', {
        method: 'PATCH',
        body: JSON.stringify({ name: profileName }),
      });
      onAuthChange(res.user, res.token);
      setAccountMsg('Your display name has been updated.');
    } catch (err) {
      setAccountErr(err instanceof ApiError ? err.message : 'Unable to update name.');
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setAccountMsg(null);
    setAccountErr(null);
    try {
      const res = await apiFetch<{ message: string }>('/api/auth/password', {
        method: 'PATCH',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setCurrentPassword('');
      setNewPassword('');
      setAccountMsg(res.message);
    } catch (err) {
      setAccountErr(err instanceof ApiError ? err.message : 'Unable to change password.');
    }
  };

  const handleDeleteAccount = async () => {
    setAccountErr(null);
    try {
      await apiFetch('/api/auth/account', { method: 'DELETE' });
      onAuthChange(null);
    } catch (err) {
      setAccountErr(err instanceof ApiError ? err.message : 'Unable to delete account.');
    }
  };

  if (!user) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <section className="rounded-2xl border border-slate-200 bg-white p-8 text-center">
          <ShieldCheck className="mx-auto h-10 w-10 text-[#1769AA]" aria-hidden="true" />
          <h1 className="mt-3 font-display text-2xl font-bold text-[#12304A]">
            Sign in to submit an OPD queue update
          </h1>
          <p className="mt-2 text-sm text-[#718096]">
            To prevent spam and keep crowd predictions trustworthy, only signed-in users can submit waiting-time
            reports. Your name and email are never shown publicly.
          </p>
          <button
            type="button"
            onClick={onRequireAuth}
            className="mt-6 min-h-[44px] rounded-xl bg-[#1769AA] px-6 py-2.5 text-sm font-semibold text-white hover:bg-[#125388]"
          >
            Sign In or Create Account
          </button>
        </section>
        <EmergencyNotice />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#12304A]">
            {tab === 'submit'
              ? 'Submit Crowd Queue Update'
              : tab === 'mine'
                ? 'My Activity & Submitted Updates'
                : 'Profile & Account Settings'}
          </h1>
          <p className="mt-1 text-sm text-[#718096]">
            Structured reporting only — no free-text notes collected and submitter identity stays private.
          </p>
        </div>

        <div className="inline-flex rounded-xl bg-slate-200/70 p-1">
          <button
            type="button"
            onClick={() => setTab('submit')}
            className={`min-h-[38px] rounded-lg px-3.5 py-1.5 text-xs font-semibold whitespace-nowrap ${
              tab === 'submit' ? 'bg-white text-[#1769AA] shadow-xs' : 'text-[#243447]'
            }`}
          >
            Submit Update
          </button>
          <button
            type="button"
            onClick={() => setTab('mine')}
            className={`min-h-[38px] rounded-lg px-3.5 py-1.5 text-xs font-semibold whitespace-nowrap ${
              tab === 'mine' ? 'bg-white text-[#1769AA] shadow-xs' : 'text-[#243447]'
            }`}
          >
            My Activity
          </button>
          <button
            type="button"
            onClick={() => setTab('account')}
            className={`min-h-[38px] rounded-lg px-3.5 py-1.5 text-xs font-semibold whitespace-nowrap ${
              tab === 'account' ? 'bg-white text-[#1769AA] shadow-xs' : 'text-[#243447]'
            }`}
          >
            Profile
          </button>
        </div>
      </div>

      {tab === 'submit' && (
        <section className="rounded-2xl border border-slate-200 bg-white p-6 sm:p-8">
          <form onSubmit={handleSubmitUpdate} className="space-y-5">
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <div>
                <label htmlFor="upd-hospital" className="block text-sm font-medium text-[#12304A]">
                  Hospital
                </label>
                <select
                  id="upd-hospital"
                  required
                  value={hospitalId}
                  onChange={(e) => setHospitalId(Number(e.target.value))}
                  className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-300 bg-[#F5F8FC] px-3.5 text-sm text-[#12304A]"
                >
                  {hospitals.map((h) => (
                    <option key={h.hospital_id} value={h.hospital_id}>
                      {h.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="upd-dept" className="block text-sm font-medium text-[#12304A]">
                  Department
                </label>
                <select
                  id="upd-dept"
                  required
                  value={departmentId}
                  onChange={(e) => setDepartmentId(Number(e.target.value))}
                  className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-300 bg-[#F5F8FC] px-3.5 text-sm text-[#12304A]"
                >
                  {departments.map((d) => (
                    <option key={d.department_id} value={d.department_id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <div>
                <label htmlFor="upd-wait" className="block text-sm font-medium text-[#12304A]">
                  Approximate waiting time (0–360 minutes)
                </label>
                <input
                  id="upd-wait"
                  type="number"
                  min={0}
                  max={360}
                  step={1}
                  required
                  value={waitingMinutes}
                  onChange={(e) => handleMinutesChange(e.target.value)}
                  className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-300 bg-[#F5F8FC] px-3.5 font-mono text-base text-[#12304A] tabular-nums"
                />
                <div className="mt-2 flex flex-wrap gap-2">
                  {[10, 25, 40, 60, 90].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => handleMinutesChange(String(preset))}
                      className="rounded-lg border border-slate-200 bg-[#F5F8FC] px-2.5 py-1 font-mono text-xs text-[#243447] hover:border-[#1769AA] hover:text-[#1769AA]"
                    >
                      {preset} min
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <span className="block text-sm font-medium text-[#12304A]">
                  Queue Level (must match waiting time)
                </span>
                <div className="mt-1.5 grid grid-cols-3 gap-2">
                  {(
                    [
                      { level: 'Low', hint: '< 20 min' },
                      { level: 'Medium', hint: '20–45 min' },
                      { level: 'High', hint: '> 45 min' },
                    ] as const
                  ).map((item) => (
                    <button
                      key={item.level}
                      type="button"
                      onClick={() => setQueueLevel(item.level)}
                      className={`min-h-[44px] rounded-xl border px-2 py-2 text-center transition-colors ${
                        queueLevel === item.level
                          ? 'border-[#1769AA] bg-[#1769AA]/10 text-[#1769AA]'
                          : 'border-slate-300 bg-white text-[#243447] hover:bg-slate-50'
                      }`}
                    >
                      <div className="text-sm font-semibold">{item.level}</div>
                      <div className="text-xs text-[#718096]">{item.hint}</div>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div>
              <label htmlFor="upd-visit-time" className="block text-sm font-medium text-[#12304A]">
                OPD Visit Time (within the last 6 hours; not in the future)
              </label>
              <input
                id="upd-visit-time"
                type="datetime-local"
                required
                value={visitTime}
                onChange={(e) => setVisitTime(e.target.value)}
                className="mt-1.5 min-h-[44px] w-full max-w-xs rounded-xl border border-slate-300 bg-[#F5F8FC] px-3.5 font-mono text-sm text-[#12304A]"
              />
              <p className="mt-1 text-xs text-[#718096]">
                Limits enforced: 1 update per department every 30 minutes, maximum 10 updates per day. Statistical
                outliers are automatically flagged for admin moderation.
              </p>
            </div>

            {submitError && (
              <div role="alert" className="rounded-xl border border-[#E05252]/40 bg-red-50 px-4 py-3 text-sm text-red-900">
                {submitError}
              </div>
            )}

            {submitSuccess && (
              <div
                role="status"
                className={`flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm ${
                  submitSuccess.status === 'Flagged'
                    ? 'border-[#F59E0B]/40 bg-amber-50 text-amber-950'
                    : 'border-[#16A36A]/40 bg-emerald-50 text-emerald-950'
                }`}
              >
                {submitSuccess.status === 'Flagged' ? (
                  <Clock className="mt-0.5 h-4 w-4 shrink-0 text-[#D97706]" />
                ) : (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#16A36A]" />
                )}
                <div>
                  <span className="font-semibold">Status: {submitSuccess.status}.</span>{' '}
                  {submitSuccess.message}
                </div>
              </div>
            )}

            <div className="pt-2">
              <button
                type="submit"
                disabled={submitting}
                className="min-h-[44px] rounded-xl bg-[#1769AA] px-6 py-2.5 text-sm font-semibold text-white hover:bg-[#125388] disabled:opacity-50"
              >
                {submitting ? 'Submitting...' : 'Submit Live Update'}
              </button>
            </div>
          </form>
        </section>
      )}

      {tab === 'mine' && (
        <div className="space-y-6">
          <section className="rounded-2xl border border-slate-200 bg-white p-6">
            <h2 className="font-display text-lg font-semibold text-[#12304A]">
              Update Submission History
            </h2>
            {loadingMine ? (
              <div className="mt-4 h-40 animate-pulse rounded-xl bg-slate-100" />
            ) : myUpdates.length === 0 ? (
              <div className="mt-4 rounded-xl border border-slate-200 bg-[#F5F8FC] p-6 text-center text-sm text-[#718096]">
                You have not submitted any queue updates yet.
              </div>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-xs font-semibold text-[#718096]">
                      <th className="py-3 pr-4">Hospital &amp; Department</th>
                      <th className="px-4 py-3">Reported Wait</th>
                      <th className="px-4 py-3">Submitted (IST)</th>
                      <th className="pl-4 py-3">Validation Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {myUpdates.map((u) => (
                      <tr key={u.update_id}>
                        <td className="py-3.5 pr-4">
                          <div className="font-semibold text-[#12304A]">{u.hospital_name}</div>
                          <div className="text-xs text-[#718096]">{u.department_name}</div>
                        </td>
                        <td className="px-4 py-3.5">
                          <div className="flex items-center gap-2">
                            <QueueLevelBadge level={u.queue_level} />
                            <span className="font-mono font-semibold tabular-nums">
                              {u.waiting_minutes} min
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3.5 font-mono text-xs text-[#718096] tabular-nums">
                          {u.submitted_at_ist}
                        </td>
                        <td className="pl-4 py-3.5">
                          <span
                            className={`font-semibold ${
                              u.validation_status === 'Accepted' || u.validation_status === 'Approved'
                                ? 'text-[#16A36A]'
                                : u.validation_status === 'Flagged'
                                  ? 'text-[#D97706]'
                                  : 'text-[#E05252]'
                            }`}
                          >
                            {u.validation_status}
                          </span>
                          {u.flag_reason && (
                            <p className="mt-0.5 max-w-xs text-xs text-[#718096]">{u.flag_reason}</p>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <section className="rounded-2xl border border-slate-200 bg-white p-6">
              <h2 className="font-display text-base font-semibold text-[#12304A]">
                Recent Hospital Searches
              </h2>
              <div className="mt-3 flex flex-wrap gap-2">
                {recentSearches.length === 0 ? (
                  <p className="text-xs text-[#718096]">No recent searches recorded.</p>
                ) : (
                  recentSearches.map((term) => (
                    <button
                      key={term}
                      type="button"
                      onClick={() => onSearchHospitals?.(term)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-[#F5F8FC] px-3 py-1.5 text-xs font-medium text-[#243447] hover:border-[#1769AA] hover:text-[#1769AA]"
                    >
                      <Search className="h-3 w-3 text-[#718096]" />
                      <span>{term}</span>
                    </button>
                  ))
                )}
              </div>
            </section>

            <section className="rounded-2xl border border-slate-200 bg-white p-6">
              <h2 className="font-display text-base font-semibold text-[#12304A]">
                Recently Viewed Hospitals
              </h2>
              <div className="mt-3 space-y-2">
                {recentHospitals.length === 0 ? (
                  <p className="text-xs text-[#718096]">Open any hospital card to track it here.</p>
                ) : (
                  recentHospitals.map((h) => (
                    <button
                      key={h.hospital_id}
                      type="button"
                      onClick={() => onOpenHospital?.(h.hospital_id)}
                      className="flex w-full items-center justify-between rounded-lg border border-slate-100 bg-[#F5F8FC] px-3 py-2 text-left text-xs hover:border-[#1769AA]/40"
                    >
                      <span className="font-semibold text-[#12304A]">{h.name}</span>
                      <span className="text-[#718096]">{h.viewedAtIst}</span>
                    </button>
                  ))
                )}
              </div>
            </section>
          </div>
        </div>
      )}

      {tab === 'account' && (
        <div className="space-y-6">
          {accountMsg && (
            <div className="rounded-xl border border-[#16A36A]/40 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
              {accountMsg}
            </div>
          )}
          {accountErr && (
            <div className="rounded-xl border border-[#E05252]/40 bg-red-50 px-4 py-3 text-sm text-red-900">
              {accountErr}
            </div>
          )}

          <section className="rounded-2xl border border-slate-200 bg-white p-6">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 pb-4">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#1769AA]/10 text-[#1769AA]">
                  <User className="h-6 w-6" />
                </div>
                <div>
                  <h2 className="font-display text-lg font-semibold text-[#12304A]">{user.name}</h2>
                  <p className="text-xs text-[#718096]">
                    {user.email} · Role: <span className="font-semibold uppercase">{user.role}</span>
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => onAuthChange(null)}
                className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold text-[#243447] hover:bg-slate-50"
              >
                <LogOut className="h-4 w-4 text-[#E05252]" />
                <span>Logout</span>
              </button>
            </div>

            <form onSubmit={handleUpdateName} className="mt-5 flex flex-wrap items-end gap-4">
              <div className="min-w-[220px] flex-1">
                <label htmlFor="prof-name" className="block text-sm font-medium text-[#12304A]">
                  Display Name
                </label>
                <input
                  id="prof-name"
                  type="text"
                  required
                  value={profileName}
                  onChange={(e) => setProfileName(e.target.value)}
                  className="mt-1 min-h-[42px] w-full rounded-xl border border-slate-300 bg-[#F5F8FC] px-3.5 text-sm"
                />
              </div>
              <button
                type="submit"
                className="min-h-[42px] rounded-xl bg-[#1769AA] px-5 py-2 text-sm font-semibold text-white hover:bg-[#125388]"
              >
                Save Name
              </button>
            </form>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-6">
            <h2 className="font-display text-lg font-semibold text-[#12304A]">Change Password</h2>
            <form onSubmit={handleChangePassword} className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="curr-pwd" className="block text-sm font-medium text-[#12304A]">
                  Current Password
                </label>
                <input
                  id="curr-pwd"
                  type="password"
                  required
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  className="mt-1 min-h-[42px] w-full rounded-xl border border-slate-300 bg-[#F5F8FC] px-3.5 text-sm"
                />
              </div>
              <div>
                <label htmlFor="new-pwd" className="block text-sm font-medium text-[#12304A]">
                  New Password (8+ chars, letters &amp; digits)
                </label>
                <input
                  id="new-pwd"
                  type="password"
                  required
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="mt-1 min-h-[42px] w-full rounded-xl border border-slate-300 bg-[#F5F8FC] px-3.5 text-sm"
                />
              </div>
              <div className="sm:col-span-2">
                <button
                  type="submit"
                  className="min-h-[42px] rounded-xl border border-slate-300 bg-white px-5 py-2 text-sm font-semibold text-[#12304A] hover:bg-slate-50"
                >
                  Update Password
                </button>
              </div>
            </form>
          </section>

          {user.role !== 'admin' && (
            <section className="rounded-2xl border border-[#E05252]/30 bg-white p-6">
              <h2 className="font-display text-lg font-semibold text-[#B91C1C]">Delete Account</h2>
              <p className="mt-1 text-sm text-[#718096]">
                Deleting your account removes personal details immediately. Historical queue reports remain in
                anonymised form without any link to your identity.
              </p>
              {!confirmDelete ? (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="mt-4 min-h-[42px] rounded-xl border border-[#E05252]/40 px-4 py-2 text-sm font-semibold text-[#B91C1C] hover:bg-red-50"
                >
                  Request Account Deletion
                </button>
              ) : (
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={handleDeleteAccount}
                    className="min-h-[42px] rounded-xl bg-[#E05252] px-4 py-2 text-sm font-semibold text-white hover:bg-red-700"
                  >
                    Confirm Permanent Deletion
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    className="min-h-[42px] rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-[#243447]"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </section>
          )}
        </div>
      )}

      <EmergencyNotice compact />
    </div>
  );
}
