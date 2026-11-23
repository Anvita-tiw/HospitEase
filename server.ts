import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { initSchema } from './server/db/database.ts';
import { ensureSeededAndTrained } from './server/db/seed.ts';
import { adminRouter } from './server/routes/admin.ts';
import { aiRouter } from './server/routes/ai.ts';
import { authRouter } from './server/routes/auth.ts';
import { feedsRouter } from './server/routes/feeds.ts';
import { hospitalsRouter } from './server/routes/hospitals.ts';
import { updatesRouter } from './server/routes/updates.ts';
import { startFeedScheduler } from './server/services/feedService.ts';
import { attachLiveVoiceWebSocket } from './server/services/liveVoiceWs.ts';

async function startServer(): Promise<void> {
  initSchema();
  await ensureSeededAndTrained();
  startFeedScheduler();

  const app = express();
  app.use(express.json({ limit: '5mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'HospitEase AI API' });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/ai', aiRouter);
  app.use('/api', feedsRouter);
  app.use('/api', hospitalsRouter);
  app.use('/api/updates', updatesRouter);
  app.use('/api/admin', adminRouter);

  // Uniform API 404 for unknown /api routes
  app.use('/api', (_req, res) => {
    res.status(404).json({
      code: 'ENDPOINT_NOT_FOUND',
      message: 'Requested API endpoint was not found.',
      details: null,
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Production build not found. Run npm run build first.');
      }
    });
  }

  const port = Number(process.env.PORT) || 3000;
  const httpServer = app.listen(port, '0.0.0.0', () => {
    console.log(`HospitEase AI running at http://localhost:${port}`);
  });
  attachLiveVoiceWebSocket(httpServer);
}

startServer().catch((err) => {
  console.error('Failed to start HospitEase AI server:', err);
  process.exit(1);
});
