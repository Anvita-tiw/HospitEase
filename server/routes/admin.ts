import { Router } from 'express';
import { db, writeAuditLog } from '../db/database.ts';
import { predictionService } from '../ml/service.ts';
import { buildTrainingDatasetFromDb } from '../ml/trainingData.ts';
import { requireAuth, requireRole, type AuthenticatedRequest } from '../middleware/auth.ts';
import type { DataSource, ModelMetricsSummary, OpdTimingsConfig } from '../types.ts';
import { formatUtcAsIST } from '../utils/time.ts';
import { deriveQueueLevel } from '../utils/validation.ts';
import { liveEventBus } from '../services/liveEvents.ts';
import {
  generateFeedToken,
  syncOutboundFeed,
  validateExternalFeedUrl,
  type ConnectorType,
  type FeedConnectionRow,
} from '../services/feedService.ts';

export const adminRouter = Router();

// REQ-ADM-08: All /admin endpoints require authenticated admin role
adminRouter.use(requireAuth, requireRole(['admin']));

// REQ-ADM-05: Admin dashboard statistics
adminRouter.get('/dashboard', (_req, res) => {
  const usersCount = (db.prepare('SELECT COUNT(*) AS cnt FROM users').get() as { cnt: number }).cnt;
  const activeHospitals = (
    db.prepare('SELECT COUNT(*) AS cnt FROM hospitals WHERE is_active = 1').get() as { cnt: number }
  ).cnt;
  const activeDepartments = (
    db.prepare('SELECT COUNT(*) AS cnt FROM departments WHERE is_active = 1').get() as { cnt: number }
  ).cnt;

  const dayAgoIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const updates24h = (
    db.prepare('SELECT COUNT(*) AS cnt FROM crowd_updates WHERE submitted_at >= ?').get(dayAgoIso) as {
      cnt: number;
    }
  ).cnt;

  const pendingFlagged = (
    db.prepare("SELECT COUNT(*) AS cnt FROM crowd_updates WHERE validation_status = 'Flagged'").get() as {
      cnt: number;
    }
  ).cnt;

  const activeModelRow = db
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

  const latestWait = (
    db.prepare('SELECT MAX(record_time) AS ts FROM waiting_time_records').get() as { ts: string | null }
  ).ts;
  const latestBed = (
    db.prepare('SELECT MAX(record_time) AS ts FROM bed_availability_records').get() as { ts: string | null }
  ).ts;
  const latestCrowd = (
    db.prepare('SELECT MAX(submitted_at) AS ts FROM crowd_updates').get() as { ts: string | null }
  ).ts;

  res.json({
    counts: {
      users: usersCount,
      active_hospitals: activeHospitals,
      active_departments: activeDepartments,
      updates_24h: updates24h,
      pending_flagged: pendingFlagged,
    },
    active_model: activeModelRow
      ? {
          model_version: activeModelRow.model_version,
          model_type: activeModelRow.model_type,
          training_range: activeModelRow.training_range,
          data_provenance: activeModelRow.data_provenance,
          trained_at_ist: formatUtcAsIST(activeModelRow.trained_at),
          metrics: JSON.parse(activeModelRow.metrics) as ModelMetricsSummary,
        }
      : null,
    latest_timestamps: {
      waiting_records_ist: formatUtcAsIST(latestWait),
      bed_records_ist: formatUtcAsIST(latestBed),
      crowd_updates_ist: formatUtcAsIST(latestCrowd),
    },
  });
});

// REQ-ADM-04: Moderation queue (Flagged updates oldest first with comparison context)
adminRouter.get('/updates', (req, res) => {
  const statusFilter = typeof req.query.status === 'string' ? req.query.status : 'Flagged';
  const normalizedStatus =
    statusFilter.toLowerCase() === 'all'
      ? null
      : statusFilter.charAt(0).toUpperCase() + statusFilter.slice(1).toLowerCase();

  const orderDir = normalizedStatus === 'Flagged' ? 'ASC' : 'DESC';
  const sql = `
    SELECT
      c.update_id, c.hospital_id, c.department_id, c.queue_level, c.waiting_minutes,
      c.visit_time, c.submitted_at, c.validation_status, c.flag_reason, c.reviewed_at,
      h.name AS hospital_name, d.name AS department_name,
      u.name AS submitter_name, r.name AS reviewer_name
    FROM crowd_updates c
    JOIN hospitals h ON h.hospital_id = c.hospital_id
    JOIN departments d ON d.department_id = c.department_id
    LEFT JOIN users u ON u.user_id = c.user_id
    LEFT JOIN users r ON r.user_id = c.reviewed_by
    ${normalizedStatus ? 'WHERE c.validation_status = ?' : ''}
    ORDER BY c.submitted_at ${orderDir}
    LIMIT 100
  `;

  const rows = (normalizedStatus ? db.prepare(sql).all(normalizedStatus) : db.prepare(sql).all()) as Array<{
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
    submitter_name: string | null;
    reviewer_name: string | null;
  }>;

  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const enriched = rows.map((row) => {
    const recentRows = db
      .prepare(
        `SELECT waiting_minutes FROM crowd_updates
         WHERE department_id = ? AND validation_status IN ('Accepted', 'Approved') AND submitted_at >= ?`,
      )
      .all(row.department_id, twoHoursAgo) as Array<{ waiting_minutes: number }>;

    const sortedRecent = recentRows.map((x) => x.waiting_minutes).sort((a, b) => a - b);
    const recentMedian =
      sortedRecent.length > 0 ? sortedRecent[Math.floor(sortedRecent.length / 2)] : null;

    const histAvg = (
      db
        .prepare(
          `SELECT AVG(avg_waiting_minutes) AS avg_wait FROM (
            SELECT avg_waiting_minutes FROM waiting_time_records WHERE department_id = ? ORDER BY record_time DESC LIMIT 40
          )`,
        )
        .get(row.department_id) as { avg_wait: number | null }
    ).avg_wait;

    return {
      ...row,
      submitter_name: row.submitter_name || 'Anonymised user',
      visit_time_ist: formatUtcAsIST(row.visit_time),
      submitted_at_ist: formatUtcAsIST(row.submitted_at),
      reviewed_at_ist: row.reviewed_at ? formatUtcAsIST(row.reviewed_at) : null,
      context: {
        recent_valid_median: recentMedian !== null ? Math.round(recentMedian) : null,
        historical_avg: histAvg !== null ? Math.round(histAvg) : null,
      },
    };
  });

  res.json({ updates: enriched });
});

