/**
 * Renderer (Vanilla JS).
 * Responsibilities:
 * - Load models from main process via IPC (preload bridge)
 * - Render sidebar list with favicons
 * - Cache <webview> instances and switch instantly (hide/show)
 * - Enforce per-domain persistent partition isolation
 */

const CHROME_UA = navigator.userAgent;

const els = {
  appRoot: document.getElementById("appRoot"),
  sidebarToggle: document.getElementById("sidebarToggle"),
  sidebarToggleFloating: document.getElementById("sidebarToggleFloating"),
  list: document.getElementById("modelsList"),
  loginBtn: document.getElementById("loginBtn"),
  authState: document.getElementById("authState"),
  addForm: document.getElementById("addForm"),
  urlInput: document.getElementById("urlInput"),
  webviewHost: document.getElementById("webviewHost"),
  emptyState: document.getElementById("emptyState"),
  hintText: document.getElementById("hintText"),
};

let state = {
  models: [],
  activeId: null,
  auth: {
    provider: null,
  },
};

function handleAuthSuccess(data) {
  if (data?.ok === true || data?.event === "auth:success") {
    state.auth.isAuthenticated = true;
    console.log("[auth FINAL STATE]", state.auth.isAuthenticated);
    renderAuthUi();
  }
}

const webviewCache = new Map();

function buildGoogleOAuthPayload() {
  const clientId = String(window.AiFlow?.env?.googleOAuthClientId || "").trim();
  return {
    provider: "google",
    authBaseUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    clientId,
    scope: ["openid", "email", "profile"],
    responseType: "code",
    syncWebSession: true,
    extraParams: {
      prompt: "consent",
      access_type: "offline",
    },
  };
}

function renderAuthUi() {
  const loggedIn = state.auth.isAuthenticated;

  if (els.loginBtn) {
    els.loginBtn.style.display = loggedIn ? "none" : "";
  }

  if (els.authState) {
    if (!loggedIn) {
      els.authState.textContent = "Not logged in";
      return;
    }

    const provider = state.auth.provider || "OAuth";
    const authType = state.auth.lastResult?.code
      ? "code"
      : state.auth.lastResult?.token?.accessToken || state.auth.lastResult?.token?.idToken
        ? "token"
        : "callback";

    els.authState.textContent = `Logged in via ${provider} (${authType})`;
  }
}

function safeUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return null;

  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

function normalizeUrlForCompare(url) {
  const s = String(url || "").trim();
  if (!s) return "";

  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.toString();
  } catch {
    return "";
  }
}

function extractDomain(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "unknown";
  }
}

function isGoogleServiceHost(hostname) {
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

function storagePartitionKeyForUrl(url) {
  const domain = extractDomain(url);
  return isGoogleServiceHost(domain) ? "google-services" : domain;
}

function expectedWebviewPartitionForUrl(url) {
  const key = storagePartitionKeyForUrl(url);
  return `persist:${toPartitionId(key)}`;
}

function toPartitionId(domainOrName) {
  return String(domainOrName || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "unknown";
}

function faviconUrl(model) {
  const domain = extractDomain(model?.url || "");
  return `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`;
}

function renderModels() {
  els.list.innerHTML = "";

  const sorted = [...state.models].sort((a, b) => {
    const ap = Number(a.is_pinned) ? 1 : 0;
    const bp = Number(b.is_pinned) ? 1 : 0;
    if (ap !== bp) return bp - ap;
    return Number(a.id) - Number(b.id);
  });

  for (const m of sorted) {
    const row = document.createElement("div");
    row.className = "model-row";
    row.dataset.id = String(m.id);
    row.setAttribute("aria-current", state.activeId === m.id ? "true" : "false");

    const icon = document.createElement("div");
    icon.className = "model-item__icon";

    const img = document.createElement("img");
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.src = faviconUrl(m);

    icon.appendChild(img);

    const meta = document.createElement("div");
    meta.className = "model-item__meta";

    const name = document.createElement("div");
    name.className = "model-item__name";
    name.textContent = m.name + (Number(m.is_pinned) ? " · Pinned" : "");

    const url = document.createElement("div");
    url.className = "model-item__url";
    url.textContent = m.url;

    meta.appendChild(name);
    meta.appendChild(url);

    const mainBtn = document.createElement("button");
    mainBtn.className = "model-main";
    mainBtn.type = "button";

    mainBtn.appendChild(icon);
    mainBtn.appendChild(meta);

    mainBtn.addEventListener("click", () => {
      setActiveModel(m.id);
    });

    const actions = document.createElement("div");
    actions.className = "model-actions";

    const pinBtn = document.createElement("button");
    pinBtn.className = `mini-btn ${Number(m.is_pinned) ? "pin-on" : ""}`;
    pinBtn.type = "button";
    pinBtn.textContent = "📌";

    pinBtn.addEventListener("click", async (e) => {
      e.stopPropagation();

      const updated = await window.AiFlow.models.togglePin({ id: m.id });

      state.models = state.models.map((x) =>
        x.id === updated.id ? updated : x
      );

      renderModels();
    });

    const delBtn = document.createElement("button");
    delBtn.className = "mini-btn mini-btn--danger";
    delBtn.type = "button";
    delBtn.textContent = "🗑";

    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();

      await window.AiFlow.models.delete({ id: m.id });

      const cached = webviewCache.get(m.id);
      if (cached?.webview && cached.webview.isConnected) {
        cached.webview.remove();
      }

      webviewCache.delete(m.id);

      const wasActive = state.activeId === m.id;

      await refreshModels();

      if (wasActive) {
        state.activeId = null;
        els.emptyState.style.display = "grid";
        els.hintText.textContent = "Model deleted.";
        hideAllWebviews();
      }
    });

    actions.appendChild(pinBtn);
    actions.appendChild(delBtn);

    row.appendChild(mainBtn);
    row.appendChild(actions);

    els.list.appendChild(row);
  }
}

