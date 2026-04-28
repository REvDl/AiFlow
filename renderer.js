/**
 * Renderer (Vanilla JS).
 * Responsibilities:
 * - Load models from main process via IPC (preload bridge)
 * - Render sidebar list with favicons
 * - Cache <webview> instances and switch instantly (hide/show)
 * - Enforce per-domain persistent partition isolation
 */

// Use the current UA (main process sets app.userAgentFallback to a safe Chrome-like UA).
const CHROME_UA = navigator.userAgent;

const els = {
  appRoot: document.getElementById("appRoot"),
  sidebarToggle: document.getElementById("sidebarToggle"),
  sidebarToggleFloating: document.getElementById("sidebarToggleFloating"),
  list: document.getElementById("modelsList"),
  addForm: document.getElementById("addForm"),
  urlInput: document.getElementById("urlInput"),
  webviewHost: document.getElementById("webviewHost"),
  emptyState: document.getElementById("emptyState"),
  hintText: document.getElementById("hintText"),
};

let state = {
  models: [],
  activeId: null,
};

// Webview cache: keep created instances to allow instant switching.
// Key: model.id (stable) -> { webview, modelId }
const webviewCache = new Map();

function safeUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    // For simplicity and safety, keep to http(s).
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

function normalizeUrlForCompare(url) {
  // Avoid accidental reloads from minor formatting differences (trailing slash, etc.).
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

function toPartitionId(domainOrName) {
  // Critical: ensure partition is stable and safe.
  // Example: "chat.openai.com" -> "chat-openai-com"
  return String(domainOrName || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "unknown";
}

function faviconUrl(model) {
  const domain = extractDomain(model?.url || "");
  // DuckDuckGo icons API (more permissive for embeds than Google in practice).
  // Example: https://icons.duckduckgo.com/ip3/openai.com.ico
  return `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`;
}

function renderModels() {
  els.list.innerHTML = "";

  // Sort: pinned first, then by id (stable).
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
    pinBtn.title = Number(m.is_pinned) ? "Unpin" : "Pin";
    pinBtn.setAttribute("aria-label", pinBtn.title);
    pinBtn.textContent = "📌";
    pinBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        const updated = await window.AiFlow.models.togglePin({ id: m.id });
        // Update local state with returned row.
        state.models = state.models.map((x) => (x.id === updated.id ? updated : x));
        renderModels();
      } catch (err) {
        els.hintText.textContent = `Failed to toggle pin: ${err?.message || String(err)}`;
      }
    });

    const delBtn = document.createElement("button");
    delBtn.className = "mini-btn mini-btn--danger";
    delBtn.type = "button";
    delBtn.title = "Delete";
    delBtn.setAttribute("aria-label", "Delete");
    delBtn.textContent = "🗑";
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await window.AiFlow.models.delete({ id: m.id });
        // Remove cached webview too (to free memory).
        const cached = webviewCache.get(m.id);
        if (cached?.webview && cached.webview.isConnected) {
          cached.webview.remove();
        }
        webviewCache.delete(m.id);

        // Refresh DB-driven list (ensures consistency).
        const wasActive = state.activeId === m.id;
        await refreshModels();
        if (wasActive) {
          state.activeId = null;
          els.emptyState.style.display = "grid";
          els.hintText.textContent = "Model deleted.";
          hideAllWebviews();
        }
      } catch (err) {
        els.hintText.textContent = `Failed to delete model: ${err?.message || String(err)}`;
      }
    });

    actions.appendChild(pinBtn);
    actions.appendChild(delBtn);

    row.appendChild(mainBtn);
    row.appendChild(actions);
    els.list.appendChild(row);
  }
}

function createWebview({ url, domainKey }) {
  const webview = document.createElement("webview");
  webview.setAttribute("src", url);
  webview.setAttribute("partition", `persist:${toPartitionId(domainKey)}`);
  webview.setAttribute("allowpopups", "true");
  // Force a Chrome-like UA at element level (some services are strict in embedded contexts).
  webview.setAttribute("useragent", CHROME_UA);

  // Set Chrome UA to reduce site blocks on embedded webviews.
  webview.addEventListener("dom-ready", () => {
    try {
      webview.setUserAgent(CHROME_UA);
    } catch {
      // Some Electron versions may not expose setUserAgent on the element; ignore silently.
    }
  });

  // Visibility/debug: report failed loads in DevTools console.
  webview.addEventListener("did-fail-load", (e) => {
    // eslint-disable-next-line no-console
    console.error("[webview] did-fail-load", {
      errorCode: e?.errorCode,
      errorDescription: e?.errorDescription,
      validatedURL: e?.validatedURL,
      isMainFrame: e?.isMainFrame,
    });
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

  // Critical isolation rule:
  // Each model gets its own persistent partition based on its domain,
  // so cookies/sessions do not overlap across different AI sites.
  const domain = extractDomain(url);

  // Instant switching:
  // - Do NOT delete existing <webview>s
  // - Keep them cached and only toggle visibility
  let cached = webviewCache.get(model.id);
  if (!cached) {
    const wv = createWebview({ url, domainKey: domain });
    els.webviewHost.appendChild(wv);
    cached = { webview: wv, modelId: model.id };
    webviewCache.set(model.id, cached);
  } else {
    // If URL changed for an existing model, update src (partition stays the same for its domain).
    const current = normalizeUrlForCompare(cached.webview.getAttribute("src"));
    const next = normalizeUrlForCompare(url);
    if (current && next && current !== next) {
      cached.webview.setAttribute("src", url);
    }
  }

  hideAllWebviews();
  // Avoid white flash: keep webviews mounted, toggle visibility via CSS class.
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

els.addForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = safeUrl(els.urlInput.value);
  if (!url) {
    els.hintText.textContent = "Please enter a valid http(s) URL.";
    return;
  }

  try {
    const inserted = await window.AiFlow.models.add({ url });
    els.urlInput.value = "";
    await refreshModels();
    setActiveModel(inserted.id);
  } catch (err) {
    els.hintText.textContent = `Failed to add model: ${err?.message || String(err)}`;
  }
});

// Sidebar collapse/expand
function toggleSidebar(force) {
  if (typeof force === "boolean") {
    els.appRoot.classList.toggle("app--collapsed", force);
  } else {
    els.appRoot.classList.toggle("app--collapsed");
  }
}

els.sidebarToggle.addEventListener("click", () => toggleSidebar());
els.sidebarToggleFloating.addEventListener("click", () => toggleSidebar(false));

// Boot
refreshModels({ autoSelectFirst: true }).catch((err) => {
  els.hintText.textContent = `Failed to load models: ${err?.message || String(err)}`;
});

