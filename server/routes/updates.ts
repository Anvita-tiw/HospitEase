import { Router } from 'express';
import { db } from '../db/database.ts';
import { rateLimitMiddleware, requireAuth, type AuthenticatedRequest } from '../middleware/auth.ts';
import { SRS_DEFAULTS, type QueueLevel } from '../types.ts';
import { formatUtcAsIST, toISTParts } from '../utils/time.ts';
import { checkOutlierRule, deriveQueueLevel } from '../utils/validation.ts';
import { liveEventBus } from '../services/liveEvents.ts';

export const updatesRouter = Router();

// REQ-CRW-01..12: Authenticated non-suspended users submit structured queue updates
updatesRouter.post('/', requireAuth, rateLimitMiddleware(30, 60_000), (req: AuthenticatedRequest, res) => {
  const userId = req.user!.user_id;
  const body = req.body ?? {};

  // REQ-CRW-02, NFR-SAF-07: Reject unexpected free-text notes/comments fields
  const allowedKeys = new Set([
    'hospital_id',
    'department_id',
    'queue_level',
    'waiting_minutes',
    'visit_time',
  ]);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      res.status(400).json({
        code: 'FREE_TEXT_NOT_ALLOWED',
        message: 'Free-text fields are not accepted in queue updates.',
        details: `Unexpected field: ${key}`,
      });
      return;
    }
  }

  const hospitalId = Number(body.hospital_id);
  const departmentId = Number(body.department_id);
  const queueLevel = body.queue_level as QueueLevel;
  const waitingMinutes = Number(body.waiting_minutes);
  const visitTimeRaw = body.visit_time;

  if (
    !Number.isInteger(hospitalId) ||
    !Number.isInteger(departmentId) ||
    !['Low', 'Medium', 'High'].includes(queueLevel) ||
    !Number.isInteger(waitingMinutes) ||
    typeof visitTimeRaw !== 'string'
  ) {
    res.status(422).json({
      code: 'INVALID_FIELDS',
      message:
        'Please complete hospital, department, queue level (Low/Medium/High), whole waiting minutes, and visit time.',
      details: 'Required fields missing or malformed.',
    });
    return;
  }

  // REQ-CRW-04: Department must belong to active hospital
  const deptMatch = db
    .prepare(
      `SELECT d.department_id, h.hospital_id
       FROM departments d
       JOIN hospitals h ON h.hospital_id = d.hospital_id
       WHERE d.department_id = ? AND d.hospital_id = ? AND d.is_active = 1 AND h.is_active = 1`,
    )
    .get(departmentId, hospitalId);

  if (!deptMatch) {
    res.status(422).json({
      code: 'DEPARTMENT_HOSPITAL_MISMATCH',
      message: 'The selected department does not belong to this active hospital.',
      details: 'hospital_id and department_id mismatch or inactive.',
    });
    return;
  }

  // REQ-CRW-05: Waiting minutes in [0..360]
  if (waitingMinutes < 0 || waitingMinutes > SRS_DEFAULTS.MAX_WAIT_MINUTES) {
    res.status(422).json({
      code: 'WAIT_OUT_OF_RANGE',
      message: `Waiting time must be between 0 and ${SRS_DEFAULTS.MAX_WAIT_MINUTES} minutes.`,
      details: 'Violated rule REQ-CRW-05 (0-360 minutes).',
    });
    return;
  }

  // REQ-CRW-03: Server clock for submission time; validate visit_time not in future and not older than 6h
  const nowUtc = new Date();
  const visitDate = new Date(visitTimeRaw);
  if (Number.isNaN(visitDate.getTime())) {
    res.status(422).json({
      code: 'INVALID_VISIT_TIME',
      message: 'Please enter a valid visit date and time.',
      details: 'visit_time is not a valid ISO timestamp.',
    });
    return;
  }

  const visitDiffMs = nowUtc.getTime() - visitDate.getTime();
  if (visitDiffMs < -2 * 60 * 1000) {
    res.status(422).json({
      code: 'FUTURE_VISIT_TIME',
      message: 'Visit time cannot be in the future.',
      details: 'Violated rule REQ-CRW-05 (visit_time in future).',
    });
    return;
  }
  if (visitDiffMs > SRS_DEFAULTS.MAX_VISIT_AGE_HOURS * 60 * 60 * 1000) {
    res.status(422).json({
      code: 'VISIT_TOO_OLD',
      message: `Visit time must be within the last ${SRS_DEFAULTS.MAX_VISIT_AGE_HOURS} hours.`,
      details: 'Violated rule REQ-CRW-05 (visit_time > 6h old).',
    });
    return;
  }

  // REQ-CRW-06: Consistency between queue_level and waiting_minutes
  const expectedLevel = deriveQueueLevel(waitingMinutes);
  if (queueLevel !== expectedLevel) {
    res.status(422).json({
      code: 'LEVEL_MINUTES_MISMATCH',
      message: `Queue level "${queueLevel}" does not match ${waitingMinutes} minutes (expected "${expectedLevel}": Low < 20, Medium 20–45, High > 45 min).`,
      details: 'Violated rule REQ-CRW-06.',
    });
    return;
  }

  // REQ-CRW-07: Duplicate window (30 min per user per department -> 409)
  const dupWindowIso = new Date(
    nowUtc.getTime() - SRS_DEFAULTS.DUPLICATE_WINDOW_MINUTES * 60 * 1000,
  ).toISOString();
  const recentDup = db
    .prepare(
      `SELECT update_id FROM crowd_updates
       WHERE user_id = ? AND department_id = ? AND submitted_at >= ?
       LIMIT 1`,
    )
    .get(userId, departmentId, dupWindowIso);

  if (recentDup) {
    res.status(409).json({
      code: 'DUPLICATE_SUBMISSION',
      message: `You already submitted an update for this department within the last ${SRS_DEFAULTS.DUPLICATE_WINDOW_MINUTES} minutes.`,
      details: 'Violated rule REQ-CRW-07 (30-min duplicate window).',
    });
    return;
  }

  // REQ-CRW-07: Daily limit (10 per user per day -> 429)
  const dayAgoIso = new Date(nowUtc.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const dailyRow = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM crowd_updates
       WHERE user_id = ? AND submitted_at >= ?`,
    )
    .get(userId, dayAgoIso) as { cnt: number };

  if (dailyRow.cnt >= SRS_DEFAULTS.DAILY_SUBMISSION_LIMIT) {
    res.status(429).json({
      code: 'DAILY_LIMIT_REACHED',
      message: `You have reached the daily limit of ${SRS_DEFAULTS.DAILY_SUBMISSION_LIMIT} updates per day.`,
      details: 'Violated rule REQ-CRW-07 (daily limit).',
    });
    return;
  }

  // REQ-CRW-08 (TBD-5): Check outlier rule against recent reports (2h) or historical mean/SD
  const twoHoursAgoIso = new Date(nowUtc.getTime() - 2 * 60 * 60 * 1000).toISOString();
  const recentValid = db
    .prepare(
      `SELECT waiting_minutes FROM crowd_updates
       WHERE department_id = ? AND validation_status IN ('Accepted', 'Approved') AND submitted_at >= ?`,
    )
    .all(departmentId, twoHoursAgoIso) as Array<{ waiting_minutes: number }>;

  const nowIst = toISTParts(nowUtc);
  const histRows = db
    .prepare(
      `SELECT avg_waiting_minutes, record_time FROM waiting_time_records
       WHERE department_id = ? ORDER BY record_time DESC LIMIT 300`,
    )
    .all(departmentId) as Array<{ avg_waiting_minutes: number; record_time: string }>;

  const slotRows = histRows.filter((r) => {
    const rIst = toISTParts(r.record_time);
    return rIst.dayOfWeek === nowIst.dayOfWeek && rIst.timeSlot === nowIst.timeSlot;
  });
  const histPool = (slotRows.length >= 4 ? slotRows : histRows).map((r) => r.avg_waiting_minutes);
  let histMean: number | null = null;
  let histSd: number | null = null;
  if (histPool.length > 0) {
    histMean = histPool.reduce((a, b) => a + b, 0) / histPool.length;
    const variance =
      histPool.length > 1
        ? histPool.reduce((a, b) => a + (b - histMean!) ** 2, 0) / (histPool.length - 1)
        : 225;
    histSd = Math.sqrt(variance);
  }

  const outlier = checkOutlierRule(
    waitingMinutes,
    recentValid.map((r) => r.waiting_minutes),
    histMean,
    histSd,
  );

  const validationStatus = outlier.isOutlier ? 'Flagged' : 'Accepted';
  const submittedAtIso = nowUtc.toISOString();

  const insertRes = db
    .prepare(
      `INSERT INTO crowd_updates
       (user_id, hospital_id, department_id, queue_level, waiting_minutes, visit_time, submitted_at, validation_status, flag_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      userId,
      hospitalId,
      departmentId,
      queueLevel,
      waitingMinutes,
      visitDate.toISOString(),
      submittedAtIso,
      validationStatus,
      outlier.reason,
    );

  if (validationStatus === 'Accepted') {
    liveEventBus.emitUpdate({
      type: 'queue:updated',
      hospital_id: hospitalId,
      department_id: departmentId,
      source: 'crowd',
      at: submittedAtIso,
    });
  }

  res.status(201).json({
    update_id: Number(insertRes.lastInsertRowid),
    validation_status: validationStatus,
    submitted_at_ist: formatUtcAsIST(submittedAtIso),
    message:
      validationStatus === 'Flagged'
        ? 'Thank you. Your report is far from recent estimates and has been placed under administrator review before affecting live predictions.'
        : 'Thank you. Your update has been accepted and will be included in live queue estimates.',
  });
});

