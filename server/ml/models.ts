import fs from 'node:fs';
import path from 'node:path';
import type {
  BedClassifierMetrics,
  BedStatus,
  ModelComparisonMetric,
  ModelMetricsSummary,
  QueueLevel,
  RecentUpdateAggregate,
} from '../types.ts';
import { toISTParts } from '../utils/time.ts';
import { deriveBedStatus, deriveQueueLevel, formatWaitRange } from '../utils/validation.ts';

// Deterministic PRNG (Mulberry32) for fixed random seed reproducibility (REQ-ML-11)
function createRng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface WaitingTrainingSample {
  hospital_id: number;
  department_id: number;
  department_name: string;
  record_time: string;
  waiting_minutes: number;
  queue_size: number;
  prev_queue_size: number;
  prev_waiting_minutes: number;
  recent_weighted_wait: number | null;
  recent_count: number;
  recent_latest_age_min: number | null;
}

export interface BedTrainingSample {
  hospital_id: number;
  ward_type: string;
  record_time: string;
  total_beds: number;
  available_beds: number;
  prev_available_ratio: number;
}

interface RegressionTreeNode {
  isLeaf: boolean;
  value: number;
  featureIndex?: number;
  threshold?: number;
  left?: RegressionTreeNode;
  right?: RegressionTreeNode;
}

interface ClassificationTreeNode {
  isLeaf: boolean;
  classProbs: number[]; // length 3: [Available, Limited, Likely Unavailable]
  featureIndex?: number;
  threshold?: number;
  left?: ClassificationTreeNode;
  right?: ClassificationTreeNode;
}

export interface HistoricalGroupStats {
  mean: number;
  sd: number;
  count: number;
}

export interface SerializedFeatureSchema {
  hospitalIds: number[];
  departmentNames: string[];
  wardTypes: string[];
  timeSlots: string[];
  numericMeans: number[];
  numericStds: number[];
}

export interface SerializedBaseline {
  globalMean: number;
  globalSd: number;
  byFullKey: Record<string, HistoricalGroupStats>; // hospital_dept_dow_slot
  byHospDeptSlot: Record<string, HistoricalGroupStats>; // hospital_dept_slot
  byDeptNameSlot: Record<string, HistoricalGroupStats>; // deptName_slot
}

export interface SerializedModelArtifact {
  model_version: string;
  model_type: 'Baseline' | 'LinearRegression' | 'RandomForest' | 'GradientBoosting';
  trained_at: string;
  training_range: string;
  data_provenance: string;
  schema: SerializedFeatureSchema;
  baseline: SerializedBaseline;
  linearWeights?: number[];
  forestTrees?: RegressionTreeNode[];
  gbInitialValue?: number;
  gbLearningRate?: number;
  gbTrees?: RegressionTreeNode[];
  bedClassifier?: {
    wardTypes: string[];
    hospitalIds: number[];
    trees: ClassificationTreeNode[];
  } | null;
  metrics: ModelMetricsSummary;
}

const TIME_SLOTS = ['morning', 'midday', 'afternoon', 'evening', 'off_hours'];
const BED_CLASSES: BedStatus[] = ['Available', 'Limited Availability', 'Likely Unavailable'];

function computeMaeRmseR2(yTrue: number[], yPred: number[]): { mae: number; rmse: number; r2: number } {
  if (yTrue.length === 0) return { mae: 0, rmse: 0, r2: 0 };
  let absSum = 0;
  let sqSum = 0;
  let meanTrue = 0;
  for (let i = 0; i < yTrue.length; i++) {
    meanTrue += yTrue[i];
  }
  meanTrue /= yTrue.length;

  let ssTot = 0;
  for (let i = 0; i < yTrue.length; i++) {
    const err = yTrue[i] - yPred[i];
    absSum += Math.abs(err);
    sqSum += err * err;
    const dev = yTrue[i] - meanTrue;
    ssTot += dev * dev;
  }

  const mae = absSum / yTrue.length;
  const rmse = Math.sqrt(sqSum / yTrue.length);
  const r2 = ssTot > 1e-9 ? 1 - sqSum / ssTot : 0;

  return {
    mae: Math.round(mae * 100) / 100,
    rmse: Math.round(rmse * 100) / 100,
    r2: Math.round(r2 * 1000) / 1000,
  };
}

