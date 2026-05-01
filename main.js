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
let googleBridgeWindow = null;
const configuredUserAgentSessions = new WeakSet();

const DEEP_LINK_PROTOCOL = "aiflow";
const DEEP_LINK_REDIRECT_URI = `${DEEP_LINK_PROTOCOL}://auth/callback`;
const OAUTH_LOOPBACK_PORT = 53682;
/** Must exactly match redirect registered for your Google OAuth client (Web) or documented loopback (Desktop). */
const OAUTH_FIXED_LOOPBACK_REDIRECT_URI = `http://127.0.0.1:${OAUTH_LOOPBACK_PORT}/callback`;
/** All embedded Google-origin sites share one session so OAuth bridge + webviews align. */
const GOOGLE_SERVICES_PARTITION = "persist:google-services";
const pendingOAuthStates = new Map();
const hasSingleInstanceLock = app.requestSingleInstanceLock();
const WEBAUTHN_BLOCKED_FEATURES = "WebAuthentication,WebAuthnConditionalUI";

// Prevent passkey/Windows Hello prompts in embedded auth pages (<webview> and renderer).
app.commandLine.appendSwitch("disable-features", WEBAUTHN_BLOCKED_FEATURES);
// eslint-disable-next-line no-console
console.log("[auth] webauthn blocked or bypassed");

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

function getChromeLikeUaMetadata() {
  const fullChromeVersion = process.versions?.chrome || "124.0.0.0";
  const majorVersion = String(fullChromeVersion).split(".")[0] || "124";
  return {
    userAgent:
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
      `Chrome/${fullChromeVersion} Safari/537.36`,
    secChUa: `"Not:A-Brand";v="99", "Google Chrome";v="${majorVersion}", "Chromium";v="${majorVersion}"`,
    secChUaMobile: "?0",
    secChUaPlatform: '"Windows"',
  };
}

function enforceChromeLikeRequestHeaders(targetSession) {
  if (!targetSession || configuredUserAgentSessions.has(targetSession)) return;
  configuredUserAgentSessions.add(targetSession);

  targetSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const nextHeaders = { ...(details.requestHeaders || {}) };
    const uaMeta = getChromeLikeUaMetadata();

    // Keep headers browser-like for providers that reject embedded auth flows.
    nextHeaders["User-Agent"] = uaMeta.userAgent;
    nextHeaders["sec-ch-ua"] = uaMeta.secChUa;
    nextHeaders["sec-ch-ua-mobile"] = uaMeta.secChUaMobile;
    nextHeaders["sec-ch-ua-platform"] = uaMeta.secChUaPlatform;

    callback({ requestHeaders: nextHeaders });
  });
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
    return u.hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "unknown";
  }
}

function isGoogleServiceDomain(hostname) {
  const h = String(hostname || "")
    .toLowerCase()
    .replace(/^www\./i, "");
  if (!h) return false;
  return (
    h === "google.com" ||
    h.endsWith(".google.com") ||
    h === "googleusercontent.com" ||
    h.endsWith(".googleusercontent.com") ||
    h === "googleapis.com" ||
    h.endsWith(".googleapis.com") ||
    h === "gstatic.com" ||
    h.endsWith(".gstatic.com")
  );
}

function buildOAuthPendingEntry(provider, payload, isGoogleFlow) {
  let syncWebSession = Boolean(isGoogleFlow);
  if (typeof payload?.syncWebSession === "boolean") syncWebSession = payload.syncWebSession;
  return { provider, createdAt: Date.now(), syncWebSession };
}

