import chokidar from 'chokidar';
import fs from 'fs-extra';
import path from 'path';
import { exec } from 'child_process';
import { createLogger, format, transports } from 'winston';

const WORKER_ID = "worker001";

// --- PFADE ---
const BASE_SYNC_PATH = "/srv/renderfleet/sync";
const RUNTIME_PATH = "/srv/renderfleet/runtime";
const STAGE_PATH = "/srv/renderfleet/stage";
const SCRIPT_PATH = path.join(BASE_SYNC_PATH, "video/tools/RunwayVideo.ascr");
const PAUSE_FILE = path.join(RUNTIME_PATH, "PAUSED");

// INPUT: Downloads Ordner (wird geleert vor jedem Step)
const DOWNLOADS_PATH = "/srv/renderfleet/runtime/downloads/general";

// OUTPUT: Sync Outbox (Hierhin gehen die Ergebnisse)
const OUTBOX_PATH = path.join(BASE_SYNC_PATH, "video/outbox");

const getGuiEnv = () => {
    const authPath = `/run/user/${process.getuid()}/gdm/Xauthority`;
    const env: NodeJS.ProcessEnv = { ...process.env, DISPLAY: ':1', QT_QPA_PLATFORM: 'xcb' };
    if (fs.existsSync(authPath)) env['XAUTHORITY'] = authPath;
    else {
        const homeAuth = path.join(process.env.HOME || '', '.Xauthority');
        if (fs.existsSync(homeAuth)) env['XAUTHORITY'] = homeAuth;
    }
    return env;
};

const PATHS = {
    imageInbox: path.join(BASE_SYNC_PATH, "image/assigned", WORKER_ID, "inbox"),
    videoInbox: path.join(BASE_SYNC_PATH, "video/assigned", WORKER_ID, "inbox"),
    processingVideo: path.join(RUNTIME_PATH, "processing/video"),
    logs: path.join(RUNTIME_PATH, "logs/node.log")
};

const logger = createLogger({
    level: 'info',
    format: format.combine(format.timestamp(), format.json()),
    transports: [ new transports.Console(), new transports.File({ filename: PATHS.logs }) ]
});

const jobQueue: string[] = [];
let isProcessing = false;
const activeJobs = new Set<string>();
const debounceTimers = new Map<string, NodeJS.Timeout>();

function addToQueue(jobName: string) {
    if (activeJobs.has(jobName)) return;
    logger.info(`📥 Added to Queue: ${jobName}`);
    activeJobs.add(jobName);
    jobQueue.push(jobName);
    processNext();
}

async function processNext() {
    if (isProcessing) return;
    
    if (fs.existsSync(PAUSE_FILE)) {
        logger.warn("⏸️ WORKER PAUSED. Waiting 5s...");
        setTimeout(processNext, 5000);
        return;
    }

    if (jobQueue.length === 0) return;

    const jobName = jobQueue[0]; 
    if (!jobName) return;

    isProcessing = true;
    try {
        const finished = await processVideoJob(jobName);
        if (finished) {
            jobQueue.shift(); 
            activeJobs.delete(jobName);
            logger.info(`✅ Job ${jobName} completely finished.`);
            
            // --- CLEANUP (Der Müllschlucker) ---
            const jobPath = path.join(PATHS.processingVideo, jobName);
            logger.info(`🧹 Cleaning up: Deleting ${jobPath}`);
            await fs.remove(jobPath); // Löscht den Job Ordner im Processing
            
        } else {
             logger.info(`🔄 Job ${jobName} paused/partial.`);
        }
    } catch (e: any) {
        logger.error(`Error in processing: ${e.message}`);
        jobQueue.shift();
        activeJobs.delete(jobName);
    } finally {
        isProcessing = false;
        setTimeout(processNext, 2000);
    }
}

const killZombies = () => {
    return new Promise<void>((resolve) => {
        logger.info("🧟 Checking for Zombie 'actexec' processes...");
        exec('pkill -f actexec', (err) => {
            if (!err) logger.info("🔫 Killed old actexec instances.");
            else logger.info("✨ No zombies found (clean start).");
            resolve();
        });
    });
};