function buildBaseline(samples: WaitingTrainingSample[]): SerializedBaseline {
  const accumFull = new Map<string, number[]>();
  const accumHds = new Map<string, number[]>();
  const accumDns = new Map<string, number[]>();
  const allVals: number[] = [];

  for (const s of samples) {
    const ist = toISTParts(s.record_time);
    const kFull = `${s.hospital_id}:${s.department_id}:${ist.dayOfWeek}:${ist.timeSlot}`;
    const kHds = `${s.hospital_id}:${s.department_id}:${ist.timeSlot}`;
    const kDns = `${s.department_name}:${ist.timeSlot}`;

    if (!accumFull.has(kFull)) accumFull.set(kFull, []);
    accumFull.get(kFull)!.push(s.waiting_minutes);

    if (!accumHds.has(kHds)) accumHds.set(kHds, []);
    accumHds.get(kHds)!.push(s.waiting_minutes);

    if (!accumDns.has(kDns)) accumDns.set(kDns, []);
    accumDns.get(kDns)!.push(s.waiting_minutes);

    allVals.push(s.waiting_minutes);
  }

  const summarize = (arr: number[]): HistoricalGroupStats => {
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const variance =
      arr.length > 1 ? arr.reduce((a, b) => a + (b - mean) ** 2, 0) / (arr.length - 1) : 100;
    return {
      mean: Math.round(mean * 100) / 100,
      sd: Math.round(Math.sqrt(variance) * 100) / 100,
      count: arr.length,
    };
  };

  const globalStats = allVals.length > 0 ? summarize(allVals) : { mean: 25, sd: 12, count: 0 };
  const byFullKey: Record<string, HistoricalGroupStats> = {};
  const byHospDeptSlot: Record<string, HistoricalGroupStats> = {};
  const byDeptNameSlot: Record<string, HistoricalGroupStats> = {};

  for (const [k, v] of accumFull) byFullKey[k] = summarize(v);
  for (const [k, v] of accumHds) byHospDeptSlot[k] = summarize(v);
  for (const [k, v] of accumDns) byDeptNameSlot[k] = summarize(v);

  return {
    globalMean: globalStats.mean,
    globalSd: globalStats.sd,
    byFullKey,
    byHospDeptSlot,
    byDeptNameSlot,
  };
}

export function lookupBaselineStats(
  baseline: SerializedBaseline,
  hospitalId: number,
  departmentId: number,
  departmentName: string,
  timestampIso: string,
): HistoricalGroupStats {
  const ist = toISTParts(timestampIso);
  const kFull = `${hospitalId}:${departmentId}:${ist.dayOfWeek}:${ist.timeSlot}`;
  if (baseline.byFullKey[kFull]) return baseline.byFullKey[kFull];

  const kHds = `${hospitalId}:${departmentId}:${ist.timeSlot}`;
  if (baseline.byHospDeptSlot[kHds]) return baseline.byHospDeptSlot[kHds];

  const kDns = `${departmentName}:${ist.timeSlot}`;
  if (baseline.byDeptNameSlot[kDns]) return baseline.byDeptNameSlot[kDns];

  return { mean: baseline.globalMean, sd: baseline.globalSd, count: 0 };
}

function extractRawNumericAndCat(
  hospitalId: number,
  departmentId: number,
  departmentName: string,
  timestampIso: string,
  prevQueueSize: number,
  prevWaitingMinutes: number,
  recentWeightedWait: number | null,
  recentCount: number,
  recentLatestAgeMin: number | null,
  baseline: SerializedBaseline,
  schema: Pick<SerializedFeatureSchema, 'hospitalIds' | 'departmentNames' | 'timeSlots'>,
): number[] {
  const ist = toISTParts(timestampIso);
  const histStats = lookupBaselineStats(baseline, hospitalId, departmentId, departmentName, timestampIso);

  const hourAngle = (2 * Math.PI * (ist.hour + ist.minute / 60)) / 24;
  const dowAngle = (2 * Math.PI * ist.dayOfWeek) / 7;
  const hasRecent = recentWeightedWait !== null && recentCount > 0 ? 1 : 0;
  const effRecentWait = hasRecent ? recentWeightedWait! : histStats.mean;
  const effRecentAge = hasRecent && recentLatestAgeMin !== null ? Math.min(120, recentLatestAgeMin) : 120;

  // Numeric part (11 features)
  const numeric = [
    histStats.mean,
    Math.sin(hourAngle),
    Math.cos(hourAngle),
    Math.sin(dowAngle),
    Math.cos(dowAngle),
    ist.isWeekend ? 1 : 0,
    ist.isHoliday ? 1 : 0,
    prevQueueSize,
    prevWaitingMinutes,
    hasRecent,
    effRecentWait,
    Math.min(10, recentCount),
    effRecentAge,
  ];

  // One-hot categoricals
  const hospOneHot = schema.hospitalIds.map((id) => (id === hospitalId ? 1 : 0));
  const deptOneHot = schema.departmentNames.map((name) => (name === departmentName ? 1 : 0));
  const slotOneHot = schema.timeSlots.map((slot) => (slot === ist.timeSlot ? 1 : 0));

  return [...numeric, ...hospOneHot, ...deptOneHot, ...slotOneHot];
}

const NUMERIC_FEATURE_COUNT = 13;

function standardizeFeatures(rows: number[][], means: number[], stds: number[]): number[][] {
  return rows.map((row) =>
    row.map((val, j) => {
      if (j < NUMERIC_FEATURE_COUNT) {
        return (val - means[j]) / stds[j];
      }
      return val;
    }),
  );
}

