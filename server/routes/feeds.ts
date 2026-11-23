import { Router } from 'express';
import { db } from '../db/database.ts';
import { rateLimitMiddleware } from '../middleware/auth.ts';
import {
  ingestStructuredHospitalPayload,
  verifyFeedToken,
  type FeedConnectionRow,
} from '../services/feedService.ts';
import { liveEventBus, type LiveEventPayload } from '../services/liveEvents.ts';

export const feedsRouter = Router();

// Server-Sent Events (SSE) stream for live hospital queue, bed, and feed sync broadcasts
feedsRouter.get('/events/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true, connected_at: new Date().toISOString() })}\n\n`);

  const onLiveEvent = (payload: LiveEventPayload) => {
    try {
      res.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch {
      // Ignore broken pipe; close handler cleans up listener
    }
  };

  liveEventBus.on('live-event', onLiveEvent);

  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    liveEventBus.off('live-event', onLiveEvent);
  });
});

// Partner Hospital HMS Push Webhook Ingestion
feedsRouter.post('/feeds/ingest/:feedId', rateLimitMiddleware(120, 60_000), (req, res) => {
  const feedId = Number.parseInt(req.params.feedId, 10);
  if (!Number.isInteger(feedId) || feedId <= 0) {
    res.status(400).json({
      code: 'INVALID_FEED_ID',
      message: 'Feed ID must be a valid positive integer.',
      details: null,
    });
    return;
  }

  const authHeader = req.headers.authorization;
  const headerKey = req.headers['x-hospital-feed-key'];
  const providedToken =
    typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : typeof headerKey === 'string'
        ? headerKey.trim()
        : '';

  const feed = db
    .prepare('SELECT * FROM hospital_feed_connections WHERE feed_id = ?')
    .get(feedId) as FeedConnectionRow | undefined;

  if (!feed || feed.connector_type !== 'hms_webhook' || feed.is_enabled !== 1) {
    res.status(404).json({
      code: 'FEED_NOT_ACTIVE',
      message: 'Active webhook feed connection not found.',
      details: null,
    });
    return;
  }

  if (!verifyFeedToken(providedToken, feed.auth_token_hash)) {
    res.status(401).json({
      code: 'INVALID_FEED_TOKEN',
      message: 'Missing or invalid hospital feed Bearer token.',
      details: null,
    });
    return;
  }

  const summary = ingestStructuredHospitalPayload(
    feed.hospital_id,
    feed.data_source,
    'webhook',
    feed.feed_id,
    feed.provider_name,
    req.body,
  );

  const httpStatus = summary.status === 'error' ? 422 : 200;
  res.status(httpStatus).json({
    feed_id: feed.feed_id,
    hospital_id: feed.hospital_id,
    provider_name: feed.provider_name,
    data_source: feed.data_source,
    ...summary,
  });
});
