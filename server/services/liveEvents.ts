import { EventEmitter } from 'node:events';

export type LiveEventType = 'queue:updated' | 'beds:updated' | 'feed:synced';

export interface LiveEventPayload {
  type: LiveEventType;
  hospital_id: number;
  department_id?: number;
  ward_type?: string;
  feed_id?: number;
  provider_name?: string;
  records_ingested?: number;
  source: string;
  at: string;
}

class LiveEventBus extends EventEmitter {
  public emitUpdate(payload: LiveEventPayload): void {
    this.emit('live-event', payload);
  }
}

export const liveEventBus = new LiveEventBus();
liveEventBus.setMaxListeners(200);