adminRouter.patch('/updates/:id', (req: AuthenticatedRequest, res) => {
  const updateId = Number.parseInt(req.params.id, 10);
  const { decision } = req.body ?? {};
  if (!Number.isFinite(updateId) || !['Approved', 'Rejected', 'Flagged'].includes(decision)) {
    res.status(400).json({
      code: 'INVALID_MODERATION_ACTION',
      message: 'Decision must be "Approved", "Rejected", or "Flagged".',
      details: null,
    });
    return;
  }

  const existing = db
    .prepare('SELECT update_id, hospital_id, department_id FROM crowd_updates WHERE update_id = ?')
    .get(updateId) as { update_id: number; hospital_id: number; department_id: number } | undefined;
  if (!existing) {
    res.status(404).json({ code: 'UPDATE_NOT_FOUND', message: 'Crowd update not found.', details: null });
    return;
  }

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE crowd_updates
     SET validation_status = ?, reviewed_by = ?, reviewed_at = ?
     WHERE update_id = ?`,
  ).run(decision, req.user!.user_id, now, updateId);

  writeAuditLog(req.user!.user_id, `MODERATE_${decision.toUpperCase()}`, `crowd_update:${updateId}`);

  liveEventBus.emitUpdate({
    type: 'queue:updated',
    hospital_id: existing.hospital_id,
    department_id: existing.department_id,
    source: 'crowd',
    at: now,
  });

  res.json({
    update_id: updateId,
    validation_status: decision,
    reviewed_at_ist: formatUtcAsIST(now),
  });
});

// REQ-ADM-01: Master hospital & department CRUD
adminRouter.get('/hospitals', (_req, res) => {
  const hospitals = db.prepare('SELECT * FROM hospitals ORDER BY hospital_id ASC').all() as Array<{
    hospital_id: number;
    name: string;
    address: string;
    city: string;
    contact: string;
    type: string;
    is_active: number;
    created_at: string;
  }>;

  const result = hospitals.map((h) => {
    const depts = db
      .prepare('SELECT * FROM departments WHERE hospital_id = ? ORDER BY name ASC')
      .all(h.hospital_id) as Array<{
      department_id: number;
      hospital_id: number;
      name: string;
      opd_timings: string;
      is_active: number;
    }>;

    return {
      ...h,
      is_active: Boolean(h.is_active),
      departments: depts.map((d) => {
        let label = d.opd_timings;
        try {
          label = (JSON.parse(d.opd_timings) as OpdTimingsConfig).label;
        } catch {
          // keep raw
        }
        return {
          ...d,
          is_active: Boolean(d.is_active),
          opd_timings_label: label,
        };
      }),
    };
  });

  res.json({ hospitals: result });
});

adminRouter.post('/hospitals', (req: AuthenticatedRequest, res) => {
  const { name, address, city, contact, type } = req.body ?? {};
  if (
    typeof name !== 'string' ||
    name.trim().length < 2 ||
    typeof address !== 'string' ||
    address.trim().length < 4 ||
    typeof city !== 'string' ||
    city.trim().length < 2 ||
    typeof contact !== 'string' ||
    contact.trim().length < 5 ||
    typeof type !== 'string' ||
    type.trim().length < 2
  ) {
    res.status(400).json({
      code: 'INVALID_HOSPITAL_DATA',
      message: 'Please provide hospital name, address, city, contact, and type.',
      details: null,
    });
    return;
  }

  const now = new Date().toISOString();
  const r = db
    .prepare(
      'INSERT INTO hospitals (name, address, city, contact, type, is_active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
    )
    .run(name.trim(), address.trim(), city.trim(), contact.trim(), type.trim(), now);

  const hospitalId = Number(r.lastInsertRowid);
  writeAuditLog(req.user!.user_id, 'CREATE_HOSPITAL', `hospital:${hospitalId}`, name.trim());

  res.status(201).json({ hospital_id: hospitalId, name: name.trim(), is_active: true });
});

adminRouter.patch('/hospitals/:id', (req: AuthenticatedRequest, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const existing = db.prepare('SELECT * FROM hospitals WHERE hospital_id = ?').get(id) as
    | {
        hospital_id: number;
        name: string;
        address: string;
        city: string;
        contact: string;
        type: string;
        is_active: number;
      }
    | undefined;

  if (!existing) {
    res.status(404).json({ code: 'HOSPITAL_NOT_FOUND', message: 'Hospital not found.', details: null });
    return;
  }

  const { name, address, city, contact, type, is_active } = req.body ?? {};
  const nextName = typeof name === 'string' && name.trim() ? name.trim() : existing.name;
  const nextAddr = typeof address === 'string' && address.trim() ? address.trim() : existing.address;
  const nextCity = typeof city === 'string' && city.trim() ? city.trim() : existing.city;
  const nextContact = typeof contact === 'string' && contact.trim() ? contact.trim() : existing.contact;
  const nextType = typeof type === 'string' && type.trim() ? type.trim() : existing.type;
  const nextActive = typeof is_active === 'boolean' ? (is_active ? 1 : 0) : existing.is_active;

  db.prepare(
    `UPDATE hospitals SET name = ?, address = ?, city = ?, contact = ?, type = ?, is_active = ? WHERE hospital_id = ?`,
  ).run(nextName, nextAddr, nextCity, nextContact, nextType, nextActive, id);

  writeAuditLog(
    req.user!.user_id,
    nextActive === 0 ? 'DEACTIVATE_HOSPITAL' : 'UPDATE_HOSPITAL',
    `hospital:${id}`,
    nextName,
  );

  res.json({ hospital_id: id, name: nextName, is_active: Boolean(nextActive) });
});

adminRouter.post('/departments', (req: AuthenticatedRequest, res) => {
  const { hospital_id, name, opd_label, start_time, end_time, days } = req.body ?? {};
  const hid = Number(hospital_id);
  if (!Number.isInteger(hid) || typeof name !== 'string' || name.trim().length < 2) {
    res.status(400).json({
      code: 'INVALID_DEPARTMENT',
      message: 'Please provide a valid hospital ID and department name.',
      details: null,
    });
    return;
  }

  const hosp = db.prepare('SELECT hospital_id FROM hospitals WHERE hospital_id = ?').get(hid);
  if (!hosp) {
    res.status(404).json({ code: 'HOSPITAL_NOT_FOUND', message: 'Hospital not found.', details: null });
    return;
  }

  const validDays = Array.isArray(days) && days.length > 0 ? days : [1, 2, 3, 4, 5, 6];
  const sTime = typeof start_time === 'string' && /^\d{2}:\d{2}$/.test(start_time) ? start_time : '09:00';
  const eTime = typeof end_time === 'string' && /^\d{2}:\d{2}$/.test(end_time) ? end_time : '14:00';
  const timingsConfig: OpdTimingsConfig = {
    label: typeof opd_label === 'string' && opd_label.trim() ? opd_label.trim() : `Mon–Sat ${sTime}–${eTime}`,
    sessions: [{ days: validDays, start: sTime, end: eTime }],
  };

  const r = db
    .prepare('INSERT INTO departments (hospital_id, name, opd_timings, is_active) VALUES (?, ?, ?, 1)')
    .run(hid, name.trim(), JSON.stringify(timingsConfig));

  const departmentId = Number(r.lastInsertRowid);
  writeAuditLog(req.user!.user_id, 'CREATE_DEPARTMENT', `department:${departmentId}`, `${name.trim()} (H:${hid})`);

  res.status(201).json({ department_id: departmentId, hospital_id: hid, name: name.trim(), is_active: true });
});

adminRouter.patch('/departments/:id', (req: AuthenticatedRequest, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const existing = db.prepare('SELECT * FROM departments WHERE department_id = ?').get(id) as
    | { department_id: number; name: string; opd_timings: string; is_active: number }
    | undefined;

  if (!existing) {
    res.status(404).json({ code: 'DEPARTMENT_NOT_FOUND', message: 'Department not found.', details: null });
    return;
  }

  const { name, is_active } = req.body ?? {};
  const nextName = typeof name === 'string' && name.trim() ? name.trim() : existing.name;
  const nextActive = typeof is_active === 'boolean' ? (is_active ? 1 : 0) : existing.is_active;

  db.prepare('UPDATE departments SET name = ?, is_active = ? WHERE department_id = ?').run(
    nextName,
    nextActive,
    id,
  );
  writeAuditLog(
    req.user!.user_id,
    nextActive === 0 ? 'DEACTIVATE_DEPARTMENT' : 'UPDATE_DEPARTMENT',
    `department:${id}`,
    nextName,
  );
  res.json({ department_id: id, name: nextName, is_active: Boolean(nextActive) });
});

// REQ-BED-07: Add bed availability record with validation
adminRouter.post('/beds', (req: AuthenticatedRequest, res) => {
  const { hospital_id, ward_type, total_beds, available_beds, data_source } = req.body ?? {};
  const hid = Number(hospital_id);
  const total = Number(total_beds);
  const available = Number(available_beds);
  const source: DataSource = ['real', 'public', 'synthetic'].includes(data_source)
    ? data_source
    : 'real';

  if (
    !Number.isInteger(hid) ||
    typeof ward_type !== 'string' ||
    ward_type.trim().length < 2 ||
    !Number.isInteger(total) ||
    !Number.isInteger(available)
  ) {
    res.status(400).json({
      code: 'INVALID_BED_INPUT',
      message: 'Please enter valid hospital, ward type, total beds, and available beds.',
      details: null,
    });
    return;
  }

  if (total <= 0 || available < 0 || available > total) {
    res.status(422).json({
      code: 'INVALID_BED_COUNTS',
      message: 'Available beds must be 0 or more and cannot exceed total beds.',
      details: 'Violated rule REQ-BED-07.',
    });
    return;
  }

  const hosp = db.prepare('SELECT hospital_id FROM hospitals WHERE hospital_id = ?').get(hid);
  if (!hosp) {
    res.status(404).json({ code: 'HOSPITAL_NOT_FOUND', message: 'Hospital not found.', details: null });
    return;
  }

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO bed_availability_records (hospital_id, ward_type, total_beds, available_beds, record_time, data_source)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(hid, ward_type.trim(), total, available, now, source);

  writeAuditLog(
    req.user!.user_id,
    'ADD_BED_RECORD',
    `hospital:${hid}`,
    `${ward_type.trim()}: ${available}/${total} (${source})`,
  );

  liveEventBus.emitUpdate({
    type: 'beds:updated',
    hospital_id: hid,
    ward_type: ward_type.trim(),
    source,
    at: now,
  });

  res.status(201).json({
    hospital_id: hid,
    ward_type: ward_type.trim(),
    total_beds: total,
    available_beds: available,
    record_time_ist: formatUtcAsIST(now),
  });
});

// REQ-ADM-02, REQ-ADM-03: CSV Import with schema/value validation and provenance tagging
adminRouter.post('/import/:type', (req: AuthenticatedRequest, res) => {
  const importType = req.params.type;
  if (!['opd_queue', 'waiting_time', 'beds'].includes(importType)) {
    res.status(400).json({
      code: 'INVALID_IMPORT_TYPE',
      message: 'Import type must be opd_queue, waiting_time, or beds.',
      details: null,
    });
    return;
  }

  const { csv, data_source } = req.body ?? {};
  const source: DataSource = ['real', 'public', 'synthetic'].includes(data_source)
    ? data_source
    : 'public';

  if (typeof csv !== 'string' || csv.trim().length === 0) {
    res.status(400).json({
      code: 'EMPTY_CSV',
      message: 'Please paste or upload non-empty UTF-8 CSV content.',
      details: null,
    });
    return;
  }

  const lines = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 2) {
    res.status(400).json({
      code: 'NO_DATA_ROWS',
      message: 'CSV must contain a header row and at least one data row.',
      details: null,
    });
    return;
  }

  const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const errors: Array<{ row: number; reason: string }> = [];
  let rowsImported = 0;
  const rowsRead = lines.length - 1;

  const tx = db.transaction(() => {
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map((c) => c.trim());
      const rowNum = i + 1;
      const obj: Record<string, string> = {};
      headers.forEach((h, idx) => {
        obj[h] = cols[idx] ?? '';
      });

      if (importType === 'waiting_time') {
        const deptId = Number(obj.department_id);
        const waitMin = Number(obj.avg_waiting_minutes);
        const recTime = new Date(obj.record_time);
        if (!Number.isInteger(deptId) || !Number.isFinite(waitMin) || waitMin < 0 || waitMin > 360) {
          errors.push({ row: rowNum, reason: 'Invalid department_id or avg_waiting_minutes (0–360).' });
          continue;
        }
        if (Number.isNaN(recTime.getTime())) {
          errors.push({ row: rowNum, reason: 'Invalid ISO record_time timestamp.' });
          continue;
        }
        const deptExists = db.prepare('SELECT department_id FROM departments WHERE department_id = ?').get(deptId);
        if (!deptExists) {
          errors.push({ row: rowNum, reason: `Department ID ${deptId} does not exist.` });
          continue;
        }
        db.prepare(
          'INSERT INTO waiting_time_records (department_id, record_time, avg_waiting_minutes, data_source) VALUES (?, ?, ?, ?)',
        ).run(deptId, recTime.toISOString(), waitMin, source);
        rowsImported++;
      } else if (importType === 'opd_queue') {
        const deptId = Number(obj.department_id);
        const qSize = Number(obj.queue_size);
        const qLevel = obj.queue_level;
        const recTime = new Date(obj.record_time);
        if (!Number.isInteger(deptId) || !Number.isInteger(qSize) || qSize < 0) {
          errors.push({ row: rowNum, reason: 'Invalid department_id or non-negative queue_size.' });
          continue;
        }
        if (Number.isNaN(recTime.getTime())) {
          errors.push({ row: rowNum, reason: 'Invalid ISO record_time timestamp.' });
          continue;
        }
        const deptExists = db.prepare('SELECT department_id FROM departments WHERE department_id = ?').get(deptId);
        if (!deptExists) {
          errors.push({ row: rowNum, reason: `Department ID ${deptId} does not exist.` });
          continue;
        }
        const level = ['Low', 'Medium', 'High'].includes(qLevel) ? qLevel : deriveQueueLevel(qSize * 1.4);
        db.prepare(
          'INSERT INTO opd_queue_records (department_id, record_time, queue_size, queue_level, data_source) VALUES (?, ?, ?, ?, ?)',
        ).run(deptId, recTime.toISOString(), qSize, level, source);
        rowsImported++;
      } else if (importType === 'beds') {
        const hospId = Number(obj.hospital_id);
        const ward = obj.ward_type;
        const total = Number(obj.total_beds);
        const avail = Number(obj.available_beds);
        const recTime = new Date(obj.record_time);
        if (
          !Number.isInteger(hospId) ||
          !ward ||
          !Number.isInteger(total) ||
          !Number.isInteger(avail) ||
          total <= 0 ||
          avail < 0 ||
          avail > total
        ) {
          errors.push({
            row: rowNum,
            reason: 'Invalid hospital_id, ward_type, or bed counts (0 <= available <= total).',
          });
          continue;
        }
        if (Number.isNaN(recTime.getTime())) {
          errors.push({ row: rowNum, reason: 'Invalid ISO record_time timestamp.' });
          continue;
        }
        const hospExists = db.prepare('SELECT hospital_id FROM hospitals WHERE hospital_id = ?').get(hospId);
        if (!hospExists) {
          errors.push({ row: rowNum, reason: `Hospital ID ${hospId} does not exist.` });
          continue;
        }
        db.prepare(
          'INSERT INTO bed_availability_records (hospital_id, ward_type, total_beds, available_beds, record_time, data_source) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(hospId, ward, total, avail, recTime.toISOString(), source);
        rowsImported++;
      }
    }
  });

  tx();

  writeAuditLog(
    req.user!.user_id,
    'CSV_IMPORT',
    importType,
    `source=${source}, read=${rowsRead}, imported=${rowsImported}, rejected=${errors.length}`,
  );

  if (rowsImported > 0) {
    liveEventBus.emitUpdate({
      type: importType === 'beds' ? 'beds:updated' : 'queue:updated',
      hospital_id: 0,
      source,
      at: new Date().toISOString(),
    });
  }

  res.json({
    import_type: importType,
    data_source: source,
    rows_read: rowsRead,
    rows_imported: rowsImported,
    rows_rejected: errors.length,
    errors: errors.slice(0, 50),
  });
});

// REQ-ML-09, REQ-ML-11, REQ-ADM-06: Model versions, offline retraining, activation/rollback
adminRouter.get('/models', (_req, res) => {
  const rows = db
    .prepare('SELECT * FROM model_versions ORDER BY trained_at DESC')
    .all() as Array<{
    model_version: string;
    model_type: string;
    training_range: string;
    metrics: string;
    data_provenance: string;
    status: string;
    trained_at: string;
  }>;

  res.json({
    models: rows.map((r) => ({
      ...r,
      trained_at_ist: formatUtcAsIST(r.trained_at),
      metrics: JSON.parse(r.metrics) as ModelMetricsSummary,
    })),
  });
});

adminRouter.post('/models/retrain', async (req: AuthenticatedRequest, res) => {
  const countRow = db.prepare('SELECT COUNT(*) AS cnt FROM model_versions').get() as { cnt: number };
  const newVersion = `v1.${countRow.cnt}.0`;

  try {
    const { waitingSamples, bedSamples, dataProvenance } = buildTrainingDatasetFromDb();
    const result = await predictionService.retrainOffline({
      modelVersion: newVersion,
      dataProvenance,
      waitingSamples,
      bedSamples,
    });

    const autoActivate = Boolean(req.body?.auto_activate);
    let finalStatus: 'active' | 'candidate' = 'candidate';

    if (autoActivate) {
      db.prepare("UPDATE model_versions SET status = 'archived' WHERE status = 'active'").run();
      finalStatus = 'active';
      await predictionService.loadModel(result.model_version);
    }

    db.prepare(
      `INSERT INTO model_versions
       (model_version, model_type, training_range, metrics, data_provenance, status, trained_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      result.model_version,
      result.model_type,
      result.training_range,
      JSON.stringify(result.metrics),
      result.data_provenance,
      finalStatus,
      result.trained_at,
    );

    writeAuditLog(
      req.user!.user_id,
      'RETRAIN_MODEL',
      `model:${result.model_version}`,
      `type=${result.model_type}, status=${finalStatus}, beats_baseline=${result.metrics.beats_baseline}`,
    );

    res.status(201).json({
      ...result,
      status: finalStatus,
      trained_at_ist: formatUtcAsIST(result.trained_at),
    });
  } catch (err) {
    // REQ-ML-11: Failed retraining must never replace active model
    const errMsg = err instanceof Error ? err.message : 'Model retraining failed.';
    writeAuditLog(req.user!.user_id, 'RETRAIN_FAILED', `model:${newVersion}`, errMsg);
    res.status(500).json({
      code: 'RETRAIN_FAILED',
      message: `Retraining failed (${errMsg}). The currently active model remains unchanged.`,
      details: errMsg,
    });
  }
});

