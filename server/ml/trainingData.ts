import { db } from '../db/database.ts';
import type { BedTrainingSample, WaitingTrainingSample } from './models.ts';

export function buildTrainingDatasetFromDb(): {
  waitingSamples: WaitingTrainingSample[];
  bedSamples: BedTrainingSample[];
  dataProvenance: string;
} {
  // Fetch waiting-time records joined with department, hospital, and matching opd_queue_records
  const rows = db
    .prepare(
      `
      SELECT
        d.hospital_id,
        w.department_id,
        d.name AS department_name,
        w.record_time,
        w.avg_waiting_minutes AS waiting_minutes,
        COALESCE(q.queue_size, CAST(ROUND(w.avg_waiting_minutes * 0.75) AS INTEGER)) AS queue_size,
        w.data_source
      FROM waiting_time_records w
      JOIN departments d ON d.department_id = w.department_id
      LEFT JOIN opd_queue_records q
        ON q.department_id = w.department_id AND q.record_time = w.record_time
      ORDER BY w.department_id ASC, w.record_time ASC
      `,
    )
    .all() as Array<{
    hospital_id: number;
    department_id: number;
    department_name: string;
    record_time: string;
    waiting_minutes: number;
    queue_size: number;
    data_source: string;
  }>;

  // REQ-ML-07: Include Accepted/Approved crowd updates; Flagged and Rejected never enter training
  const crowdRows = db
    .prepare(
      `
      SELECT
        c.hospital_id,
        c.department_id,
        d.name AS department_name,
        c.submitted_at AS record_time,
        c.waiting_minutes,
        CAST(ROUND(c.waiting_minutes * 0.75) AS INTEGER) AS queue_size,
        'crowd' AS data_source
      FROM crowd_updates c
      JOIN departments d ON d.department_id = c.department_id
      WHERE c.validation_status IN ('Accepted', 'Approved')
      ORDER BY c.submitted_at ASC
      `,
    )
    .all() as Array<{
    hospital_id: number;
    department_id: number;
    department_name: string;
    record_time: string;
    waiting_minutes: number;
    queue_size: number;
    data_source: string;
  }>;

  const combined = [...rows, ...crowdRows].sort((a, b) => {
    if (a.department_id !== b.department_id) return a.department_id - b.department_id;
    return a.record_time.localeCompare(b.record_time);
  });

  const sources = new Set<string>();
  const waitingSamples: WaitingTrainingSample[] = [];
  let lastDeptId = -1;
  let prevQueue = 10;
  let prevWait = 20;
  let prevTimeMs = 0;

  for (const r of combined) {
    sources.add(r.data_source);
    const currMs = new Date(r.record_time).getTime();
    const isSameDaySlot = r.department_id === lastDeptId && currMs - prevTimeMs <= 4 * 60 * 60 * 1000;

    const effPrevQueue = isSameDaySlot ? prevQueue : r.queue_size;
    const effPrevWait = isSameDaySlot ? prevWait : r.waiting_minutes;
    const recentWait = isSameDaySlot ? Math.round((prevWait * 0.7 + r.waiting_minutes * 0.3) * 10) / 10 : null;

    waitingSamples.push({
      hospital_id: r.hospital_id,
      department_id: r.department_id,
      department_name: r.department_name,
      record_time: r.record_time,
      waiting_minutes: r.waiting_minutes,
      queue_size: r.queue_size,
      prev_queue_size: effPrevQueue,
      prev_waiting_minutes: effPrevWait,
      recent_weighted_wait: recentWait,
      recent_count: isSameDaySlot ? 2 : 0,
      recent_latest_age_min: isSameDaySlot ? 25 : null,
    });

    lastDeptId = r.department_id;
    prevQueue = r.queue_size;
    prevWait = r.waiting_minutes;
    prevTimeMs = currMs;
  }

  // Bed samples
  const bedRows = db
    .prepare(
      `
      SELECT hospital_id, ward_type, total_beds, available_beds, record_time, data_source
      FROM bed_availability_records
      ORDER BY hospital_id ASC, ward_type ASC, record_time ASC
      `,
    )
    .all() as Array<{
    hospital_id: number;
    ward_type: string;
    total_beds: number;
    available_beds: number;
    record_time: string;
    data_source: string;
  }>;

  const bedSamples: BedTrainingSample[] = [];
  let prevKey = '';
  let prevRatio = 0.25;
  for (const b of bedRows) {
    sources.add(b.data_source);
    const key = `${b.hospital_id}:${b.ward_type}`;
    const currRatio = b.total_beds > 0 ? b.available_beds / b.total_beds : 0;
    bedSamples.push({
      hospital_id: b.hospital_id,
      ward_type: b.ward_type,
      record_time: b.record_time,
      total_beds: b.total_beds,
      available_beds: b.available_beds,
      prev_available_ratio: key === prevKey ? prevRatio : currRatio,
    });
    prevKey = key;
    prevRatio = currRatio;
  }

  const provenanceList = Array.from(sources).filter((s) => s !== 'crowd');
  const dataProvenance =
    provenanceList.length === 0
      ? 'synthetic'
      : provenanceList.length === 1
        ? provenanceList[0]
        : provenanceList.join('+');

  return { waitingSamples, bedSamples, dataProvenance };
}
