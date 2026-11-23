import path from 'node:path';
import {
  inferBedStatus,
  inferWaitTime,
  loadModelArtifact,
  saveModelArtifact,
  trainAndEvaluateModels,
  type BedTrainingSample,
  type SerializedModelArtifact,
  type WaitingTrainingSample,
} from './models.ts';
import type { RecentUpdateAggregate } from '../types.ts';

type WorkerRequest =
  | { id: string; type: 'load'; modelsDir: string; modelVersion: string }
  | {
      id: string;
      type: 'predict_wait';
      input: {
        hospitalId: number;
        departmentId: number;
        departmentName: string;
        timestampIso: string;
        prevQueueSize: number;
        prevWaitingMinutes: number;
        recentAggregate: RecentUpdateAggregate;
      };
    }
  | {
      id: string;
      type: 'predict_bed';
      input: {
        hospitalId: number;
        wardType: string;
        timestampIso: string;
        totalBeds: number;
        availableBeds: number;
      };
    }
  | {
      id: string;
      type: 'retrain';
      modelsDir: string;
      modelVersion: string;
      dataProvenance: string;
      waitingSamples: WaitingTrainingSample[];
      bedSamples: BedTrainingSample[];
    }
  | { id: string; type: 'health' };

let activeArtifact: SerializedModelArtifact | null = null;
let currentModelsDir = path.resolve(process.cwd(), 'data/models');

process.on('message', (msg: WorkerRequest) => {
  try {
    if (msg.type === 'load') {
      currentModelsDir = msg.modelsDir;
      const loaded = loadModelArtifact(msg.modelsDir, msg.modelVersion);
      if (!loaded) {
        process.send?.({ id: msg.id, ok: false, error: `Model artifact ${msg.modelVersion} not found.` });
        return;
      }
      activeArtifact = loaded;
      process.send?.({
        id: msg.id,
        ok: true,
        data: { model_version: loaded.model_version, model_type: loaded.model_type },
      });
      return;
    }

    if (msg.type === 'health') {
      process.send?.({
        id: msg.id,
        ok: true,
        data: {
          ready: activeArtifact !== null,
          model_version: activeArtifact?.model_version ?? null,
          model_type: activeArtifact?.model_type ?? null,
          modelsDir: currentModelsDir,
        },
      });
      return;
    }

    if (msg.type === 'predict_wait') {
      if (!activeArtifact) {
        process.send?.({ id: msg.id, ok: false, error: 'No active model loaded in prediction service.' });
        return;
      }
      const result = inferWaitTime(activeArtifact, msg.input);
      process.send?.({ id: msg.id, ok: true, data: result });
      return;
    }

    if (msg.type === 'predict_bed') {
      const result = inferBedStatus(activeArtifact, msg.input);
      process.send?.({ id: msg.id, ok: true, data: result });
      return;
    }

    if (msg.type === 'retrain') {
      const artifact = trainAndEvaluateModels(
        msg.waitingSamples,
        msg.bedSamples,
        msg.modelVersion,
        msg.dataProvenance,
      );
      saveModelArtifact(msg.modelsDir, artifact);
      process.send?.({
        id: msg.id,
        ok: true,
        data: {
          model_version: artifact.model_version,
          model_type: artifact.model_type,
          training_range: artifact.training_range,
          trained_at: artifact.trained_at,
          data_provenance: artifact.data_provenance,
          metrics: artifact.metrics,
        },
      });
    }
  } catch (err) {
    process.send?.({
      id: msg.id,
      ok: false,
      error: err instanceof Error ? err.message : 'Prediction service execution error.',
    });
  }
});
