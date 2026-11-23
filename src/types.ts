export type UserRole = 'guest' | 'user' | 'admin';
export type QueueLevel = 'Low' | 'Medium' | 'High';
export type BedStatus = 'Available' | 'Limited Availability' | 'Likely Unavailable';
export type ConfidenceLevel = 'Low' | 'Medium' | 'High';

export type AppRoute =
  | 'landing'
  | 'dashboard'
  | 'hospitals'
  | 'hospital'
  | 'opd-queue'
  | 'beds'
  | 'compare'
  | 'submit'
  | 'assistant'
  | 'my-activity'
  | 'profile'
  | 'ml-info'
  | 'admin'
  | 'auth';

export type AssistantChatMode = 'general' | 'reasoning' | 'fast' | 'search' | 'maps' | 'voice';
export type AssistantRole = 'navigator' | 'analyst' | 'guide';

export interface GroundedSource {
  title: string;
  uri: string;
  sourceType: 'web' | 'maps';
  snippet?: string;
}

export interface SavedHospitalDoc {
  id: string;
  userId: string;
  hospitalId: number;
  hospitalName: string;
  city: string;
  hospitalType?: string;
  notes?: string;
  createdAtMs: number;
}

export interface FirestoreChatSession {
  id: string;
  userId: string;
  title: string;
  mode: AssistantChatMode;
  model: string;
  systemRole: AssistantRole;
  messageCount: number;
  updatedAtMs: number;
}

export interface FirestoreChatMessage {
  id: string;
  userId: string;
  sessionId: string;
  role: 'user' | 'model';
  text: string;
  model?: string;
  sources?: GroundedSource[];
  createdAtMs: number;
}

export type AdminSection =
  | 'overview'
  | 'hospitals'
  | 'departments'
  | 'beds'
  | 'crowd-updates'
  | 'moderation'
  | 'csv-import'
  | 'live-feeds'
  | 'ml-models'
  | 'audit-logs'
  | 'settings';

export interface AuthUser {
  user_id: number;
  name: string;
  email: string;
  role: 'user' | 'admin';
  status?: string;
}

export interface HospitalListItem {
  hospital_id: number;
  name: string;
  address: string;
  city: string;
  contact: string;
  type: string;
  is_active: boolean;
  department_count: number;
  open_departments_count: number;
  department_names: string[];
  recent_reports_count: number;
  last_report_ist: string | null;
  summary_queue_level: QueueLevel | null;
  summary_range_low: number | null;
  summary_range_high: number | null;
  summary_department_name: string | null;
}

export interface DepartmentSummary {
  department_id: number;
  hospital_id: number;
  name: string;
  opd_timings_label: string;
  is_open_now: boolean;
  current_session_text: string | null;
  next_opening_text: string | null;
}

export interface AnonymisedRecentUpdate {
  update_id: number;
  department_name: string;
  queue_level: QueueLevel;
  waiting_minutes: number;
  submitted_at_ist: string;
  validation_status: 'Accepted' | 'Approved';
}

export interface DepartmentEstimate {
  hospital_name?: string;
  department_id: number;
  hospital_id: number;
  department_name: string;
  is_open_now: boolean;
  opd_status_label: string;
  opd_timings_label: string;
  next_opening_text: string | null;
  current_session_text: string | null;
  queue_level: QueueLevel | null;
  range_low: number | null;
  range_high: number | null;
  last_updated_utc: string | null;
  last_updated_ist: string;
  recent_reports_count: number;
  confidence: ConfidenceLevel | null;
  basis: string | null;
  model_version: string | null;
  model_type?: string | null;
  fallback_notice: string | null;
  data_source?: string | null;
  disclaimer: string;
  non_emergency_notice: string;
}

export interface WardBedInfo {
  ward_type: string;
  total_beds: number;
  available_beds: number;
  status: BedStatus;
  basis: 'Predicted' | 'Last recorded';
  is_outdated: boolean;
  data_source?: string | null;
  record_time_utc: string;
  record_time_ist: string;
}

