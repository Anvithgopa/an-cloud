import { createApp } from './app.js';
import { loadConfig } from './config.js';

async function bootstrap() {
  try {
    const config = loadConfig();
    const { app, indexer, close } = createApp(config);

    // Run an initial non-blocking startup scan and start scheduled indexing
    indexer.runScan('startup').catch((err) => {
      console.error('[Startup Indexer] Error during initial scan:', err.message);
    });
    indexer.startScheduledIndexing();

    const server = app.listen(config.port, config.host, () => {
      console.log(
        `[AN Cloud] Server listening on http://${config.host}:${config.port} (Storage Root: ${config.paths.root})`
      );
    });

    const shutdown = (signal: string) => {
      console.log(`[AN Cloud] Received ${signal}. Shutting down gracefully...`);
      server.close(() => {
        close();
        process.exit(0);
      });
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (err: any) {
    console.error('[AN Cloud] FATAL STARTUP ERROR:', err.message);
    process.exit(1);
  }
}

bootstrap();