// REQ-CRW-11: User lists own submissions with time and status
updatesRouter.get('/mine', requireAuth, (req: AuthenticatedRequest, res) => {
  const rows = db
    .prepare(
      `SELECT
         c.update_id, c.hospital_id, c.department_id, c.queue_level, c.waiting_minutes,
         c.visit_time, c.submitted_at, c.validation_status, c.flag_reason, c.reviewed_at,
         h.name AS hospital_name, d.name AS department_name
       FROM crowd_updates c
       JOIN hospitals h ON h.hospital_id = c.hospital_id
       JOIN departments d ON d.department_id = c.department_id
       WHERE c.user_id = ?
       ORDER BY c.submitted_at DESC
       LIMIT 100`,
    )
    .all(req.user!.user_id) as Array<{
    update_id: number;
    hospital_id: number;
    department_id: number;
    queue_level: string;
    waiting_minutes: number;
    visit_time: string;
    submitted_at: string;
    validation_status: string;
    flag_reason: string | null;
    reviewed_at: string | null;
    hospital_name: string;
    department_name: string;
  }>;

  res.json({
    updates: rows.map((r) => ({
      ...r,
      visit_time_ist: formatUtcAsIST(r.visit_time),
      submitted_at_ist: formatUtcAsIST(r.submitted_at),
      reviewed_at_ist: r.reviewed_at ? formatUtcAsIST(r.reviewed_at) : null,
    })),
  });
});