// === ОЧИЩЕННЫЙ WEBVIEW ===
function createWebview({ url, partitionKey }) {
  const webview = document.createElement("webview");

  webview.setAttribute("src", url);
  webview.setAttribute("partition", `persist:${toPartitionId(partitionKey)}`);
  webview.setAttribute("allowpopups", "true");
  webview.setAttribute("useragent", CHROME_UA);

  webview.addEventListener("did-fail-load", (e) => {
    console.error("[webview] did-fail-load", e);
  });

  return webview;
}

function hideAllWebviews() {
  for (const { webview } of webviewCache.values()) {
    if (webview) webview.classList.remove("active");
  }
}

function mountWebviewForModel(model) {
  const url = safeUrl(model.url);
  if (!url) return;

  const partitionKey = storagePartitionKeyForUrl(url);
  const expectedPartition = expectedWebviewPartitionForUrl(url);

  let cached = webviewCache.get(model.id);

  if (cached?.webview?.getAttribute("partition") !== expectedPartition) {
    if (cached?.webview?.isConnected) cached.webview.remove();
    webviewCache.delete(model.id);
    cached = null;
  }

  if (!cached) {
    const wv = createWebview({ url, partitionKey });

    els.webviewHost.appendChild(wv);

    cached = { webview: wv, modelId: model.id };

    webviewCache.set(model.id, cached);
  } else {
    const current = normalizeUrlForCompare(
      cached.webview.getAttribute("src")
    );
    const next = normalizeUrlForCompare(url);

    if (current && next && current !== next) {
      cached.webview.setAttribute("src", url);
    }
  }

  hideAllWebviews();
  cached.webview.classList.add("active");

  els.emptyState.style.display = "none";
  els.hintText.textContent = `Active: ${model.name}`;
}

function setActiveModel(id) {
  state.activeId = id;
  renderModels();

  const m = state.models.find((x) => x.id === id);
  if (m) mountWebviewForModel(m);
}

async function refreshModels({ autoSelectFirst = false } = {}) {
  state.models = await window.AiFlow.models.list();
  renderModels();

  if (autoSelectFirst && state.models.length > 0 && state.activeId == null) {
    setActiveModel(state.models[0].id);
  }
}

els.sidebarToggle?.addEventListener("click", () => {
  if (!els.appRoot) return;
  els.appRoot.classList.toggle("app--collapsed");
});

els.sidebarToggleFloating?.addEventListener("click", () => {
  if (!els.appRoot) return;
  els.appRoot.classList.toggle("app--collapsed");
});

els.addForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const url = safeUrl(els.urlInput.value);

  if (!url) {
    els.hintText.textContent = "Please enter a valid http(s) URL.";
    return;
  }

  const inserted = await window.AiFlow.models.add({ url });

  els.urlInput.value = "";

  await refreshModels();
  setActiveModel(inserted.id);
});

els.loginBtn?.addEventListener("click", () => {
  const oauthPayload = buildGoogleOAuthPayload();
  if (!oauthPayload.clientId) {
    els.hintText.textContent =
      "Set environment variable GOOGLE_OAUTH_CLIENT_ID and restart AiFlow.";
    return;
  }
  window.AiFlow.oauth.start(oauthPayload);
});

refreshModels({ autoSelectFirst: true });

window.AiFlow.oauth.onAuth((data) => {
  state.auth.lastResult = data || null;
  state.auth.provider = data?.provider || null;

  const success =
    data?.ok ||
    data?.event === "auth:success" ||
    !!data?.code ||
    !!data?.access_token ||
    !!data?.id_token;

  if (success) state.auth.isAuthenticated = true;

  renderAuthUi();

  if (success && data?.googleWebSessionBridge) {
    els.hintText.textContent =
      "OAuth OK — finish Google sign-in in the extra window so in-app Google tabs reuse that session.";
  } else if (success) {
    els.hintText.textContent = "Login successful";
  } else {
    els.hintText.textContent = "Login failed";
  }
});

renderAuthUi();