function fitRidgeRegression(X: number[][], y: number[], lambda = 2.0): number[] {
  const n = X.length;
  const d = X[0].length + 1; // +1 for intercept
  // Build (X^T X + lambda I) and X^T y
  const A: number[][] = Array.from({ length: d }, () => Array(d).fill(0));
  const b: number[] = Array(d).fill(0);

  for (let i = 0; i < n; i++) {
    const row = X[i];
    for (let j = 0; j < d; j++) {
      const xj = j === 0 ? 1 : row[j - 1];
      b[j] += xj * y[i];
      for (let k = j; k < d; k++) {
        const xk = k === 0 ? 1 : row[k - 1];
        A[j][k] += xj * xk;
      }
    }
  }
  for (let j = 0; j < d; j++) {
    for (let k = 0; k < j; k++) A[j][k] = A[k][j];
    if (j > 0) A[j][j] += lambda;
  }

  // Gaussian elimination with partial pivoting
  for (let i = 0; i < d; i++) {
    let maxRow = i;
    for (let r = i + 1; r < d; r++) {
      if (Math.abs(A[r][i]) > Math.abs(A[maxRow][i])) maxRow = r;
    }
    [A[i], A[maxRow]] = [A[maxRow], A[i]];
    [b[i], b[maxRow]] = [b[maxRow], b[i]];

    const pivot = Math.abs(A[i][i]) < 1e-10 ? 1e-10 : A[i][i];
    for (let r = i + 1; r < d; r++) {
      const factor = A[r][i] / pivot;
      b[r] -= factor * b[i];
      for (let c = i; c < d; c++) {
        A[r][c] -= factor * A[i][c];
      }
    }
  }

  const w = Array(d).fill(0);
  for (let i = d - 1; i >= 0; i--) {
    let sum = b[i];
    for (let c = i + 1; c < d; c++) sum -= A[i][c] * w[c];
    const denom = Math.abs(A[i][i]) < 1e-10 ? 1e-10 : A[i][i];
    w[i] = sum / denom;
  }
  return w;
}

function predictRidge(weights: number[], x: number[]): number {
  let y = weights[0];
  for (let i = 0; i < x.length; i++) {
    y += weights[i + 1] * x[i];
  }
  return Math.max(0, y);
}

// Fast CART Regression Tree with histogram/quantile candidate thresholds
function buildRegressionTree(
  X: number[][],
  y: number[],
  indices: number[],
  depth: number,
  maxDepth: number,
  minSamplesLeaf: number,
  maxFeatures: number,
  rng: () => number,
): RegressionTreeNode {
  const n = indices.length;
  let sum = 0;
  for (const idx of indices) sum += y[idx];
  const mean = sum / n;

  if (depth >= maxDepth || n < minSamplesLeaf * 2) {
    return { isLeaf: true, value: Math.round(mean * 1000) / 1000 };
  }

  const numFeatures = X[0].length;
  const featureIndices: number[] = [];
  if (maxFeatures >= numFeatures) {
    for (let f = 0; f < numFeatures; f++) featureIndices.push(f);
  } else {
    const pool = Array.from({ length: numFeatures }, (_, i) => i);
    for (let i = 0; i < maxFeatures; i++) {
      const pick = i + Math.floor(rng() * (pool.length - i));
      [pool[i], pool[pick]] = [pool[pick], pool[i]];
      featureIndices.push(pool[i]);
    }
  }

  let bestGain = -Infinity;
  let bestFeature = -1;
  let bestThreshold = 0;

  let totalSum = 0;
  for (const idx of indices) totalSum += y[idx];

  const BINS = 16;
  const binCounts = new Int32Array(BINS);
  const binSums = new Float64Array(BINS);

  for (const f of featureIndices) {
    let minV = Infinity;
    let maxV = -Infinity;
    for (let i = 0; i < n; i++) {
      const val = X[indices[i]][f];
      if (val < minV) minV = val;
      if (val > maxV) maxV = val;
    }
    const span = maxV - minV;
    if (span <= 1e-12) continue;

    binCounts.fill(0);
    binSums.fill(0);
    const invSpan = BINS / span;

    for (let i = 0; i < n; i++) {
      const idx = indices[i];
      let b = Math.floor((X[idx][f] - minV) * invSpan);
      if (b >= BINS) b = BINS - 1;
      binCounts[b]++;
      binSums[b] += y[idx];
    }

    let leftCount = 0;
    let leftSum = 0;
    for (let b = 0; b < BINS - 1; b++) {
      leftCount += binCounts[b];
      leftSum += binSums[b];
      const rightCount = n - leftCount;
      if (leftCount < minSamplesLeaf || rightCount < minSamplesLeaf) continue;

      const rightSum = totalSum - leftSum;
      const gain = (leftSum * leftSum) / leftCount + (rightSum * rightSum) / rightCount;
      if (gain > bestGain) {
        bestGain = gain;
        bestFeature = f;
        bestThreshold = minV + ((b + 1) / BINS) * span;
      }
    }
  }

  if (bestFeature === -1) {
    return { isLeaf: true, value: Math.round(mean * 1000) / 1000 };
  }

  const bestLeft: number[] = [];
  const bestRight: number[] = [];
  for (const idx of indices) {
    if (X[idx][bestFeature] <= bestThreshold) bestLeft.push(idx);
    else bestRight.push(idx);
  }

  return {
    isLeaf: false,
    value: Math.round(mean * 1000) / 1000,
    featureIndex: bestFeature,
    threshold: Math.round(bestThreshold * 10000) / 10000,
    left: buildRegressionTree(X, y, bestLeft, depth + 1, maxDepth, minSamplesLeaf, maxFeatures, rng),
    right: buildRegressionTree(X, y, bestRight, depth + 1, maxDepth, minSamplesLeaf, maxFeatures, rng),
  };
}

