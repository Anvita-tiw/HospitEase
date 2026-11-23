import { fork, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SRS_DEFAULTS,
  type BedStatus,
  type ModelMetricsSummary,
  type QueueLevel,
  type RecentUpdateAggregate,
} from '../types.ts';
import { deriveBedStatus, deriveQueueLevel, formatWaitRange } from '../utils/validation.ts';
import type { BedTrainingSample, WaitingTrainingSample } from './models.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

class PredictionServiceClient {
  private child: ChildProcess | null = null;
  private pending = new Map<string, PendingCall>();
  private modelsDir: string;
  private activeVersion: string | null = null;

  constructor() {
    this.modelsDir = path.resolve(process.cwd(), 'data/models');
  }

  public getModelsDir(): string {
    return this.modelsDir;
  }

  private ensureWorker(): ChildProcess {
    if (this.child && this.child.connected) {
      return this.child;
    }
    const workerPath = path.resolve(__dirname, 'worker.ts');
    const child = fork(workerPath, [], {
      execArgv: process.execArgv,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });

    child.on('message', (msg: { id: string; ok: boolean; data?: unknown; error?: string }) => {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(msg.id);
      if (msg.ok) entry.resolve(msg.data);
      else entry.reject(new Error(msg.error || 'Worker error'));
    });

    child.on('exit', () => {
      for (const [id, entry] of this.pending.entries()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('Prediction worker exited unexpectedly'));
        this.pending.delete(id);
      }
      this.child = null;
    });

    this.child = child;
    return child;
  }

  private callWorker<T>(payload: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const worker = this.ensureWorker();
    const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Prediction service timed out after ${timeoutMs} ms`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      worker.send({ ...payload, id });
    });
  }

  public async loadModel(modelVersion: string): Promise<void> {
    await this.callWorker(
      {
        type: 'load',
        modelsDir: this.modelsDir,
        modelVersion,
      },
      5000,
    );
    this.activeVersion = modelVersion;
  }

  public async predictWaitWithFallback(
    input: {
      hospitalId: number;
      departmentId: number;
      departmentName: string;
      timestampIso: string;
      prevQueueSize: number;
      prevWaitingMinutes: number;
      recentAggregate: RecentUpdateAggregate;
    },
    historicalFallbackMean: number,
  ): Promise<{
    predictedValue: number;
    rangeLow: number;
    rangeHigh: number;
    queueLevel: QueueLevel;
    modelVersion: string;
    modelType: string;
    basis: 'ML prediction' | 'Historical data only';
    fallbackNotice: string | null;
  }> {
    try {
      const res = await this.callWorker<{
        predictedValue: number;
        rangeLow: number;
        rangeHigh: number;
        queueLevel: QueueLevel;
        modelVersion: string;
        modelType: string;
        basis: 'ML prediction' | 'Historical data only';
      }>({ type: 'predict_wait', input }, SRS_DEFAULTS.PREDICTION_TIMEOUT_MS);

      return {
        ...res,
        fallbackNotice: null,
      };
    } catch {
      // REQ-EST-08: Prediction service down or > 2s -> historical-average baseline with visible notice
      const { estimate, rangeLow, rangeHigh } = formatWaitRange(historicalFallbackMean, 10);
      return {
        predictedValue: estimate,
        rangeLow,
        rangeHigh,
        queueLevel: deriveQueueLevel(estimate),
        modelVersion: this.activeVersion ? `${this.activeVersion}-fallback` : 'baseline-fallback',
        modelType: 'HistoricalBaselineFallback',
        basis: 'Historical data only',
        fallbackNotice:
          'Prediction service temporarily unavailable; showing historical-average baseline estimate.',
      };
    }
  }

  public async predictBedStatusWithFallback(input: {
    hospitalId: number;
    wardType: string;
    timestampIso: string;
    totalBeds: number;
    availableBeds: number;
  }): Promise<{ status: BedStatus; basis: 'Predicted' | 'Last recorded' }> {
    try {
      return await this.callWorker<{ status: BedStatus; basis: 'Predicted' | 'Last recorded' }>(
        { type: 'predict_bed', input },
        SRS_DEFAULTS.PREDICTION_TIMEOUT_MS,
      );
    } catch {
      return {
        status: deriveBedStatus(input.availableBeds, input.totalBeds),
        basis: 'Last recorded',
      };
    }
  }

  public async retrainOffline(input: {
    modelVersion: string;
    dataProvenance: string;
    waitingSamples: WaitingTrainingSample[];
    bedSamples: BedTrainingSample[];
  }): Promise<{
    model_version: string;
    model_type: string;
    training_range: string;
    trained_at: string;
    data_provenance: string;
    metrics: ModelMetricsSummary;
  }> {
    return await this.callWorker(
      {
        type: 'retrain',
        modelsDir: this.modelsDir,
        modelVersion: input.modelVersion,
        dataProvenance: input.dataProvenance,
        waitingSamples: input.waitingSamples,
        bedSamples: input.bedSamples,
      },
      60_000,
    );
  }
}

export const predictionService = new PredictionServiceClient();
