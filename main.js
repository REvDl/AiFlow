const path = require("path");
const { app, BrowserWindow, ipcMain, session } = require("electron");
const { initDb, listModels, addModel } = require("./db");

/**
 * Main Process entry.
 * - Creates BrowserWindow with <webview> support
 * - Initializes SQLite and seeds default models
 * - Registers IPC handlers for renderer <-> DB communication
 */

let mainWindow = null;
let dbHandle = null;

/**
 * IMPORTANT:
 * Some providers block sign-in in Electron/embedded browsers if the UA looks suspicious
 * (e.g., old Chrome versions or explicit "Electron/xx" tokens).
 * We set a global Chrome-like UA based on Electron's bundled Chromium.
 */
function setSafeUserAgentFallback() {
  const chromeVersion = process.versions?.chrome || "124.0.0.0";
  app.userAgentFallback =
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${chromeVersion} Safari/537.36`;
}

function toPartitionId(domainOrName) {
  return (
    String(domainOrName || "unknown")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "unknown"
  );
}

function extractDomain(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\\./i, "").toLowerCase();
  } catch {
    return "unknown";
  }
}

async function resetAllWebviewSessions() {
  /**
   * Session reset (requested):
   * Clears cache/storage for all persistent partitions used by models.
   *
   * Note: This will log you out of sites in those partitions.
   * It is intended as a recovery/diagnostic tool, not a permanent solution.
   */
  try {
    const models = await listModels(dbHandle.db);
    const partitions = new Set();
    for (const m of models) {
      const domain = extractDomain(m.url);
      partitions.add(`persist:${toPartitionId(domain)}`);
    }

    for (const p of partitions) {
      const s = session.fromPartition(p);
      await s.clearCache();
      await s.clearStorageData();
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[AiFlow] Failed to reset sessions:", err?.message || err);
  }
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function registerIpcHandlers() {
  ipcMain.handle("models:list", async () => {
    return await listModels(dbHandle.db);
  });

  ipcMain.handle("models:add", async (_event, payload) => {
    return await addModel(dbHandle.db, payload || {});
  });

  // Deletes a model by id.
  ipcMain.handle("models:delete", async (_event, { id }) => {
    const modelId = Number(id);
    if (!Number.isFinite(modelId)) throw new Error("Invalid id.");
    await run(dbHandle.db, "DELETE FROM models WHERE id = ?", [modelId]);
    return { ok: true };
  });

  // Toggles pinned flag for a model and returns updated row.
  ipcMain.handle("models:togglePin", async (_event, { id }) => {
    const modelId = Number(id);
    if (!Number.isFinite(modelId)) throw new Error("Invalid id.");
    await run(
      dbHandle.db,
      "UPDATE models SET is_pinned = CASE WHEN is_pinned = 1 THEN 0 ELSE 1 END WHERE id = ?",
      [modelId],
    );
    const updated = await get(
      dbHandle.db,
      "SELECT id, name, url, icon_url, is_pinned FROM models WHERE id = ?",
      [modelId],
    );
    return updated;
  });
}

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: "#0b0f14",
    // Hide the default Windows menu bar (File/Edit/View...).
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,

      // Required by your spec: enable <webview>.
      webviewTag: true,
    },
  });

  await mainWindow.loadFile(path.join(__dirname, "index.html"));

  // Optional: keep it clean for a strict UI.
  // mainWindow.removeMenu();
}

app.whenReady().then(async () => {
  setSafeUserAgentFallback();
  dbHandle = await initDb({ userDataPath: app.getPath("userData") });
  await resetAllWebviewSessions();
  registerIpcHandlers();
  await createMainWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