adminRouter.post('/models/:version/activate', async (req: AuthenticatedRequest, res) => {
  const version = req.params.version;
  const row = db
    .prepare('SELECT model_version, status FROM model_versions WHERE model_version = ?')
    .get(version) as { model_version: string; status: string } | undefined;

  if (!row) {
    res.status(404).json({ code: 'MODEL_NOT_FOUND', message: 'Model version not found.', details: null });
    return;
  }

  try {
    await predictionService.loadModel(version);
    const tx = db.transaction(() => {
      db.prepare("UPDATE model_versions SET status = 'archived' WHERE status = 'active'").run();
      db.prepare("UPDATE model_versions SET status = 'active' WHERE model_version = ?").run(version);
      writeAuditLog(req.user!.user_id, 'ACTIVATE_MODEL', `model:${version}`);
    });
    tx();
    res.json({ model_version: version, status: 'active' });
  } catch (err) {
    res.status(500).json({
      code: 'MODEL_ACTIVATION_FAILED',
      message: err instanceof Error ? err.message : 'Could not load model artifact.',
      details: null,
    });
  }
});

// REQ-ACC-08: Manage user accounts (suspend / reactivate)
adminRouter.get('/users', (_req, res) => {
  const users = db
    .prepare(
      `SELECT u.user_id, u.name, u.email, u.role, u.status, u.created_at,
         (SELECT COUNT(*) FROM crowd_updates c WHERE c.user_id = u.user_id) AS submission_count
       FROM users u
       ORDER BY u.created_at DESC`,
    )
    .all() as Array<{
    user_id: number;
    name: string;
    email: string;
    role: string;
    status: string;
    created_at: string;
    submission_count: number;
  }>;

  res.json({
    users: users.map((u) => ({
      ...u,
      created_at_ist: formatUtcAsIST(u.created_at),
    })),
  });
});