function openGoogleWebSessionBridgeWindow() {
  /**
   * System Chrome cannot expose Google cookies to Electron. After desktop OAuth succeeds,
   * we open Google sign-in in an Electron BrowserWindow using the SAME session partition as
   * <webview>s for *.google.com, so cookie-based Google web apps work inside AiFlow.
   */
  try {
    if (googleBridgeWindow && !googleBridgeWindow.isDestroyed()) {
      googleBridgeWindow.focus();
      return;
    }

    googleBridgeWindow = new BrowserWindow({
      width: 480,
      height: 760,
      parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
      autoHideMenuBar: true,
      backgroundColor: "#ffffff",
      title: "Google · link in-app session",
      webPreferences: {
        partition: GOOGLE_SERVICES_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        disableBlinkFeatures: WEBAUTHN_BLOCKED_FEATURES,
      },
    });

    googleBridgeWindow.once("closed", () => {
      googleBridgeWindow = null;
    });

    googleBridgeWindow.webContents.once("did-finish-load", () => {
      googleBridgeWindow?.setTitle("Google · AiFlow · sign in, then close this window");
    });

    googleBridgeWindow.loadURL("https://accounts.google.com/");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[AiFlow] Google session bridge:", err?.message || err);
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
      if (isGoogleServiceDomain(domain)) {
        partitions.add(GOOGLE_SERVICES_PARTITION);
      }
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
  const shouldBridgeGoogleCookies =
    ok &&
    provider === "google" &&
    flow?.syncWebSession === true &&
    parsed.type !== "unknown";
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
    googleWebSessionBridge: Boolean(shouldBridgeGoogleCookies),
    ...parsed,
  });

  if (shouldBridgeGoogleCookies) {
    queueMicrotask(() => openGoogleWebSessionBridgeWindow());
  }
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
    return { port: OAUTH_LOOPBACK_PORT, redirectUri: OAUTH_FIXED_LOOPBACK_REDIRECT_URI };
  }

  await new Promise((resolve, reject) => {
    oauthServer = http.createServer((req, res) => {
      try {
        const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
        if (req.method === "POST" && reqUrl.pathname === "/token-report") {
          let body = "";
          req.on("data", (chunk) => {
            body += String(chunk || "");
            if (body.length > 100000) req.destroy();
          });
          req.on("end", () => {
            try {
              const parsedBody = JSON.parse(body || "{}");
              const params = new URLSearchParams();
              if (parsedBody.access_token) params.set("access_token", String(parsedBody.access_token));
              if (parsedBody.id_token) params.set("id_token", String(parsedBody.id_token));
              if (parsedBody.state) params.set("state", String(parsedBody.state));
              if (parsedBody.error) params.set("error", String(parsedBody.error));

              const syntheticUrl = `${OAUTH_FIXED_LOOPBACK_REDIRECT_URI}#${params.toString()}`;
              completeOAuthFromCallback(syntheticUrl, "localhost-fragment");
              res.statusCode = 200;
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.end(JSON.stringify({ ok: true }));
            } catch {
              res.statusCode = 400;
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.end(JSON.stringify({ ok: false, error: "Invalid token report payload" }));
            }
          });
          return;
        }

        if (reqUrl.pathname !== "/callback") {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Not found");
          return;
        }

        const fullCallbackUrl = `${OAUTH_FIXED_LOOPBACK_REDIRECT_URI}${reqUrl.search || ""}${reqUrl.hash || ""}`;
        const handled = completeOAuthFromCallback(fullCallbackUrl, "localhost");

        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(
          `<!doctype html>
<html>
  <body style="font-family:sans-serif;padding:20px;line-height:1.45">
    <h3 id="title">${handled ? "Login completed" : "Login callback received"}</h3>
    <p id="description">You can return to AiFlow.</p>
    <script>
      (async function () {
        const hash = String(location.hash || "").replace(/^#/, "");
        if (!hash) {
          setTimeout(() => window.close(), 300);
          return;
        }

        try {
          const params = new URLSearchParams(hash);
          const payload = {
            access_token: params.get("access_token"),
            id_token: params.get("id_token"),
            state: params.get("state"),
            error: params.get("error") || params.get("error_description"),
          };

          await fetch("/token-report", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });

          document.getElementById("title").textContent = "Login completed";
          document.getElementById("description").textContent = "Token delivered to AiFlow. You can close this tab.";
          setTimeout(() => window.close(), 500);
        } catch {
          document.getElementById("title").textContent = "Login completed";
          document.getElementById("description").textContent = "Please return to AiFlow manually.";
        }
      })();
    </script>
  </body>
</html>`,
        );
      } catch {
        res.statusCode = 500;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Internal callback error");
      }
    });

    oauthServer.on("error", (err) => {
      reject(
        new Error(
          `Failed to bind localhost callback server on 127.0.0.1:${OAUTH_LOOPBACK_PORT}. ` +
            `Close the process using this port and try again. Original error: ${err?.message || err}`,
        ),
      );
    });
    oauthServer.listen(OAUTH_LOOPBACK_PORT, "127.0.0.1", () => {
      const address = oauthServer.address();
      if (!address || typeof address === "string") {
        return reject(new Error("Failed to bind localhost callback server."));
      }
      oauthServerPort = address.port;
      resolve();
    });
  });

  return { port: OAUTH_LOOPBACK_PORT, redirectUri: OAUTH_FIXED_LOOPBACK_REDIRECT_URI };
}

