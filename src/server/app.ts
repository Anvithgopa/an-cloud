import path from 'node:path';
import fs from 'node:fs';
import express, { Express, Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { AppConfig, loadConfig } from './config.js';
import { initializeStorageDirectories, getDiskHealthAndSpace } from './storage/mountGuard.js';
import { initializeDatabase, DbInstance } from './db/database.js';
import { IndexerService } from './services/indexerService.js';
import { createAuthRouter } from './routes/authRoutes.js';
import { createDriveRouter } from './routes/driveRoutes.js';
import { createAdminSharesRouter, createPublicSharesRouter } from './routes/shareRoutes.js';
import { createSystemRouter } from './routes/systemRoutes.js';

export interface AppContext {
  app: Express;
  db: DbInstance;
  config: AppConfig;
  indexer: IndexerService;
  close: () => void;
}

export function createApp(customConfig?: AppConfig): AppContext {
  const config = customConfig || loadConfig();

  // 1. Verify HDD Mount & Create Required `/mnt/cloud/...` Directories
  initializeStorageDirectories(config);

  // 2. Initialize SQLite on the HDD (`/mnt/cloud/data/database/cloud.sqlite`)
  const db = initializeDatabase(config);

  // 3. Initialize Background Indexer Service
  const indexer = new IndexerService(db, config);

  const app = express();
  app.set('trust proxy', 1);

  // Security headers via Helmet (only enable HSTS when SECURE_COOKIES=true over HTTPS)
  app.use(
    helmet({
      contentSecurityPolicy: false, // Managed per-route for file streaming & SPA
      crossOriginEmbedderPolicy: false,
      strictTransportSecurity: config.secureCookies,
      crossOriginOpenerPolicy: false,
      originAgentCluster: false,
      frameguard: { action: 'sameorigin' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    })
  );

  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');

    // Verify Origin header matches Host on state-changing requests when Origin is present
    const unsafeMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (origin && host && unsafeMethods.includes(req.method.toUpperCase())) {
      try {
        const originHost = new URL(origin).host;
        if (originHost !== host && config.nodeEnv === 'production') {
          res.status(403).json({ error: 'Cross-origin state-changing request blocked', code: 'ORIGIN_MISMATCH' });
          return;
        }
      } catch {
        res.status(400).json({ error: 'Malformed Origin header', code: 'INVALID_ORIGIN' });
        return;
      }
    }
    next();
  });

  app.use(cookieParser());
  app.use(express.json({ limit: '2mb' }));

  // Public Health Check endpoint (verifies HDD mount status without exposing sensitive paths)
  app.get('/api/v1/health', (_req: Request, res: Response) => {
    const health = getDiskHealthAndSpace(config);
    const ok = health.isMounted && health.isWritable && health.identityVerified;
    res.status(ok ? 200 : 503).json({
      status: ok ? 'healthy' : 'degraded',
      storageMounted: health.isMounted,
      storageWritable: health.isWritable,
      identityVerified: health.identityVerified,
      usagePercent: health.usagePercent,
      checkedAt: health.lastCheckedAt,
    });
  });

  // Mount Versioned REST API Routers
  app.use('/api/v1/auth', createAuthRouter(db, config));
  app.use('/api/v1/drive', createDriveRouter(db, config));
  app.use('/api/v1/shares', createAdminSharesRouter(db, config));
  app.use('/api/v1/public/shares', createPublicSharesRouter(db, config));
  app.use('/api/v1/system', createSystemRouter(db, config, indexer));

  // Catch-all for unknown /api routes
  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'API endpoint not found', code: 'ENDPOINT_NOT_FOUND' });
  });

  // Serve built React frontend in production
  const clientDistPath = path.resolve(process.cwd(), 'dist/client');
  if (fs.existsSync(clientDistPath)) {
    app.use(express.static(clientDistPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(clientDistPath, 'index.html'));
    });
  }

  // Global error handler — never leaks stack traces or internal filesystem paths
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.statusCode || err.status || 500;
    const code = err.code || 'INTERNAL_SERVER_ERROR';
    const message = status === 500 ? 'An unexpected server error occurred' : err.message;
    res.status(status).json({ error: message, code });
  });

  const close = () => {
    indexer.stopScheduledIndexing();
    try {
      db.close();
    } catch {
      // Ignore
    }
  };

  return { app, db, config, indexer, close };
}