export interface GlobalBedWardItem {
  hospital_id: number;
  hospital_name: string;
  city: string;
  hospital_type: string;
  ward_type: string;
  total_beds: number;
  available_beds: number;
  occupied_beds: number;
  availability_pct: number;
  status: BedStatus;
  basis: 'Predicted' | 'Last recorded';
  is_outdated: boolean;
  data_source?: string | null;
  record_time_ist: string;
}

export interface CompareColumn {
  hospital_id: number;
  hospital_name: string;
  city: string;
  type: string;
  contact: string;
  department_found: boolean;
  department_name: string;
  estimate: DepartmentEstimate | null;
  bed_summary: {
    status: BedStatus;
    basis: string;
    is_outdated: boolean;
    as_of_ist: string;
  } | null;
}

export interface MyUpdateItem {
  update_id: number;
  hospital_id: number;
  department_id: number;
  hospital_name: string;
  department_name: string;
  queue_level: QueueLevel;
  waiting_minutes: number;
  visit_time_ist: string;
  submitted_at_ist: string;
  validation_status: 'Accepted' | 'Flagged' | 'Approved' | 'Rejected';
  flag_reason: string | null;
  reviewed_at_ist: string | null;
}

export interface ModelMetricsSummary {
  train_samples: number;
  test_samples: number;
  split_strategy: string;
  margin_rule: string;
  margin_minutes: number;
  baseline_mae: number;
  baseline_rmse: number;
  active_model_type: string;
  beats_baseline: boolean;
  candidates: Array<{
    model_name: string;
    mae: number;
    rmse: number;
    r2: number;
    is_selected: boolean;
  }>;
  bed_classifier: {
    accuracy: number;
    macro_precision: number;
    macro_recall: number;
    baseline_accuracy: number;
    classes: BedStatus[];
    confusion_matrix: number[][];
    eligible_days: number;
    sample_count: number;
  } | null;
}

export interface ModelVersionRecord {
  model_version: string;
  model_type: string;
  training_range: string;
  data_provenance: string;
  status: 'active' | 'candidate' | 'archived' | 'failed';
  trained_at_ist: string;
  metrics: ModelMetricsSummary;
}

export interface DashboardSummaryResponse {
  counts: {
    hospitals_available: number;
    opd_departments: number;
    recent_queue_updates: number;
    hospitals_with_beds: number;
  };
  queue_distribution: {
    Low: number;
    Medium: number;
    High: number;
  };
  latest_updates: Array<{
    update_id: number;
    hospital_id: number;
    hospital_name: string;
    department_name: string;
    queue_level: QueueLevel;
    waiting_minutes: number;
    submitted_at: string;
    submitted_at_ist: string;
    validation_status: string;
  }>;
  hospital_bed_overview: Array<{
    hospital_id: number;
    hospital_name: string;
    type: string;
    total_beds: number;
    available_beds: number;
    availability_pct: number;
    status: BedStatus;
    latest_time_ist: string;
  }>;
}

export interface HospitalFeedConnection {
  feed_id: number;
  hospital_id: number;
  hospital_name: string;
  city: string;
  provider_name: string;
  connector_type: 'hms_webhook' | 'json_pull' | 'public_health_api';
  data_source: 'real' | 'public';
  endpoint_url: string | null;
  auth_header_name: string | null;
  auth_env_var: string | null;
  token_preview: string | null;
  poll_interval_minutes: number;
  is_enabled: boolean;
  last_sync_at: string | null;
  last_sync_at_ist: string | null;
  last_sync_status: string | null;
  last_sync_message: string | null;
  records_ingested: number;
  created_at_ist: string;
  ingest_path: string | null;
}

export interface FeedSyncLogItem {
  sync_id: number;
  feed_id: number;
  provider_name: string;
  hospital_name: string;
  trigger_mode: 'webhook' | 'manual' | 'scheduled';
  status: 'success' | 'partial' | 'error';
  records_ingested: number;
  records_rejected: number;
  message: string;
  created_at_ist: string;
}
