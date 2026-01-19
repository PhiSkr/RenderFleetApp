import fs from 'fs-extra';
import path from 'path';
import { JobParsed } from './types';
import { logger } from './logger';
import { runActionaScript } from './runner';

const RUNTIME_ROOT = '/srv/renderfleet/runtime';
const TOOLS_ROOT = '/srv/renderfleet/sync'; 

// --- UNIFIED DOWNLOAD FOLDER ---
const DOWNLOAD_DIR = '/srv/renderfleet/runtime/downloads/general';

// Flags Paths
const FLAGS_DIR_IMAGE = '/srv/renderfleet/runtime/flags/image';
const FLAGS_DIR_VIDEO = '/srv/renderfleet/runtime/flags/video';

// Processing Stages
const IMAGE_STAGE = path.join(RUNTIME_ROOT, 'processing', 'image');
const VIDEO_STAGE = path.join(RUNTIME_ROOT, 'processing', 'video');

// --- POLICY CONFIG ---
const MAX_RETRIES = 1; 
const ACTIONA_TIMEOUT_MS = 30 * 60 * 1000; 
const STRAGGLER_TIMEOUT_MS = 5 * 60 * 1000; 

// --- STATUS EXPORT (NEU für Heartbeat) ---
export let CURRENT_STATUS: 'IDLE' | 'BUSY' = 'IDLE';

export async function processJob(job: JobParsed) {
  // Check if Busy
  if (CURRENT_STATUS === 'BUSY') {
      logger.warn(`⚠️ Job ${job.jobId} ignored because worker is BUSY.`);
      return;
  }
  
  CURRENT_STATUS = 'BUSY'; // Status setzen
  logger.info(`⚙️ Processing Job: [${job.type.toUpperCase()}] ${job.jobId}`);

  try {
    if (job.type === 'image') {
       const procDir = path.join(IMAGE_STAGE, job.jobId);
       await fs.emptyDir(procDir);
       const targetPath = path.join(procDir, job.originalName);
       await fs.move(job.fullPath, targetPath, { overwrite: true });
       await processImageJob(targetPath, job, procDir);

    } else if (job.type === 'video') {
       await fs.emptyDir(VIDEO_STAGE);
       const targetJobDir = path.join(VIDEO_STAGE, job.originalName);
       await fs.move(job.fullPath, targetJobDir, { overwrite: true });
       logger.info(`Moved video job to Processing Stage: ${targetJobDir}`);
       await processVideoJob(targetJobDir, job);
    }
  } catch (error) {
    logger.error(`Failed to process job ${job.jobId}:`, error);
  } finally {
    // Egal ob Erfolg oder Fehler: Wir sind wieder bereit.
    CURRENT_STATUS = 'IDLE';
  }
}

async function processImageJob(txtPath: string, job: JobParsed, procDir: string) {
  const mainScript = path.join(TOOLS_ROOT, 'image', 'tools', 'higgsfield_image.ascr');
  const refreshScript = path.join(TOOLS_ROOT, 'image', 'tools', 'higgsfield_refresh.ascr');

  if (!await fs.pathExists(mainScript)) throw new Error(`Script missing: ${mainScript}`);
  const content = await fs.readFile(txtPath, 'utf-8');
  const prompts = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  
  logger.info(`[IMAGE] Found ${prompts.length} prompts.`);

  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i];
    let success = false;
    let attempts = 0;
    logger.info(`>>> Prompt ${i+1}/${prompts.length}: "${prompt}"`);

    while (!success && attempts <= MAX_RETRIES + 1) {
        attempts++;
        if (attempts > 1) {
            if (await fs.pathExists(refreshScript)) {
                 try { await runActionaScript({ scriptPath: refreshScript, envVars: {RF_JOB_ID: job.jobId}, useOverlay: false }); } catch (e) {}
            }
        }
        await fs.emptyDir(DOWNLOAD_DIR);
        await fs.emptyDir(FLAGS_DIR_IMAGE);

        try {
            await runActionaScript({
                scriptPath: mainScript,
                envVars: { RF_PROMPT: prompt, RF_JOB_ID: job.jobId, RF_INDEX: String(i) },
                timeoutMs: ACTIONA_TIMEOUT_MS,
                useOverlay: false
            });
            const flags = await fs.readdir(FLAGS_DIR_IMAGE);
            if (flags.length > 0) { logger.warn(`🚩 Flags: ${flags}`); continue; }

            const files = await waitForFilesSmart(DOWNLOAD_DIR, 4, '.png'); 
            for (let k = 0; k < files.length; k++) {
                await fs.move(path.join(DOWNLOAD_DIR, files[k]), path.join(procDir, `prompt${String(i+1).padStart(3,'0')}_take${String(k+1).padStart(2,'0')}.png`));
            }
            success = true;
        } catch (err) { logger.error(`Attempt ${attempts} failed: ${err}`); }
    }
  }
  const outboxDir = path.join(TOOLS_ROOT, 'image', 'outbox', `${job.channel}__${job.jobId}__${job.name}`);
  await fs.mkdirp(outboxDir);
  await fs.copy(procDir, outboxDir);
  await fs.remove(procDir);
  logger.info(`✅ Image Job ${job.jobId} FINISHED.`);
}

