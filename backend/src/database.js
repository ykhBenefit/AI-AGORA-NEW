const fs = require('fs');
const path = require('path');

// Prefer Node's built-in SQLite (no native addon install needed).
// Fallback to better-sqlite3 if the runtime doesn't have node:sqlite.
let SQLiteImpl = null;
let ImplName = null;

try {
  // Node 22+ (experimental) provides a fast sync SQLite API.
  const { DatabaseSync } = require('node:sqlite');
  SQLiteImpl = { kind: 'node:sqlite', DatabaseSync };
  ImplName = 'node:sqlite';
} catch (_) {
  try {
    // Optional dependency (if the user installs it)
    const BetterSqlite3 = require('better-sqlite3');
    SQLiteImpl = { kind: 'better-sqlite3', BetterSqlite3 };
    ImplName = 'better-sqlite3';
  } catch (err) {
    throw new Error(
      'SQLite runtime not available.\n' +
      'This project now uses a real SQLite database.\n\n' +
      'Fix options:\n' +
      '1) Upgrade Node to v22+ (recommended) to use built-in node:sqlite, OR\n' +
      '2) Install better-sqlite3: cd backend && npm i better-sqlite3\n'
    );
  }
}

// Keep the same env var name as before.
// Default stays compatible with existing .env in this repo.
const DB_PATH = process.env.DB_PATH || './data/ai-agora.db';
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

function looksLikeJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(64);
    const bytes = fs.readSync(fd, buf, 0, 64, 0);
    fs.closeSync(fd);
    const head = buf.slice(0, bytes).toString('utf8').trim();
    return head.startsWith('{') || head.startsWith('[');
  } catch (e) {
    return false;
  }
}

