"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/index.ts
var import_chokidar = __toESM(require("chokidar"));
var import_fs_extra = __toESM(require("fs-extra"));
var import_path = __toESM(require("path"));
var import_child_process = require("child_process");
var import_winston = require("winston");
var WORKER_ID = "worker001";
var BASE_SYNC_PATH = "/srv/renderfleet/sync";
var RUNTIME_PATH = "/srv/renderfleet/runtime";
var STAGE_PATH = "/srv/renderfleet/stage";
var SCRIPT_PATH = import_path.default.join(BASE_SYNC_PATH, "video/tools/RunwayVideo.ascr");
var PAUSE_FILE = import_path.default.join(RUNTIME_PATH, "PAUSED");
var DOWNLOADS_PATH = "/srv/renderfleet/runtime/downloads/general";
var OUTBOX_PATH = import_path.default.join(BASE_SYNC_PATH, "video/outbox");
var getGuiEnv = () => {
  const authPath = `/run/user/${process.getuid()}/gdm/Xauthority`;
  const env = { ...process.env, DISPLAY: ":1", QT_QPA_PLATFORM: "xcb" };
  if (import_fs_extra.default.existsSync(authPath)) env["XAUTHORITY"] = authPath;
  else {
    const homeAuth = import_path.default.join(process.env.HOME || "", ".Xauthority");
    if (import_fs_extra.default.existsSync(homeAuth)) env["XAUTHORITY"] = homeAuth;
  }
  return env;
};
var PATHS = {
  imageInbox: import_path.default.join(BASE_SYNC_PATH, "image/assigned", WORKER_ID, "inbox"),
  videoInbox: import_path.default.join(BASE_SYNC_PATH, "video/assigned", WORKER_ID, "inbox"),
  processingVideo: import_path.default.join(RUNTIME_PATH, "processing/video"),
  logs: import_path.default.join(RUNTIME_PATH, "logs/node.log")
};
var logger = (0, import_winston.createLogger)({
  level: "info",
  format: import_winston.format.combine(import_winston.format.timestamp(), import_winston.format.json()),
  transports: [new import_winston.transports.Console(), new import_winston.transports.File({ filename: PATHS.logs })]
});
var jobQueue = [];
var isProcessing = false;
var activeJobs = /* @__PURE__ */ new Set();
var debounceTimers = /* @__PURE__ */ new Map();
function addToQueue(jobName) {
  if (activeJobs.has(jobName)) return;
  logger.info(`\u{1F4E5} Added to Queue: ${jobName}`);
  activeJobs.add(jobName);
  jobQueue.push(jobName);
  processNext();
}
async function processNext() {
  if (isProcessing) return;
  if (import_fs_extra.default.existsSync(PAUSE_FILE)) {
    logger.warn("\u23F8\uFE0F WORKER PAUSED. Waiting 5s...");
    setTimeout(processNext, 5e3);
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
      logger.info(`\u2705 Job ${jobName} completely finished.`);
      const jobPath = import_path.default.join(PATHS.processingVideo, jobName);
      logger.info(`\u{1F9F9} Cleaning up: Deleting ${jobPath}`);
      await import_fs_extra.default.remove(jobPath);
    } else {
      logger.info(`\u{1F504} Job ${jobName} paused/partial.`);
    }
  } catch (e) {
    logger.error(`Error in processing: ${e.message}`);
    jobQueue.shift();
    activeJobs.delete(jobName);
  } finally {
    isProcessing = false;
    setTimeout(processNext, 2e3);
  }
}
var killZombies = () => {
  return new Promise((resolve) => {
    logger.info("\u{1F9DF} Checking for Zombie 'actexec' processes...");
    (0, import_child_process.exec)("pkill -f actexec", (err) => {
      if (!err) logger.info("\u{1F52B} Killed old actexec instances.");
      else logger.info("\u2728 No zombies found (clean start).");
      resolve();
    });
  });
};
var startWatcher = async () => {
  logger.info(`RenderFleet Daemon v32 (Auto-Cleanup) starting...`);
  await killZombies();
  import_fs_extra.default.ensureDirSync(STAGE_PATH);
  import_fs_extra.default.ensureDirSync(PATHS.processingVideo);
  import_fs_extra.default.ensureDirSync(DOWNLOADS_PATH);
  import_fs_extra.default.ensureDirSync(OUTBOX_PATH);
  recoverCrashedJobs();
  const watcher = import_chokidar.default.watch([PATHS.imageInbox, PATHS.videoInbox], {
    ignored: /(^|[\/\\])\../,
    persistent: true,
    depth: 2,
    awaitWriteFinish: { stabilityThreshold: 2e3, pollInterval: 100 }
  });
  watcher.on("add", (filePath) => {
    const fileName = import_path.default.basename(filePath);
    if (fileName === "READY" && filePath.includes("video")) {
      const jobFolder = import_path.default.dirname(filePath);
      const jobName = import_path.default.basename(jobFolder);
      const targetPath = import_path.default.join(PATHS.processingVideo, jobName);
      if (activeJobs.has(jobName)) return;
      if (debounceTimers.has(jobName)) {
        logger.info(`\u{1F504} Resetting timer for ${jobName}`);
        clearTimeout(debounceTimers.get(jobName));
      }
      logger.info(`\u23F1\uFE0F Timer started for ${jobName}. Waiting 3s...`);
      const timer = setTimeout(async () => {
        debounceTimers.delete(jobName);
        try {
          if (import_fs_extra.default.existsSync(targetPath)) {
            logger.info(`\u270B Job ${jobName} already in processing.`);
            addToQueue(jobName);
            return;
          }
          if (import_fs_extra.default.existsSync(jobFolder)) {
            logger.info(`\u{1F69A} Moving ${jobName} to processing...`);
            await import_fs_extra.default.move(jobFolder, targetPath, { overwrite: true });
            addToQueue(jobName);
          }
        } catch (e) {
          logger.error(`Move failed: ${e.message}`);
        }
      }, 3e3);
      debounceTimers.set(jobName, timer);
    }
  });
};
async function recoverCrashedJobs() {
  try {
    const jobs = await import_fs_extra.default.readdir(PATHS.processingVideo);
    for (const job of jobs) {
      const jobPath = import_path.default.join(PATHS.processingVideo, job);
      if (import_fs_extra.default.statSync(jobPath).isDirectory()) {
        logger.info(`\u{1F691} Recovering job: ${job}`);
        addToQueue(job);
      }
    }
  } catch (e) {
    logger.error("Recovery failed: " + e);
  }
}
async function grabAndSyncAllTakes(jobName, imageName, outputDir) {
  let grabbedCount = 0;
  try {
    const files = await import_fs_extra.default.readdir(DOWNLOADS_PATH);
    const validFiles = files.filter((f) => !f.startsWith("."));
    if (validFiles.length === 0) {
      logger.warn(`\u26A0\uFE0F No files found in download folder.`);
      return false;
    }
    logger.info(`\u{1F3A3} Found ${validFiles.length} files. Syncing...`);
    validFiles.sort();
    const jobOutboxDir = import_path.default.join(OUTBOX_PATH, jobName);
    await import_fs_extra.default.ensureDir(jobOutboxDir);
    let takeCounter = 1;
    for (const file of validFiles) {
      const sourcePath = import_path.default.join(DOWNLOADS_PATH, file);
      const ext = import_path.default.extname(file) || ".mp4";
      const baseName = imageName.replace(/\.(png|jpg)$/, "");
      const targetName = `${baseName}_take${takeCounter}${ext}`;
      const localOutputPath = import_path.default.join(outputDir, targetName);
      await import_fs_extra.default.move(sourcePath, localOutputPath, { overwrite: true });
      const finalSyncPath = import_path.default.join(jobOutboxDir, targetName);
      logger.info(`\u{1F4E4} Outbox: ${jobName}/${targetName}`);
      await import_fs_extra.default.copy(localOutputPath, finalSyncPath, { overwrite: true });
      takeCounter++;
      grabbedCount++;
    }
  } catch (e) {
    logger.error(`Multi-Grabber failed: ${e.message}`);
  }
  return grabbedCount > 0;
}
async function processVideoJob(jobName) {
  const jobPath = import_path.default.join(PATHS.processingVideo, jobName);
  const inputDir = import_path.default.join(jobPath, "input");
  const outputDir = import_path.default.join(jobPath, "output");
  logger.info(`\u25B6\uFE0F Checking Job: ${jobName}`);
  if (!import_fs_extra.default.existsSync(jobPath)) return true;
  await import_fs_extra.default.ensureDir(inputDir);
  await import_fs_extra.default.ensureDir(outputDir);
  const rootFiles = await import_fs_extra.default.readdir(jobPath);
  for (const file of rootFiles) {
    const srcPath = import_path.default.join(jobPath, file);
    if (file !== "input" && file !== "output") {
      const stat = await import_fs_extra.default.stat(srcPath);
      if (stat.isFile()) {
        await import_fs_extra.default.move(srcPath, import_path.default.join(inputDir, file), { overwrite: true });
      }
    }
  }
  let promptData = {};
  try {
    const pFile = import_path.default.join(inputDir, "prompts.json");
    if (import_fs_extra.default.existsSync(pFile)) promptData = await import_fs_extra.default.readJson(pFile);
  } catch (e) {
  }
  const allFiles = await import_fs_extra.default.readdir(inputDir);
  const images = allFiles.filter((f) => (f.endsWith(".png") || f.endsWith(".jpg")) && !f.includes("output"));
  if (images.length === 0) {
    logger.warn("No images found in input folder.");
    return true;
  }
  for (const image of images) {
    if (import_fs_extra.default.existsSync(PAUSE_FILE)) return false;
    const doneMarker = import_path.default.join(outputDir, `${image}.done`);
    if (import_fs_extra.default.existsSync(doneMarker)) {
      logger.info(`\u23ED\uFE0F Skipping ${image} (Already done)`);
      continue;
    }
    logger.info(`\u2699\uFE0F Processing Item: ${image}`);
    await import_fs_extra.default.emptyDir(DOWNLOADS_PATH);
    await import_fs_extra.default.emptyDir(STAGE_PATH);
    await import_fs_extra.default.copy(import_path.default.join(inputDir, image), import_path.default.join(STAGE_PATH, image));
    if (Object.keys(promptData).length > 0) {
      await import_fs_extra.default.writeJson(import_path.default.join(STAGE_PATH, "prompts.json"), promptData);
    }
    const promptText = promptData[image] || "Dynamic Motion";
    await runActionaStep(jobName, image, promptText);
    const success = await grabAndSyncAllTakes(jobName, image, outputDir);
    if (success) {
      await import_fs_extra.default.ensureFile(doneMarker);
      logger.info(`\u2714\uFE0F Item ${image} finished.`);
    } else {
      logger.warn(`\u26A0\uFE0F No results for ${image}. Continuing...`);
    }
  }
  return true;
}
function runActionaStep(jobName, imageName, prompt) {
  return new Promise((resolve, reject) => {
    if (!import_fs_extra.default.existsSync(SCRIPT_PATH)) {
      logger.error(`\u274C Script missing: ${SCRIPT_PATH}`);
      resolve();
      return;
    }
    const env = getGuiEnv();
    env["RF_PROJECT_NAME"] = jobName;
    env["RF_IMAGE_NAME"] = imageName;
    env["RF_PROMPT"] = prompt;
    logger.info(`\u{1F680} Launching ACTEXEC for ${imageName}...`);
    const cmd = `actexec "${SCRIPT_PATH}"`;
    (0, import_child_process.exec)(cmd, { env, cwd: STAGE_PATH }, (error, stdout, stderr) => {
      if (error) {
        logger.error(`\u274C ACTEXEC Error: ${stderr}`);
      } else {
        logger.info(`\u2705 Step finished.`);
      }
      resolve();
    });
  });
}
startWatcher();
