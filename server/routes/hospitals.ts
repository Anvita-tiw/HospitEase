import { Router } from 'express';
import { db } from '../db/database.ts';
import { predictionService } from '../ml/service.ts';
import { rateLimitMiddleware } from '../middleware/auth.ts';
import {
  ESTIMATE_DISCLAIMER,
  NON_EMERGENCY_NOTICE,
  type BedRecordRow,
  type CrowdUpdateRow,
  type DepartmentRow,
  type HospitalRow,
} from '../types.ts';
import { evaluateOpdStatus, formatUtcAsIST, toISTParts } from '../utils/time.ts';
import {
  aggregateRecentUpdates,
  deriveQueueLevel,
  formatWaitRange,
  isBedRecordOutdated,
  sanitizeSearchInput,
} from '../utils/validation.ts';

export const hospitalsRouter = Router();

function computeDepartmentEstimate(dept: DepartmentRow & { hospital_name?: string }) {
  const nowUtc = new Date();
  const opdStatus = evaluateOpdStatus(dept.opd_timings, nowUtc);
  const nowIso = nowUtc.toISOString();

  // Retrieve historical records & latest data provenance for this department
  const histRows = db
    .prepare(
      `SELECT record_time, avg_waiting_minutes, data_source
       FROM waiting_time_records
       WHERE department_id = ?
       ORDER BY record_time DESC
       LIMIT 400`,
    )
    .all(dept.department_id) as Array<{
    record_time: string;
    avg_waiting_minutes: number;
    data_source: string;
  }>;

  const latestQueueRow = db
    .prepare(
      `SELECT queue_size, record_time
       FROM opd_queue_records
       WHERE department_id = ?
       ORDER BY record_time DESC
       LIMIT 1`,
    )
    .get(dept.department_id) as { queue_size: number; record_time: string } | undefined;

  // Compute historical baseline mean for this IST day & time slot
  const nowIst = toISTParts(nowUtc);
  const matchingSlot = histRows.filter((r) => {
    const rIst = toISTParts(r.record_time);
    return rIst.dayOfWeek === nowIst.dayOfWeek && rIst.timeSlot === nowIst.timeSlot;
  });
  const pool = matchingSlot.length >= 3 ? matchingSlot : histRows;
  const historicalMean =
    pool.length > 0
      ? pool.reduce((sum, r) => sum + r.avg_waiting_minutes, 0) / pool.length
      : 25;

  const latestHistoricalDate = histRows.length > 0 ? histRows[0].record_time : null;
  const latestDataSource = histRows.length > 0 ? histRows[0].data_source : null;

  // REQ-EST-11: Outside OPD timings show "OPD closed" and next opening time instead of an estimate
  if (!opdStatus.isOpenNow) {
    return Promise.resolve({
      department_id: dept.department_id,
      hospital_id: dept.hospital_id,
      department_name: dept.name,
      is_open_now: false,
      opd_status_label: 'OPD closed',
      opd_timings_label: opdStatus.label,
      next_opening_text: opdStatus.nextOpeningText,
      current_session_text: null,
      queue_level: null,
      range_low: null,
      range_high: null,
      last_updated_utc: latestHistoricalDate,
      last_updated_ist: formatUtcAsIST(latestHistoricalDate),
      recent_reports_count: 0,
      confidence: null,
      basis: null,
      model_version: null,
      fallback_notice: null,
      data_source: latestDataSource,
      disclaimer: ESTIMATE_DISCLAIMER,
      non_emergency_notice: NON_EMERGENCY_NOTICE,
    });
  }

  // Gather Accepted/Approved recent crowd updates from last 2 hours (REQ-EST-02)
  const twoHoursAgoIso = new Date(nowUtc.getTime() - 2 * 60 * 60 * 1000).toISOString();
  const recentRows = db
    .prepare(
      `SELECT waiting_minutes, submitted_at, validation_status
       FROM crowd_updates
       WHERE department_id = ?
         AND validation_status IN ('Accepted', 'Approved')
         AND submitted_at >= ?
       ORDER BY submitted_at DESC`,
    )
    .all(dept.department_id, twoHoursAgoIso) as Pick<
    CrowdUpdateRow,
    'waiting_minutes' | 'submitted_at' | 'validation_status'
  >[];

  const recentAggregate = aggregateRecentUpdates(recentRows, nowUtc);
  const prevWait = histRows.length > 0 ? histRows[0].avg_waiting_minutes : historicalMean;
  const prevQueue = latestQueueRow?.queue_size ?? Math.round(prevWait * 0.72);

  return predictionService
    .predictWaitWithFallback(
      {
        hospitalId: dept.hospital_id,
        departmentId: dept.department_id,
        departmentName: dept.name,
        timestampIso: nowIso,
        prevQueueSize: prevQueue,
        prevWaitingMinutes: prevWait,
        recentAggregate,
      },
      historicalMean,
    )
    .then((pred) => {
      // REQ-EST-12: Store each generated prediction with model version and creation time
      db.prepare(
        `INSERT INTO predictions
         (hospital_id, department_id, target, predicted_value, range_low, range_high, bed_status, model_version, created_at)
         VALUES (?, ?, 'waiting_time', ?, ?, ?, NULL, ?, ?)`,
      ).run(
        dept.hospital_id,
        dept.department_id,
        pred.predictedValue,
        pred.rangeLow,
        pred.rangeHigh,
        pred.modelVersion,
        nowIso,
      );

      const lastUpdatedUtc = recentAggregate.latestSubmittedAt || latestHistoricalDate;

      return {
        department_id: dept.department_id,
        hospital_id: dept.hospital_id,
        department_name: dept.name,
        is_open_now: true,
        opd_status_label: 'OPD open now',
        opd_timings_label: opdStatus.label,
        next_opening_text: null,
        current_session_text: opdStatus.currentSessionText,
        queue_level: pred.queueLevel,
        range_low: pred.rangeLow,
        range_high: pred.rangeHigh,
        last_updated_utc: lastUpdatedUtc,
        last_updated_ist: formatUtcAsIST(lastUpdatedUtc),
        recent_reports_count: recentAggregate.reportCount,
        confidence: recentAggregate.confidence,
        basis: pred.basis,
        model_version: pred.modelVersion,
        model_type: pred.modelType,
        fallback_notice: pred.fallbackNotice,
        data_source: recentAggregate.reportCount > 0 ? 'crowd' : latestDataSource,
        disclaimer: ESTIMATE_DISCLAIMER,
        non_emergency_notice: NON_EMERGENCY_NOTICE,
      };
    });
}

