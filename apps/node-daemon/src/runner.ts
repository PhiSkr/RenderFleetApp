import { spawn } from 'child_process';
import { logger } from './logger';

interface RunOptions {
  scriptPath: string;
  envVars: Record<string, string>;
  timeoutMs?: number;
  useOverlay?: boolean;
}

export function runActionaScript(opts: RunOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const { scriptPath, envVars, timeoutMs = 300000, useOverlay = false } = opts;

    const finalEnv = {
      ...process.env,
      ...envVars
    };

    const binary = useOverlay ? '/usr/bin/actiona' : '/usr/bin/actexec';
    
    // GUI Mode: -e (execute), -Q (quit), -s (script)
    // Headless: -s (script)
    const args = useOverlay 
      ? ['-e', '-Q', '-s', scriptPath]
      : ['-s', scriptPath];

    logger.info(`🎬 Starting ${useOverlay ? 'GUI' : 'Headless'} Actiona: ${scriptPath}`);

    const child = spawn(binary, args, {
      env: finalEnv,
      stdio: 'pipe' 
    });

    const timer = setTimeout(() => {
      logger.error('TIMEOUT: Killing Actiona process');
      child.kill();
      reject(new Error('Actiona timed out'));
    }, timeoutMs);

    child.stdout.on('data', (data) => logger.info(`[ACT] ${data.toString().trim()}`));
    
    // HIER IST DER FILTER:
    child.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        // Ignoriere die nervigen WM_NAME Warnungen
        if (msg.includes('Invalid type of WM_NAME property')) return;
        
        // Echte Fehler trotzdem loggen
        if (msg.length > 0) {
            logger.warn(`[ACT ERR] ${msg}`);
        }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        logger.info('✅ Actiona finished successfully');
        resolve();
      } else {
        logger.error(`❌ Actiona failed with code ${code}`);
        reject(new Error(`Actiona exited with code ${code}`));
      }
    });
  });
}
