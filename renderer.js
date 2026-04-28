/**
 * Renderer (Vanilla JS).
 * Responsibilities:
 * - Load models from main process via IPC (preload bridge)
 * - Render sidebar list with favicons
 * - Create / replace <webview> with per-domain persistent partition isolation
 */

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const els = {
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
  if (model?.icon_url) return model.icon_url;
  const domain = extractDomain(model?.url || "");
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
}

function renderModels() {
  els.list.innerHTML = "";

  for (const m of state.models) {
    const btn = document.createElement("button");
    btn.className = "model-item";
    btn.type = "button";
    btn.dataset.id = String(m.id);
    btn.setAttribute("aria-current", state.activeId === m.id ? "true" : "false");

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
    name.textContent = m.name;
    const url = document.createElement("div");
    url.className = "model-item__url";
    url.textContent = m.url;
    meta.appendChild(name);
    meta.appendChild(url);

    btn.appendChild(icon);
    btn.appendChild(meta);

    btn.addEventListener("click", () => {
      setActiveModel(m.id);
    });

    els.list.appendChild(btn);
  }
}

function createWebview({ url, domainKey }) {
  // IMPORTANT:
  // partition cannot be reliably "switched" after the webview is created.
  // So we replace the <webview> element each time.
  const webview = document.createElement("webview");
  webview.setAttribute("src", url);
  webview.setAttribute("partition", `persist:${toPartitionId(domainKey)}`);
  webview.setAttribute("allowpopups", "true");

  // Set Chrome UA to reduce site blocks on embedded webviews.
  webview.addEventListener("dom-ready", () => {
    try {
      webview.setUserAgent(CHROME_UA);
    } catch {
      // Some Electron versions may not expose setUserAgent on the element; ignore silently.
    }
  });

  return webview;
}

function mountWebviewForModel(model) {
  const url = safeUrl(model.url);
  if (!url) return;

  // Critical isolation rule:
  // Each model gets its own persistent partition based on its domain,
  // so cookies/sessions do not overlap across different AI sites.
  const domain = extractDomain(url);

  els.webviewHost.innerHTML = "";
  const wv = createWebview({ url, domainKey: domain });
  els.webviewHost.appendChild(wv);

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

// Boot
refreshModels({ autoSelectFirst: true }).catch((err) => {
  els.hintText.textContent = `Failed to load models: ${err?.message || String(err)}`;
});