// REQ-HOS-01, 02, 05, 06: Search active hospitals by name, city, department with pagination (20 per page)
hospitalsRouter.get('/hospitals', rateLimitMiddleware(120, 60_000), async (req, res) => {
  const q = sanitizeSearchInput(req.query.q);
  const city = sanitizeSearchInput(req.query.city);
  const type = sanitizeSearchInput(req.query.type);
  const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit || '20'), 10) || 20));
  const offset = (page - 1) * limit;

  const conditions: string[] = ['h.is_active = 1'];
  const params: Array<string | number> = [];

  if (city) {
    conditions.push('LOWER(h.city) = LOWER(?)');
    params.push(city);
  }
  if (type) {
    conditions.push('LOWER(h.type) = LOWER(?)');
    params.push(type);
  }
  if (q) {
    const like = `%${q.toLowerCase()}%`;
    conditions.push(
      `(LOWER(h.name) LIKE ? OR LOWER(h.city) LIKE ? OR EXISTS (
        SELECT 1 FROM departments d WHERE d.hospital_id = h.hospital_id AND d.is_active = 1 AND LOWER(d.name) LIKE ?
      ))`,
    );
    params.push(like, like, like);
  }

  const whereClause = conditions.join(' AND ');

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS total FROM hospitals h WHERE ${whereClause}`)
    .get(...params) as { total: number };

  const hospitals = db
    .prepare(
      `SELECT h.* FROM hospitals h
       WHERE ${whereClause}
       ORDER BY h.name ASC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as HospitalRow[];

  const citiesRows = db
    .prepare('SELECT DISTINCT city FROM hospitals WHERE is_active = 1 ORDER BY city ASC')
    .all() as Array<{ city: string }>;
  const typesRows = db
    .prepare('SELECT DISTINCT type FROM hospitals WHERE is_active = 1 ORDER BY type ASC')
    .all() as Array<{ type: string }>;

  const nowUtc = new Date();
  const enriched = hospitals.map((h) => {
    const depts = db
      .prepare('SELECT * FROM departments WHERE hospital_id = ? AND is_active = 1 ORDER BY name ASC')
      .all(h.hospital_id) as DepartmentRow[];

    const openDepts = depts.filter((d) => evaluateOpdStatus(d.opd_timings, nowUtc).isOpenNow);
    const twoHoursAgo = new Date(nowUtc.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const recentCountRow = db
      .prepare(
        `SELECT COUNT(*) AS cnt, MAX(submitted_at) AS latest_at
         FROM crowd_updates
         WHERE hospital_id = ? AND validation_status IN ('Accepted', 'Approved') AND submitted_at >= ?`,
      )
      .get(h.hospital_id, twoHoursAgo) as { cnt: number; latest_at: string | null };

    // Quick summary wait range from first open department or General Medicine
    const primaryDept = openDepts[0] || depts[0];
    let quickEstimate: { queue_level: string | null; range_low: number | null; range_high: number | null } = {
      queue_level: null,
      range_low: null,
      range_high: null,
    };
    if (primaryDept && openDepts.length > 0) {
      const avgRow = db
        .prepare(
          `SELECT AVG(avg_waiting_minutes) AS avg_wait FROM (
            SELECT avg_waiting_minutes FROM waiting_time_records WHERE department_id = ? ORDER BY record_time DESC LIMIT 12
          )`,
        )
        .get(primaryDept.department_id) as { avg_wait: number | null };
      const recentDeptRows = db
        .prepare(
          `SELECT waiting_minutes, submitted_at, validation_status FROM crowd_updates
           WHERE department_id = ? AND validation_status IN ('Accepted', 'Approved') AND submitted_at >= ?`,
        )
        .all(primaryDept.department_id, twoHoursAgo) as Pick<
        CrowdUpdateRow,
        'waiting_minutes' | 'submitted_at' | 'validation_status'
      >[];
      const agg = aggregateRecentUpdates(recentDeptRows, nowUtc);
      const baseMean = agg.weightedMeanWait ?? avgRow?.avg_wait ?? 25;
      const r = formatWaitRange(baseMean, 10);
      quickEstimate = {
        queue_level: deriveQueueLevel(r.estimate),
        range_low: r.rangeLow,
        range_high: r.rangeHigh,
      };
    }

    return {
      ...h,
      is_active: Boolean(h.is_active),
      department_count: depts.length,
      open_departments_count: openDepts.length,
      department_names: depts.map((d) => d.name),
      recent_reports_count: recentCountRow.cnt,
      last_report_ist: recentCountRow.latest_at ? formatUtcAsIST(recentCountRow.latest_at) : null,
      summary_queue_level: quickEstimate.queue_level,
      summary_range_low: quickEstimate.range_low,
      summary_range_high: quickEstimate.range_high,
      summary_department_name: primaryDept?.name ?? null,
    };
  });

  res.json({
    hospitals: enriched,
    pagination: {
      page,
      limit,
      total: totalRow.total,
      total_pages: Math.max(1, Math.ceil(totalRow.total / limit)),
    },
    filters: {
      cities: citiesRows.map((c) => c.city),
      types: typesRows.map((t) => t.type),
    },
  });
});