function predictRegTree(node: RegressionTreeNode, x: number[]): number {
  let curr = node;
  while (!curr.isLeaf) {
    if (x[curr.featureIndex!] <= curr.threshold!) curr = curr.left!;
    else curr = curr.right!;
  }
  return curr.value;
}

function fitRandomForestRegressor(
  X: number[][],
  y: number[],
  nTrees = 18,
  maxDepth = 7,
  minSamplesLeaf = 5,
  seed = 42,
): RegressionTreeNode[] {
  const rng = createRng(seed);
  const n = X.length;
  const maxFeatures = Math.max(3, Math.floor(Math.sqrt(X[0].length)) + 2);
  const trees: RegressionTreeNode[] = [];

  for (let t = 0; t < nTrees; t++) {
    const sampleIndices: number[] = [];
    for (let i = 0; i < n; i++) {
      sampleIndices.push(Math.floor(rng() * n));
    }
    trees.push(buildRegressionTree(X, y, sampleIndices, 0, maxDepth, minSamplesLeaf, maxFeatures, rng));
  }
  return trees;
}

function predictRandomForest(trees: RegressionTreeNode[], x: number[]): number {
  let sum = 0;
  for (const t of trees) sum += predictRegTree(t, x);
  return Math.max(0, sum / trees.length);
}

function fitGradientBoostingRegressor(
  X: number[][],
  y: number[],
  nEstimators = 28,
  learningRate = 0.12,
  maxDepth = 4,
  minSamplesLeaf = 6,
  seed = 42,
): { initialValue: number; learningRate: number; trees: RegressionTreeNode[] } {
  const rng = createRng(seed + 101);
  const n = X.length;
  const initialValue = y.reduce((a, b) => a + b, 0) / n;
  const preds = Array(n).fill(initialValue);
  const trees: RegressionTreeNode[] = [];
  const allIndices = Array.from({ length: n }, (_, i) => i);
  const numFeatures = X[0].length;

  for (let m = 0; m < nEstimators; m++) {
    const residuals = y.map((yi, i) => yi - preds[i]);
    // Subsample 80% rows for stochastic gradient boosting generalization
    const subIndices = allIndices.filter(() => rng() < 0.8);
    const fitIdx = subIndices.length >= 20 ? subIndices : allIndices;
    const tree = buildRegressionTree(X, residuals, fitIdx, 0, maxDepth, minSamplesLeaf, numFeatures, rng);
    trees.push(tree);
    for (let i = 0; i < n; i++) {
      preds[i] += learningRate * predictRegTree(tree, X[i]);
    }
  }

  return {
    initialValue: Math.round(initialValue * 1000) / 1000,
    learningRate,
    trees,
  };
}

function predictGradientBoosting(
  initialValue: number,
  learningRate: number,
  trees: RegressionTreeNode[],
  x: number[],
): number {
  let pred = initialValue;
  for (const t of trees) {
    pred += learningRate * predictRegTree(t, x);
  }
  return Math.max(0, pred);
}

// =========================================================================
// Bed Availability Random Forest Classifier (REQ-ML-08)
// =========================================================================

