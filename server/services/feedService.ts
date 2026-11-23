import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { db } from '../db/database.ts';
import { SRS_DEFAULTS, type DataSource, type QueueLevel } from '../types.ts';
import { deriveQueueLevel } from '../utils/validation.ts';
import { liveEventBus } from './liveEvents.ts';

export type ConnectorType = 'hms_webhook' | 'json_pull' | 'public_health_api';

export interface FeedConnectionRow {
  feed_id: number;
  hospital_id: number;
  provider_name: string;
  connector_type: ConnectorType;
  data_source: 'real' | 'public';
  endpoint_url: string | null;
  auth_header_name: string | null;
  auth_env_var: string | null;
  auth_token_hash: string | null;
  token_preview: string | null;
  poll_interval_minutes: number;
  is_enabled: number;
  last_sync_at: string | null;
  last_sync_status: string | null;
  last_sync_message: string | null;
  records_ingested: number;
  created_at: string;
}

export function generateFeedToken(): { token: string; hash: string; preview: string } {
  const token = `hef_${crypto.randomBytes(24).toString('base64url')}`;
  const hash = hashFeedToken(token);
  const preview = `${token.slice(0, 8)}...${token.slice(-4)}`;
  return { token, hash, preview };
}

export function hashFeedToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export function verifyFeedToken(providedToken: string, storedHash: string | null): boolean {
  if (!providedToken || !storedHash) return false;
  const candidateHash = hashFeedToken(providedToken);
  const a = Buffer.from(candidateHash, 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

function isDisallowedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isDisallowedIp(rawIp: string): boolean {
  const ip = rawIp.trim().toLowerCase();
  const version = net.isIP(ip);
  if (version === 4) return isDisallowedIpv4(ip);
  if (version === 6) {
    if (ip === '::' || ip === '::1') return true;
    if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // Unique local fc00::/7
    if (ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb')) {
      return true; // Link-local fe80::/10
    }
    if (ip.startsWith('::ffff:')) {
      return isDisallowedIpv4(ip.slice(7));
    }
    return false;
  }
  return true;
}

export async function validateExternalFeedUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('Endpoint URL is not a valid URL.');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Only HTTPS endpoints are permitted for hospital and public health feeds.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Embedded credentials in endpoint URLs are not allowed.');
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error('Local or internal hostnames cannot be used as external feed endpoints.');
  }

  if (net.isIP(hostname) !== 0) {
    if (isDisallowedIp(hostname)) {
      throw new Error('Private, loopback, or link-local IP addresses are blocked.');
    }
    return parsed;
  }

  const resolved = await dns.lookup(hostname, { all: true });
  if (!resolved || resolved.length === 0) {
    throw new Error('Unable to resolve external feed hostname.');
  }
  for (const addr of resolved) {
    if (isDisallowedIp(addr.address)) {
      throw new Error('Resolved endpoint address points to a restricted private or loopback network.');
    }
  }

  return parsed;
}

interface IncomingBedItem {
  ward_type: string;
  total_beds: number;
  available_beds: number;
  record_time?: string;
}

interface IncomingOpdItem {
  department_id?: number;
  department_name?: string;
  avg_waiting_minutes?: number;
  waiting_minutes?: number;
  queue_size?: number;
  queue_level?: string;
  record_time?: string;
}

export interface IngestSummary {
  status: 'success' | 'partial' | 'error';
  records_ingested: number;
  records_rejected: number;
  errors: string[];
  beds_updated: number;
  opd_updated: number;
}

function normalizeIncomingPayload(payload: unknown): {
  beds: IncomingBedItem[];
  opd: IncomingOpdItem[];
} {
  if (Array.isArray(payload)) {
    return classifyFlatRecords(payload);
  }
  if (!payload || typeof payload !== 'object') {
    return { beds: [], opd: [] };
  }

  const obj = payload as Record<string, unknown>;
  const beds: IncomingBedItem[] = Array.isArray(obj.beds) ? (obj.beds as IncomingBedItem[]) : [];
  const opd: IncomingOpdItem[] = Array.isArray(obj.opd)
    ? (obj.opd as IncomingOpdItem[])
    : Array.isArray(obj.departments)
      ? (obj.departments as IncomingOpdItem[])
      : [];

  if (Array.isArray(obj.records)) {
    const classified = classifyFlatRecords(obj.records);
    beds.push(...classified.beds);
    opd.push(...classified.opd);
  }

  return { beds, opd };
}