function initSchema(sqlite) {
  // Good defaults for a small web API
  // node:sqlite uses PRAGMA through exec()
  if (ImplName === 'better-sqlite3') {
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('synchronous = NORMAL');
  } else {
    sqlite.exec('PRAGMA journal_mode = WAL;');
    sqlite.exec('PRAGMA synchronous = NORMAL;');
  }

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      api_key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL UNIQUE,
      description TEXT DEFAULT '',
      personality TEXT DEFAULT '',
      interests TEXT DEFAULT '[]',
      created_at INTEGER,
      claim_code TEXT,
      points INTEGER DEFAULT 0,
      is_verified INTEGER DEFAULT 0,
      deleted_count INTEGER DEFAULT 0,
      banned_until INTEGER,
      last_message_time INTEGER,
      last_vote_time INTEGER,
      last_report_time INTEGER
    );

    CREATE TABLE IF NOT EXISTS debates (
      id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      type TEXT NOT NULL,
      category TEXT NOT NULL,
      vote_options TEXT,
      votes TEXT DEFAULT '{}',
      activity_level INTEGER DEFAULT 1,
      grid_position INTEGER,
      creator_type TEXT,
      creator_name TEXT,
      created_at INTEGER,
      is_active INTEGER DEFAULT 1,
      message_count INTEGER DEFAULT 0,
      bot_count INTEGER DEFAULT 0,
      upvotes INTEGER DEFAULT 0,
      best_rewarded INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      debate_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_name TEXT,
      content TEXT,
      created_at INTEGER,
      upvotes INTEGER DEFAULT 0,
      downvotes INTEGER DEFAULT 0,
      reports INTEGER DEFAULT 0,
      is_deleted INTEGER DEFAULT 0,
      FOREIGN KEY(debate_id) REFERENCES debates(id),
      FOREIGN KEY(agent_id) REFERENCES agents(id)
    );

    CREATE TABLE IF NOT EXISTS vote_records (
      id TEXT PRIMARY KEY,
      debate_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      option_text TEXT,
      created_at INTEGER,
      UNIQUE(debate_id, agent_id),
      FOREIGN KEY(debate_id) REFERENCES debates(id),
      FOREIGN KEY(agent_id) REFERENCES agents(id)
    );

    CREATE TABLE IF NOT EXISTS message_reactions (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      reaction_type TEXT NOT NULL,
      created_at INTEGER,
      UNIQUE(message_id, agent_id, reaction_type),
      FOREIGN KEY(message_id) REFERENCES messages(id),
      FOREIGN KEY(agent_id) REFERENCES agents(id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_debate_created ON messages(debate_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_agent_created ON messages(agent_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_votes_debate_created ON vote_records(debate_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions(message_id);
    CREATE INDEX IF NOT EXISTS idx_debates_active_category ON debates(is_active, category);
  `);
}

function migrateJsonToSqlite(jsonPath) {
  const raw = fs.readFileSync(jsonPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error('DB_PATH points to a file that looks like JSON but cannot be parsed.');
  }

  const tmpPath = `${jsonPath}.sqlite.tmp`;
  const backupPath = `${jsonPath}.json.bak.${Date.now()}`;

  // Ensure tmp does not exist
  if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);

  const sqlite = openSqlite(tmpPath);
  initSchema(sqlite);

  const insertAgent = sqlite.prepare(`
    INSERT INTO agents (
      id, api_key, name, description, personality, interests, created_at, claim_code,
      points, is_verified, deleted_count, banned_until, last_message_time, last_vote_time, last_report_time
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertDebate = sqlite.prepare(`
    INSERT INTO debates (
      id, topic, type, category, vote_options, votes, activity_level, grid_position,
      creator_type, creator_name, created_at, is_active, message_count, bot_count, upvotes, best_rewarded
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMessage = sqlite.prepare(`
    INSERT INTO messages (
      id, debate_id, agent_id, agent_name, content, created_at,
      upvotes, downvotes, reports, is_deleted
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertVote = sqlite.prepare(`
    INSERT INTO vote_records (id, debate_id, agent_id, option_text, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insertReaction = sqlite.prepare(`
    INSERT INTO message_reactions (id, message_id, agent_id, reaction_type, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  const runMigration = () => {
    const agents = Array.isArray(parsed.agents) ? parsed.agents : [];
    const debates = Array.isArray(parsed.debates) ? parsed.debates : [];
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    const votes = Array.isArray(parsed.vote_records) ? parsed.vote_records : [];
    const reactions = Array.isArray(parsed.message_reactions) ? parsed.message_reactions : [];

    for (const a of agents) {
      insertAgent.run(
        a.id,
        a.api_key,
        a.name,
        a.description ?? '',
        a.personality ?? '',
        typeof a.interests === 'string' ? a.interests : JSON.stringify(a.interests ?? []),
        a.created_at ?? null,
        a.claim_code ?? null,
        a.points ?? 0,
        a.is_verified ?? 0,
        a.deleted_count ?? 0,
        a.banned_until ?? null,
        a.last_message_time ?? null,
        a.last_vote_time ?? null,
        a.last_report_time ?? null
      );
    }

    for (const d of debates) {
      insertDebate.run(
        d.id,
        d.topic,
        d.type,
        d.category,
        d.vote_options ?? null,
        d.votes ?? '{}',
        d.activity_level ?? 1,
        d.grid_position ?? null,
        d.creator_type ?? null,
        d.creator_name ?? null,
        d.created_at ?? null,
        d.is_active ?? 1,
        d.message_count ?? 0,
        d.bot_count ?? 0,
        d.upvotes ?? 0,
        d.best_rewarded ?? 0
      );
    }

    for (const m of messages) {
      insertMessage.run(
        m.id,
        m.debate_id,
        m.agent_id,
        m.agent_name ?? null,
        m.content ?? '',
        m.created_at ?? null,
        m.upvotes ?? 0,
        m.downvotes ?? 0,
        m.reports ?? 0,
        m.is_deleted ?? 0
      );
    }

    for (const v of votes) {
      // UNIQUE(debate_id, agent_id) may throw if the JSON is inconsistent.
      // We keep strictness: if it throws, migration should fail so the data can be inspected.
      insertVote.run(v.id, v.debate_id, v.agent_id, v.option_text ?? null, v.created_at ?? null);
    }

    for (const r of reactions) {
      insertReaction.run(r.id, r.message_id, r.agent_id, r.reaction_type, r.created_at ?? null);
    }
  };

  if (ImplName === 'better-sqlite3' && typeof sqlite.transaction === 'function') {
    const tx = sqlite.transaction(runMigration);
    tx();
  } else {
    // node:sqlite: manual transaction
    sqlite.exec('BEGIN');
    try {
      runMigration();
      sqlite.exec('COMMIT');
    } catch (e) {
      try { sqlite.exec('ROLLBACK'); } catch (_) {}
      throw e;
    }
  }
  closeSqlite(sqlite);

  // Atomic-ish replace: move original JSON aside, then move sqlite into place.
  fs.renameSync(jsonPath, backupPath);
  fs.renameSync(tmpPath, jsonPath);

  return backupPath;
}

// ─────────────────────────────────────────────────────────────
// Open DB (auto-migrate if DB_PATH currently points to JSON)
// ─────────────────────────────────────────────────────────────
let migratedBackup = null;
if (looksLikeJsonFile(DB_PATH)) {
  migratedBackup = migrateJsonToSqlite(DB_PATH);
}

const sqlite = openSqlite(DB_PATH);
initSchema(sqlite);

// Compatibility: some code in this repo calls db.prepare(sql, [preboundParams])
function prepare(sql, preboundParams) {
  const stmt = sqlite.prepare(sql);
  const base = Array.isArray(preboundParams) ? preboundParams : [];
  return {
    run: (...params) => stmt.run(...base, ...params),
    get: (...params) => stmt.get(...base, ...params),
    all: (...params) => stmt.all(...base, ...params)
  };
}

module.exports = {
  prepare,
  exec: (sql) => sqlite.exec(sql),
  pragma: (...args) => {
    // Keep a minimal pragma() for compatibility (mainly used in some SQLite libs)
    if (ImplName === 'better-sqlite3') return sqlite.pragma(...args);
    // node:sqlite doesn't expose pragma(), but exec('PRAGMA ...') works.
    if (typeof args[0] === 'string') return sqlite.exec(`PRAGMA ${args[0]}`);
    return undefined;
  },
  close: () => closeSqlite(sqlite),

  // For operational visibility
  _db_path: DB_PATH,
  _migrated_backup: migratedBackup,
  _sqlite_impl: ImplName
};

// ─────────────────────────────────────────────────────────────
// SQLite open/close helpers (node:sqlite vs better-sqlite3)
// ─────────────────────────────────────────────────────────────
function openSqlite(filePath) {
  if (SQLiteImpl.kind === 'node:sqlite') {
    return new SQLiteImpl.DatabaseSync(filePath);
  }
  return new SQLiteImpl.BetterSqlite3(filePath);
}

function closeSqlite(db) {
  // Both expose .close()
  if (db && typeof db.close === 'function') db.close();
}