function buildClassificationTree(
  X: number[][],
  yClass: number[],
  indices: number[],
  depth: number,
  maxDepth: number,
  minSamplesLeaf: number,
  maxFeatures: number,
  rng: () => number,
): ClassificationTreeNode {
  const n = indices.length;
  const counts = [0, 0, 0];
  for (const idx of indices) counts[yClass[idx]]++;
  const probs = counts.map((c) => Math.round((c / n) * 1000) / 1000);

  const uniqueClasses = counts.filter((c) => c > 0).length;
  if (depth >= maxDepth || n < minSamplesLeaf * 2 || uniqueClasses <= 1) {
    return { isLeaf: true, classProbs: probs };
  }

  const numFeatures = X[0].length;
  const pool = Array.from({ length: numFeatures }, (_, i) => i);
  const featureIndices: number[] = [];
  const kFeat = Math.min(maxFeatures, numFeatures);
  for (let i = 0; i < kFeat; i++) {
    const pick = i + Math.floor(rng() * (pool.length - i));
    [pool[i], pool[pick]] = [pool[pick], pool[i]];
    featureIndices.push(pool[i]);
  }

  let bestGini = Infinity;
  let bestFeature = -1;
  let bestThreshold = 0;

  const BINS = 12;
  const binC0 = new Int32Array(BINS);
  const binC1 = new Int32Array(BINS);
  const binC2 = new Int32Array(BINS);

  for (const f of featureIndices) {
    let minV = Infinity;
    let maxV = -Infinity;
    for (let i = 0; i < n; i++) {
      const val = X[indices[i]][f];
      if (val < minV) minV = val;
      if (val > maxV) maxV = val;
    }
    const span = maxV - minV;
    if (span <= 1e-12) continue;

    binC0.fill(0);
    binC1.fill(0);
    binC2.fill(0);
    const invSpan = BINS / span;

    for (let i = 0; i < n; i++) {
      const idx = indices[i];
      let b = Math.floor((X[idx][f] - minV) * invSpan);
      if (b >= BINS) b = BINS - 1;
      const cls = yClass[idx];
      if (cls === 0) binC0[b]++;
      else if (cls === 1) binC1[b]++;
      else binC2[b]++;
    }

    let l0 = 0;
    let l1 = 0;
    let l2 = 0;
    for (let b = 0; b < BINS - 1; b++) {
      l0 += binC0[b];
      l1 += binC1[b];
      l2 += binC2[b];
      const ln = l0 + l1 + l2;
      const rn = n - ln;
      if (ln < minSamplesLeaf || rn < minSamplesLeaf) continue;

      const r0 = counts[0] - l0;
      const r1 = counts[1] - l1;
      const r2 = counts[2] - l2;
      const giniL = 1 - ((l0 / ln) ** 2 + (l1 / ln) ** 2 + (l2 / ln) ** 2);
      const giniR = 1 - ((r0 / rn) ** 2 + (r1 / rn) ** 2 + (r2 / rn) ** 2);
      const weightedGini = (ln / n) * giniL + (rn / n) * giniR;

      if (weightedGini < bestGini) {
        bestGini = weightedGini;
        bestFeature = f;
        bestThreshold = minV + ((b + 1) / BINS) * span;
      }
    }
  }

  if (bestFeature === -1) {
    return { isLeaf: true, classProbs: probs };
  }

  const leftIdx: number[] = [];
  const rightIdx: number[] = [];
  for (const idx of indices) {
    if (X[idx][bestFeature] <= bestThreshold) leftIdx.push(idx);
    else rightIdx.push(idx);
  }

  return {
    isLeaf: false,
    classProbs: probs,
    featureIndex: bestFeature,
    threshold: Math.round(bestThreshold * 10000) / 10000,
    left: buildClassificationTree(X, yClass, leftIdx, depth + 1, maxDepth, minSamplesLeaf, maxFeatures, rng),
    right: buildClassificationTree(X, yClass, rightIdx, depth + 1, maxDepth, minSamplesLeaf, maxFeatures, rng),
  };
}

function predictClassTree(node: ClassificationTreeNode, x: number[]): number[] {
  let curr = node;
  while (!curr.isLeaf) {
    if (x[curr.featureIndex!] <= curr.threshold!) curr = curr.left!;
    else curr = curr.right!;
  }
  return curr.classProbs;
}

function extractBedFeatureVector(
  hospitalId: number,
  wardType: string,
  timestampIso: string,
  prevAvailableRatio: number,
  hospitalIds: number[],
  wardTypes: string[],
): number[] {
  const ist = toISTParts(timestampIso);
  const hourAngle = (2 * Math.PI * ist.hour) / 24;
  return [
    prevAvailableRatio,
    Math.sin(hourAngle),
    Math.cos(hourAngle),
    ist.dayOfWeek / 6,
    ist.isWeekend ? 1 : 0,
    ist.isHoliday ? 1 : 0,
    ...hospitalIds.map((id) => (id === hospitalId ? 1 : 0)),
    ...wardTypes.map((w) => (w === wardType ? 1 : 0)),
  ];
}

