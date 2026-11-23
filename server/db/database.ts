import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const dbPath = path.resolve(process.cwd(), process.env.DB_PATH || './data/hospitease.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function initSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'admin')) DEFAULT 'user',
      status TEXT NOT NULL CHECK(status IN ('active', 'suspended')) DEFAULT 'active',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS hospitals (
      hospital_id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      city TEXT NOT NULL,
      contact TEXT NOT NULL,
      type TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS departments (
      department_id INTEGER PRIMARY KEY AUTOINCREMENT,
      hospital_id INTEGER NOT NULL REFERENCES hospitals(hospital_id),
      name TEXT NOT NULL,
      opd_timings TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS opd_queue_records (
      record_id INTEGER PRIMARY KEY AUTOINCREMENT,
      department_id INTEGER NOT NULL REFERENCES departments(department_id),
      record_time TEXT NOT NULL,
      queue_size INTEGER NOT NULL,
      queue_level TEXT NOT NULL CHECK(queue_level IN ('Low', 'Medium', 'High')),
      data_source TEXT NOT NULL CHECK(data_source IN ('real', 'public', 'synthetic')) DEFAULT 'synthetic'
    );

    CREATE TABLE IF NOT EXISTS waiting_time_records (
      record_id INTEGER PRIMARY KEY AUTOINCREMENT,
      department_id INTEGER NOT NULL REFERENCES departments(department_id),
      record_time TEXT NOT NULL,
      avg_waiting_minutes REAL NOT NULL,
      data_source TEXT NOT NULL CHECK(data_source IN ('real', 'public', 'synthetic')) DEFAULT 'synthetic'
    );

    CREATE TABLE IF NOT EXISTS bed_availability_records (
      record_id INTEGER PRIMARY KEY AUTOINCREMENT,
      hospital_id INTEGER NOT NULL REFERENCES hospitals(hospital_id),
      ward_type TEXT NOT NULL,
      total_beds INTEGER NOT NULL,
      available_beds INTEGER NOT NULL,
      record_time TEXT NOT NULL,
      data_source TEXT NOT NULL CHECK(data_source IN ('real', 'public', 'synthetic')) DEFAULT 'synthetic'
    );

    CREATE TABLE IF NOT EXISTS crowd_updates (
      update_id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
      hospital_id INTEGER NOT NULL REFERENCES hospitals(hospital_id),
      department_id INTEGER NOT NULL REFERENCES departments(department_id),
      queue_level TEXT NOT NULL CHECK(queue_level IN ('Low', 'Medium', 'High')),
      waiting_minutes INTEGER NOT NULL,
      visit_time TEXT NOT NULL,
      submitted_at TEXT NOT NULL,
      validation_status TEXT NOT NULL CHECK(validation_status IN ('Accepted', 'Flagged', 'Approved', 'Rejected')),
      flag_reason TEXT,
      reviewed_by INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
      reviewed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS predictions (
      prediction_id INTEGER PRIMARY KEY AUTOINCREMENT,
      hospital_id INTEGER NOT NULL REFERENCES hospitals(hospital_id),
      department_id INTEGER REFERENCES departments(department_id),
      target TEXT NOT NULL,
      predicted_value REAL,
      range_low INTEGER,
      range_high INTEGER,
      bed_status TEXT,
      model_version TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS model_versions (
      model_version TEXT PRIMARY KEY,
      model_type TEXT NOT NULL,
      training_range TEXT NOT NULL,
      metrics TEXT NOT NULL,
      data_provenance TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active', 'candidate', 'archived', 'failed')),
      trained_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      log_id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      target TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS hospital_feed_connections (
      feed_id INTEGER PRIMARY KEY AUTOINCREMENT,
      hospital_id INTEGER NOT NULL REFERENCES hospitals(hospital_id),
      provider_name TEXT NOT NULL,
      connector_type TEXT NOT NULL CHECK(connector_type IN ('hms_webhook', 'json_pull', 'public_health_api')),
      data_source TEXT NOT NULL CHECK(data_source IN ('real', 'public')) DEFAULT 'real',
      endpoint_url TEXT,
      auth_header_name TEXT,
      auth_env_var TEXT,
      auth_token_hash TEXT,
      token_preview TEXT,
      poll_interval_minutes INTEGER NOT NULL DEFAULT 15,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      last_sync_at TEXT,
      last_sync_status TEXT,
      last_sync_message TEXT,
      records_ingested INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS feed_sync_logs (
      sync_id INTEGER PRIMARY KEY AUTOINCREMENT,
      feed_id INTEGER NOT NULL REFERENCES hospital_feed_connections(feed_id) ON DELETE CASCADE,
      trigger_mode TEXT NOT NULL CHECK(trigger_mode IN ('webhook', 'manual', 'scheduled')),
      status TEXT NOT NULL CHECK(status IN ('success', 'partial', 'error')),
      records_ingested INTEGER NOT NULL DEFAULT 0,
      records_rejected INTEGER NOT NULL DEFAULT 0,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- NFR-PERF-07: Timestamp indexes on time-based tables for <200ms queries
    CREATE INDEX IF NOT EXISTS idx_opd_queue_dept_time ON opd_queue_records(department_id, record_time);
    CREATE INDEX IF NOT EXISTS idx_waiting_dept_time ON waiting_time_records(department_id, record_time);
    CREATE INDEX IF NOT EXISTS idx_beds_hosp_time ON bed_availability_records(hospital_id, ward_type, record_time);
    CREATE INDEX IF NOT EXISTS idx_crowd_dept_time ON crowd_updates(department_id, submitted_at, validation_status);
    CREATE INDEX IF NOT EXISTS idx_crowd_user_time ON crowd_updates(user_id, submitted_at);
    CREATE INDEX IF NOT EXISTS idx_predictions_created ON predictions(created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_feed_logs_feed_time ON feed_sync_logs(feed_id, created_at);
  `);
}

export function writeAuditLog(
  adminId: number | null,
  action: string,
  target: string,
  details?: string,
): void {
  db.prepare(
    'INSERT INTO audit_logs (admin_id, action, target, details, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(adminId, action, target, details ?? null, new Date().toISOString());
}