// REQ-HOS-03, 04: Hospital details with all departments & OPD open status
hospitalsRouter.get('/hospitals/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ code: 'INVALID_ID', message: 'Invalid hospital ID.', details: null });
    return;
  }

  const hospital = db
    .prepare('SELECT * FROM hospitals WHERE hospital_id = ? AND is_active = 1')
    .get(id) as HospitalRow | undefined;

  if (!hospital) {
    res.status(404).json({
      code: 'HOSPITAL_NOT_FOUND',
      message: 'Hospital not found or currently inactive.',
      details: null,
    });
    return;
  }

  const depts = db
    .prepare('SELECT * FROM departments WHERE hospital_id = ? AND is_active = 1 ORDER BY name ASC')
    .all(id) as DepartmentRow[];

  const nowUtc = new Date();
  const formattedDepts = depts.map((d) => {
    const opd = evaluateOpdStatus(d.opd_timings, nowUtc);
    return {
      department_id: d.department_id,
      hospital_id: d.hospital_id,
      name: d.name,
      opd_timings_label: opd.label,
      is_open_now: opd.isOpenNow,
      current_session_text: opd.currentSessionText,
      next_opening_text: opd.nextOpeningText,
    };
  });

  // Anonymised recent accepted/approved crowd updates (never expose submitter identity)
  const recentCrowdRows = db
    .prepare(
      `SELECT c.update_id, d.name AS department_name, c.queue_level, c.waiting_minutes, c.submitted_at, c.validation_status
       FROM crowd_updates c
       JOIN departments d ON d.department_id = c.department_id
       WHERE c.hospital_id = ? AND c.validation_status IN ('Accepted', 'Approved')
       ORDER BY c.submitted_at DESC
       LIMIT 8`,
    )
    .all(id) as Array<{
    update_id: number;
    department_name: string;
    queue_level: string;
    waiting_minutes: number;
    submitted_at: string;
    validation_status: string;
  }>;

  res.json({
    hospital: {
      ...hospital,
      is_active: Boolean(hospital.is_active),
    },
    departments: formattedDepts,
    recent_updates: recentCrowdRows.map((u) => ({
      update_id: u.update_id,
      department_name: u.department_name,
      queue_level: u.queue_level,
      waiting_minutes: u.waiting_minutes,
      submitted_at_ist: formatUtcAsIST(u.submitted_at),
      validation_status: u.validation_status,
    })),
    non_emergency_notice: NON_EMERGENCY_NOTICE,
  });
});