function trainBedClassifier(
  bedSamples: BedTrainingSample[],
  hospitalIds: number[],
  wardTypes: string[],
): {
  trees: ClassificationTreeNode[] | null;
  metrics: BedClassifierMetrics | null;
} {
  if (bedSamples.length < 90) {
    return { trees: null, metrics: null };
  }

  // Check if at least 90 distinct days of history exist overall (TBD-9)
  const distinctDays = new Set(bedSamples.map((s) => s.record_time.slice(0, 10))).size;
  if (distinctDays < 90) {
    return { trees: null, metrics: null };
  }

  const sorted = [...bedSamples].sort((a, b) => a.record_time.localeCompare(b.record_time));
  const splitIdx = Math.floor(sorted.length * 0.8);
  const train = sorted.slice(0, splitIdx);
  const test = sorted.slice(splitIdx);

  const toClassIndex = (status: BedStatus) => BED_CLASSES.indexOf(status);

  const XTrain = train.map((s) =>
    extractBedFeatureVector(s.hospital_id, s.ward_type, s.record_time, s.prev_available_ratio, hospitalIds, wardTypes),
  );
  const yTrain = train.map((s) => toClassIndex(deriveBedStatus(s.available_beds, s.total_beds)));

  const XTest = test.map((s) =>
    extractBedFeatureVector(s.hospital_id, s.ward_type, s.record_time, s.prev_available_ratio, hospitalIds, wardTypes),
  );
  const yTest = test.map((s) => toClassIndex(deriveBedStatus(s.available_beds, s.total_beds)));

  const rng = createRng(4242);
  const trees: ClassificationTreeNode[] = [];
  const nTrees = 15;
  const maxFeatures = Math.max(3, Math.floor(Math.sqrt(XTrain[0].length)) + 1);

  for (let t = 0; t < nTrees; t++) {
    const boot = Array.from({ length: XTrain.length }, () => Math.floor(rng() * XTrain.length));
    trees.push(buildClassificationTree(XTrain, yTrain, boot, 0, 6, 5, maxFeatures, rng));
  }

  const confusion = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  let correct = 0;
  let baselineCorrect = 0;

  for (let i = 0; i < XTest.length; i++) {
    const probSum = [0, 0, 0];
    for (const tree of trees) {
      const probs = predictClassTree(tree, XTest[i]);
      probSum[0] += probs[0];
      probSum[1] += probs[1];
      probSum[2] += probs[2];
    }
    let predClass = 0;
    if (probSum[1] > probSum[predClass]) predClass = 1;
    if (probSum[2] > probSum[predClass]) predClass = 2;

    const actual = yTest[i];
    confusion[actual][predClass]++;
    if (predClass === actual) correct++;

    const prevStatus = deriveBedStatus(test[i].prev_available_ratio * 100, 100);
    if (toClassIndex(prevStatus) === actual) baselineCorrect++;
  }

  let precSum = 0;
  let recSum = 0;
  for (let c = 0; c < 3; c++) {
    const tp = confusion[c][c];
    const fp = confusion[0][c] + confusion[1][c] + confusion[2][c] - tp;
    const fn = confusion[c][0] + confusion[c][1] + confusion[c][2] - tp;
    precSum += tp + fp > 0 ? tp / (tp + fp) : 0;
    recSum += tp + fn > 0 ? tp / (tp + fn) : 0;
  }

  return {
    trees,
    metrics: {
      accuracy: Math.round((correct / XTest.length) * 1000) / 1000,
      macro_precision: Math.round((precSum / 3) * 1000) / 1000,
      macro_recall: Math.round((recSum / 3) * 1000) / 1000,
      baseline_accuracy: Math.round((baselineCorrect / XTest.length) * 1000) / 1000,
      classes: BED_CLASSES,
      confusion_matrix: confusion,
      eligible_days: distinctDays,
      sample_count: sorted.length,
    },
  };
}

// =========================================================================
// Complete Training Pipeline (REQ-ML-01..REQ-ML-11)
// =========================================================================

