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
      icon_url TEXT
    )
  `.trim(),
  );
}

async function seedDefaultsIfEmpty(db) {
  const row = await get(db, "SELECT COUNT(*) AS cnt FROM models");
  if ((row?.cnt ?? 0) > 0) return;

  const defaults = [
    { name: "ChatGPT", url: "https://chat.openai.com/" },
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
  return await all(db, "SELECT id, name, url, icon_url FROM models ORDER BY id ASC");
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
    "INSERT INTO models (name, url, icon_url) VALUES (?, ?, ?)",
    [derivedName, trimmedUrl, buildFaviconUrl(trimmedUrl)],
  );

  const inserted = await get(db, "SELECT id, name, url, icon_url FROM models WHERE id = ?", [
    lastID,
  ]);
  return inserted;
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
  return { db, dbPath };
}

module.exports = {
  initDb,
  listModels,
  addModel,
};

