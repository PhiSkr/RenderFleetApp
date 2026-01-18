import winston from 'winston';
import path from 'path';

const LOG_DIR = '/srv/renderfleet/runtime/logs';
const LOG_FILE = path.join(LOG_DIR, 'node.log');

export const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    // 1. Schreibe in Datei (für dauerhafte History)
    new winston.transports.File({ filename: LOG_FILE }),
    // 2. Schreibe in Konsole (für systemd journal)
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});
