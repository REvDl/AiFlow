const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { app, BrowserWindow, ipcMain, session, shell } = require("electron");
const { initDb, listModels, addModel } = require("./db");

/**
 * Main Process entry.
 * - Creates BrowserWindow with <webview> support
 * - Initializes SQLite and seeds default models
 * - Registers IPC handlers for renderer <-> DB communication
 */

let mainWindow = null;
let dbHandle = null;
let oauthServer = null;
let oauthServerPort = null;

const DEEP_LINK_PROTOCOL = "aiflow";
const DEEP_LINK_REDIRECT_URI = `${DEEP_LINK_PROTOCOL}://auth/callback`;
const pendingOAuthStates = new Map();
const hasSingleInstanceLock = app.requestSingleInstanceLock();

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

function sendToRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function sendOAuthEvent(payload) {
  sendToRenderer("oauth", payload);
}

function sendAuthEvent(payload) {
  sendToRenderer("auth", payload);
}

function randomState() {
  return crypto.randomBytes(16).toString("hex");
}

function parseScope(scope) {
  if (Array.isArray(scope)) {
    return scope
      .map((x) => String(x || "").trim())
      .filter(Boolean)
      .join(" ");
  }
  return String(scope || "").trim();
}

function getProtocolUrlFromArgv(argv) {
  if (!Array.isArray(argv)) return null;
  const match = argv.find((x) => String(x || "").startsWith(`${DEEP_LINK_PROTOCOL}://`));
  return match || null;
}

function registerDeepLinkProtocol() {
  if (process.defaultApp) {
    return app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  }
  return app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL);
}

function parseAuthResultFromUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const code = u.searchParams.get("code");
    const state = u.searchParams.get("state");
    const error = u.searchParams.get("error") || u.searchParams.get("error_description");

    const fragment = String(u.hash || "").replace(/^#/, "");
    const fragParams = new URLSearchParams(fragment);
    const access_token = fragParams.get("access_token");
    const id_token = fragParams.get("id_token");

    if (error) return { type: "error", error, url: rawUrl, state };
    if (code) return { type: "code", code, url: rawUrl, state };
    if (access_token || id_token) {
      return { type: "token", access_token, id_token, url: rawUrl, state };
    }
    return { type: "unknown", url: rawUrl, state };
  } catch {
    return null;
  }
}

function completeOAuthFromCallback(rawUrl, source) {
  const parsed = parseAuthResultFromUrl(rawUrl);
  if (!parsed) return false;

  const flow = parsed.state ? pendingOAuthStates.get(parsed.state) : null;
  if (parsed.state) pendingOAuthStates.delete(parsed.state);

  const provider = flow?.provider || null;
  const ok = parsed.type !== "error";
  const token = {
    code: parsed.code || null,
    accessToken: parsed.access_token || null,
    idToken: parsed.id_token || null,
    tokenType: parsed.type === "token" ? "bearer-or-id" : parsed.type,
  };
  const sessionData = {
    authenticated: ok,
    provider,
    source,
    state: parsed.state || null,
    callbackUrl: parsed.url || rawUrl,
    authenticatedAt: new Date().toISOString(),
  };

  sendAuthEvent({
    ok,
    source,
    provider,
    user: null,
    session: sessionData,
    token,
    ...parsed,
  });
  return true;
}

function parseAndHandleProtocolUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== `${DEEP_LINK_PROTOCOL}:`) return false;
    if (u.hostname !== "auth") return false;
    if (!u.pathname.startsWith("/callback")) return false;
    return completeOAuthFromCallback(rawUrl, "deep-link");
  } catch {
    return false;
  }
}