adminRouter.patch('/users/:id/status', (req: AuthenticatedRequest, res) => {
  const targetId = Number.parseInt(req.params.id, 10);
  const { status } = req.body ?? {};
  if (!Number.isFinite(targetId) || !['active', 'suspended'].includes(status)) {
    res.status(400).json({
      code: 'INVALID_STATUS',
      message: 'Status must be "active" or "suspended".',
      details: null,
    });
    return;
  }

  if (targetId === req.user!.user_id) {
    res.status(400).json({
      code: 'SELF_SUSPEND_BLOCKED',
      message: 'You cannot suspend your own administrator account.',
      details: null,
    });
    return;
  }

  const user = db.prepare('SELECT user_id, email FROM users WHERE user_id = ?').get(targetId) as
    | { user_id: number; email: string }
    | undefined;
  if (!user) {
    res.status(404).json({ code: 'USER_NOT_FOUND', message: 'User not found.', details: null });
    return;
  }

  db.prepare('UPDATE users SET status = ? WHERE user_id = ?').run(status, targetId);
  writeAuditLog(
    req.user!.user_id,
    status === 'suspended' ? 'SUSPEND_USER' : 'REACTIVATE_USER',
    `user:${targetId}`,
    user.email,
  );

  res.json({ user_id: targetId, status });
});