export function trainAndEvaluateModels(
  rawSamples: WaitingTrainingSample[],
  bedSamples: BedTrainingSample[],
  modelVersion: string,
  dataProvenance: string,
): SerializedModelArtifact {
  // REQ-ML-01: Clean missing/invalid entries & sort chronologically for time-aware split
  const cleanSamples = rawSamples
    .filter(
      (s) =>
        Number.isFinite(s.waiting_minutes) &&
        s.waiting_minutes >= 0 &&
        s.waiting_minutes <= 360 &&
        Boolean(s.record_time),
    )
    .sort((a, b) => a.record_time.localeCompare(b.record_time));

  if (cleanSamples.length < 40) {
    throw new Error('At least 40 valid waiting-time records are required to train and evaluate models.');
  }

  const splitIdx = Math.floor(cleanSamples.length * 0.8);
  const trainSamples = cleanSamples.slice(0, splitIdx);
  const testSamples = cleanSamples.slice(splitIdx);

  const hospitalIds = Array.from(new Set(cleanSamples.map((s) => s.hospital_id))).sort((a, b) => a - b);
  const departmentNames = Array.from(new Set(cleanSamples.map((s) => s.department_name))).sort();
  const wardTypes = Array.from(new Set(bedSamples.map((b) => b.ward_type))).sort();

  const baseline = buildBaseline(trainSamples);

  const buildMatrix = (list: WaitingTrainingSample[]) =>
    list.map((s) =>
      extractRawNumericAndCat(
        s.hospital_id,
        s.department_id,
        s.department_name,
        s.record_time,
        s.prev_queue_size,
        s.prev_waiting_minutes,
        s.recent_weighted_wait,
        s.recent_count,
        s.recent_latest_age_min,
        baseline,
        { hospitalIds, departmentNames, timeSlots: TIME_SLOTS },
      ),
    );

  const rawTrainX = buildMatrix(trainSamples);
  const rawTestX = buildMatrix(testSamples);
  const yTrain = trainSamples.map((s) => s.waiting_minutes);
  const yTest = testSamples.map((s) => s.waiting_minutes);

  // Compute standardization means & stds from training split only (no data leakage)
  const numericMeans = Array(NUMERIC_FEATURE_COUNT).fill(0);
  const numericStds = Array(NUMERIC_FEATURE_COUNT).fill(1);
  for (let j = 0; j < NUMERIC_FEATURE_COUNT; j++) {
    let sum = 0;
    for (let i = 0; i < rawTrainX.length; i++) sum += rawTrainX[i][j];
    const mean = sum / rawTrainX.length;
    numericMeans[j] = Math.round(mean * 10000) / 10000;

    let varSum = 0;
    for (let i = 0; i < rawTrainX.length; i++) varSum += (rawTrainX[i][j] - mean) ** 2;
    const std = Math.sqrt(varSum / rawTrainX.length);
    numericStds[j] = std > 1e-6 ? Math.round(std * 10000) / 10000 : 1;
  }

  const XTrain = standardizeFeatures(rawTrainX, numericMeans, numericStds);
  const XTest = standardizeFeatures(rawTestX, numericMeans, numericStds);

  // 1. Historical-Average Baseline evaluation
  const baselinePreds = testSamples.map(
    (s) => lookupBaselineStats(baseline, s.hospital_id, s.department_id, s.department_name, s.record_time).mean,
  );
  const baselineStats = computeMaeRmseR2(yTest, baselinePreds);

  // 2. Ridge Linear Regression
  const linearWeights = fitRidgeRegression(XTrain, yTrain, 2.0);
  const linearPreds = XTest.map((x) => predictRidge(linearWeights, x));
  const linearStats = computeMaeRmseR2(yTest, linearPreds);

  // 3. Random Forest Regressor
  const forestTrees = fitRandomForestRegressor(XTrain, yTrain, 18, 7, 5, 42);
  const forestPreds = XTest.map((x) => predictRandomForest(forestTrees, x));
  const forestStats = computeMaeRmseR2(yTest, forestPreds);

  // 4. Gradient Boosting Regressor
  const gbModel = fitGradientBoostingRegressor(XTrain, yTrain, 28, 0.12, 4, 6, 42);
  const gbPreds = XTest.map((x) =>
    predictGradientBoosting(gbModel.initialValue, gbModel.learningRate, gbModel.trees, x),
  );
  const gbStats = computeMaeRmseR2(yTest, gbPreds);

  const mlCandidates: Array<{
    name: 'LinearRegression' | 'RandomForest' | 'GradientBoosting';
    stats: { mae: number; rmse: number; r2: number };
  }> = [
    { name: 'LinearRegression', stats: linearStats },
    { name: 'RandomForest', stats: forestStats },
    { name: 'GradientBoosting', stats: gbStats },
  ];

  // Rank candidates by RMSE then MAE
  mlCandidates.sort((a, b) => a.stats.rmse - b.stats.rmse || a.stats.mae - b.stats.mae);
  const bestCandidate = mlCandidates[0];

  // REQ-ML-05: Deploy only if held-out MAE and RMSE BOTH beat baseline
  const beatsBaseline =
    bestCandidate.stats.mae < baselineStats.mae && bestCandidate.stats.rmse < baselineStats.rmse;

  const selectedModelType: SerializedModelArtifact['model_type'] = beatsBaseline
    ? bestCandidate.name
    : 'Baseline';
  const selectedRmse = beatsBaseline ? bestCandidate.stats.rmse : baselineStats.rmse;
  const marginMinutes = Math.max(5, Math.round(selectedRmse));

  const candidatesComparison: ModelComparisonMetric[] = [
    {
      model_name: 'Historical Baseline',
      mae: baselineStats.mae,
      rmse: baselineStats.rmse,
      r2: baselineStats.r2,
      is_selected: selectedModelType === 'Baseline',
    },
    {
      model_name: 'Linear Regression (Ridge)',
      mae: linearStats.mae,
      rmse: linearStats.rmse,
      r2: linearStats.r2,
      is_selected: selectedModelType === 'LinearRegression',
    },
    {
      model_name: 'Random Forest Regressor',
      mae: forestStats.mae,
      rmse: forestStats.rmse,
      r2: forestStats.r2,
      is_selected: selectedModelType === 'RandomForest',
    },
    {
      model_name: 'Gradient Boosting Regressor',
      mae: gbStats.mae,
      rmse: gbStats.rmse,
      r2: gbStats.r2,
      is_selected: selectedModelType === 'GradientBoosting',
    },
  ];

  // Bed Availability Classifier (REQ-ML-08)
  const bedResult = trainBedClassifier(bedSamples, hospitalIds, wardTypes);

  const minDate = cleanSamples[0].record_time.slice(0, 10);
  const maxDate = cleanSamples[cleanSamples.length - 1].record_time.slice(0, 10);

  return {
    model_version: modelVersion,
    model_type: selectedModelType,
    trained_at: new Date().toISOString(),
    training_range: `${minDate} to ${maxDate}`,
    data_provenance: dataProvenance,
    schema: {
      hospitalIds,
      departmentNames,
      wardTypes,
      timeSlots: TIME_SLOTS,
      numericMeans,
      numericStds,
    },
    baseline,
    linearWeights,
    forestTrees,
    gbInitialValue: gbModel.initialValue,
    gbLearningRate: gbModel.learningRate,
    gbTrees: gbModel.trees,
    bedClassifier: bedResult.trees
      ? {
          wardTypes,
          hospitalIds,
          trees: bedResult.trees,
        }
      : null,
    metrics: {
      train_samples: trainSamples.length,
      test_samples: testSamples.length,
      split_strategy: '80% chronological train / 20% latest held-out test',
      margin_rule: 'Estimate ± 1.0 × held-out RMSE (rounded to 5 min, min width 10 min)',
      margin_minutes: marginMinutes,
      baseline_mae: baselineStats.mae,
      baseline_rmse: baselineStats.rmse,
      active_model_type: selectedModelType,
      beats_baseline: beatsBaseline,
      candidates: candidatesComparison,
      bed_classifier: bedResult.metrics,
    },
  };
}

