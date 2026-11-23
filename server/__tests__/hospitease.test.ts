import { describe, expect, it } from 'vitest';
import {
  aggregateRecentUpdates,
  checkOutlierRule,
  computeRecencyWeight,
  deriveBedStatus,
  deriveConfidence,
  deriveQueueLevel,
  formatWaitRange,
  isBedRecordOutdated,
  validateEmail,
  validatePasswordStrength,
} from '../utils/validation.ts';
import { evaluateOpdStatus, toISTParts } from '../utils/time.ts';
import {
  inferBedStatus,
  inferWaitTime,
  trainAndEvaluateModels,
  type BedTrainingSample,
  type WaitingTrainingSample,
} from '../ml/models.ts';
import {
  generateFeedToken,
  validateExternalFeedUrl,
  verifyFeedToken,
} from '../services/feedService.ts';

describe('SRS Validation & Weighting Rules', () => {
  it('validates email and password strength (REQ-ACC-01, REQ-ACC-02)', () => {
    expect(validateEmail('patient@hospitease.in')).toBe(true);
    expect(validateEmail('invalid-email')).toBe(false);

    expect(validatePasswordStrength('Short1').valid).toBe(false);
    expect(validatePasswordStrength('onlyletters').valid).toBe(false);
    expect(validatePasswordStrength('12345678').valid).toBe(false);
    expect(validatePasswordStrength('Patient123').valid).toBe(true);
  });

  it('derives queue levels and formats ranges rounded to 5 min with min width 10 min (REQ-EST-04, REQ-EST-05)', () => {
    expect(deriveQueueLevel(19)).toBe('Low');
    expect(deriveQueueLevel(20)).toBe('Medium');
    expect(deriveQueueLevel(45)).toBe('Medium');
    expect(deriveQueueLevel(46)).toBe('High');

    const r1 = formatWaitRange(12, 6);
    expect(r1.rangeLow).toBeGreaterThanOrEqual(0);
    expect(r1.rangeLow % 5).toBe(0);
    expect(r1.rangeHigh % 5).toBe(0);
    expect(r1.rangeHigh - r1.rangeLow).toBeGreaterThanOrEqual(10);

    const r2 = formatWaitRange(2, 3);
    expect(r2.rangeLow).toBe(0);
    expect(r2.rangeHigh).toBe(10);
  });

  it('computes exponential decay recency weight with 30 min half-life and excludes > 2h (REQ-EST-02, REQ-EST-03)', () => {
    expect(computeRecencyWeight(0, 30)).toBeCloseTo(1.0, 5);
    expect(computeRecencyWeight(30, 30)).toBeCloseTo(0.5, 5);
    expect(computeRecencyWeight(60, 30)).toBeCloseTo(0.25, 5);

    const now = new Date('2026-11-20T12:00:00.000Z');
    const agg = aggregateRecentUpdates(
      [
        { waiting_minutes: 60, submitted_at: '2026-11-20T11:50:00.000Z', validation_status: 'Accepted' }, // 10 min ago
        { waiting_minutes: 20, submitted_at: '2026-11-20T11:00:00.000Z', validation_status: 'Approved' }, // 60 min ago
        { waiting_minutes: 120, submitted_at: '2026-11-20T09:00:00.000Z', validation_status: 'Accepted' }, // 3h ago -> excluded
        { waiting_minutes: 200, submitted_at: '2026-11-20T11:55:00.000Z', validation_status: 'Flagged' }, // flagged -> excluded
      ],
      now,
    );

    expect(agg.reportCount).toBe(2);
    expect(agg.weightedMeanWait).toBeGreaterThan(45); // newer 60 min report weighs much more than 20 min report
    expect(agg.confidence).toBe('Medium');
    expect(deriveConfidence(5, 15)).toBe('High');
    expect(deriveConfidence(1, 100)).toBe('Low');
  });

  it('flags statistical outliers via 3xMAD or 2xSD (REQ-CRW-08, TBD-5)', () => {
    const okRecent = checkOutlierRule(32, [28, 30, 35, 29], 30, 10);
    expect(okRecent.isOutlier).toBe(false);

    const badRecent = checkOutlierRule(140, [28, 30, 35, 29], 30, 10);
    expect(badRecent.isOutlier).toBe(true);

    const badHist = checkOutlierRule(120, [30], 30, 15);
    expect(badHist.isOutlier).toBe(true);
  });

  it('computes bed status thresholds and 24h staleness (REQ-BED-03, REQ-BED-05)', () => {
    expect(deriveBedStatus(30, 100)).toBe('Available');
    expect(deriveBedStatus(15, 100)).toBe('Limited Availability');
    expect(deriveBedStatus(9, 100)).toBe('Likely Unavailable');

    const now = new Date('2026-11-20T12:00:00.000Z');
    expect(isBedRecordOutdated('2026-11-20T06:00:00.000Z', now)).toBe(false);
    expect(isBedRecordOutdated('2026-11-19T06:00:00.000Z', now)).toBe(true);
  });

  it('evaluates OPD open/closed status in IST (REQ-HOS-04, REQ-EST-11)', () => {
    const timings = JSON.stringify({
      label: 'Mon–Sat 09:00–14:00',
      sessions: [{ days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '14:00' }],
    });

    // 2026-11-20 is Friday. 05:30 UTC = 11:00 IST (Open)
    const openTime = new Date('2026-11-20T05:30:00.000Z');
    expect(toISTParts(openTime).hour).toBe(11);
    expect(evaluateOpdStatus(timings, openTime).isOpenNow).toBe(true);

    // 10:30 UTC = 16:00 IST (Closed)
    const closedTime = new Date('2026-11-20T10:30:00.000Z');
    const closedRes = evaluateOpdStatus(timings, closedTime);
    expect(closedRes.isOpenNow).toBe(false);
    expect(closedRes.nextOpeningText).toContain('Tomorrow at 9:00 AM IST');
  });
});