// REQ-ADM-07: Audit logs
adminRouter.get('/audit', (_req, res) => {
  const logs = db
    .prepare(
      `SELECT a.log_id, a.admin_id, a.action, a.target, a.details, a.created_at, u.name AS admin_name
       FROM audit_logs a
       LEFT JOIN users u ON u.user_id = a.admin_id
       ORDER BY a.created_at DESC
       LIMIT 150`,
    )
    .all() as Array<{
    log_id: number;
    admin_id: number | null;
    action: string;
    target: string;
    details: string | null;
    created_at: string;
    admin_name: string | null;
  }>;

  res.json({
    logs: logs.map((l) => ({
      ...l,
      admin_name: l.admin_name || 'System',
      created_at_ist: formatUtcAsIST(l.created_at),
    })),
  });
});

// Download CSV import templates populated with active hospital/department IDs
adminRouter.get('/csv-template/:type', (req, res) => {
  const importType = req.params.type;
  const nowIso = new Date().toISOString();

  if (importType === 'waiting_time') {
    const depts = db
      .prepare(
        `SELECT d.department_id, h.name AS hospital_name, d.name AS dept_name
         FROM departments d JOIN hospitals h ON h.hospital_id = d.hospital_id
         WHERE d.is_active = 1 AND h.is_active = 1
         ORDER BY h.hospital_id ASC, d.department_id ASC LIMIT 5`,
      )
      .all() as Array<{ department_id: number; hospital_name: string; dept_name: string }>;
    const rows = depts.map((d) => `${d.department_id},${nowIso},24`);
    const csv = ['department_id,record_time,avg_waiting_minutes', ...rows].join('\n');
    res.json({ filename: 'waiting_time_template.csv', csv });
    return;
  }

  if (importType === 'opd_queue') {
    const depts = db
      .prepare(
        `SELECT d.department_id
         FROM departments d JOIN hospitals h ON h.hospital_id = d.hospital_id
         WHERE d.is_active = 1 AND h.is_active = 1
         ORDER BY h.hospital_id ASC, d.department_id ASC LIMIT 5`,
      )
      .all() as Array<{ department_id: number }>;
    const rows = depts.map((d) => `${d.department_id},${nowIso},18,Medium`);
    const csv = ['department_id,record_time,queue_size,queue_level', ...rows].join('\n');
    res.json({ filename: 'opd_queue_template.csv', csv });
    return;
  }

  if (importType === 'beds') {
    const hosps = db
      .prepare('SELECT hospital_id FROM hospitals WHERE is_active = 1 ORDER BY hospital_id ASC LIMIT 5')
      .all() as Array<{ hospital_id: number }>;
    const rows = hosps.map((h) => `${h.hospital_id},General Ward,150,42,${nowIso}`);
    const csv = ['hospital_id,ward_type,total_beds,available_beds,record_time', ...rows].join('\n');
    res.json({ filename: 'beds_template.csv', csv });
    return;
  }

  res.status(400).json({
    code: 'INVALID_IMPORT_TYPE',
    message: 'Template type must be waiting_time, opd_queue, or beds.',
    details: null,
  });
});