async function ensureLocalhostCallbackServer() {
  if (oauthServer && oauthServerPort) {
    return { port: oauthServerPort, redirectUri: `http://127.0.0.1:${oauthServerPort}/callback` };
  }

  await new Promise((resolve, reject) => {
    oauthServer = http.createServer((req, res) => {
      try {
        const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
        if (reqUrl.pathname !== "/callback") {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Not found");
          return;
        }

        const fullCallbackUrl = `http://127.0.0.1:${oauthServerPort}${reqUrl.pathname}${reqUrl.search || ""}${reqUrl.hash || ""}`;
        const handled = completeOAuthFromCallback(fullCallbackUrl, "localhost");

        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(
          `<!doctype html><html><body style="font-family:sans-serif;padding:20px;">
             <h3>${handled ? "Login completed" : "Login callback received"}</h3>
             <p>You can return to AiFlow.</p>
           </body></html>`,
        );
      } catch {
        res.statusCode = 500;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Internal callback error");
      }
    });

    oauthServer.on("error", reject);
    oauthServer.listen(0, "127.0.0.1", () => {
      const address = oauthServer.address();
      if (!address || typeof address === "string") {
        return reject(new Error("Failed to bind localhost callback server."));
      }
      oauthServerPort = address.port;
      resolve();
    });
  });

  return { port: oauthServerPort, redirectUri: `http://127.0.0.1:${oauthServerPort}/callback` };
}

async function startOAuthFlow(payload = {}) {
  const provider = String(payload.provider || "generic").trim();
  const protocolRegistered = registerDeepLinkProtocol();
  const useLocalhostFallback = Boolean(payload.useLocalhostFallback || !protocolRegistered);

  let redirectUri = DEEP_LINK_REDIRECT_URI;
  if (useLocalhostFallback) {
    const local = await ensureLocalhostCallbackServer();
    redirectUri = local.redirectUri;
  }

  let authUrlString = String(payload.url || "").trim();
  if (!authUrlString) {
    const authBaseUrl = String(payload.authBaseUrl || "").trim();
    if (!authBaseUrl) throw new Error("OAuth authBaseUrl is required.");

    const parsedBase = new URL(authBaseUrl);
    if (parsedBase.protocol !== "https:" && parsedBase.protocol !== "http:") {
      throw new Error("OAuth authBaseUrl must be http(s).");
    }

    const state = String(payload.state || randomState());
    const scope = parseScope(payload.scope);
    pendingOAuthStates.set(state, { provider, createdAt: Date.now() });

    parsedBase.searchParams.set("client_id", String(payload.clientId || "").trim());
    parsedBase.searchParams.set("redirect_uri", String(payload.redirectUri || redirectUri));
    parsedBase.searchParams.set("response_type", String(payload.responseType || "code"));
    parsedBase.searchParams.set("state", state);
    if (scope) parsedBase.searchParams.set("scope", scope);

    if (payload.extraParams && typeof payload.extraParams === "object") {
      for (const [key, value] of Object.entries(payload.extraParams)) {
        if (value == null) continue;
        parsedBase.searchParams.set(key, String(value));
      }
    }
    authUrlString = parsedBase.toString();
  }

  const parsed = new URL(authUrlString);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Only http(s) OAuth URLs are allowed.");
  }

  sendOAuthEvent({
    stage: "opening-browser",
    message: "Login opened in secure browser...",
    provider,
    redirectUri,
    callbackMode: useLocalhostFallback ? "localhost" : "deep-link",
  });

  await shell.openExternal(parsed.toString());

  return {
    ok: true,
    provider,
    redirectUri,
    callbackMode: useLocalhostFallback ? "localhost" : "deep-link",
    authUrl: parsed.toString(),
  };
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

  /**
   * OAuth flow entrypoint.
   * Renderer must NOT run OAuth inside <webview>.
   * Open auth URL in the system default browser.
   */
  ipcMain.handle("oauth", async (_event, payload) => await startOAuthFlow(payload || {}));
  // Backward compatibility with previous renderer API.
  ipcMain.handle("oauth:start", async (_event, payload) => await startOAuthFlow(payload || {}));
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

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.whenReady().then(async () => {
    setSafeUserAgentFallback();
    registerDeepLinkProtocol();

    const initialProtocolUrl = getProtocolUrlFromArgv(process.argv);
    if (initialProtocolUrl) {
      app.once("browser-window-created", () => {
        parseAndHandleProtocolUrl(initialProtocolUrl);
      });
    }

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
}

app.on("second-instance", (_event, argv) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  const protocolUrl = getProtocolUrlFromArgv(argv);
  if (protocolUrl) parseAndHandleProtocolUrl(protocolUrl);
});

app.on("open-url", (event, url) => {
  event.preventDefault();
  parseAndHandleProtocolUrl(url);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

