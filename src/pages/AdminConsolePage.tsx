import {
  Check,
  Copy,
  Download,
  Flag,
  KeyRound,
  Pause,
  Play,
  Radio,
  RefreshCw,
  ShieldAlert,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { BedStatusIndicator, QueueLevelBadge } from '../components/StatusIndicators.tsx';
import { apiFetch, ApiError } from '../lib/api.ts';
import { useLiveEvents } from '../lib/useLiveEvents.ts';
import type {
  AdminSection,
  FeedSyncLogItem,
  GlobalBedWardItem,
  HospitalFeedConnection,
  ModelVersionRecord,
  QueueLevel,
} from '../types.ts';

interface AdminConsolePageProps {
  activeSection: AdminSection;
  onSectionChange: (section: AdminSection) => void;
}

interface DashboardData {
  counts: {
    users: number;
    active_hospitals: number;
    active_departments: number;
    updates_24h: number;
    pending_flagged: number;
  };
  active_model: {
    model_version: string;
    model_type: string;
    training_range: string;
    data_provenance: string;
    trained_at_ist: string;
    metrics: ModelVersionRecord['metrics'];
  } | null;
  latest_timestamps: {
    waiting_records_ist: string;
    bed_records_ist: string;
    crowd_updates_ist: string;
  };
}

interface FlaggedUpdateItem {
  update_id: number;
  hospital_name: string;
  department_name: string;
  queue_level: QueueLevel;
  waiting_minutes: number;
  visit_time_ist: string;
  submitted_at_ist: string;
  validation_status: string;
  flag_reason: string | null;
  submitter_name: string;
  reviewer_name: string | null;
  reviewed_at_ist: string | null;
  context: {
    recent_valid_median: number | null;
    historical_avg: number | null;
  };
}

interface AdminHospitalItem {
  hospital_id: number;
  name: string;
  address: string;
  city: string;
  contact: string;
  type: string;
  is_active: boolean;
  departments: Array<{
    department_id: number;
    name: string;
    opd_timings_label: string;
    is_active: boolean;
  }>;
}

interface AdminUserItem {
  user_id: number;
  name: string;
  email: string;
  role: string;
  status: 'active' | 'suspended';
  created_at_ist: string;
  submission_count: number;
}

interface AuditLogItem {
  log_id: number;
  admin_name: string;
  action: string;
  target: string;
  details: string | null;
  created_at_ist: string;
}

export function AdminConsolePage({ activeSection, onSectionChange }: AdminConsolePageProps) {
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [updates, setUpdates] = useState<FlaggedUpdateItem[]>([]);
  const [modFilter, setModFilter] = useState<'Flagged' | 'All'>('Flagged');
  const [models, setModels] = useState<ModelVersionRecord[]>([]);
  const [hospitals, setHospitals] = useState<AdminHospitalItem[]>([]);
  const [bedRecords, setBedRecords] = useState<GlobalBedWardItem[]>([]);
  const [users, setUsers] = useState<AdminUserItem[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogItem[]>([]);

  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retraining, setRetraining] = useState(false);

  // Add hospital form
  const [newHospName, setNewHospName] = useState('');
  const [newHospAddr, setNewHospAddr] = useState('');
  const [newHospCity, setNewHospCity] = useState('Indore');
  const [newHospContact, setNewHospContact] = useState('');
  const [newHospType, setNewHospType] = useState('Private');

  // Add department form
  const [deptHospId, setDeptHospId] = useState<number>(1);
  const [deptName, setDeptName] = useState('');
  const [deptStart, setDeptStart] = useState('09:00');
  const [deptEnd, setDeptEnd] = useState('14:00');

  // Add bed record form
  const [bedHospId, setBedHospId] = useState<number>(1);
  const [bedWard, setBedWard] = useState('General Ward');
  const [bedTotal, setBedTotal] = useState('100');
  const [bedAvail, setBedAvail] = useState('28');

  // CSV Import state
  const [importType, setImportType] = useState<'waiting_time' | 'opd_queue' | 'beds'>('waiting_time');
  const [importSource, setImportSource] = useState<'real' | 'public'>('public');
  const [csvFileName, setCsvFileName] = useState<string | null>(null);
  const [csvText, setCsvText] = useState('');
  const [importResult, setImportResult] = useState<{
    rows_read: number;
    rows_imported: number;
    rows_rejected: number;
    errors: Array<{ row: number; reason: string }>;
  } | null>(null);

  const [feeds, setFeeds] = useState<HospitalFeedConnection[]>([]);
  const [feedLogs, setFeedLogs] = useState<FeedSyncLogItem[]>([]);
  const [feedHospId, setFeedHospId] = useState<number>(1);
  const [feedProvider, setFeedProvider] = useState('');
  const [feedType, setFeedType] = useState<'hms_webhook' | 'json_pull' | 'public_health_api'>('hms_webhook');
  const [feedSource, setFeedSource] = useState<'real' | 'public'>('real');
  const [feedEndpointUrl, setFeedEndpointUrl] = useState('');
  const [feedAuthHeader, setFeedAuthHeader] = useState('');
  const [feedAuthEnvVar, setFeedAuthEnvVar] = useState('');
  const [feedInterval, setFeedInterval] = useState('15');
  const [savingFeed, setSavingFeed] = useState(false);
  const [syncingFeedId, setSyncingFeedId] = useState<number | null>(null);
  const [issuedSecret, setIssuedSecret] = useState<{
    feed_id: number;
    provider_name: string;
    token: string;
    ingest_path: string;
  } | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const loadSection = useCallback(
    async (sec: AdminSection, currentModFilter = modFilter) => {
      setError(null);
      try {
        if (sec === 'overview') {
          const d = await apiFetch<DashboardData>('/api/admin/dashboard');
          setDashboard(d);
        } else if (sec === 'hospitals' || sec === 'departments') {
          const res = await apiFetch<{ hospitals: AdminHospitalItem[] }>('/api/admin/hospitals');
          setHospitals(res.hospitals);
        } else if (sec === 'beds') {
          const [hRes, bRes] = await Promise.all([
            apiFetch<{ hospitals: AdminHospitalItem[] }>('/api/admin/hospitals'),
            apiFetch<{ wards: GlobalBedWardItem[] }>('/api/beds'),
          ]);
          setHospitals(hRes.hospitals);
          setBedRecords(bRes.wards);
        } else if (sec === 'crowd-updates') {
          const res = await apiFetch<{ updates: FlaggedUpdateItem[] }>('/api/admin/updates?status=all');
          setUpdates(res.updates);
        } else if (sec === 'moderation') {
          const res = await apiFetch<{ updates: FlaggedUpdateItem[] }>(
            `/api/admin/updates?status=${currentModFilter.toLowerCase()}`,
          );
          setUpdates(res.updates);
        } else if (sec === 'live-feeds') {
          const [hRes, fRes] = await Promise.all([
            apiFetch<{ hospitals: AdminHospitalItem[] }>('/api/admin/hospitals'),
            apiFetch<{ feeds: HospitalFeedConnection[]; logs: FeedSyncLogItem[] }>('/api/admin/feeds'),
          ]);
          setHospitals(hRes.hospitals);
          setFeeds(fRes.feeds);
          setFeedLogs(fRes.logs);
        } else if (sec === 'ml-models') {
          const res = await apiFetch<{ models: ModelVersionRecord[] }>('/api/admin/models');
          setModels(res.models);
        } else if (sec === 'audit-logs') {
          const [uRes, aRes] = await Promise.all([
            apiFetch<{ users: AdminUserItem[] }>('/api/admin/users'),
            apiFetch<{ logs: AuditLogItem[] }>('/api/admin/audit'),
          ]);
          setUsers(uRes.users);
          setAuditLogs(aRes.logs);
        }
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Unable to load administrator data.');
      }
    },
    [modFilter],
  );

  useEffect(() => {
    loadSection(activeSection);
  }, [activeSection, loadSection]);

  useLiveEvents((ev) => {
    if (
      activeSection === 'overview' ||
      (activeSection === 'beds' && (ev.type === 'beds:updated' || ev.type === 'feed:synced')) ||
      ((activeSection === 'crowd-updates' || activeSection === 'moderation') &&
        ev.type === 'queue:updated') ||
      (activeSection === 'live-feeds' &&
        (ev.type === 'feed:synced' || ev.type === 'beds:updated' || ev.type === 'queue:updated'))
    ) {
      loadSection(activeSection);
    }
  });

  const handleModerate = async (updateId: number, decision: 'Approved' | 'Rejected' | 'Flagged') => {
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/api/admin/updates/${updateId}`, {
        method: 'PATCH',
        body: JSON.stringify({ decision }),
      });
      setNotice(`Update #${updateId} marked as ${decision}.`);
      await loadSection(activeSection);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Moderation failed.');
    }
  };

  const handleRetrain = async (autoActivate: boolean) => {
    setError(null);
    setNotice(null);
    setRetraining(true);
    try {
      const res = await apiFetch<ModelVersionRecord>('/api/admin/models/retrain', {
        method: 'POST',
        body: JSON.stringify({ auto_activate: autoActivate }),
      });
      setNotice(
        `Trained ${res.model_version} (${res.model_type}, status: ${res.status}). Beats baseline: ${
          res.metrics.beats_baseline ? 'Yes' : 'No'
        }.`,
      );
      await loadSection('ml-models');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Retraining failed.');
    } finally {
      setRetraining(false);
    }
  };

  const handleActivateModel = async (version: string) => {
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/api/admin/models/${version}/activate`, { method: 'POST' });
      setNotice(`Activated model version ${version}.`);
      await loadSection('ml-models');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Activation failed.');
    }
  };

  const handleToggleHospital = async (h: AdminHospitalItem) => {
    try {
      await apiFetch(`/api/admin/hospitals/${h.hospital_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active: !h.is_active }),
      });
      setNotice(`${h.name} is now ${!h.is_active ? 'active' : 'inactive'}.`);
      await loadSection('hospitals');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update hospital.');
    }
  };

  const handleToggleDepartment = async (deptId: number, currentActive: boolean, name: string) => {
    try {
      await apiFetch(`/api/admin/departments/${deptId}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active: !currentActive }),
      });
      setNotice(`Department ${name} is now ${!currentActive ? 'active' : 'inactive'}.`);
      await loadSection('departments');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update department.');
    }
  };

  const handleAddHospital = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      await apiFetch('/api/admin/hospitals', {
        method: 'POST',
        body: JSON.stringify({
          name: newHospName,
          address: newHospAddr,
          city: newHospCity,
          contact: newHospContact,
          type: newHospType,
        }),
      });
      setNewHospName('');
      setNewHospAddr('');
      setNewHospContact('');
      setNotice('Hospital created.');
      await loadSection('hospitals');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create hospital.');
    }
  };

  const handleAddDepartment = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      await apiFetch('/api/admin/departments', {
        method: 'POST',
        body: JSON.stringify({
          hospital_id: deptHospId,
          name: deptName,
          start_time: deptStart,
          end_time: deptEnd,
          opd_label: `Mon–Sat ${deptStart}–${deptEnd}`,
        }),
      });
      setDeptName('');
      setNotice('Department added.');
      await loadSection('departments');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add department.');
    }
  };

  const handleAddBed = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      await apiFetch('/api/admin/beds', {
        method: 'POST',
        body: JSON.stringify({
          hospital_id: bedHospId,
          ward_type: bedWard,
          total_beds: Number(bedTotal),
          available_beds: Number(bedAvail),
          data_source: 'real',
        }),
      });
      setNotice(`Bed record saved for ${bedWard}.`);
      await loadSection('beds');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save bed record.');
    }
  };

  const handleCsvFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setCsvFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setCsvText(reader.result);
      }
    };
    reader.readAsText(file);
  };

  const handleImportCsv = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setImportResult(null);
    try {
      const res = await apiFetch<{
        rows_read: number;
        rows_imported: number;
        rows_rejected: number;
        errors: Array<{ row: number; reason: string }>;
      }>(`/api/admin/import/${importType}`, {
        method: 'POST',
        body: JSON.stringify({ csv: csvText, data_source: importSource }),
      });
      setImportResult(res);
      setNotice(`CSV import finished: ${res.rows_imported} imported, ${res.rows_rejected} rejected.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'CSV import failed.');
    }
  };

  const handleDownloadCsvTemplate = async () => {
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch<{ filename: string; csv: string }>(
        `/api/admin/csv-template/${importType}`,
      );
      setCsvText(res.csv);
      setCsvFileName(res.filename);
      const blob = new Blob([res.csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = res.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setNotice(`Downloaded ${res.filename} and loaded sample header & active IDs into the editor.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not download CSV template.');
    }
  };

  const handleCopyText = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((prev) => (prev === key ? null : prev)), 2000);
    } catch {
      setError('Clipboard copy was blocked by the browser. Please select and copy manually.');
    }
  };

  const handleCreateFeed = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setSavingFeed(true);
    try {
      const res = await apiFetch<{
        feed_id: number;
        provider_name: string;
        connector_type: string;
        ingest_path: string | null;
        one_time_token: string | null;
      }>('/api/admin/feeds', {
        method: 'POST',
        body: JSON.stringify({
          hospital_id: feedHospId,
          provider_name: feedProvider,
          connector_type: feedType,
          data_source: feedSource,
          endpoint_url: feedType === 'hms_webhook' ? undefined : feedEndpointUrl,
          auth_header_name: feedType === 'hms_webhook' ? undefined : feedAuthHeader || undefined,
          auth_env_var: feedType === 'hms_webhook' ? undefined : feedAuthEnvVar || undefined,
          poll_interval_minutes: Number(feedInterval) || 15,
        }),
      });
      setFeedProvider('');
      setFeedEndpointUrl('');
      setFeedAuthHeader('');
      setFeedAuthEnvVar('');
      if (res.one_time_token && res.ingest_path) {
        setIssuedSecret({
          feed_id: res.feed_id,
          provider_name: res.provider_name,
          token: res.one_time_token,
          ingest_path: res.ingest_path,
        });
      }
      setNotice(`Feed connector "${res.provider_name}" created.`);
      await loadSection('live-feeds');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create feed connector.');
    } finally {
      setSavingFeed(false);
    }
  };

  const handleRotateFeedKey = async (feed: HospitalFeedConnection) => {
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch<{
        feed_id: number;
        one_time_token: string;
        token_preview: string;
      }>(`/api/admin/feeds/${feed.feed_id}/rotate-key`, { method: 'POST' });
      setIssuedSecret({
        feed_id: feed.feed_id,
        provider_name: feed.provider_name,
        token: res.one_time_token,
        ingest_path: feed.ingest_path || `/api/feeds/ingest/${feed.feed_id}`,
      });
      setNotice(`Rotated webhook key for "${feed.provider_name}". Previous token is immediately invalidated.`);
      await loadSection('live-feeds');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not rotate webhook key.');
    }
  };

  const handleToggleFeed = async (feed: HospitalFeedConnection) => {
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/api/admin/feeds/${feed.feed_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_enabled: !feed.is_enabled }),
      });
      setNotice(`Feed "${feed.provider_name}" ${!feed.is_enabled ? 'enabled' : 'paused'}.`);
      await loadSection('live-feeds');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update feed status.');
    }
  };

  const handleManualSyncFeed = async (feed: HospitalFeedConnection) => {
    setError(null);
    setNotice(null);
    setSyncingFeedId(feed.feed_id);
    try {
      const res = await apiFetch<{
        status: string;
        records_ingested: number;
        records_rejected: number;
        errors: string[];
      }>(`/api/admin/feeds/${feed.feed_id}/sync`, { method: 'POST' });
      if (res.status === 'error' && res.errors.length > 0) {
        setError(`Sync failed for "${feed.provider_name}": ${res.errors[0]}`);
      } else {
        setNotice(
          `Synced "${feed.provider_name}": ${res.records_ingested} ingested, ${res.records_rejected} rejected.`,
        );
      }
      await loadSection('live-feeds');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Feed sync failed.');
    } finally {
      setSyncingFeedId(null);
    }
  };

  const handleDeleteFeed = async (feed: HospitalFeedConnection) => {
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/api/admin/feeds/${feed.feed_id}`, { method: 'DELETE' });
      if (issuedSecret?.feed_id === feed.feed_id) {
        setIssuedSecret(null);
      }
      setNotice(`Removed feed connector "${feed.provider_name}".`);
      await loadSection('live-feeds');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete feed connector.');
    }
  };

  const handleToggleUserStatus = async (u: AdminUserItem) => {
    const nextStatus = u.status === 'active' ? 'suspended' : 'active';
    setError(null);
    try {
      await apiFetch(`/api/admin/users/${u.user_id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: nextStatus }),
      });
      setNotice(`User ${u.email} is now ${nextStatus}.`);
      await loadSection('audit-logs');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update user status.');
    }
  };

  const sectionTitleMap: Record<AdminSection, string> = {
    overview: 'Admin Overview',
    hospitals: 'Manage Hospitals',
    departments: 'Manage Departments',
    beds: 'Ward Bed Records',
    'crowd-updates': 'All Crowd Updates',
    moderation: 'Moderation Queue',
    'csv-import': 'CSV Dataset Import',
    'live-feeds': 'Live HMS & Public Health Feeds',
    'ml-models': 'ML Model Management',
    'audit-logs': 'Audit Logs & User Accounts',
    settings: 'System Configuration & Rules',
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-5">
        <div>
          <span className="text-xs font-semibold uppercase tracking-wider text-[#16A6A1]">
            Administrator Workspace
          </span>
          <h1 className="mt-0.5 font-display text-2xl font-bold text-[#12304A]">
            {sectionTitleMap[activeSection]}
          </h1>
        </div>
        <button
          type="button"
          onClick={() => loadSection(activeSection)}
          className="inline-flex min-h-[38px] items-center gap-1.5 rounded-xl border border-slate-200 bg-[#F5F8FC] px-3.5 py-1.5 text-xs font-semibold text-[#12304A] hover:bg-slate-100"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          <span>Refresh Data</span>
        </button>
      </div>

      {notice && (
        <div className="rounded-xl border border-[#16A36A]/40 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          {notice}
        </div>
      )}
      {error && (
        <div role="alert" className="rounded-xl border border-[#E05252]/40 bg-red-50 px-4 py-3 text-sm text-red-900">
          {error}
        </div>
      )}

      {/* 1. OVERVIEW */}
      {activeSection === 'overview' && dashboard && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {[
              { label: 'Registered Users', value: dashboard.counts.users },
              { label: 'Active Hospitals', value: dashboard.counts.active_hospitals },
              { label: 'Active Departments', value: dashboard.counts.active_departments },
              { label: 'Updates (24h)', value: dashboard.counts.updates_24h },
              { label: 'Pending Flagged', value: dashboard.counts.pending_flagged },
            ].map((stat) => (
              <div key={stat.label} className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="text-xs font-medium text-[#718096]">{stat.label}</div>
                <div className="mt-1 font-mono text-2xl font-bold text-[#12304A] tabular-nums">
                  {stat.value}
                </div>
              </div>
            ))}
          </div>

          {dashboard.active_model && (
            <section className="rounded-2xl border border-slate-200 bg-white p-6">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-4">
                <div>
                  <h2 className="font-display text-lg font-semibold text-[#12304A]">
                    Active Model: {dashboard.active_model.model_version} ({dashboard.active_model.model_type})
                  </h2>
                  <p className="mt-0.5 text-xs text-[#718096]">
                    Trained {dashboard.active_model.trained_at_ist} · Range:{' '}
                    {dashboard.active_model.training_range} · Provenance:{' '}
                    {dashboard.active_model.data_provenance}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onSectionChange('ml-models')}
                  className="min-h-[38px] rounded-xl border border-slate-200 bg-[#F5F8FC] px-3.5 py-1.5 text-xs font-semibold text-[#1769AA] hover:bg-slate-100"
                >
                  Manage Models
                </button>
              </div>

              <div className="mt-4 overflow-x-auto">
                <table className="w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-xs font-semibold text-[#718096]">
                      <th className="py-2.5 pr-4">Model</th>
                      <th className="px-4 py-2.5 text-right">MAE (min)</th>
                      <th className="px-4 py-2.5 text-right">RMSE (min)</th>
                      <th className="px-4 py-2.5 text-right">R²</th>
                      <th className="pl-4 py-2.5">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {dashboard.active_model.metrics.candidates.map((c) => (
                      <tr key={c.model_name} className={c.is_selected ? 'bg-[#1769AA]/6' : ''}>
                        <td className="py-2.5 pr-4 font-medium text-[#12304A]">{c.model_name}</td>
                        <td className="px-4 py-2.5 text-right font-mono tabular-nums">{c.mae.toFixed(2)}</td>
                        <td className="px-4 py-2.5 text-right font-mono tabular-nums">{c.rmse.toFixed(2)}</td>
                        <td className="px-4 py-2.5 text-right font-mono tabular-nums">{c.r2.toFixed(3)}</td>
                        <td className="pl-4 py-2.5 text-xs font-semibold text-[#16A36A]">
                          {c.is_selected ? 'Deployed' : 'Evaluated'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section className="rounded-2xl border border-slate-200 bg-white p-6">
            <h2 className="font-display text-base font-semibold text-[#12304A]">Latest Data Timestamps (IST)</h2>
            <dl className="mt-3 grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-xs text-[#718096]">Waiting-time records</dt>
                <dd className="mt-0.5 font-mono text-[#12304A] tabular-nums">
                  {dashboard.latest_timestamps.waiting_records_ist}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-[#718096]">Bed availability records</dt>
                <dd className="mt-0.5 font-mono text-[#12304A] tabular-nums">
                  {dashboard.latest_timestamps.bed_records_ist}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-[#718096]">Crowdsourced updates</dt>
                <dd className="mt-0.5 font-mono text-[#12304A] tabular-nums">
                  {dashboard.latest_timestamps.crowd_updates_ist}
                </dd>
              </div>
            </dl>
          </section>
        </div>
      )}

      {/* 2. MANAGE HOSPITALS */}
      {activeSection === 'hospitals' && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          <form
            onSubmit={handleAddHospital}
            className="space-y-3 rounded-2xl border border-slate-200 bg-white p-5 lg:col-span-4"
          >
            <h2 className="font-display text-base font-semibold text-[#12304A]">Add New Hospital</h2>
            <input
              type="text"
              required
              placeholder="Hospital name"
              value={newHospName}
              onChange={(e) => setNewHospName(e.target.value)}
              className="min-h-[40px] w-full rounded-xl border border-slate-300 bg-[#F5F8FC] px-3 text-sm"
            />
            <input
              type="text"
              required
              placeholder="Street address"
              value={newHospAddr}
              onChange={(e) => setNewHospAddr(e.target.value)}
              className="min-h-[40px] w-full rounded-xl border border-slate-300 bg-[#F5F8FC] px-3 text-sm"
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                type="text"
                required
                placeholder="City"
                value={newHospCity}
                onChange={(e) => setNewHospCity(e.target.value)}
                className="min-h-[40px] w-full rounded-xl border border-slate-300 bg-[#F5F8FC] px-3 text-sm"
              />
              <select
                value={newHospType}
                onChange={(e) => setNewHospType(e.target.value)}
                className="min-h-[40px] w-full rounded-xl border border-slate-300 bg-[#F5F8FC] px-3 text-sm"
              >
                <option value="Private">Private</option>
                <option value="Government">Government</option>
                <option value="Trust / Charitable">Trust / Charitable</option>
                <option value="Teaching">Teaching</option>
              </select>
            </div>
            <input
              type="text"
              required
              placeholder="Contact phone (+91-731-...)"
              value={newHospContact}
              onChange={(e) => setNewHospContact(e.target.value)}
              className="min-h-[40px] w-full rounded-xl border border-slate-300 bg-[#F5F8FC] px-3 text-sm"
            />
            <button
              type="submit"
              className="min-h-[42px] w-full rounded-xl bg-[#1769AA] px-4 py-2 text-sm font-semibold text-white hover:bg-[#125388]"
            >
              Create Hospital
            </button>
          </form>

          <section className="rounded-2xl border border-slate-200 bg-white p-6 lg:col-span-8">
            <h2 className="font-display text-lg font-semibold text-[#12304A]">Participating Hospitals</h2>
            <div className="mt-4 divide-y divide-slate-100">
              {hospitals.map((h) => (
                <div key={h.hospital_id} className="flex flex-wrap items-center justify-between gap-4 py-3.5">
                  <div>
                    <div className="font-semibold text-[#12304A]">
                      #{h.hospital_id} · {h.name}{' '}
                      {!h.is_active && <span className="text-xs font-semibold text-[#E05252]">(Inactive)</span>}
                    </div>
                    <div className="text-xs text-[#718096]">
                      {h.type} · {h.city} · {h.contact} · {h.departments.length} departments
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleToggleHospital(h)}
                    className="min-h-[38px] rounded-xl border border-slate-300 px-3.5 py-1.5 text-xs font-semibold text-[#243447] hover:bg-slate-50"
                  >
                    {h.is_active ? 'Deactivate' : 'Reactivate'}
                  </button>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {/* 3. MANAGE DEPARTMENTS */}
      {activeSection === 'departments' && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          <form
            onSubmit={handleAddDepartment}
            className="space-y-3 rounded-2xl border border-slate-200 bg-white p-5 lg:col-span-4"
          >
            <h2 className="font-display text-base font-semibold text-[#12304A]">Add Department</h2>
            <select
              value={deptHospId}
              onChange={(e) => setDeptHospId(Number(e.target.value))}
              className="min-h-[40px] w-full rounded-xl border border-slate-300 bg-[#F5F8FC] px-3 text-sm"
            >
              {hospitals.map((h) => (
                <option key={h.hospital_id} value={h.hospital_id}>
                  {h.name}
                </option>
              ))}
            </select>
            <input
              type="text"
              required
              placeholder="Department name (e.g. Neurology)"
              value={deptName}
              onChange={(e) => setDeptName(e.target.value)}
              className="min-h-[40px] w-full rounded-xl border border-slate-300 bg-[#F5F8FC] px-3 text-sm"
            />
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-[#718096]">Start (IST)</label>
                <input
                  type="time"
                  value={deptStart}
                  onChange={(e) => setDeptStart(e.target.value)}
                  className="min-h-[40px] w-full rounded-xl border border-slate-300 bg-[#F5F8FC] px-2.5 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-[#718096]">End (IST)</label>
                <input
                  type="time"
                  value={deptEnd}
                  onChange={(e) => setDeptEnd(e.target.value)}
                  className="min-h-[40px] w-full rounded-xl border border-slate-300 bg-[#F5F8FC] px-2.5 text-sm"
                />
              </div>
            </div>
            <button
              type="submit"
              className="min-h-[42px] w-full rounded-xl bg-[#1769AA] px-4 py-2 text-sm font-semibold text-white hover:bg-[#125388]"
            >
              Add Department
            </button>
          </form>

          <section className="rounded-2xl border border-slate-200 bg-white p-6 lg:col-span-8">
            <h2 className="font-display text-lg font-semibold text-[#12304A]">
              Departments &amp; OPD Schedules
            </h2>
            <div className="mt-4 space-y-4">
              {hospitals.map((h) => (
                <div key={h.hospital_id} className="rounded-xl border border-slate-200 bg-[#F5F8FC] p-4">
                  <h3 className="font-display text-sm font-bold text-[#12304A]">{h.name}</h3>
                  <div className="mt-2 divide-y divide-slate-200/70">
                    {h.departments.map((d) => (
                      <div key={d.department_id} className="flex items-center justify-between gap-3 py-2 text-xs">
                        <div>
                          <span className="font-semibold text-[#243447]">{d.name}</span>
                          <span className="ml-2 text-[#718096]">{d.opd_timings_label}</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleToggleDepartment(d.department_id, d.is_active, d.name)}
                          className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 font-semibold text-[#243447] hover:bg-slate-50"
                        >
                          {d.is_active ? 'Active' : 'Inactive'}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {/* 4. BED RECORDS */}
      {activeSection === 'beds' && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          <form
            onSubmit={handleAddBed}
            className="space-y-3 rounded-2xl border border-slate-200 bg-white p-5 lg:col-span-4"
          >
            <h2 className="font-display text-base font-semibold text-[#12304A]">Record Ward Bed Snapshot</h2>
            <select
              value={bedHospId}
              onChange={(e) => setBedHospId(Number(e.target.value))}
              className="min-h-[40px] w-full rounded-xl border border-slate-300 bg-[#F5F8FC] px-3 text-sm"
            >
              {hospitals.map((h) => (
                <option key={h.hospital_id} value={h.hospital_id}>
                  {h.name}
                </option>
              ))}
            </select>
            <input
              type="text"
              required
              placeholder="Ward type (e.g. General Ward, ICU)"
              value={bedWard}
              onChange={(e) => setBedWard(e.target.value)}
              className="min-h-[40px] w-full rounded-xl border border-slate-300 bg-[#F5F8FC] px-3 text-sm"
            />
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-[#718096]">Total Beds</label>
                <input
                  type="number"
                  min={1}
                  required
                  value={bedTotal}
                  onChange={(e) => setBedTotal(e.target.value)}
                  className="min-h-[40px] w-full rounded-xl border border-slate-300 bg-[#F5F8FC] px-3 font-mono text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-[#718096]">Available Beds</label>
                <input
                  type="number"
                  min={0}
                  required
                  value={bedAvail}
                  onChange={(e) => setBedAvail(e.target.value)}
                  className="min-h-[40px] w-full rounded-xl border border-slate-300 bg-[#F5F8FC] px-3 font-mono text-sm"
                />
              </div>
            </div>
            <button
              type="submit"
              className="min-h-[42px] w-full rounded-xl bg-[#1769AA] px-4 py-2 text-sm font-semibold text-white hover:bg-[#125388]"
            >
              Save Bed Snapshot
            </button>
          </form>

          <section className="rounded-2xl border border-slate-200 bg-white p-6 lg:col-span-8">
            <h2 className="font-display text-lg font-semibold text-[#12304A]">Latest Bed Records</h2>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-200 font-semibold text-[#718096]">
                    <th className="py-2.5 pr-3">Hospital &amp; Ward</th>
                    <th className="px-3 py-2.5 text-right">Available / Total</th>
                    <th className="px-3 py-2.5">Status</th>
                    <th className="pl-3 py-2.5">Timestamp (IST)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {bedRecords.map((b) => (
                    <tr key={`${b.hospital_id}-${b.ward_type}`}>
                      <td className="py-3 pr-3">
                        <div className="font-semibold text-[#12304A]">{b.hospital_name}</div>
                        <div className="text-[#718096]">{b.ward_type}</div>
                      </td>
                      <td className="px-3 py-3 text-right font-mono font-bold text-[#12304A] tabular-nums">
                        {b.available_beds} / {b.total_beds}
                      </td>
                      <td className="px-3 py-3">
                        <BedStatusIndicator status={b.status} />
                      </td>
                      <td className="pl-3 py-3 font-mono text-[#718096] tabular-nums">
                        {b.record_time_ist}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {/* 5 & 6. CROWD UPDATES & MODERATION */}
      {(activeSection === 'crowd-updates' || activeSection === 'moderation') && (
        <section className="rounded-2xl border border-slate-200 bg-white p-6">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
            <div>
              <h2 className="font-display text-lg font-semibold text-[#12304A]">
                {activeSection === 'moderation'
                  ? 'Crowd Update Moderation Queue'
                  : 'All Crowdsourced Queue Reports'}
              </h2>
              <p className="text-xs text-[#718096]">
                Approve, Reject, or Flag for review. Flagged reports remain excluded from live estimates until
                approved.
              </p>
            </div>

            {activeSection === 'moderation' && (
              <div className="inline-flex rounded-xl bg-[#F5F8FC] p-1">
                {(['Flagged', 'All'] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => {
                      setModFilter(f);
                      loadSection('moderation', f);
                    }}
                    className={`min-h-[34px] rounded-lg px-3 text-xs font-semibold ${
                      modFilter === f ? 'bg-white text-[#1769AA] shadow-xs' : 'text-[#718096]'
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </div>
            )}
          </div>

          {updates.length === 0 ? (
            <div className="mt-4 rounded-xl border border-slate-200 bg-[#F5F8FC] p-8 text-center text-sm text-[#718096]">
              No matching crowd updates found.
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              {updates.map((u) => (
                <div key={u.update_id} className="rounded-xl border border-slate-200 bg-[#F5F8FC] p-4">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <div className="text-xs text-[#718096]">
                        Update #{u.update_id} · {u.submitted_at_ist} · By {u.submitter_name} · Status:{' '}
                        <strong className="text-[#12304A]">{u.validation_status}</strong>
                      </div>
                      <h3 className="mt-1 font-display text-base font-semibold text-[#12304A]">
                        {u.hospital_name} — {u.department_name}
                      </h3>
                      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                        <QueueLevelBadge level={u.queue_level} />
                        <span className="font-mono font-bold text-[#12304A] tabular-nums">
                          Reported: {u.waiting_minutes} min
                        </span>
                        <span className="text-[#718096]">·</span>
                        <span className="font-mono text-[#718096] tabular-nums">
                          Recent median:{' '}
                          {u.context.recent_valid_median !== null
                            ? `${u.context.recent_valid_median}m`
                            : 'None'}
                        </span>
                        <span className="text-[#718096]">·</span>
                        <span className="font-mono text-[#718096] tabular-nums">
                          Historical avg:{' '}
                          {u.context.historical_avg !== null ? `${u.context.historical_avg}m` : 'None'}
                        </span>
                      </div>
                      {u.flag_reason && <p className="mt-2 text-xs text-[#A16207]">{u.flag_reason}</p>}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleModerate(u.update_id, 'Approved')}
                        className="inline-flex min-h-[36px] items-center gap-1 rounded-lg bg-[#16A36A] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#128a59]"
                      >
                        <Check className="h-3.5 w-3.5" />
                        <span>Approve</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleModerate(u.update_id, 'Rejected')}
                        className="inline-flex min-h-[36px] items-center gap-1 rounded-lg border border-[#E05252]/40 bg-white px-3 py-1.5 text-xs font-semibold text-[#B91C1C] hover:bg-red-50"
                      >
                        <X className="h-3.5 w-3.5" />
                        <span>Reject</span>
                      </button>
                      {u.validation_status !== 'Flagged' && (
                        <button
                          type="button"
                          onClick={() => handleModerate(u.update_id, 'Flagged')}
                          className="inline-flex min-h-[36px] items-center gap-1 rounded-lg border border-[#F59E0B]/40 bg-white px-3 py-1.5 text-xs font-semibold text-[#A16207] hover:bg-amber-50"
                        >
                          <Flag className="h-3.5 w-3.5" />
                          <span>Flag for review</span>
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* 7. CSV IMPORT */}
      {activeSection === 'csv-import' && (
        <section className="space-y-5 rounded-2xl border border-slate-200 bg-white p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="font-display text-lg font-semibold text-[#12304A]">
                CSV Dataset Upload &amp; Validation
              </h2>
              <p className="text-xs text-[#718096]">
                Upload a CSV file or paste UTF-8 CSV rows. Invalid rows are rejected with row-level reasons.
              </p>
            </div>
            <button
              type="button"
              onClick={handleDownloadCsvTemplate}
              className="inline-flex min-h-[38px] items-center gap-1.5 rounded-xl border border-slate-300 bg-[#F5F8FC] px-3.5 py-1.5 text-xs font-semibold text-[#1769AA] hover:bg-slate-100"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Download Template CSV</span>
            </button>
          </div>

          <form onSubmit={handleImportCsv} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[#718096]">
                  Dataset Type
                </label>
                <select
                  value={importType}
                  onChange={(e) => setImportType(e.target.value as typeof importType)}
                  className="mt-1.5 min-h-[42px] w-full rounded-xl border border-slate-300 bg-[#F5F8FC] px-3.5 text-sm"
                >
                  <option value="waiting_time">Waiting Time (department_id, record_time, avg_waiting_minutes)</option>
                  <option value="opd_queue">OPD Queue (department_id, record_time, queue_size, queue_level)</option>
                  <option value="beds">Beds (hospital_id, ward_type, total_beds, available_beds, record_time)</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[#718096]">
                  Data Provenance Tag
                </label>
                <select
                  value={importSource}
                  onChange={(e) => setImportSource(e.target.value as typeof importSource)}
                  className="mt-1.5 min-h-[42px] w-full rounded-xl border border-slate-300 bg-[#F5F8FC] px-3.5 text-sm"
                >
                  <option value="public">Public dataset (public)</option>
                  <option value="real">Hospital official record (real)</option>
                </select>
              </div>
            </div>

            {/* File Input Upload */}
            <div className="rounded-xl border border-dashed border-slate-300 bg-[#F5F8FC] p-4">
              <label className="flex cursor-pointer flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <Upload className="h-5 w-5 text-[#1769AA]" />
                  <div>
                    <span className="block text-sm font-semibold text-[#12304A]">
                      {csvFileName ? `Selected file: ${csvFileName}` : 'Choose a .csv file from your computer'}
                    </span>
                    <span className="text-xs text-[#718096]">UTF-8 encoded CSV files supported</span>
                  </div>
                </div>
                <span className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-[#1769AA]">
                  Browse CSV
                </span>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={handleCsvFileUpload}
                  className="sr-only"
                />
              </label>
            </div>

            <div>
              <label htmlFor="csv-content" className="block text-xs font-semibold uppercase tracking-wider text-[#718096]">
                CSV Content Preview / Editor
              </label>
              <textarea
                id="csv-content"
                rows={6}
                required
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
                placeholder="department_id,record_time,avg_waiting_minutes"
                className="mt-1.5 w-full rounded-xl border border-slate-300 bg-[#F5F8FC] p-3 font-mono text-xs text-[#12304A]"
              />
            </div>

            <button
              type="submit"
              className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-[#1769AA] px-5 py-2 text-sm font-semibold text-white hover:bg-[#125388]"
            >
              <Upload className="h-4 w-4" />
              <span>Validate &amp; Import CSV</span>
            </button>
          </form>

          {importResult && (
            <div className="rounded-xl border border-slate-200 bg-[#F5F8FC] p-4 space-y-2 text-sm">
              <div className="flex flex-wrap gap-6 font-mono text-xs tabular-nums">
                <span>Rows read: <strong>{importResult.rows_read}</strong></span>
                <span className="text-[#16A36A]">Imported: <strong>{importResult.rows_imported}</strong></span>
                <span className="text-[#E05252]">Rejected: <strong>{importResult.rows_rejected}</strong></span>
              </div>
              {importResult.errors.length > 0 && (
                <ul className="space-y-1 text-xs text-[#B91C1C]">
                  {importResult.errors.map((err, i) => (
                    <li key={i}>
                      Row {err.row}: {err.reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      )}

      {/* 7B. LIVE HMS & PUBLIC HEALTH FEEDS */}
      {activeSection === 'live-feeds' && (
        <div className="space-y-6">
          {issuedSecret && (
            <section className="rounded-2xl border border-[#16A6A1]/50 bg-[#16A6A1]/8 p-6 space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="font-display text-base font-semibold text-[#12304A]">
                    Webhook Bearer Key Issued — {issuedSecret.provider_name}
                  </h2>
                  <p className="mt-0.5 text-xs text-[#243447]">
                    Copy this token now. For security, only a SHA-256 hash is stored on the server and this token cannot be displayed again.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setIssuedSecret(null)}
                  className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-[#243447] hover:bg-slate-50"
                >
                  Dismiss
                </button>
              </div>

              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                <div className="rounded-xl border border-slate-200 bg-white p-3">
                  <div className="flex items-center justify-between text-xs font-semibold text-[#718096]">
                    <span>Ingest Endpoint &amp; Bearer Token</span>
                    <button
                      type="button"
                      onClick={() => handleCopyText('token', issuedSecret.token)}
                      className="inline-flex items-center gap-1 text-[#1769AA] hover:underline"
                    >
                      <Copy className="h-3.5 w-3.5" />
                      <span>{copiedKey === 'token' ? 'Copied' : 'Copy Token'}</span>
                    </button>
                  </div>
                  <div className="mt-1.5 break-all font-mono text-xs text-[#12304A]">
                    POST {window.location.origin}
                    {issuedSecret.ingest_path}
                  </div>
                  <div className="mt-1 break-all font-mono text-xs font-semibold text-[#1769AA]">
                    {issuedSecret.token}
                  </div>
                </div>

                <div className="rounded-xl border border-slate-200 bg-white p-3">
                  <div className="flex items-center justify-between text-xs font-semibold text-[#718096]">
                    <span>Test Webhook Push (curl)</span>
                    <button
                      type="button"
                      onClick={() =>
                        handleCopyText(
                          'curl',
                          `curl -X POST "${window.location.origin}${issuedSecret.ingest_path}" -H "Authorization: Bearer ${issuedSecret.token}" -H "Content-Type: application/json" -d '{"beds":[{"ward_type":"ICU","total_beds":30,"available_beds":8}],"opd":[{"department_name":"General Medicine","avg_waiting_minutes":22}]}'`,
                        )
                      }
                      className="inline-flex items-center gap-1 text-[#1769AA] hover:underline"
                    >
                      <Copy className="h-3.5 w-3.5" />
                      <span>{copiedKey === 'curl' ? 'Copied' : 'Copy curl'}</span>
                    </button>
                  </div>
                  <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-[#243447]">
                    {`curl -X POST "${window.location.origin}${issuedSecret.ingest_path}" \\\n  -H "Authorization: Bearer ${issuedSecret.token}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"beds":[{"ward_type":"ICU","total_beds":30,"available_beds":8}],"opd":[{"department_name":"General Medicine","avg_waiting_minutes":22}]}'`}
                  </pre>
                </div>
              </div>
            </section>
          )}

          {/* Create Connector Form */}
          <section className="rounded-2xl border border-slate-200 bg-white p-6">
            <div className="flex items-start gap-3">
              <Radio className="mt-0.5 h-5 w-5 text-[#1769AA]" />
              <div>
                <h2 className="font-display text-lg font-semibold text-[#12304A]">
                  Connect Hospital HMS Webhook or Public Health API
                </h2>
                <p className="text-xs text-[#718096]">
                  Stream live bed occupancy and OPD queue updates into HospitEase AI. Incoming feeds broadcast immediately over the live event stream.
                </p>
              </div>
            </div>

            <form onSubmit={handleCreateFeed} className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[#718096]">
                  Hospital
                </label>
                <select
                  value={feedHospId}
                  onChange={(e) => setFeedHospId(Number(e.target.value))}
                  className="mt-1.5 min-h-[42px] w-full rounded-xl border border-slate-300 bg-[#F5F8FC] px-3 text-sm"
                >
                  {hospitals.map((h) => (
                    <option key={h.hospital_id} value={h.hospital_id}>
                      #{h.hospital_id} {h.name} ({h.city})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[#718096]">
                  Connector Name / System
                </label>
                <input
                  type="text"
                  required
                  value={feedProvider}
                  onChange={(e) => setFeedProvider(e.target.value)}
                  placeholder="e.g. MYH e-Hospital HMS Webhook"
                  className="mt-1.5 min-h-[42px] w-full rounded-xl border border-slate-300 bg-[#F5F8FC] px-3 text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[#718096]">
                  Connector Mode
                </label>
                <select
                  value={feedType}
                  onChange={(e) => {
                    const nextType = e.target.value as typeof feedType;
                    setFeedType(nextType);
                    if (nextType === 'public_health_api') setFeedSource('public');
                    if (nextType === 'hms_webhook') setFeedSource('real');
                  }}
                  className="mt-1.5 min-h-[42px] w-full rounded-xl border border-slate-300 bg-[#F5F8FC] px-3 text-sm"
                >
                  <option value="hms_webhook">Partner HMS Push Webhook (Inbound)</option>
                  <option value="json_pull">Hospital JSON Feed Pull (HTTPS Poll)</option>
                  <option value="public_health_api">Public Health Open API (HTTPS Poll)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[#718096]">
                  Provenance Classification
                </label>
                <select
                  value={feedSource}
                  onChange={(e) => setFeedSource(e.target.value as 'real' | 'public')}
                  className="mt-1.5 min-h-[42px] w-full rounded-xl border border-slate-300 bg-[#F5F8FC] px-3 text-sm"
                >
                  <option value="real">Hospital HMS Feed (real)</option>
                  <option value="public">Public Health Feed (public)</option>
                </select>
              </div>

              {feedType !== 'hms_webhook' && (
                <>
                  <div className="sm:col-span-2">
                    <label className="block text-xs font-semibold uppercase tracking-wider text-[#718096]">
                      HTTPS Feed Endpoint URL
                    </label>
                    <input
                      type="url"
                      required
                      value={feedEndpointUrl}
                      onChange={(e) => setFeedEndpointUrl(e.target.value)}
                      placeholder="https://hospital-hms.example.org/api/v1/hospitease-feed.json"
                      className="mt-1.5 min-h-[42px] w-full rounded-xl border border-slate-300 bg-[#F5F8FC] px-3 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider text-[#718096]">
                      Auth Header Name (Optional)
                    </label>
                    <input
                      type="text"
                      value={feedAuthHeader}
                      onChange={(e) => setFeedAuthHeader(e.target.value)}
                      placeholder="e.g. X-API-Key or Authorization"
                      className="mt-1.5 min-h-[42px] w-full rounded-xl border border-slate-300 bg-[#F5F8FC] px-3 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider text-[#718096]">
                      Server Secret Env Var Name (Optional)
                    </label>
                    <input
                      type="text"
                      value={feedAuthEnvVar}
                      onChange={(e) => setFeedAuthEnvVar(e.target.value.toUpperCase())}
                      placeholder="e.g. HOSPITAL_HMS_TOKEN"
                      className="mt-1.5 min-h-[42px] w-full rounded-xl border border-slate-300 bg-[#F5F8FC] px-3 font-mono text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider text-[#718096]">
                      Poll Interval (Minutes)
                    </label>
                    <input
                      type="number"
                      min={5}
                      max={1440}
                      value={feedInterval}
                      onChange={(e) => setFeedInterval(e.target.value)}
                      className="mt-1.5 min-h-[42px] w-full rounded-xl border border-slate-300 bg-[#F5F8FC] px-3 font-mono text-sm tabular-nums"
                    />
                  </div>
                </>
              )}

              <div className="flex items-end sm:col-span-2 lg:col-span-3">
                <button
                  type="submit"
                  disabled={savingFeed}
                  className="inline-flex min-h-[42px] items-center gap-2 rounded-xl bg-[#1769AA] px-5 py-2 text-sm font-semibold text-white hover:bg-[#125388] disabled:opacity-50"
                >
                  <Radio className="h-4 w-4" />
                  <span>{savingFeed ? 'Creating...' : 'Create Feed Connector'}</span>
                </button>
              </div>
            </form>
          </section>

          {/* Active Feed Connections */}
          <section className="rounded-2xl border border-slate-200 bg-white p-6">
            <h2 className="font-display text-lg font-semibold text-[#12304A]">
              Configured Feed Connectors ({feeds.length})
            </h2>
            {feeds.length === 0 ? (
              <p className="mt-3 text-sm text-[#718096]">
                No live HMS or public health connectors configured yet. Add one above to generate a webhook key or attach an HTTPS JSON feed.
              </p>
            ) : (
              <div className="mt-4 divide-y divide-slate-100">
                {feeds.map((f) => (
                  <div key={f.feed_id} className="flex flex-col gap-3 py-4 lg:flex-row lg:items-center lg:justify-between">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="font-semibold text-[#12304A]">{f.provider_name}</span>
                        <span className="text-xs text-[#718096]">
                          · {f.hospital_name} ({f.city})
                        </span>
                        <span
                          className={`text-xs font-semibold ${
                            f.is_enabled ? 'text-[#16A36A]' : 'text-[#718096]'
                          }`}
                        >
                          · {f.is_enabled ? 'Enabled' : 'Paused'}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#718096]">
                        <span>
                          Mode: <strong className="text-[#243447]">{f.connector_type}</strong>
                        </span>
                        <span>
                          · Source: <strong className="text-[#243447]">{f.data_source}</strong>
                        </span>
                        {f.ingest_path && (
                          <span className="font-mono text-[#1769AA]">· {f.ingest_path}</span>
                        )}
                        {f.token_preview && (
                          <span className="font-mono">· Key {f.token_preview}</span>
                        )}
                        {f.endpoint_url && (
                          <span className="break-all font-mono">· {f.endpoint_url} (every {f.poll_interval_minutes}m)</span>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#718096] font-mono tabular-nums">
                        <span>Ingested: {f.records_ingested}</span>
                        <span>· Last sync: {f.last_sync_at_ist || 'Never'}</span>
                        {f.last_sync_status && (
                          <span
                            className={
                              f.last_sync_status === 'success'
                                ? 'text-[#16A36A]'
                                : f.last_sync_status === 'partial'
                                  ? 'text-[#D97706]'
                                  : 'text-[#E05252]'
                            }
                          >
                            · {f.last_sync_status}: {f.last_sync_message}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      {f.connector_type !== 'hms_webhook' ? (
                        <button
                          type="button"
                          disabled={syncingFeedId === f.feed_id}
                          onClick={() => handleManualSyncFeed(f)}
                          className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-[#1769AA] px-3 py-1.5 text-xs font-semibold text-[#1769AA] hover:bg-[#1769AA]/8 disabled:opacity-50"
                        >
                          <RefreshCw className={`h-3.5 w-3.5 ${syncingFeedId === f.feed_id ? 'animate-spin' : ''}`} />
                          <span>{syncingFeedId === f.feed_id ? 'Syncing...' : 'Sync Now'}</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleRotateFeedKey(f)}
                          className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-[#12304A] hover:bg-slate-50"
                        >
                          <KeyRound className="h-3.5 w-3.5" />
                          <span>Rotate Key</span>
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => handleToggleFeed(f)}
                        className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-[#243447] hover:bg-slate-50"
                      >
                        {f.is_enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                        <span>{f.is_enabled ? 'Pause' : 'Enable'}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleDeleteFeed(f)}
                        aria-label={`Delete ${f.provider_name}`}
                        className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-[#E05252]/40 bg-white px-3 py-1.5 text-xs font-semibold text-[#B91C1C] hover:bg-red-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        <span>Delete</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Sync Logs */}
          <section className="rounded-2xl border border-slate-200 bg-white p-6">
            <h2 className="font-display text-lg font-semibold text-[#12304A]">
              Recent Feed Sync Activity
            </h2>
            {feedLogs.length === 0 ? (
              <p className="mt-3 text-sm text-[#718096]">No webhook pushes or outbound sync runs recorded yet.</p>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full border-collapse text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 font-semibold text-[#718096]">
                      <th className="py-2 pr-3">Time (IST)</th>
                      <th className="px-3 py-2">Provider / Hospital</th>
                      <th className="px-3 py-2">Trigger</th>
                      <th className="px-3 py-2 text-right">Ingested</th>
                      <th className="px-3 py-2 text-right">Rejected</th>
                      <th className="pl-3 py-2">Outcome</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {feedLogs.map((log) => (
                      <tr key={log.sync_id}>
                        <td className="py-2 pr-3 font-mono text-[#718096] tabular-nums">{log.created_at_ist}</td>
                        <td className="px-3 py-2">
                          <span className="font-semibold text-[#12304A]">{log.provider_name}</span>
                          <span className="block text-[#718096]">{log.hospital_name}</span>
                        </td>
                        <td className="px-3 py-2 font-mono text-[#243447]">{log.trigger_mode}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums text-[#16A36A]">
                          {log.records_ingested}
                        </td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums text-[#E05252]">
                          {log.records_rejected}
                        </td>
                        <td className="pl-3 py-2 text-[#243447]">
                          <span
                            className={`font-semibold ${
                              log.status === 'success'
                                ? 'text-[#16A36A]'
                                : log.status === 'partial'
                                  ? 'text-[#D97706]'
                                  : 'text-[#E05252]'
                            }`}
                          >
                            {log.status}
                          </span>
                          {' · '}
                          {log.message}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}

      {/* 8. ML MODEL MANAGEMENT */}
      {activeSection === 'ml-models' && (
        <div className="space-y-6">
          <section className="rounded-2xl border border-slate-200 bg-white p-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="font-display text-lg font-semibold text-[#12304A]">
                  ML Model Training &amp; Version Governance
                </h2>
                <p className="mt-1 text-xs text-[#718096]">
                  Evaluates Historical Baseline, Ridge Linear Regression, Random Forest, and Gradient Boosting on an
                  80/20 chronological split.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={retraining}
                  onClick={() => handleRetrain(false)}
                  className="inline-flex min-h-[42px] items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-[#12304A] hover:bg-slate-50 disabled:opacity-50"
                >
                  <RefreshCw className={`h-4 w-4 ${retraining ? 'animate-spin' : ''}`} />
                  <span>{retraining ? 'Training...' : 'Train Candidate'}</span>
                </button>
                <button
                  type="button"
                  disabled={retraining}
                  onClick={() => handleRetrain(true)}
                  className="inline-flex min-h-[42px] items-center gap-2 rounded-xl bg-[#1769AA] px-4 py-2 text-xs font-semibold text-white hover:bg-[#125388] disabled:opacity-50"
                >
                  <span>Retrain &amp; Activate</span>
                </button>
              </div>
            </div>
          </section>

          {models.map((m) => (
            <section key={m.model_version} className="rounded-2xl border border-slate-200 bg-white p-6">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-display text-lg font-semibold text-[#12304A]">
                      {m.model_version} — {m.model_type}
                    </h3>
                    <span
                      className={`text-xs font-semibold ${
                        m.status === 'active' ? 'text-[#16A36A]' : 'text-[#718096]'
                      }`}
                    >
                      ({m.status})
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-[#718096]">
                    Trained {m.trained_at_ist} · Samples: {m.metrics.train_samples} train / {m.metrics.test_samples}{' '}
                    test · Provenance: {m.data_provenance}
                  </p>
                </div>

                {m.status !== 'active' && (
                  <button
                    type="button"
                    onClick={() => handleActivateModel(m.model_version)}
                    className="min-h-[38px] rounded-xl border border-[#1769AA] px-4 py-1.5 text-xs font-semibold text-[#1769AA] hover:bg-[#1769AA]/8"
                  >
                    Activate {m.model_version}
                  </button>
                )}
              </div>

              <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-12">
                <div className="overflow-x-auto lg:col-span-7">
                  <table className="w-full border-collapse text-left text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 text-xs font-semibold text-[#718096]">
                        <th className="py-2 pr-3">Model</th>
                        <th className="px-3 py-2 text-right">MAE</th>
                        <th className="px-3 py-2 text-right">RMSE</th>
                        <th className="px-3 py-2 text-right">R²</th>
                        <th className="pl-3 py-2">Selected</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {m.metrics.candidates.map((c) => (
                        <tr key={c.model_name} className={c.is_selected ? 'bg-[#1769AA]/6' : ''}>
                          <td className="py-2 pr-3 font-medium text-[#12304A]">{c.model_name}</td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums">{c.mae.toFixed(2)}</td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums">{c.rmse.toFixed(2)}</td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums">{c.r2.toFixed(3)}</td>
                          <td className="pl-3 py-2 text-xs font-semibold text-[#16A36A]">
                            {c.is_selected ? 'Yes' : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="lg:col-span-5">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-[#718096]">
                    Bed Availability Classifier Confusion Matrix
                  </h4>
                  {m.metrics.bed_classifier ? (
                    <div className="mt-2 space-y-2">
                      <div className="grid grid-cols-3 gap-2 text-xs font-mono">
                        <div className="rounded-lg bg-[#F5F8FC] p-2">
                          <div className="font-sans text-[#718096]">Accuracy</div>
                          <div className="font-bold text-[#12304A]">
                            {(m.metrics.bed_classifier.accuracy * 100).toFixed(1)}%
                          </div>
                        </div>
                        <div className="rounded-lg bg-[#F5F8FC] p-2">
                          <div className="font-sans text-[#718096]">Precision</div>
                          <div className="font-bold text-[#12304A]">
                            {(m.metrics.bed_classifier.macro_precision * 100).toFixed(1)}%
                          </div>
                        </div>
                        <div className="rounded-lg bg-[#F5F8FC] p-2">
                          <div className="font-sans text-[#718096]">Recall</div>
                          <div className="font-bold text-[#12304A]">
                            {(m.metrics.bed_classifier.macro_recall * 100).toFixed(1)}%
                          </div>
                        </div>
                      </div>
                      <table className="w-full border-collapse text-center text-xs">
                        <thead>
                          <tr className="border-b border-slate-200 text-[#718096]">
                            <th className="py-1 text-left">Actual \ Pred</th>
                            <th className="py-1">Avail</th>
                            <th className="py-1">Limited</th>
                            <th className="py-1">Unavail</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 font-mono">
                          {m.metrics.bed_classifier.confusion_matrix.map((row, idx) => (
                            <tr key={idx}>
                              <td className="py-1 text-left font-sans text-[#243447]">
                                {idx === 0 ? 'Available' : idx === 1 ? 'Limited' : 'Unavailable'}
                              </td>
                              {row.map((cell, cIdx) => (
                                <td
                                  key={cIdx}
                                  className={`py-1 ${idx === cIdx ? 'font-bold text-[#1769AA]' : 'text-[#718096]'}`}
                                >
                                  {cell}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-[#718096]">Insufficient bed history (&lt;90 days).</p>
                  )}
                </div>
              </div>
            </section>
          ))}
        </div>
      )}

      {/* 9. AUDIT LOGS & USER ACCOUNTS */}
      {activeSection === 'audit-logs' && (
        <div className="space-y-6">
          <section className="rounded-2xl border border-slate-200 bg-white p-6">
            <h2 className="font-display text-lg font-semibold text-[#12304A]">User Account Governance</h2>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs font-semibold text-[#718096]">
                    <th className="py-2.5 pr-4">Name &amp; Email</th>
                    <th className="px-4 py-2.5">Role</th>
                    <th className="px-4 py-2.5 text-right">Reports</th>
                    <th className="px-4 py-2.5">Status</th>
                    <th className="pl-4 py-2.5">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {users.map((u) => (
                    <tr key={u.user_id}>
                      <td className="py-3 pr-4">
                        <div className="font-semibold text-[#12304A]">{u.name}</div>
                        <div className="font-mono text-xs text-[#718096]">{u.email}</div>
                      </td>
                      <td className="px-4 py-3 text-xs uppercase text-[#718096]">{u.role}</td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums">{u.submission_count}</td>
                      <td className="px-4 py-3">
                        <span
                          className={`text-xs font-semibold ${
                            u.status === 'active' ? 'text-[#16A36A]' : 'text-[#E05252]'
                          }`}
                        >
                          {u.status}
                        </span>
                      </td>
                      <td className="pl-4 py-3">
                        {u.role !== 'admin' && (
                          <button
                            type="button"
                            onClick={() => handleToggleUserStatus(u)}
                            className="min-h-[34px] rounded-lg border border-slate-300 px-3 py-1 text-xs font-semibold text-[#243447] hover:bg-slate-50"
                          >
                            {u.status === 'active' ? 'Suspend' : 'Reactivate'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-6">
            <h2 className="font-display text-lg font-semibold text-[#12304A]">Administrator Audit Trail</h2>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-200 font-semibold text-[#718096]">
                    <th className="py-2 pr-3">Time (IST)</th>
                    <th className="px-3 py-2">Admin</th>
                    <th className="px-3 py-2">Action</th>
                    <th className="px-3 py-2">Target</th>
                    <th className="pl-3 py-2">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {auditLogs.map((l) => (
                    <tr key={l.log_id}>
                      <td className="py-2 pr-3 font-mono text-[#718096] tabular-nums">{l.created_at_ist}</td>
                      <td className="px-3 py-2 font-medium text-[#12304A]">{l.admin_name}</td>
                      <td className="px-3 py-2 font-mono font-semibold text-[#1769AA]">{l.action}</td>
                      <td className="px-3 py-2 font-mono text-[#243447]">{l.target}</td>
                      <td className="pl-3 py-2 text-[#718096]">{l.details || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {/* 10. SETTINGS */}
      {activeSection === 'settings' && (
        <section className="rounded-2xl border border-slate-200 bg-white p-6 space-y-5">
          <div className="flex items-start gap-3">
            <ShieldAlert className="mt-0.5 h-5 w-5 text-[#1769AA]" />
            <div>
              <h2 className="font-display text-lg font-semibold text-[#12304A]">
                Operational Thresholds &amp; Validation Policies
              </h2>
              <p className="text-xs text-[#718096]">
                Configured per SRS governance rules across prediction, crowdsourcing, and bed freshness.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { label: 'Queue Thresholds', value: 'Low <20m · Med 20–45m · High >45m' },
              { label: 'Recency Half-Life (h)', value: '30 minutes (w = 0.5^(age / 30))' },
              { label: 'Live Crowd Window', value: '2 hours (120 minutes)' },
              { label: 'Duplicate & Daily Caps', value: '30 min per dept · 10 updates / day' },
              { label: 'Outlier Flagging', value: '3×MAD (recent) or 2×SD (historical)' },
              { label: 'Bed Staleness Threshold', value: '> 24 hours marked Outdated' },
            ].map((item) => (
              <div key={item.label} className="rounded-xl border border-slate-200 bg-[#F5F8FC] p-4">
                <div className="text-xs font-medium text-[#718096]">{item.label}</div>
                <div className="mt-1 font-mono text-sm font-semibold text-[#12304A]">{item.value}</div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