// Live Hospital HMS API & Public Health Feed Connections
adminRouter.get('/feeds', (_req, res) => {
  const feeds = db
    .prepare(
      `SELECT f.feed_id, f.hospital_id, f.provider_name, f.connector_type, f.data_source,
              f.endpoint_url, f.auth_header_name, f.auth_env_var, f.token_preview,
              f.poll_interval_minutes, f.is_enabled, f.last_sync_at, f.last_sync_status,
              f.last_sync_message, f.records_ingested, f.created_at,
              h.name AS hospital_name, h.city
       FROM hospital_feed_connections f
       JOIN hospitals h ON h.hospital_id = f.hospital_id
       ORDER BY f.created_at DESC`,
    )
    .all() as Array<
    Omit<FeedConnectionRow, 'auth_token_hash'> & { hospital_name: string; city: string }
  >;

  const logs = db
    .prepare(
      `SELECT l.*, f.provider_name, h.name AS hospital_name
       FROM feed_sync_logs l
       JOIN hospital_feed_connections f ON f.feed_id = l.feed_id
       JOIN hospitals h ON h.hospital_id = f.hospital_id
       ORDER BY l.created_at DESC
       LIMIT 40`,
    )
    .all() as Array<{
    sync_id: number;
    feed_id: number;
    trigger_mode: string;
    status: string;
    records_ingested: number;
    records_rejected: number;
    message: string;
    created_at: string;
    provider_name: string;
    hospital_name: string;
  }>;

  res.json({
    feeds: feeds.map((f) => ({
      ...f,
      is_enabled: Boolean(f.is_enabled),
      last_sync_at_ist: f.last_sync_at ? formatUtcAsIST(f.last_sync_at) : null,
      created_at_ist: formatUtcAsIST(f.created_at),
      ingest_path: f.connector_type === 'hms_webhook' ? `/api/feeds/ingest/${f.feed_id}` : null,
    })),
    logs: logs.map((l) => ({
      ...l,
      created_at_ist: formatUtcAsIST(l.created_at),
    })),
  });
});

