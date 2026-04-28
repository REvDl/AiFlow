const path = require("path");
const sqlite3 = require("sqlite3").verbose();

/**
 * SQLite helper (Main Process).
 * - Creates `models` table on boot
 * - Seeds default rows if empty
 *
 * The renderer never talks to SQLite directly — use IPC handlers in `main.js`.
 */

function openDb(dbFilePath) {
  return new sqlite3.Database(dbFilePath);
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

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

function sanitizeDomainForFavicon(url) {
  try {
    const u = new URL(url);
    return u.hostname;
  } catch {
    return "";
  }
}

function buildFaviconUrl(url) {
  const domain = sanitizeDomainForFavicon(url);
  if (!domain) return "";
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
}

async function ensureSchema(db) {
  await run(
    db,
    `
    CREATE TABLE IF NOT EXISTS models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      icon_url TEXT,
      is_pinned INTEGER NOT NULL DEFAULT 0
    )
  `.trim(),
  );

  // Lightweight migration: older DBs may not have `is_pinned`.
  // We add it in-place to keep existing user data.
  const cols = await all(db, "PRAGMA table_info(models)");
  const hasPinned = cols.some((c) => c && c.name === "is_pinned");
  if (!hasPinned) {
    await run(db, "ALTER TABLE models ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0");
  }
}

async function seedDefaultsIfEmpty(db) {
  const row = await get(db, "SELECT COUNT(*) AS cnt FROM models");
  if ((row?.cnt ?? 0) > 0) return;

  const defaults = [
    // NOTE: chat.openai.com is frequently blocked/broken in embedded browsers.
    // Use chatgpt.com as the default entrypoint.
    { name: "ChatGPT", url: "https://chatgpt.com/" },
    { name: "DeepSeek", url: "https://chat.deepseek.com/" },
    { name: "Gemini", url: "https://gemini.google.com/" },
  ];

  for (const m of defaults) {
    await run(db, "INSERT INTO models (name, url, icon_url) VALUES (?, ?, ?)", [
      m.name,
      m.url,
      buildFaviconUrl(m.url),
    ]);
  }
}

async function listModels(db) {
  return await all(
    db,
    "SELECT id, name, url, icon_url, is_pinned FROM models ORDER BY is_pinned DESC, id ASC",
  );
}

async function addModel(db, { name, url }) {
  const trimmedUrl = String(url || "").trim();
  if (!trimmedUrl) throw new Error("URL is required.");

  // Name is optional from UI; we will derive something stable if not provided.
  let derivedName = String(name || "").trim();
  if (!derivedName) {
    try {
      const u = new URL(trimmedUrl);
      derivedName = u.hostname.replace(/^www\./i, "");
    } catch {
      derivedName = "Custom AI";
    }
  }

  const { lastID } = await run(
    db,
    "INSERT INTO models (name, url, icon_url, is_pinned) VALUES (?, ?, ?, 0)",
    [derivedName, trimmedUrl, buildFaviconUrl(trimmedUrl)],
  );

  const inserted = await get(db, "SELECT id, name, url, icon_url, is_pinned FROM models WHERE id = ?", [
    lastID,
  ]);
  return inserted;
}

async function migrateChatGPTUrl(db) {
  /**
   * Migration:
   * If user already has the old URL stored (https://chat.openai.com/),
   * update it to https://chatgpt.com/ so <webview> can load it.
   *
   * Handle potential uniqueness conflict if user already added chatgpt.com manually.
   */
  const oldUrl = "https://chat.openai.com/";
  const newUrl = "https://chatgpt.com/";

  const existingNew = await get(db, "SELECT id FROM models WHERE url = ?", [newUrl]);
  if (existingNew) {
    // If new exists, remove the old record(s) to satisfy UNIQUE(url).
    await run(db, "DELETE FROM models WHERE url = ?", [oldUrl]);
    await run(db, "DELETE FROM models WHERE url LIKE ?", ["https://chat.openai.com/%"]);
    return;
  }

  await run(
    db,
    "UPDATE models SET url = ?, icon_url = ? WHERE url = ? OR url LIKE ?",
    [newUrl, buildFaviconUrl(newUrl), oldUrl, "https://chat.openai.com/%"],
  );
}

/**
 * Initializes and returns a DB handle.
 * Keep a single DB connection for the app lifecycle.
 */
async function initDb({ userDataPath }) {
  const dbPath = path.join(userDataPath, "aiflow.sqlite");
  const db = openDb(dbPath);
  await ensureSchema(db);
  await seedDefaultsIfEmpty(db);
  await migrateChatGPTUrl(db);
  return { db, dbPath };
}

module.exports = {
  initDb,
  listModels,
  addModel,
};

