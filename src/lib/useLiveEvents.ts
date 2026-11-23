import { useEffect, useRef, useState } from 'react';

export interface LiveEventMessage {
  type: 'queue:updated' | 'beds:updated' | 'feed:synced';
  hospital_id: number;
  department_id?: number;
  ward_type?: string;
  feed_id?: number;
  provider_name?: string;
  records_ingested?: number;
  source: string;
  at: string;
}

export function formatDataSourceLabel(source?: string | null): string {
  if (source === 'real') return 'Hospital HMS feed';
  if (source === 'public') return 'Public health feed';
  if (source === 'crowd') return 'Live crowd reports';
  return 'Baseline records';
}

export function useLiveEvents(onEvent?: (ev: LiveEventMessage) => void): {
  connectionState: 'connecting' | 'connected' | 'reconnecting';
  lastEventAt: string | null;
} {
  const [connectionState, setConnectionState] = useState<'connecting' | 'connected' | 'reconnecting'>('connecting');
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const es = new EventSource('/api/events/stream');

    const handleConnected = () => {
      setConnectionState('connected');
    };

    const handlePayload = (raw: MessageEvent) => {
      try {
        const parsed = JSON.parse(raw.data) as LiveEventMessage;
        setLastEventAt(parsed.at);
        handlerRef.current?.(parsed);
      } catch {
        // Ignore malformed SSE payload
      }
    };

    es.addEventListener('connected', handleConnected);
    es.addEventListener('queue:updated', handlePayload);
    es.addEventListener('beds:updated', handlePayload);
    es.addEventListener('feed:synced', handlePayload);
    es.onerror = () => {
      setConnectionState('reconnecting');
    };

    return () => {
      es.removeEventListener('connected', handleConnected);
      es.removeEventListener('queue:updated', handlePayload);
      es.removeEventListener('beds:updated', handlePayload);
      es.removeEventListener('feed:synced', handlePayload);
      es.close();
    };
  }, []);

  return { connectionState, lastEventAt };
}
