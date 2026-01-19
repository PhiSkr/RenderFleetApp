import path from 'path';
import { JobParsed, JobType } from './types';
import { logger } from './logger';

export function parseJobPath(filePath: string, type: JobType): JobParsed | null {
  const fileName = path.basename(filePath);
  
  // Ignoriere System-Dateien
  if (fileName.startsWith('.') || fileName.endsWith('.tmp')) return null;

  // Regex: channel__jobid__name...
  // Wir splitten einfach am Doppel-Unterstrich '__'
  const parts = fileName.split('__');

  // Validierung: Wir brauchen mindestens channel und jobid
  if (parts.length < 2) {
    logger.warn(`Skipping invalid filename format: ${fileName}`);
    return null;
  }

  const channel = parts[0];
  const jobId = parts[1];
  // Rest ist der Name (könnte auch noch __ enthalten, daher join)
  const name = parts.slice(2).join('__').replace(/\.(txt|json)$/, '');

  // Timestamp versuchen zu extrahieren (bei Video oft im Namen), sonst heute
  // Hier einfach pragmatisch:
  const timestamp = new Date().toISOString().split('T')[0];

  return {
    originalName: fileName,
    fullPath: filePath,
    type,
    channel,
    jobId,
    name,
    timestamp
  };
}