describe('ML Pipeline Training & Inference', () => {
  it('trains candidate models on chronological split, beats baseline, and produces wait + bed predictions', () => {
    const waitSamples: WaitingTrainingSample[] = [];
    const bedSamples: BedTrainingSample[] = [];
    const baseMs = new Date('2026-08-01T04:30:00.000Z').getTime();

    for (let day = 0; day < 92; day++) {
      for (const hourOff of [0, 2, 8]) {
        const ts = new Date(baseMs + day * 86400_000 + hourOff * 3600_000).toISOString();
        const ist = toISTParts(ts);
        const basePattern = ist.dayOfWeek === 1 ? 52 : ist.timeSlot === 'midday' ? 38 : 22;
        const surge = (day % 4 === 0 ? 16 : -4); // Sudden daily surge/lull that static historical average misses
        const actualWait = basePattern + surge + (day % 3);
        const prevWait = actualWait - 2;
        waitSamples.push({
          hospital_id: 1,
          department_id: 1,
          department_name: 'General Medicine',
          record_time: ts,
          waiting_minutes: actualWait,
          queue_size: Math.round(actualWait * 0.7),
          prev_queue_size: Math.round(prevWait * 0.7),
          prev_waiting_minutes: prevWait,
          recent_weighted_wait: actualWait - 1,
          recent_count: 2,
          recent_latest_age_min: 20,
        });
      }

      const bedTs = new Date(baseMs + day * 86400_000).toISOString();
      const avail = day % 3 === 0 ? 45 : day % 3 === 1 ? 18 : 5;
      bedSamples.push({
        hospital_id: 1,
        ward_type: 'General Ward',
        record_time: bedTs,
        total_beds: 100,
        available_beds: avail,
        prev_available_ratio: avail / 100,
      });
    }

    const artifact = trainAndEvaluateModels(waitSamples, bedSamples, 'v-test', 'synthetic');
    expect(artifact.metrics.candidates.length).toBe(4);
    expect(artifact.metrics.beats_baseline).toBe(true);
    expect(artifact.metrics.bed_classifier).not.toBeNull();
    expect(artifact.metrics.bed_classifier!.confusion_matrix.length).toBe(3);

    const pred = inferWaitTime(artifact, {
      hospitalId: 1,
      departmentId: 1,
      departmentName: 'General Medicine',
      timestampIso: new Date(baseMs + 95 * 86400_000).toISOString(),
      prevQueueSize: 24,
      prevWaitingMinutes: 35,
      recentAggregate: {
        weightedMeanWait: 38,
        reportCount: 3,
        latestSubmittedAt: new Date(baseMs + 95 * 86400_000 - 15 * 60_000).toISOString(),
        latestAgeMinutes: 15,
        confidence: 'Medium',
        recentCrowdStatus: 'Medium',
      },
    });
    expect(pred.rangeHigh - pred.rangeLow).toBeGreaterThanOrEqual(10);
    expect(['Low', 'Medium', 'High']).toContain(pred.queueLevel);

    const bedPred = inferBedStatus(artifact, {
      hospitalId: 1,
      wardType: 'General Ward',
      timestampIso: new Date(baseMs + 95 * 86400_000).toISOString(),
      totalBeds: 100,
      availableBeds: 45,
    });
    expect(bedPred.basis).toBe('Predicted');
    expect(['Available', 'Limited Availability', 'Likely Unavailable']).toContain(bedPred.status);
  });
});

describe('Live HMS Feed Security & Validation', () => {
  it('generates high-entropy feed tokens and verifies hashes in constant time', () => {
    const generated = generateFeedToken();
    expect(generated.token.startsWith('hef_')).toBe(true);
    expect(generated.hash).toHaveLength(64);
    expect(verifyFeedToken(generated.token, generated.hash)).toBe(true);
    expect(verifyFeedToken(`${generated.token}_tampered`, generated.hash)).toBe(false);
    expect(verifyFeedToken(generated.token, null)).toBe(false);
  });

  it('blocks insecure protocols, embedded credentials, loopback, and private/metadata IPs (SSRF)', async () => {
    await expect(validateExternalFeedUrl('http://hospital.example.org/feed.json')).rejects.toThrow(
      /HTTPS/i,
    );
    await expect(validateExternalFeedUrl('https://user:secret@hospital.example.org/feed.json')).rejects.toThrow(
      /credentials/i,
    );
    await expect(validateExternalFeedUrl('https://localhost/feed.json')).rejects.toThrow(/local/i);
    await expect(validateExternalFeedUrl('https://127.0.0.1/feed.json')).rejects.toThrow(/blocked/i);
    await expect(validateExternalFeedUrl('https://169.254.169.254/latest/meta-data')).rejects.toThrow(
      /blocked/i,
    );
    await expect(validateExternalFeedUrl('https://10.0.0.12/hms')).rejects.toThrow(/blocked/i);
  });
});