hospitalsRouter.get('/hospitals/:id/departments', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const hospital = db
    .prepare('SELECT hospital_id FROM hospitals WHERE hospital_id = ? AND is_active = 1')
    .get(id);
  if (!hospital) {
    res.status(404).json({ code: 'HOSPITAL_NOT_FOUND', message: 'Hospital not found.', details: null });
    return;
  }

  const depts = db
    .prepare('SELECT * FROM departments WHERE hospital_id = ? AND is_active = 1 ORDER BY name ASC')
    .all(id) as DepartmentRow[];
  const nowUtc = new Date();
  res.json({
    departments: depts.map((d) => {
      const opd = evaluateOpdStatus(d.opd_timings, nowUtc);
      return {
        department_id: d.department_id,
        hospital_id: d.hospital_id,
        name: d.name,
        opd_timings_label: opd.label,
        is_open_now: opd.isOpenNow,
        current_session_text: opd.currentSessionText,
        next_opening_text: opd.nextOpeningText,
      };
    }),
  });
});

// REQ-EST-01..12: Department queue status & waiting-time estimate
hospitalsRouter.get('/departments/:id/estimate', async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ code: 'INVALID_ID', message: 'Invalid department ID.', details: null });
    return;
  }

  const dept = db
    .prepare(
      `SELECT d.*, h.name AS hospital_name
       FROM departments d
       JOIN hospitals h ON h.hospital_id = d.hospital_id
       WHERE d.department_id = ? AND d.is_active = 1 AND h.is_active = 1`,
    )
    .get(id) as (DepartmentRow & { hospital_name: string }) | undefined;

  if (!dept) {
    res.status(404).json({
      code: 'DEPARTMENT_NOT_FOUND',
      message: 'Department not found or hospital is inactive.',
      details: null,
    });
    return;
  }

  const estimate = await computeDepartmentEstimate(dept);
  res.json({
    hospital_name: dept.hospital_name,
    ...estimate,
  });
});

