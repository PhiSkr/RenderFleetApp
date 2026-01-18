import fs from 'fs-extra';
import path from 'path';
import { logger } from './logger';

const CONFIG_PATH = '/srv/renderfleet/config/node_config.json';

export interface NodeConfig {
  workerId: string;
  roles: string[]; // z.B. ['video-worker', 'image-dispatcher']
}

const DEFAULT_CONFIG: NodeConfig = {
  workerId: 'worker001',
  roles: ['video-worker', 'video-dispatcher', 'image-worker', 'image-dispatcher']
};

export async function loadConfig(): Promise<NodeConfig> {
  try {
    if (await fs.pathExists(CONFIG_PATH)) {
      const content = await fs.readJson(CONFIG_PATH);
      logger.info('Config loaded from file.', { workerId: content.workerId });
      return { ...DEFAULT_CONFIG, ...content };
    } else {
      logger.warn('No config found. Creating default.');
      await fs.outputJson(CONFIG_PATH, DEFAULT_CONFIG, { spaces: 2 });
      return DEFAULT_CONFIG;
    }
  } catch (error) {
    logger.error('Failed to load config, using default in-memory.', error);
    return DEFAULT_CONFIG;
  }
}
