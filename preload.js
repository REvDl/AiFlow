const { contextBridge, ipcRenderer } = require("electron");

/**
 * Preload (runs in isolated context).
 * Exposes a minimal, typed-like API to the renderer.
 *
 * Renderer is intentionally "Vanilla web" (no Node access).
 */

contextBridge.exposeInMainWorld("AiFlow", {
  env: {
    /** Set GOOGLE_OAUTH_CLIENT_ID in the environment before starting Electron (never commit real values). */
    googleOAuthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID || "",
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