// REQ-BED-01..06: Ward-wise bed availability
hospitalsRouter.get('/hospitals/:id/beds', async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const hospital = db
    .prepare('SELECT * FROM hospitals WHERE hospital_id = ? AND is_active = 1')
    .get(id) as HospitalRow | undefined;

  if (!hospital) {
    res.status(404).json({ code: 'HOSPITAL_NOT_FOUND', message: 'Hospital not found.', details: null });
    return;
  }

  // Latest record per ward_type
  const latestWards = db
    .prepare(
      `SELECT b.*
       FROM bed_availability_records b
       INNER JOIN (
         SELECT ward_type, MAX(record_time) AS max_time
         FROM bed_availability_records
         WHERE hospital_id = ?
         GROUP BY ward_type
       ) latest ON b.ward_type = latest.ward_type AND b.record_time = latest.max_time
       WHERE b.hospital_id = ?
       ORDER BY b.ward_type ASC`,
    )
    .all(id, id) as BedRecordRow[];

  const nowUtc = new Date();
  const nowIso = nowUtc.toISOString();

  const wards = await Promise.all(
    latestWards.map(async (w) => {
      // Check distinct days of history for this hospital-ward (TBD-9 >= 90 days)
      const histCount = db
        .prepare(
          `SELECT COUNT(DISTINCT substr(record_time, 1, 10)) AS days_count
           FROM bed_availability_records
           WHERE hospital_id = ? AND ward_type = ?`,
        )
        .get(id, w.ward_type) as { days_count: number };

      const outdated = isBedRecordOutdated(w.record_time, nowUtc);
      let statusRes: { status: string; basis: 'Predicted' | 'Last recorded' };

      if (histCount.days_count >= 90 && !outdated) {
        statusRes = await predictionService.predictBedStatusWithFallback({
          hospitalId: id,
          wardType: w.ward_type,
          timestampIso: nowIso,
          totalBeds: w.total_beds,
          availableBeds: w.available_beds,
        });
      } else {
        const ratio = w.total_beds > 0 ? w.available_beds / w.total_beds : 0;
        const status =
          ratio >= 0.3 ? 'Available' : ratio >= 0.1 ? 'Limited Availability' : 'Likely Unavailable';
        statusRes = { status, basis: 'Last recorded' };
      }

      return {
        ward_type: w.ward_type,
        total_beds: w.total_beds,
        available_beds: w.available_beds,
        status: statusRes.status,
        basis: statusRes.basis,
        is_outdated: outdated,
        data_source: w.data_source,
        record_time_utc: w.record_time,
        record_time_ist: formatUtcAsIST(w.record_time),
      };
    }),
  );

  res.json({
    hospital_id: id,
    hospital_name: hospital.name,
    wards,
    advice: 'Call the hospital to confirm bed availability before travelling.',
    non_emergency_notice: NON_EMERGENCY_NOTICE,
  });
});

// REQ-CMP-01..06: Side-by-side comparison of 2-4 active hospitals
hospitalsRouter.get('/compare', async (req, res) => {
  const rawIds = String(req.query.hospitals || '')
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);

  const uniqueIds = Array.from(new Set(rawIds)).slice(0, 4);
  if (uniqueIds.length < 2) {
    res.status(400).json({
      code: 'MIN_HOSPITALS_REQUIRED',
      message: 'Please select between 2 and 4 hospitals to compare.',
      details: 'Pass hospitals=id1,id2 query parameter.',
    });
    return;
  }

  const departmentName = sanitizeSearchInput(req.query.department) || 'General Medicine';
  const nowUtc = new Date();

  const columns = await Promise.all(
    uniqueIds.map(async (hid) => {
      const hospital = db
        .prepare('SELECT * FROM hospitals WHERE hospital_id = ? AND is_active = 1')
        .get(hid) as HospitalRow | undefined;

      if (!hospital) return null;

      const dept = db
        .prepare(
          `SELECT * FROM departments
           WHERE hospital_id = ? AND is_active = 1 AND LOWER(name) = LOWER(?)
           LIMIT 1`,
        )
        .get(hid, departmentName) as DepartmentRow | undefined;

      let queueInfo: Awaited<ReturnType<typeof computeDepartmentEstimate>> | null = null;
      if (dept) {
        queueInfo = await computeDepartmentEstimate(dept);
      }

      // Bed summary (General Ward or aggregate across wards)
      const latestWards = db
        .prepare(
          `SELECT b.*
           FROM bed_availability_records b
           INNER JOIN (
             SELECT ward_type, MAX(record_time) AS max_time
             FROM bed_availability_records
             WHERE hospital_id = ?
             GROUP BY ward_type
           ) latest ON b.ward_type = latest.ward_type AND b.record_time = latest.max_time
           WHERE b.hospital_id = ?`,
        )
        .all(hid, hid) as BedRecordRow[];

      let bedSummary: {
        status: string;
        basis: string;
        is_outdated: boolean;
        as_of_ist: string;
      } | null = null;

      if (latestWards.length > 0) {
        const totalAll = latestWards.reduce((s, w) => s + w.total_beds, 0);
        const availAll = latestWards.reduce((s, w) => s + w.available_beds, 0);
        const latestTime = latestWards.map((w) => w.record_time).sort().reverse()[0];
        const ratio = totalAll > 0 ? availAll / totalAll : 0;
        const status =
          ratio >= 0.3 ? 'Available' : ratio >= 0.1 ? 'Limited Availability' : 'Likely Unavailable';
        bedSummary = {
          status,
          basis: 'Last recorded',
          is_outdated: isBedRecordOutdated(latestTime, nowUtc),
          as_of_ist: formatUtcAsIST(latestTime),
        };
      }

      return {
        hospital_id: hospital.hospital_id,
        hospital_name: hospital.name,
        city: hospital.city,
        type: hospital.type,
        contact: hospital.contact,
        department_found: Boolean(dept),
        department_name: dept ? dept.name : departmentName,
        estimate: queueInfo,
        bed_summary: bedSummary,
      };
    }),
  );

  // List of all distinct active department names for the selector
  const deptOptions = db
    .prepare(
      `SELECT DISTINCT d.name FROM departments d
       JOIN hospitals h ON h.hospital_id = d.hospital_id
       WHERE d.is_active = 1 AND h.is_active = 1
       ORDER BY d.name ASC`,
    )
    .all() as Array<{ name: string }>;

  res.json({
    department: departmentName,
    available_departments: deptOptions.map((d) => d.name),
    columns: columns.filter(Boolean),
    disclaimer: ESTIMATE_DISCLAIMER,
    non_emergency_notice: NON_EMERGENCY_NOTICE,
  });
});