async function processVideoJob(jobDir: string, job: JobParsed) {
  const scriptPath = path.join(TOOLS_ROOT, 'video', 'tools', 'RunwayVideo.ascr');
  if (!await fs.pathExists(scriptPath)) throw new Error(`Video Script missing: ${scriptPath}`);

  const files = await fs.readdir(jobDir);
  const images = files.filter(f => f.match(/\.(png|jpg|jpeg)$/i));
  
  let promptMap: Record<string, string> = {};
  const mapFile = path.join(jobDir, 'prompts.json');
  if (await fs.pathExists(mapFile)) {
      try { promptMap = await fs.readJson(mapFile); } catch(e) {}
  } 

  logger.info(`[VIDEO] Found ${images.length} images in ${jobDir}`);

  for (let i = 0; i < images.length; i++) {
      const imgName = images[i];
      const prompt = promptMap[imgName] || "";
      let success = false;
      let attempts = 0;
      logger.info(`>>> Image ${i+1}: "${imgName}" (Prompt: "${prompt}")`);

      while (!success && attempts <= MAX_RETRIES + 1) {
          attempts++;
          await fs.emptyDir(DOWNLOAD_DIR);
          await fs.emptyDir(FLAGS_DIR_VIDEO);

          try {
             await runActionaScript({
                 scriptPath,
                 envVars: {
                     RF_PROJECT_NAME: job.originalName,
                     RF_IMAGE_NAME: imgName,
                     RF_PROMPT: prompt,
                     RF_JOB_ID: job.jobId,
                     RF_FULL_JOB_PATH: jobDir 
                 },
                 timeoutMs: ACTIONA_TIMEOUT_MS,
                 useOverlay: false
             });

             const flags = await fs.readdir(FLAGS_DIR_VIDEO);
             const criticalFlags = flags.filter(f => f === 'Issue.txt' || f === 'PromptViolation.txt');
             if (criticalFlags.length > 0) {
                 logger.warn(`🚩 Video Flags: ${criticalFlags}`);
                 continue; 
             }

             logger.info('Waiting for 2 MP4s...');
             const mp4s = await waitForFilesSmart(DOWNLOAD_DIR, 2, '.mp4');
             
             for (let k = 0; k < mp4s.length; k++) {
                 const src = path.join(DOWNLOAD_DIR, mp4s[k]);
                 const baseName = path.parse(imgName).name;
                 const destName = `${baseName}_take${String(k+1).padStart(2,'0')}.mp4`;
                 await fs.move(src, path.join(jobDir, destName));
             }
             success = true;

          } catch (err) { logger.error(`Attempt ${attempts} failed: ${err}`); }
      }
  }

  logger.info('🧹 Organizing inputs into "input" folder...');
  const inputDir = path.join(jobDir, 'input');
  await fs.ensureDir(inputDir);
  for (const imgName of images) {
      const src = path.join(jobDir, imgName);
      const dest = path.join(inputDir, imgName);
      if (await fs.pathExists(src)) await fs.move(src, dest);
  }
  const pJson = path.join(jobDir, 'prompts.json');
  if (await fs.pathExists(pJson)) await fs.move(pJson, path.join(inputDir, 'prompts.json'));
  
  const outboxDir = path.join(TOOLS_ROOT, 'video', 'outbox', `${job.channel}__${job.jobId}__${job.name}`);
  await fs.mkdirp(outboxDir);
  await fs.copy(jobDir, outboxDir);
  await fs.emptyDir(VIDEO_STAGE);
  logger.info(`✅ Video Job ${job.jobId} FINISHED.`);
}

async function waitForFilesSmart(dir: string, targetCount: number, ext: string): Promise<string[]> {
  const globalStart = Date.now();
  let firstTime: number | null = null;
  while (Date.now() - globalStart < ACTIONA_TIMEOUT_MS) {
    const files = (await fs.readdir(dir)).filter(f => f.endsWith(ext));
    const count = files.length;
    if (count >= targetCount) return files;
    if (count > 0 && firstTime === null) {
        firstTime = Date.now();
        logger.info(`First ${ext} detected. Starting straggler timer.`);
    }
    if (firstTime !== null && (Date.now() - firstTime > STRAGGLER_TIMEOUT_MS)) {
        if (count > 0) {
            logger.warn(`Straggler timeout. Accepting ${count}/${targetCount}.`);
            return files;
        }
        throw new Error(`Straggler timeout with 0 valid files.`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('Global timeout.');
}
