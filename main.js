const path = require("path");
const { app, BrowserWindow, ipcMain } = require("electron");
const { initDb, listModels, addModel } = require("./db");

/**
 * Main Process entry.
 * - Creates BrowserWindow with <webview> support
 * - Initializes SQLite and seeds default models
 * - Registers IPC handlers for renderer <-> DB communication
 */

let mainWindow = null;
let dbHandle = null;

function registerIpcHandlers() {
  ipcMain.handle("models:list", async () => {
    return await listModels(dbHandle.db);
  });

  ipcMain.handle("models:add", async (_event, payload) => {
    return await addModel(dbHandle.db, payload || {});
  });
}

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: "#0b0f14",
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
  dbHandle = await initDb({ userDataPath: app.getPath("userData") });
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

