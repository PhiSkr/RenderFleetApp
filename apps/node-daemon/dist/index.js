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
var import_path2 = __toESM(require("path"));
var import_chokidar = __toESM(require("chokidar"));

// src/config.ts
var import_fs_extra = __toESM(require("fs-extra"));

// src/logger.ts
var import_winston = __toESM(require("winston"));
var import_path = __toESM(require("path"));
var LOG_DIR = "/srv/renderfleet/runtime/logs";
var LOG_FILE = import_path.default.join(LOG_DIR, "node.log");
var logger = import_winston.default.createLogger({
  level: "info",
  format: import_winston.default.format.combine(
    import_winston.default.format.timestamp(),
    import_winston.default.format.json()
  ),
  transports: [
    // 1. Schreibe in Datei (für dauerhafte History)
    new import_winston.default.transports.File({ filename: LOG_FILE }),
    // 2. Schreibe in Konsole (für systemd journal)
    new import_winston.default.transports.Console({
      format: import_winston.default.format.combine(
        import_winston.default.format.colorize(),
        import_winston.default.format.simple()
      )
    })
  ]
});

// src/config.ts
var CONFIG_PATH = "/srv/renderfleet/config/node_config.json";
var DEFAULT_CONFIG = {
  workerId: "worker001",
  roles: ["video-worker", "video-dispatcher", "image-worker", "image-dispatcher"]
};
async function loadConfig() {
  try {
    if (await import_fs_extra.default.pathExists(CONFIG_PATH)) {
      const content = await import_fs_extra.default.readJson(CONFIG_PATH);
      logger.info("Config loaded from file.", { workerId: content.workerId });
      return { ...DEFAULT_CONFIG, ...content };
    } else {
      logger.warn("No config found. Creating default.");
      await import_fs_extra.default.outputJson(CONFIG_PATH, DEFAULT_CONFIG, { spaces: 2 });
      return DEFAULT_CONFIG;
    }
  } catch (error) {
    logger.error("Failed to load config, using default in-memory.", error);
    return DEFAULT_CONFIG;
  }
}

// src/index.ts
var SYNC_ROOT = "/srv/renderfleet/sync";
async function main() {
  logger.info("RenderFleet Node Daemon starting...");
  const config = await loadConfig();
  const workerId = config.workerId;
  logger.info(`Identity confirmed: ${workerId}`);
  const watchPaths = [
    import_path2.default.join(SYNC_ROOT, "image", "assigned", workerId, "inbox"),
    import_path2.default.join(SYNC_ROOT, "video", "assigned", workerId, "inbox")
  ];
  logger.info("Initializing watchers...", { paths: watchPaths });
  const watcher = import_chokidar.default.watch(watchPaths, {
    ignored: /(^|[\/\\])\../,
    // ignoriere hidden files (.DS_Store etc)
    persistent: true,
    depth: 1,
    // nur direkte Unterordner/Dateien
    awaitWriteFinish: {
      stabilityThreshold: 2e3,
      // Warte 2s bis Datei fertig geschrieben ist
      pollInterval: 100
    }
  });
  watcher.on("add", (filePath) => {
    logger.info(`\u{1F195} New File detected: ${filePath}`);
  }).on("addDir", (dirPath) => {
    logger.info(`\u{1F4C1} New Folder detected: ${dirPath}`);
  }).on("error", (error) => logger.error(`Watcher error: ${error}`));
  logger.info("Watcher is active. Waiting for jobs...");
}
main().catch((err) => {
  logger.error("Fatal startup error", err);
  process.exit(1);
});
