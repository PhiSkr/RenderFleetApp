import path from 'path';
import chokidar from 'chokidar';
import { loadConfig } from './config';
import { logger } from './logger';

// Pfade basierend auf Spec
const SYNC_ROOT = '/srv/renderfleet/sync';

async function main() {
  logger.info('RenderFleet Node Daemon starting...');

  // 1. Config laden
  const config = await loadConfig();
  const workerId = config.workerId;
  
  logger.info(`Identity confirmed: ${workerId}`);

  // 2. Watch Pfade definieren
  // Wir überwachen die ZUGEWIESENEN Ordner für diesen Worker
  const watchPaths = [
    path.join(SYNC_ROOT, 'image', 'assigned', workerId, 'inbox'),
    path.join(SYNC_ROOT, 'video', 'assigned', workerId, 'inbox')
  ];

  logger.info('Initializing watchers...', { paths: watchPaths });

  // 3. Watcher starten
  const watcher = chokidar.watch(watchPaths, {
    ignored: /(^|[\/\\])\../, // ignoriere hidden files (.DS_Store etc)
    persistent: true,
    depth: 1, // nur direkte Unterordner/Dateien
    awaitWriteFinish: {
      stabilityThreshold: 2000, // Warte 2s bis Datei fertig geschrieben ist
      pollInterval: 100
    }
  });

  // 4. Events behandeln
  watcher
    .on('add', (filePath) => {
      logger.info(`🆕 New File detected: ${filePath}`);
      // HIER kommt später die Logik: "Ist es ein Job? Dann starte Verarbeitung"
    })
    .on('addDir', (dirPath) => {
      // Wichtig für Video-Jobs (die sind Ordner)
      logger.info(`📁 New Folder detected: ${dirPath}`);
    })
    .on('error', error => logger.error(`Watcher error: ${error}`));

  logger.info('Watcher is active. Waiting for jobs...');
}

main().catch(err => {
  logger.error('Fatal startup error', err);
  process.exit(1);
});
