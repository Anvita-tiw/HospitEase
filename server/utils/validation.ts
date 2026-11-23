import {
  SRS_DEFAULTS,
  type BedStatus,
  type ConfidenceLevel,
  type CrowdUpdateRow,
  type QueueLevel,
  type RecentUpdateAggregate,
} from '../types.ts';

export function validateEmail(email: string): boolean {
  const trimmed = email.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmed) && trimmed.length <= 254;
}

export function validatePasswordStrength(password: string): { valid: boolean; message?: string } {
  if (typeof password !== 'string' || password.length < 8) {
    return { valid: false, message: 'Password must be at least 8 characters long.' };
  }
  if (!/[a-zA-Z]/.test(password)) {
    return { valid: false, message: 'Password must include at least one letter.' };
  }
  if (!/[0-9]/.test(password)) {
    return { valid: false, message: 'Password must include at least one digit.' };
  }
  return { valid: true };
}

export function sanitizeSearchInput(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 100);
}

export function deriveQueueLevel(minutes: number): QueueLevel {
  if (minutes < SRS_DEFAULTS.LOW_WAIT_MAX) return 'Low';
  if (minutes <= SRS_DEFAULTS.MEDIUM_WAIT_MAX) return 'Medium';
  return 'High';
}

export function formatWaitRange(estimateMinutes: number, marginMinutes: number): {
  estimate: number;
  rangeLow: number;
  rangeHigh: number;
} {
  const safeEstimate = Math.max(0, Math.min(SRS_DEFAULTS.MAX_WAIT_MINUTES, Math.round(estimateMinutes)));
  const safeMargin = Math.max(5, marginMinutes);

  let low = Math.floor(Math.max(0, safeEstimate - safeMargin) / 5) * 5;
  let high = Math.ceil(Math.min(SRS_DEFAULTS.MAX_WAIT_MINUTES, safeEstimate + safeMargin) / 5) * 5;

  if (high - low < 10) {
    high = Math.min(SRS_DEFAULTS.MAX_WAIT_MINUTES, low + 10);
    if (high - low < 10) {
      low = Math.max(0, high - 10);
    }
  }

  return {
    estimate: safeEstimate,
    rangeLow: low,
    rangeHigh: high,
  };
}

/**
 * REQ-EST-03: w = 0.5^(age / h), half-life h = 30 min (TBD-6)
 */
export function computeRecencyWeight(
  ageMinutes: number,
  halfLifeMinutes: number = SRS_DEFAULTS.RECENCY_HALF_LIFE_MINUTES,
): number {
  const clampedAge = Math.max(0, ageMinutes);
  return Math.pow(0.5, clampedAge / halfLifeMinutes);
}

/**
 * TBD-7 Confidence Rule:
 * High: >= 5 reports and latest <= 30 min
 * Medium: 2-4 reports or latest <= 90 min
 * Else: Low
 */
export function deriveConfidence(reportCount: number, latestAgeMinutes: number | null): ConfidenceLevel {
  if (reportCount === 0 || latestAgeMinutes === null) return 'Low';
  if (reportCount >= 5 && latestAgeMinutes <= 30) return 'High';
  if (reportCount >= 2 || latestAgeMinutes <= 90) return 'Medium';
  return 'Low';
}