async function startOAuthFlow(payload = {}) {
  const provider = String(payload.provider || "generic").trim();
  const protocolRegistered = registerDeepLinkProtocol();
  const providerHint = `${provider} ${String(payload.authBaseUrl || "")} ${String(payload.url || "")}`.toLowerCase();
  const isGoogleFlow = /google|accounts\.google\.com/.test(providerHint);
  /** Normalize so Google URLs from webviews still get cookie bridge + pending state. */
  const oauthProvider = isGoogleFlow ? "google" : provider;
  const useLocalhostFallback = Boolean(
    payload.useLocalhostFallback || isGoogleFlow || !protocolRegistered || process.defaultApp,
  );

  let redirectUri = DEEP_LINK_REDIRECT_URI;
  if (useLocalhostFallback) {
    await ensureLocalhostCallbackServer();
    redirectUri = OAUTH_FIXED_LOOPBACK_REDIRECT_URI;
  }

  let authUrlString = String(payload.url || "").trim();
  let ensuredState = null;
  if (!authUrlString) {
    const authBaseUrl = String(payload.authBaseUrl || "").trim();
    if (!authBaseUrl) throw new Error("OAuth authBaseUrl is required.");
    const clientId = String(payload.clientId || "").trim();
    if (!clientId) throw new Error("OAuth clientId is required.");

    const parsedBase = new URL(authBaseUrl);
    if (parsedBase.protocol !== "https:" && parsedBase.protocol !== "http:") {
      throw new Error("OAuth authBaseUrl must be http(s).");
    }

    const state = String(payload.state || randomState());
    ensuredState = state;
    const scope = parseScope(payload.scope);
    pendingOAuthStates.set(state, buildOAuthPendingEntry(oauthProvider, payload, isGoogleFlow));

    parsedBase.searchParams.set("client_id", clientId);
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
  // Some providers pass a fully-built authorize URL from the web app.
  // Ensure callback params are still bound to this app so the flow can complete.
  const looksLikeOAuth =
    /oauth|authorize|signin|login|accounts\.google\.com/i.test(authUrlString) ||
    parsed.searchParams.has("client_id") ||
    parsed.searchParams.has("response_type") ||
    parsed.searchParams.has("scope");
  if (looksLikeOAuth) {
    const preserveRedirectUri = Boolean(payload.preserveRedirectUri);
    if (!parsed.searchParams.get("client_id")) {
      const fallbackClientId = String(payload.clientId || "").trim();
      if (fallbackClientId) parsed.searchParams.set("client_id", fallbackClientId);
    }
    if (!preserveRedirectUri) {
      parsed.searchParams.set("redirect_uri", String(payload.redirectUri || redirectUri));
    }
    const stateParam = String(parsed.searchParams.get("state") || payload.state || randomState());
    parsed.searchParams.set("state", stateParam);
    ensuredState = stateParam;
    pendingOAuthStates.set(stateParam, buildOAuthPendingEntry(oauthProvider, payload, isGoogleFlow));
  }
  const url = parsed.toString();

  sendOAuthEvent({
    stage: "opening-browser",
    message: "Login opened in secure browser...",
    provider: oauthProvider,
    redirectUri,
    callbackMode: useLocalhostFallback ? "localhost" : "deep-link",
  });

  // eslint-disable-next-line no-console
  console.log('Final Auth URL:', url);
  await shell.openExternal(url);

  return {
    ok: true,
    provider: oauthProvider,
    state: ensuredState,
    redirectUri,
    callbackMode: useLocalhostFallback ? "localhost" : "deep-link",
    authUrl: url,
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
  ipcMain.handle("google:openWebSessionBridge", () => {
    openGoogleWebSessionBridgeWindow();
    return { ok: true };
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
      disableBlinkFeatures: WEBAUTHN_BLOCKED_FEATURES,

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
    enforceChromeLikeRequestHeaders(session.defaultSession);
    app.on("session-created", (createdSession) => {
      enforceChromeLikeRequestHeaders(createdSession);
    });
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

