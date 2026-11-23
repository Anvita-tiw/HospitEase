export type UserRole = 'guest' | 'user' | 'admin';
export type UserStatus = 'active' | 'suspended';
export type QueueLevel = 'Low' | 'Medium' | 'High';
export type BedStatus = 'Available' | 'Limited Availability' | 'Likely Unavailable';
export type UpdateStatus = 'Accepted' | 'Flagged' | 'Approved' | 'Rejected';
export type DataSource = 'real' | 'public' | 'synthetic';
export type ConfidenceLevel = 'Low' | 'Medium' | 'High';

export const SRS_DEFAULTS = {
  LOW_WAIT_MAX: 20, // < 20 min => Low (TBD-1)
  MEDIUM_WAIT_MAX: 45, // 20-45 min => Medium, > 45 => High (TBD-1)
  MAX_WAIT_MINUTES: 360, // TBD-2
  MAX_VISIT_AGE_HOURS: 6, // TBD-3
  DUPLICATE_WINDOW_MINUTES: 30, // TBD-4
  DAILY_SUBMISSION_LIMIT: 10, // TBD-4
  RECENCY_HALF_LIFE_MINUTES: 30, // TBD-6
  RECENT_WINDOW_MINUTES: 120, // 2 hours (REQ-EST-02)
  BED_AVAILABLE_RATIO: 0.30, // >= 30% Available (TBD-8)
  BED_LIMITED_RATIO: 0.10, // 10%-30% Limited, < 10% Likely Unavailable (TBD-8)
  BED_STALENESS_HOURS: 24, // TBD-8
  MIN_BED_HISTORY_DAYS: 90, // TBD-9
  PREDICTION_TIMEOUT_MS: 2000, // NFR-PERF-03
  LOGIN_THROTTLE_MAX: 5, // NFR-SEC-05
  LOGIN_THROTTLE_WINDOW_MS: 15 * 60 * 1000, // 15 min
} as const;

export const NON_EMERGENCY_NOTICE =
  'Not for medical emergencies. For urgent care or emergencies, contact the hospital directly or dial 112 (India).';

export const ESTIMATE_DISCLAIMER =
  'Estimates are approximate and based on historical patterns and recent patient reports. They are not official hospital statements and actual waiting times may differ.';

export interface OpdSession {
  days: number[]; // 0=Sun..6=Sat
  start: string; // "HH:MM" in IST
  end: string; // "HH:MM" in IST
}

export interface OpdTimingsConfig {
  label: string;
  sessions: OpdSession[];
}

export interface HospitalRow {
  hospital_id: number;
  name: string;
  address: string;
  city: string;
  contact: string;
  type: string;
  is_active: number;
  created_at: string;
}

export interface DepartmentRow {
  department_id: number;
  hospital_id: number;
  name: string;
  opd_timings: string; // JSON string of OpdTimingsConfig
  is_active: number;
}

export interface CrowdUpdateRow {
  update_id: number;
  user_id: number | null;
  hospital_id: number;
  department_id: number;
  queue_level: QueueLevel;
  waiting_minutes: number;
  visit_time: string;
  submitted_at: string;
  validation_status: UpdateStatus;
  flag_reason: string | null;
  reviewed_by: number | null;
  reviewed_at: string | null;
}

export interface BedRecordRow {
  record_id: number;
  hospital_id: number;
  ward_type: string;
  total_beds: number;
  available_beds: number;
  record_time: string;
  data_source: DataSource;
}

export interface RecentUpdateAggregate {
  weightedMeanWait: number | null;
  reportCount: number;
  latestSubmittedAt: string | null;
  latestAgeMinutes: number | null;
  confidence: ConfidenceLevel;
  recentCrowdStatus: QueueLevel | null;
}

export interface ModelComparisonMetric {
  model_name: string;
  mae: number;
  rmse: number;
  r2: number;
  is_selected: boolean;
}

export interface BedClassifierMetrics {
  accuracy: number;
  macro_precision: number;
  macro_recall: number;
  baseline_accuracy: number;
  classes: BedStatus[];
  confusion_matrix: number[][]; // 3x3 [actual][predicted]
  eligible_days: number;
  sample_count: number;
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
  candidates: ModelComparisonMetric[];
  bed_classifier: BedClassifierMetrics | null;
}