function classifyFlatRecords(rows: unknown[]): { beds: IncomingBedItem[]; opd: IncomingOpdItem[] } {
  const beds: IncomingBedItem[] = [];
  const opd: IncomingOpdItem[] = [];

  for (const item of rows) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (typeof r.ward_type === 'string' && (r.total_beds !== undefined || r.available_beds !== undefined)) {
      beds.push({
        ward_type: r.ward_type,
        total_beds: Number(r.total_beds),
        available_beds: Number(r.available_beds),
        record_time: typeof r.record_time === 'string' ? r.record_time : undefined,
      });
    } else if (
      (r.department_id !== undefined || typeof r.department_name === 'string') &&
      (r.avg_waiting_minutes !== undefined || r.waiting_minutes !== undefined)
    ) {
      opd.push({
        department_id: r.department_id !== undefined ? Number(r.department_id) : undefined,
        department_name: typeof r.department_name === 'string' ? r.department_name : undefined,
        avg_waiting_minutes:
          r.avg_waiting_minutes !== undefined
            ? Number(r.avg_waiting_minutes)
            : Number(r.waiting_minutes),
        queue_size: r.queue_size !== undefined ? Number(r.queue_size) : undefined,
        queue_level: typeof r.queue_level === 'string' ? r.queue_level : undefined,
        record_time: typeof r.record_time === 'string' ? r.record_time : undefined,
      });
    }
  }

  return { beds, opd };
}

