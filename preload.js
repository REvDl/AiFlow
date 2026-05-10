const { contextBridge, ipcRenderer } = require("electron");

/**
 * Preload (runs in isolated context).
 * Exposes a minimal, typed-like API to the renderer.
 *
 * Renderer is intentionally "Vanilla web" (no Node access).
 */

contextBridge.exposeInMainWorld("AiFlow", {
  env: {
    // ID уже загружен в процессе main.js через dotenv,
    // так что мы просто безопасно прокидываем его сюда
    googleOAuthClientId: String(process.env.GOOGLE_OAUTH_CLIENT_ID || "").trim(),
  },
  models: {
    list: () => ipcRenderer.invoke("models:list"),
    add: (payload) => ipcRenderer.invoke("models:add", payload),
    delete: (payload) => ipcRenderer.invoke("models:delete", payload),
    togglePin: (payload) => ipcRenderer.invoke("models:togglePin", payload),
  },
  oauth: {
    // Renderer -> Main
    start: (payload) => ipcRenderer.invoke("oauth:start", payload),
    logout: () => ipcRenderer.invoke("oauth:logout"),
    // Backward compatibility with previous channel name.
    startLegacy: (payload) => ipcRenderer.invoke("oauth", payload),
    // Main -> Renderer
    onOAuth: (handler) => {
      ipcRenderer.on("oauth", (_event, data) => handler(data));
    },
    onAuth: (handler) => {
      ipcRenderer.on("auth", (_event, data) => handler(data));
    },
  },
  google: {
    openWebSessionBridge: () => ipcRenderer.invoke("google:openWebSessionBridge"),
  },
});