const startWatcher = async () => {
    logger.info(`RenderFleet Daemon v32 (Auto-Cleanup) starting...`);
    
    await killZombies();

    fs.ensureDirSync(STAGE_PATH);
    fs.ensureDirSync(PATHS.processingVideo);
    fs.ensureDirSync(DOWNLOADS_PATH); 
    fs.ensureDirSync(OUTBOX_PATH);
    
    recoverCrashedJobs();

    const watcher = chokidar.watch([PATHS.imageInbox, PATHS.videoInbox], {
        ignored: /(^|[\/\\])\../, persistent: true, depth: 2,
        awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 }
    });

    watcher.on('add', (filePath) => {
        const fileName = path.basename(filePath);
        if (fileName === "READY" && filePath.includes("video")) {
            const jobFolder = path.dirname(filePath);
            const jobName = path.basename(jobFolder);
            const targetPath = path.join(PATHS.processingVideo, jobName);
            
            if (activeJobs.has(jobName)) return;

            if (debounceTimers.has(jobName)) {
                logger.info(`🔄 Resetting timer for ${jobName}`);
                clearTimeout(debounceTimers.get(jobName));
            }

            logger.info(`⏱️ Timer started for ${jobName}. Waiting 3s...`);
            
            const timer = setTimeout(async () => {
                debounceTimers.delete(jobName);
                try {
                    if (fs.existsSync(targetPath)) {
                        logger.info(`✋ Job ${jobName} already in processing.`);
                        addToQueue(jobName);
                        return;
                    }
                    if (fs.existsSync(jobFolder)) {
                         logger.info(`🚚 Moving ${jobName} to processing...`);
                         await fs.move(jobFolder, targetPath, { overwrite: true });
                         addToQueue(jobName);
                    }
                } catch(e: any) { logger.error(`Move failed: ${e.message}`); }
            }, 3000);

            debounceTimers.set(jobName, timer);
        }
    });
};

async function recoverCrashedJobs() {
    try {
        const jobs = await fs.readdir(PATHS.processingVideo);
        for (const job of jobs) {
            const jobPath = path.join(PATHS.processingVideo, job);
            if (fs.statSync(jobPath).isDirectory()) {
                logger.info(`🚑 Recovering job: ${job}`);
                addToQueue(job);
            }
        }
    } catch(e) { logger.error("Recovery failed: " + e); }
}

// --- MULTI-TAKE SYNC LOGIC ---
async function grabAndSyncAllTakes(jobName: string, imageName: string, outputDir: string) {
    let grabbedCount = 0;
    try {
        const files = await fs.readdir(DOWNLOADS_PATH);
        const validFiles = files.filter(f => !f.startsWith('.')); 

        if (validFiles.length === 0) {
            logger.warn(`⚠️ No files found in download folder.`);
            return false;
        }

        logger.info(`🎣 Found ${validFiles.length} files. Syncing...`);
        validFiles.sort(); 

        // Ziel-Ordner in der Outbox: /sync/video/outbox/JOBNAME/
        const jobOutboxDir = path.join(OUTBOX_PATH, jobName);
        await fs.ensureDir(jobOutboxDir); 

        let takeCounter = 1;
        for (const file of validFiles) {
            const sourcePath = path.join(DOWNLOADS_PATH, file);
            const ext = path.extname(file) || ".mp4"; 
            
            // Name: img001_take1.mp4
            const baseName = imageName.replace(/\.(png|jpg)$/, '');
            const targetName = `${baseName}_take${takeCounter}${ext}`;
            
            // 1. Move to Processing Output (als Zwischenspeicher, wird später gelöscht)
            const localOutputPath = path.join(outputDir, targetName);
            await fs.move(sourcePath, localOutputPath, { overwrite: true });
            
            // 2. COPY to Outbox (Das bleibt!)
            const finalSyncPath = path.join(jobOutboxDir, targetName);

            logger.info(`📤 Outbox: ${jobName}/${targetName}`);
            await fs.copy(localOutputPath, finalSyncPath, { overwrite: true });
            
            takeCounter++;
            grabbedCount++;
        }

    } catch(e: any) { logger.error(`Multi-Grabber failed: ${e.message}`); }
    
    return grabbedCount > 0;
}