adminRouter.post('/feeds', async (req: AuthenticatedRequest, res) => {
  const {
    hospital_id,
    provider_name,
    connector_type,
    data_source,
    endpoint_url,
    auth_header_name,
    auth_env_var,
    poll_interval_minutes,
  } = req.body ?? {};

  const hid = Number(hospital_id);
  const cType = connector_type as ConnectorType;
  const source: 'real' | 'public' = data_source === 'public' ? 'public' : 'real';
  const interval = Math.min(1440, Math.max(5, Number.parseInt(String(poll_interval_minutes || '15'), 10) || 15));

  if (
    !Number.isInteger(hid) ||
    typeof provider_name !== 'string' ||
    provider_name.trim().length < 2 ||
    !['hms_webhook', 'json_pull', 'public_health_api'].includes(cType)
  ) {
    res.status(400).json({
      code: 'INVALID_FEED_INPUT',
      message: 'Please provide a valid hospital, provider name, and connector type.',
      details: null,
    });
    return;
  }

  const hosp = db.prepare('SELECT hospital_id, name FROM hospitals WHERE hospital_id = ?').get(hid) as
    | { hospital_id: number; name: string }
    | undefined;
  if (!hosp) {
    res.status(404).json({ code: 'HOSPITAL_NOT_FOUND', message: 'Hospital not found.', details: null });
    return;
  }

  let cleanUrl: string | null = null;
  if (cType === 'json_pull' || cType === 'public_health_api') {
    if (typeof endpoint_url !== 'string' || !endpoint_url.trim()) {
      res.status(400).json({
        code: 'ENDPOINT_URL_REQUIRED',
        message: 'Pull and public health API connectors require a valid HTTPS endpoint URL.',
        details: null,
      });
      return;
    }
    try {
      const parsed = await validateExternalFeedUrl(endpoint_url);
      cleanUrl = parsed.toString();
    } catch (err) {
      res.status(422).json({
        code: 'INVALID_ENDPOINT_URL',
        message: err instanceof Error ? err.message : 'Invalid external feed URL.',
        details: null,
      });
      return;
    }
  }

  const cleanHeader =
    typeof auth_header_name === 'string' && auth_header_name.trim()
      ? auth_header_name.trim().slice(0, 64)
      : null;
  const cleanEnvVar =
    typeof auth_env_var === 'string' && /^[A-Z0-9_]{2,64}$/.test(auth_env_var.trim())
      ? auth_env_var.trim()
      : null;

  let generatedToken: string | null = null;
  let tokenHash: string | null = null;
  let tokenPreview: string | null = null;

  if (cType === 'hms_webhook') {
    const tok = generateFeedToken();
    generatedToken = tok.token;
    tokenHash = tok.hash;
    tokenPreview = tok.preview;
  }

  const now = new Date().toISOString();
  const insertRes = db
    .prepare(
      `INSERT INTO hospital_feed_connections
       (hospital_id, provider_name, connector_type, data_source, endpoint_url, auth_header_name, auth_env_var,
        auth_token_hash, token_preview, poll_interval_minutes, is_enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    )
    .run(
      hid,
      provider_name.trim(),
      cType,
      source,
      cleanUrl,
      cleanHeader,
      cleanEnvVar,
      tokenHash,
      tokenPreview,
      interval,
      now,
    );

  const feedId = Number(insertRes.lastInsertRowid);
  writeAuditLog(
    req.user!.user_id,
    'CREATE_FEED_CONNECTION',
    `feed:${feedId}`,
    `${hosp.name} (${cType}, ${source})`,
  );

  res.status(201).json({
    feed_id: feedId,
    hospital_id: hid,
    provider_name: provider_name.trim(),
    connector_type: cType,
    data_source: source,
    ingest_path: cType === 'hms_webhook' ? `/api/feeds/ingest/${feedId}` : null,
    one_time_token: generatedToken,
    token_preview: tokenPreview,
  });
});

adminRouter.post('/feeds/:id/rotate-key', (req: AuthenticatedRequest, res) => {
  const feedId = Number.parseInt(req.params.id, 10);
  const feed = db
    .prepare('SELECT feed_id, connector_type FROM hospital_feed_connections WHERE feed_id = ?')
    .get(feedId) as { feed_id: number; connector_type: ConnectorType } | undefined;

  if (!feed || feed.connector_type !== 'hms_webhook') {
    res.status(404).json({ code: 'FEED_NOT_FOUND', message: 'Webhook feed connection not found.', details: null });
    return;
  }

  const tok = generateFeedToken();
  db.prepare('UPDATE hospital_feed_connections SET auth_token_hash = ?, token_preview = ? WHERE feed_id = ?').run(
    tok.hash,
    tok.preview,
    feedId,
  );
  writeAuditLog(req.user!.user_id, 'ROTATE_FEED_KEY', `feed:${feedId}`);

  res.json({
    feed_id: feedId,
    one_time_token: tok.token,
    token_preview: tok.preview,
  });
});

adminRouter.patch('/feeds/:id', (req: AuthenticatedRequest, res) => {
  const feedId = Number.parseInt(req.params.id, 10);
  const existing = db
    .prepare('SELECT feed_id, is_enabled, poll_interval_minutes FROM hospital_feed_connections WHERE feed_id = ?')
    .get(feedId) as { feed_id: number; is_enabled: number; poll_interval_minutes: number } | undefined;

  if (!existing) {
    res.status(404).json({ code: 'FEED_NOT_FOUND', message: 'Feed connection not found.', details: null });
    return;
  }

  const nextEnabled =
    typeof req.body?.is_enabled === 'boolean' ? (req.body.is_enabled ? 1 : 0) : existing.is_enabled;
  const nextInterval =
    req.body?.poll_interval_minutes !== undefined
      ? Math.min(1440, Math.max(5, Number.parseInt(String(req.body.poll_interval_minutes), 10) || 15))
      : existing.poll_interval_minutes;

  db.prepare('UPDATE hospital_feed_connections SET is_enabled = ?, poll_interval_minutes = ? WHERE feed_id = ?').run(
    nextEnabled,
    nextInterval,
    feedId,
  );
  writeAuditLog(
    req.user!.user_id,
    'UPDATE_FEED_CONNECTION',
    `feed:${feedId}`,
    `enabled=${Boolean(nextEnabled)}, interval=${nextInterval}m`,
  );

  res.json({ feed_id: feedId, is_enabled: Boolean(nextEnabled), poll_interval_minutes: nextInterval });
});

adminRouter.post('/feeds/:id/sync', async (req: AuthenticatedRequest, res) => {
  const feedId = Number.parseInt(req.params.id, 10);
  try {
    const result = await syncOutboundFeed(feedId, 'manual');
    writeAuditLog(
      req.user!.user_id,
      'MANUAL_FEED_SYNC',
      `feed:${feedId}`,
      `status=${result.status}, ingested=${result.records_ingested}`,
    );
    res.json(result);
  } catch (err) {
    res.status(400).json({
      code: 'FEED_SYNC_FAILED',
      message: err instanceof Error ? err.message : 'Unable to sync feed.',
      details: null,
    });
  }
});

adminRouter.delete('/feeds/:id', (req: AuthenticatedRequest, res) => {
  const feedId = Number.parseInt(req.params.id, 10);
  const existing = db
    .prepare('SELECT feed_id, provider_name FROM hospital_feed_connections WHERE feed_id = ?')
    .get(feedId) as { feed_id: number; provider_name: string } | undefined;

  if (!existing) {
    res.status(404).json({ code: 'FEED_NOT_FOUND', message: 'Feed connection not found.', details: null });
    return;
  }

  db.prepare('DELETE FROM hospital_feed_connections WHERE feed_id = ?').run(feedId);
  writeAuditLog(req.user!.user_id, 'DELETE_FEED_CONNECTION', `feed:${feedId}`, existing.provider_name);
  res.json({ deleted: true, feed_id: feedId });
});