export function aggregateRecentUpdates(
  updates: Pick<CrowdUpdateRow, 'waiting_minutes' | 'submitted_at' | 'validation_status'>[],
  nowUtc: Date = new Date(),
): RecentUpdateAggregate {
  const nowMs = nowUtc.getTime();
  const maxAgeMs = SRS_DEFAULTS.RECENT_WINDOW_MINUTES * 60 * 1000;

  const eligible = updates
    .filter((u) => u.validation_status === 'Accepted' || u.validation_status === 'Approved')
    .map((u) => {
      const submittedMs = new Date(u.submitted_at).getTime();
      const ageMs = nowMs - submittedMs;
      return {
        wait: u.waiting_minutes,
        submittedAt: u.submitted_at,
        ageMinutes: ageMs / 60000,
      };
    })
    .filter((u) => u.ageMinutes >= -5 && u.ageMinutes * 60000 <= maxAgeMs)
    .sort((a, b) => a.ageMinutes - b.ageMinutes);

  if (eligible.length === 0) {
    return {
      weightedMeanWait: null,
      reportCount: 0,
      latestSubmittedAt: null,
      latestAgeMinutes: null,
      confidence: 'Low',
      recentCrowdStatus: null,
    };
  }

  let weightSum = 0;
  let weightedTotal = 0;
  for (const item of eligible) {
    const w = computeRecencyWeight(item.ageMinutes);
    weightSum += w;
    weightedTotal += w * item.wait;
  }

  const weightedMean = weightSum > 0 ? weightedTotal / weightSum : eligible[0].wait;
  const latest = eligible[0];

  return {
    weightedMeanWait: Math.round(weightedMean * 10) / 10,
    reportCount: eligible.length,
    latestSubmittedAt: latest.submittedAt,
    latestAgeMinutes: Math.max(0, Math.round(latest.ageMinutes)),
    confidence: deriveConfidence(eligible.length, Math.max(0, latest.ageMinutes)),
    recentCrowdStatus: deriveQueueLevel(weightedMean),
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * TBD-5 Outlier Rule:
 * - If >= 3 recent valid reports: > 3 MAD from recent median (with floor tolerance of 15 min when MAD is small)
 * - If < 3 recent valid reports: > 2 SD from historical mean (with floor SD of 10 min)
 */
export function checkOutlierRule(
  submittedMinutes: number,
  recentWaits: number[],
  historicalMean: number | null,
  historicalSd: number | null,
): { isOutlier: boolean; reason: string | null } {
  if (recentWaits.length >= 3) {
    const med = median(recentWaits);
    const absDevs = recentWaits.map((v) => Math.abs(v - med));
    const mad = median(absDevs);
    const threshold = Math.max(15, 3 * mad);
    const diff = Math.abs(submittedMinutes - med);
    if (diff > threshold) {
      return {
        isOutlier: true,
        reason: `Submitted wait (${submittedMinutes} min) differs by ${Math.round(diff)} min from recent median (${Math.round(med)} min), exceeding 3×MAD threshold (${Math.round(threshold)} min).`,
      };
    }
    return { isOutlier: false, reason: null };
  }

  if (historicalMean !== null) {
    const effectiveSd = Math.max(10, historicalSd ?? 15);
    const threshold = 2 * effectiveSd;
    const diff = Math.abs(submittedMinutes - historicalMean);
    if (diff > threshold) {
      return {
        isOutlier: true,
        reason: `Submitted wait (${submittedMinutes} min) differs by ${Math.round(diff)} min from historical mean (${Math.round(historicalMean)} min), exceeding 2×SD threshold (${Math.round(threshold)} min).`,
      };
    }
  }

  return { isOutlier: false, reason: null };
}

/**
 * REQ-BED-03 & TBD-8:
 * Available >= 30%, Limited Availability 10%-30%, Likely Unavailable < 10%
 */
export function deriveBedStatus(availableBeds: number, totalBeds: number): BedStatus {
  if (totalBeds <= 0) return 'Likely Unavailable';
  const ratio = availableBeds / totalBeds;
  if (ratio >= SRS_DEFAULTS.BED_AVAILABLE_RATIO) return 'Available';
  if (ratio >= SRS_DEFAULTS.BED_LIMITED_RATIO) return 'Limited Availability';
  return 'Likely Unavailable';
}

export function isBedRecordOutdated(recordTimeIso: string, nowUtc: Date = new Date()): boolean {
  const recMs = new Date(recordTimeIso).getTime();
  if (Number.isNaN(recMs)) return true;
  const ageHours = (nowUtc.getTime() - recMs) / (1000 * 60 * 60);
  return ageHours > SRS_DEFAULTS.BED_STALENESS_HOURS;
}