export function ingestStructuredHospitalPayload(
  hospitalId: number,
  dataSource: Extract<DataSource, 'real' | 'public'>,
  triggerMode: 'webhook' | 'manual' | 'scheduled',
  feedId: number | null,
  providerName: string,
  payload: unknown,
): IngestSummary {
  const { beds, opd } = normalizeIncomingPayload(payload);
  const nowIso = new Date().toISOString();
  const errors: string[] = [];
  let bedsUpdated = 0;
  let opdUpdated = 0;
  let rejected = 0;

  if (beds.length === 0 && opd.length === 0) {
    const msg = 'Payload did not contain any recognized bed or OPD records.';
    if (feedId !== null) {
      recordFeedSyncOutcome(feedId, triggerMode, 'error', 0, 0, msg, nowIso);
    }
    return {
      status: 'error',
      records_ingested: 0,
      records_rejected: 0,
      errors: [msg],
      beds_updated: 0,
      opd_updated: 0,
    };
  }

  const depts = db
    .prepare('SELECT department_id, name FROM departments WHERE hospital_id = ? AND is_active = 1')
    .all(hospitalId) as Array<{ department_id: number; name: string }>;
  const deptById = new Map<number, string>();
  const deptByName = new Map<string, number>();
  for (const d of depts) {
    deptById.set(d.department_id, d.name);
    deptByName.set(d.name.trim().toLowerCase(), d.department_id);
  }

  const insertBed = db.prepare(
    `INSERT INTO bed_availability_records (hospital_id, ward_type, total_beds, available_beds, record_time, data_source)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertWait = db.prepare(
    `INSERT INTO waiting_time_records (department_id, record_time, avg_waiting_minutes, data_source)
     VALUES (?, ?, ?, ?)`,
  );
  const insertQueue = db.prepare(
    `INSERT INTO opd_queue_records (department_id, record_time, queue_size, queue_level, data_source)
     VALUES (?, ?, ?, ?, ?)`,
  );

  const bedEvents: Array<{ ward_type: string }> = [];
  const opdEvents: Array<{ department_id: number }> = [];

  const tx = db.transaction(() => {
    for (let i = 0; i < beds.length; i++) {
      const b = beds[i];
      const ward = typeof b?.ward_type === 'string' ? b.ward_type.trim() : '';
      const total = Number(b?.total_beds);
      const avail = Number(b?.available_beds);
      const recDate = b?.record_time ? new Date(b.record_time) : new Date(nowIso);

      if (
        ward.length < 2 ||
        !Number.isInteger(total) ||
        !Number.isInteger(avail) ||
        total <= 0 ||
        avail < 0 ||
        avail > total ||
        Number.isNaN(recDate.getTime())
      ) {
        rejected++;
        if (errors.length < 20) {
          errors.push(`beds[${i}]: invalid ward_type, bed counts (0 <= available <= total), or record_time.`);
        }
        continue;
      }

      insertBed.run(hospitalId, ward, total, avail, recDate.toISOString(), dataSource);
      bedsUpdated++;
      bedEvents.push({ ward_type: ward });
    }

    for (let i = 0; i < opd.length; i++) {
      const o = opd[i];
      let deptId = Number.isInteger(Number(o?.department_id)) ? Number(o?.department_id) : 0;
      if (!deptById.has(deptId) && typeof o?.department_name === 'string') {
        deptId = deptByName.get(o.department_name.trim().toLowerCase()) || 0;
      }

      const rawWait = o?.avg_waiting_minutes !== undefined ? o.avg_waiting_minutes : o?.waiting_minutes;
      const waitMin = Number(rawWait);
      const recDate = o?.record_time ? new Date(o.record_time) : new Date(nowIso);

      if (
        !deptById.has(deptId) ||
        !Number.isFinite(waitMin) ||
        waitMin < 0 ||
        waitMin > SRS_DEFAULTS.MAX_WAIT_MINUTES ||
        Number.isNaN(recDate.getTime())
      ) {
        rejected++;
        if (errors.length < 20) {
          errors.push(`opd[${i}]: unknown hospital department, waiting minutes outside 0–360, or invalid record_time.`);
        }
        continue;
      }

      const qSize =
        o?.queue_size !== undefined && Number.isInteger(Number(o.queue_size)) && Number(o.queue_size) >= 0
          ? Number(o.queue_size)
          : Math.max(1, Math.round(waitMin * 0.72));
      const qLevel: QueueLevel =
        o?.queue_level && ['Low', 'Medium', 'High'].includes(o.queue_level)
          ? (o.queue_level as QueueLevel)
          : deriveQueueLevel(waitMin);

      const recIso = recDate.toISOString();
      insertWait.run(deptId, recIso, Math.round(waitMin * 10) / 10, dataSource);
      insertQueue.run(deptId, recIso, qSize, qLevel, dataSource);
      opdUpdated++;
      opdEvents.push({ department_id: deptId });
    }
  });

  tx();

  const totalIngested = bedsUpdated + opdUpdated;
  const status: 'success' | 'partial' | 'error' =
    totalIngested === 0 ? 'error' : rejected > 0 ? 'partial' : 'success';
  const msg =
    totalIngested > 0
      ? `Ingested ${bedsUpdated} bed and ${opdUpdated} OPD record(s)${rejected > 0 ? ` (${rejected} rejected)` : ''}.`
      : errors[0] || 'No valid records ingested.';

  if (feedId !== null) {
    recordFeedSyncOutcome(feedId, triggerMode, status, totalIngested, rejected, msg, nowIso);
  }

  for (const b of bedEvents) {
    liveEventBus.emitUpdate({
      type: 'beds:updated',
      hospital_id: hospitalId,
      ward_type: b.ward_type,
      source: dataSource,
      at: nowIso,
    });
  }
  for (const o of opdEvents) {
    liveEventBus.emitUpdate({
      type: 'queue:updated',
      hospital_id: hospitalId,
      department_id: o.department_id,
      source: dataSource,
      at: nowIso,
    });
  }
  if (totalIngested > 0 && feedId !== null) {
    liveEventBus.emitUpdate({
      type: 'feed:synced',
      feed_id: feedId,
      hospital_id: hospitalId,
      provider_name: providerName,
      records_ingested: totalIngested,
      source: dataSource,
      at: nowIso,
    });
  }

  return {
    status,
    records_ingested: totalIngested,
    records_rejected: rejected,
    errors,
    beds_updated: bedsUpdated,
    opd_updated: opdUpdated,
  };
}

function recordFeedSyncOutcome(
  feedId: number,
  triggerMode: 'webhook' | 'manual' | 'scheduled',
  status: 'success' | 'partial' | 'error',
  ingested: number,
  rejected: number,
  message: string,
  nowIso: string,
): void {
  db.prepare(
    `UPDATE hospital_feed_connections
     SET last_sync_at = ?,
         last_sync_status = ?,
         last_sync_message = ?,
         records_ingested = records_ingested + ?
     WHERE feed_id = ?`,
  ).run(nowIso, status, message, ingested, feedId);

  db.prepare(
    `INSERT INTO feed_sync_logs (feed_id, trigger_mode, status, records_ingested, records_rejected, message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(feedId, triggerMode, status, ingested, rejected, message, nowIso);
}

export async function syncOutboundFeed(
  feedId: number,
  triggerMode: 'manual' | 'scheduled',
): Promise<IngestSummary> {
  const feed = db
    .prepare('SELECT * FROM hospital_feed_connections WHERE feed_id = ?')
    .get(feedId) as FeedConnectionRow | undefined;

  if (!feed) {
    throw new Error('Feed connection not found.');
  }
  if (feed.connector_type === 'hms_webhook' || !feed.endpoint_url) {
    throw new Error('Only pull-based API feeds with an HTTPS endpoint URL can be fetched outbound.');
  }

  const nowIso = new Date().toISOString();
  try {
    const validatedUrl = await validateExternalFeedUrl(feed.endpoint_url);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': 'HospitEase-FeedSync/1.0',
    };

    if (feed.auth_header_name && feed.auth_env_var) {
      const envName = feed.auth_env_var.trim();
      if (/^[A-Z0-9_]+$/.test(envName) && process.env[envName]) {
        headers[feed.auth_header_name.trim()] = process.env[envName]!;
      }
    }

    const resp = await fetch(validatedUrl.toString(), {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    });

    if (!resp.ok) {
      const msg = `Remote endpoint returned HTTP ${resp.status}.`;
      recordFeedSyncOutcome(feedId, triggerMode, 'error', 0, 0, msg, nowIso);
      return { status: 'error', records_ingested: 0, records_rejected: 0, errors: [msg], beds_updated: 0, opd_updated: 0 };
    }

    const text = await resp.text();
    if (Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024) {
      const msg = 'Remote feed response exceeded the 2 MB payload limit.';
      recordFeedSyncOutcome(feedId, triggerMode, 'error', 0, 0, msg, nowIso);
      return { status: 'error', records_ingested: 0, records_rejected: 0, errors: [msg], beds_updated: 0, opd_updated: 0 };
    }

    const parsed = JSON.parse(text) as unknown;
    return ingestStructuredHospitalPayload(
      feed.hospital_id,
      feed.data_source,
      triggerMode,
      feed.feed_id,
      feed.provider_name,
      parsed,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Outbound feed sync failed.';
    recordFeedSyncOutcome(feedId, triggerMode, 'error', 0, 0, msg, nowIso);
    return { status: 'error', records_ingested: 0, records_rejected: 0, errors: [msg], beds_updated: 0, opd_updated: 0 };
  }
}

let schedulerStarted = false;

export function startFeedScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;

  const timer = setInterval(async () => {
    try {
      const pullFeeds = db
        .prepare(
          `SELECT feed_id, poll_interval_minutes, last_sync_at
           FROM hospital_feed_connections
           WHERE is_enabled = 1 AND connector_type IN ('json_pull', 'public_health_api')`,
        )
        .all() as Array<{ feed_id: number; poll_interval_minutes: number; last_sync_at: string | null }>;

      const nowMs = Date.now();
      for (const f of pullFeeds) {
        const lastMs = f.last_sync_at ? new Date(f.last_sync_at).getTime() : 0;
        const intervalMs = Math.max(5, f.poll_interval_minutes) * 60 * 1000;
        if (nowMs - lastMs >= intervalMs) {
          await syncOutboundFeed(f.feed_id, 'scheduled');
        }
      }
    } catch {
      // Keep scheduler resilient across transient errors
    }
  }, 60_000);

  timer.unref();
}