// Dashboard summary endpoint for User Dashboard
hospitalsRouter.get('/dashboard/summary', (_req, res) => {
  const hospitalsCount = (
    db.prepare('SELECT COUNT(*) AS cnt FROM hospitals WHERE is_active = 1').get() as { cnt: number }
  ).cnt;
  const departmentsCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM departments d
         JOIN hospitals h ON h.hospital_id = d.hospital_id
         WHERE d.is_active = 1 AND h.is_active = 1`,
      )
      .get() as { cnt: number }
  ).cnt;
  const recentUpdatesCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM crowd_updates
         WHERE validation_status IN ('Accepted', 'Approved')`,
      )
      .get() as { cnt: number }
  ).cnt;
  const hospitalsWithBedsCount = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT b.hospital_id) AS cnt FROM bed_availability_records b
         JOIN hospitals h ON h.hospital_id = b.hospital_id
         WHERE h.is_active = 1`,
      )
      .get() as { cnt: number }
  ).cnt;

  const latestUpdates = db
    .prepare(
      `SELECT c.update_id, c.hospital_id, h.name AS hospital_name, d.name AS department_name,
              c.queue_level, c.waiting_minutes, c.submitted_at, c.validation_status
       FROM crowd_updates c
       JOIN hospitals h ON h.hospital_id = c.hospital_id
       JOIN departments d ON d.department_id = c.department_id
       WHERE h.is_active = 1 AND c.validation_status IN ('Accepted', 'Approved')
       ORDER BY c.submitted_at DESC
       LIMIT 6`,
    )
    .all() as Array<{
    update_id: number;
    hospital_id: number;
    hospital_name: string;
    department_name: string;
    queue_level: string;
    waiting_minutes: number;
    submitted_at: string;
    validation_status: string;
  }>;

  // Queue status distribution across active departments from latest waiting records
  const deptLatestWaits = db
    .prepare(
      `SELECT w.department_id, w.avg_waiting_minutes
       FROM waiting_time_records w
       INNER JOIN (
         SELECT department_id, MAX(record_time) AS max_time
         FROM waiting_time_records
         GROUP BY department_id
       ) latest ON w.department_id = latest.department_id AND w.record_time = latest.max_time`,
    )
    .all() as Array<{ department_id: number; avg_waiting_minutes: number }>;

  let lowCount = 0;
  let medCount = 0;
  let highCount = 0;
  for (const r of deptLatestWaits) {
    const lvl = deriveQueueLevel(r.avg_waiting_minutes);
    if (lvl === 'Low') lowCount++;
    else if (lvl === 'Medium') medCount++;
    else highCount++;
  }

  // Hospital bed availability overview
  const bedOverview = db
    .prepare(
      `SELECT h.hospital_id, h.name AS hospital_name, h.type,
              SUM(b.total_beds) AS total_beds, SUM(b.available_beds) AS available_beds,
              MAX(b.record_time) AS latest_time
       FROM bed_availability_records b
       JOIN hospitals h ON h.hospital_id = b.hospital_id
       INNER JOIN (
         SELECT hospital_id, ward_type, MAX(record_time) AS max_time
         FROM bed_availability_records
         GROUP BY hospital_id, ward_type
       ) latest ON b.hospital_id = latest.hospital_id AND b.ward_type = latest.ward_type AND b.record_time = latest.max_time
       WHERE h.is_active = 1
       GROUP BY h.hospital_id
       ORDER BY h.name ASC`,
    )
    .all() as Array<{
    hospital_id: number;
    hospital_name: string;
    type: string;
    total_beds: number;
    available_beds: number;
    latest_time: string;
  }>;

  res.json({
    counts: {
      hospitals_available: hospitalsCount,
      opd_departments: departmentsCount,
      recent_queue_updates: recentUpdatesCount,
      hospitals_with_beds: hospitalsWithBedsCount,
    },
    queue_distribution: {
      Low: lowCount,
      Medium: medCount,
      High: highCount,
    },
    latest_updates: latestUpdates.map((u) => ({
      ...u,
      submitted_at_ist: formatUtcAsIST(u.submitted_at),
    })),
    hospital_bed_overview: bedOverview.map((b) => {
      const pct = b.total_beds > 0 ? Math.round((b.available_beds / b.total_beds) * 100) : 0;
      return {
        ...b,
        availability_pct: pct,
        status: pct >= 30 ? 'Available' : pct >= 10 ? 'Limited Availability' : 'Likely Unavailable',
        latest_time_ist: formatUtcAsIST(b.latest_time),
      };
    }),
  });
});

// Global Ward-wise Bed Availability across active hospitals
hospitalsRouter.get('/beds', async (req, res) => {
  const hospitalIdParam = Number.parseInt(String(req.query.hospital_id || ''), 10);
  const q = sanitizeSearchInput(req.query.q).toLowerCase();

  const rows = db
    .prepare(
      `SELECT b.*, h.name AS hospital_name, h.city, h.type
       FROM bed_availability_records b
       JOIN hospitals h ON h.hospital_id = b.hospital_id
       INNER JOIN (
         SELECT hospital_id, ward_type, MAX(record_time) AS max_time
         FROM bed_availability_records
         GROUP BY hospital_id, ward_type
       ) latest ON b.hospital_id = latest.hospital_id AND b.ward_type = latest.ward_type AND b.record_time = latest.max_time
       WHERE h.is_active = 1
       ORDER BY h.name ASC, b.ward_type ASC`,
    )
    .all() as Array<BedRecordRow & { hospital_name: string; city: string; type: string }>;

  const nowUtc = new Date();
  const filtered = rows.filter((r) => {
    if (Number.isFinite(hospitalIdParam) && r.hospital_id !== hospitalIdParam) return false;
    if (q && !r.hospital_name.toLowerCase().includes(q) && !r.ward_type.toLowerCase().includes(q)) {
      return false;
    }
    return true;
  });

  const wards = filtered.map((w) => {
    const outdated = isBedRecordOutdated(w.record_time, nowUtc);
    const ratio = w.total_beds > 0 ? w.available_beds / w.total_beds : 0;
    const status =
      ratio >= 0.3 ? 'Available' : ratio >= 0.1 ? 'Limited Availability' : 'Likely Unavailable';
    return {
      hospital_id: w.hospital_id,
      hospital_name: w.hospital_name,
      city: w.city,
      hospital_type: w.type,
      ward_type: w.ward_type,
      total_beds: w.total_beds,
      available_beds: w.available_beds,
      occupied_beds: Math.max(0, w.total_beds - w.available_beds),
      availability_pct: Math.round(ratio * 100),
      status,
      basis: outdated ? 'Last recorded' : 'Predicted',
      is_outdated: outdated,
      data_source: w.data_source,
      record_time_ist: formatUtcAsIST(w.record_time),
    };
  });

  res.json({
    wards,
    advice: 'Call the hospital to confirm bed availability before travelling.',
    non_emergency_notice: NON_EMERGENCY_NOTICE,
  });
});

// Public ML model metrics overview for Machine Learning Information page
hospitalsRouter.get('/ml/overview', (_req, res) => {
  const activeModel = db
    .prepare("SELECT * FROM model_versions WHERE status = 'active' ORDER BY trained_at DESC LIMIT 1")
    .get() as
    | {
        model_version: string;
        model_type: string;
        training_range: string;
        metrics: string;
        data_provenance: string;
        trained_at: string;
      }
    | undefined;

  res.json({
    active_model: activeModel
      ? {
          model_version: activeModel.model_version,
          model_type: activeModel.model_type,
          training_range: activeModel.training_range,
          data_provenance: activeModel.data_provenance,
          trained_at_ist: formatUtcAsIST(activeModel.trained_at),
          metrics: JSON.parse(activeModel.metrics),
        }
      : null,
  });
});