export interface WaitPredictionOutput {
  predictedValue: number;
  rangeLow: number;
  rangeHigh: number;
  queueLevel: QueueLevel;
  modelVersion: string;
  modelType: string;
  basis: 'ML prediction' | 'Historical data only';
}

export function inferWaitTime(
  artifact: SerializedModelArtifact,
  input: {
    hospitalId: number;
    departmentId: number;
    departmentName: string;
    timestampIso: string;
    prevQueueSize: number;
    prevWaitingMinutes: number;
    recentAggregate: RecentUpdateAggregate;
  },
): WaitPredictionOutput {
  const { recentAggregate } = input;
  const hasRecent = recentAggregate.reportCount > 0 && recentAggregate.weightedMeanWait !== null;

  const rawVec = extractRawNumericAndCat(
    input.hospitalId,
    input.departmentId,
    input.departmentName,
    input.timestampIso,
    input.prevQueueSize,
    input.prevWaitingMinutes,
    recentAggregate.weightedMeanWait,
    recentAggregate.reportCount,
    recentAggregate.latestAgeMinutes,
    artifact.baseline,
    artifact.schema,
  );

  const stdVec = standardizeFeatures([rawVec], artifact.schema.numericMeans, artifact.schema.numericStds)[0];
  const histStats = lookupBaselineStats(
    artifact.baseline,
    input.hospitalId,
    input.departmentId,
    input.departmentName,
    input.timestampIso,
  );

  let rawPrediction = histStats.mean;
  if (artifact.model_type === 'LinearRegression' && artifact.linearWeights) {
    rawPrediction = predictRidge(artifact.linearWeights, stdVec);
  } else if (artifact.model_type === 'RandomForest' && artifact.forestTrees) {
    rawPrediction = predictRandomForest(artifact.forestTrees, stdVec);
  } else if (artifact.model_type === 'GradientBoosting' && artifact.gbTrees) {
    rawPrediction = predictGradientBoosting(
      artifact.gbInitialValue ?? histStats.mean,
      artifact.gbLearningRate ?? 0.12,
      artifact.gbTrees,
      stdVec,
    );
  }

  // Blend slightly with very fresh human reports when confidence is Medium/High so live surges reflect immediately
  let finalEstimate = rawPrediction;
  if (hasRecent && recentAggregate.weightedMeanWait !== null) {
    const recencyAlpha = recentAggregate.confidence === 'High' ? 0.55 : recentAggregate.confidence === 'Medium' ? 0.35 : 0.2;
    finalEstimate = (1 - recencyAlpha) * rawPrediction + recencyAlpha * recentAggregate.weightedMeanWait;
  }

  const margin = artifact.metrics?.margin_minutes ?? 10;
  const { estimate, rangeLow, rangeHigh } = formatWaitRange(finalEstimate, margin);

  return {
    predictedValue: estimate,
    rangeLow,
    rangeHigh,
    queueLevel: deriveQueueLevel(estimate),
    modelVersion: artifact.model_version,
    modelType: artifact.model_type,
    basis: hasRecent ? 'ML prediction' : 'Historical data only',
  };
}

export function inferBedStatus(
  artifact: SerializedModelArtifact | null,
  input: {
    hospitalId: number;
    wardType: string;
    timestampIso: string;
    totalBeds: number;
    availableBeds: number;
  },
): { status: BedStatus; basis: 'Predicted' | 'Last recorded' } {
  const ratioStatus = deriveBedStatus(input.availableBeds, input.totalBeds);
  if (!artifact || !artifact.bedClassifier || artifact.bedClassifier.trees.length === 0) {
    return { status: ratioStatus, basis: 'Last recorded' };
  }

  const prevRatio = input.totalBeds > 0 ? input.availableBeds / input.totalBeds : 0;
  const vec = extractBedFeatureVector(
    input.hospitalId,
    input.wardType,
    input.timestampIso,
    prevRatio,
    artifact.bedClassifier.hospitalIds,
    artifact.bedClassifier.wardTypes,
  );

  const probSum = [0, 0, 0];
  for (const tree of artifact.bedClassifier.trees) {
    const p = predictClassTree(tree, vec);
    probSum[0] += p[0];
    probSum[1] += p[1];
    probSum[2] += p[2];
  }

  let bestIdx = 0;
  if (probSum[1] > probSum[bestIdx]) bestIdx = 1;
  if (probSum[2] > probSum[bestIdx]) bestIdx = 2;

  return {
    status: BED_CLASSES[bestIdx],
    basis: 'Predicted',
  };
}

export function saveModelArtifact(modelsDir: string, artifact: SerializedModelArtifact): string {
  fs.mkdirSync(modelsDir, { recursive: true });
  const filePath = path.join(modelsDir, `${artifact.model_version}.json`);
  fs.writeFileSync(filePath, JSON.stringify(artifact), 'utf-8');
  return filePath;
}

export function loadModelArtifact(modelsDir: string, modelVersion: string): SerializedModelArtifact | null {
  const filePath = path.join(modelsDir, `${modelVersion}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SerializedModelArtifact;
}