async function processVideoJob(jobName: string): Promise<boolean> {
    const jobPath = path.join(PATHS.processingVideo, jobName);
    const inputDir = path.join(jobPath, "input"); 
    const outputDir = path.join(jobPath, "output"); 
    
    logger.info(`▶️ Checking Job: ${jobName}`);

    if (!fs.existsSync(jobPath)) return true; // Job schon weg?
    
    await fs.ensureDir(inputDir);
    await fs.ensureDir(outputDir);

    const rootFiles = await fs.readdir(jobPath);
    for (const file of rootFiles) {
        const srcPath = path.join(jobPath, file);
        if (file !== "input" && file !== "output") {
            const stat = await fs.stat(srcPath);
            if (stat.isFile()) {
                await fs.move(srcPath, path.join(inputDir, file), { overwrite: true });
            }
        }
    }

    let promptData: any = {};
    try {
        const pFile = path.join(inputDir, "prompts.json");
        if (fs.existsSync(pFile)) promptData = await fs.readJson(pFile);
    } catch(e) {}

    const allFiles = await fs.readdir(inputDir);
    const images = allFiles.filter(f => (f.endsWith('.png') || f.endsWith('.jpg')) && !f.includes('output'));

    if (images.length === 0) {
        logger.warn("No images found in input folder.");
        return true; 
    }

    for (const image of images) {
        if (fs.existsSync(PAUSE_FILE)) return false;

        const doneMarker = path.join(outputDir, `${image}.done`);
        if (fs.existsSync(doneMarker)) {
            logger.info(`⏭️ Skipping ${image} (Already done)`);
            continue;
        }

        logger.info(`⚙️ Processing Item: ${image}`);

        await fs.emptyDir(DOWNLOADS_PATH); // Downloads leeren
        await fs.emptyDir(STAGE_PATH);     // Stage leeren

        await fs.copy(path.join(inputDir, image), path.join(STAGE_PATH, image));
        if (Object.keys(promptData).length > 0) {
             await fs.writeJson(path.join(STAGE_PATH, "prompts.json"), promptData);
        }

        const promptText = promptData[image] || "Dynamic Motion";

        await runActionaStep(jobName, image, promptText);

        const success = await grabAndSyncAllTakes(jobName, image, outputDir);

        if (success) {
            await fs.ensureFile(doneMarker);
            logger.info(`✔️ Item ${image} finished.`);
        } else {
            logger.warn(`⚠️ No results for ${image}. Continuing...`);
            // Wir markieren es trotzdem als Done, damit wir nicht ewig loopen?
            // Nein, besser nochmal versuchen beim nächsten Loop, falls es ein Fehler war.
        }
    }

    return true; // Gibt 'true' zurück -> Startet Cleanup in processNext()
}

function runActionaStep(jobName: string, imageName: string, prompt: string): Promise<void> {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(SCRIPT_PATH)) {
            logger.error(`❌ Script missing: ${SCRIPT_PATH}`);
            resolve(); return;
        }

        const env = getGuiEnv();
        env['RF_PROJECT_NAME'] = jobName;
        env['RF_IMAGE_NAME'] = imageName;
        env['RF_PROMPT'] = prompt;

        logger.info(`🚀 Launching ACTEXEC for ${imageName}...`);

        const cmd = `actexec "${SCRIPT_PATH}"`; 
        
        exec(cmd, { env: env, cwd: STAGE_PATH }, (error, stdout, stderr) => {
            if (error) {
                logger.error(`❌ ACTEXEC Error: ${stderr}`);
            } else {
                logger.info(`✅ Step finished.`);
            }
            resolve();
        });
    });
}

startWatcher();
