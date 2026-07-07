#!/usr/bin/env node
'use strict';

/*
 * sidewrite viewer-daemon
 * ---------------------
 * Local dashboard daemon. Must be launched with:
 *     node --experimental-sqlite viewer-daemon.cjs
 *
 * Binds 127.0.0.1 only, generates a per-boot bearer token, serves an SSE
 * stream + a control/read API, and persists events/costs/runs to a
 * WAL-mode SQLite database under ~/.sidewrite/.
 *
 * No external npm dependencies: node: builtins only.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

// Free-Tier Pool (Track B) — pure logic modules, self-contained, no
// dependency on this file's DB/HTTP internals beyond what's passed in.
const pool = require('./pool-store.cjs');
const poolRouter = require('./pool-router.cjs');
const context7Store = require('./context7-store.cjs');
const agentStore = require('./agent-store.cjs');

// Opt-in error/crash telemetry (default OFF — see config.telemetry.level).
// scrub() redacts secrets/PII BEFORE anything is queued; enqueue()/flush() are
// entirely local-write until flush() is actually invoked with a real endpoint.
const errorScrub = require('./error-scrub.cjs');
const telemetryReporter = require('./telemetry-reporter.cjs');
const { getInstallId } = require('./install-id.cjs');
const TELEMETRY_ENDPOINT = 'https://sidewrite.com/api/telemetry';
const TELEMETRY_FLUSH_INTERVAL_MS = 5 * 60 * 1000; // 5 min
// Anonymized daily usage digest (counts/tokens/$ only — no task text, no file
// paths, no project names) is a step ABOVE error reporting: only sent at the
// most verbose opt-in tier ('all'), never at 'crash'/'error'/'off'.
const USAGE_SUMMARY_LEVEL = 'all';
const USAGE_SUMMARY_INTERVAL_MS = 24 * 60 * 60 * 1000; // once/day
const USAGE_SUMMARY_CHECK_MS = 60 * 60 * 1000; // check hourly whether a day has elapsed
const USAGE_SUMMARY_TOP_N = 10;

// ---------------------------------------------------------------------------
// node:sqlite (experimental on Node 22.x — requires --experimental-sqlite)
// ---------------------------------------------------------------------------
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  process.stderr.write(
    '\n[sidewrite] FATAL: could not load node:sqlite.\n' +
      '  This daemon requires Node >= 22.5 launched with the ' +
      '--experimental-sqlite flag.\n' +
      '  Start it as:  node --experimental-sqlite ' +
      path.basename(__filename) +
      '\n  Underlying error: ' +
      (err && err.message ? err.message : String(err)) +
      '\n\n'
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Constants & shared paths
// ---------------------------------------------------------------------------
const VERSION = '1.2.0';
const HOST = '127.0.0.1';
const DEFAULT_PORT = 1510;
const MAX_PORT_TRIES = 20;
const MAX_BODY_BYTES = 1024 * 1024; // 1MB
const HEARTBEAT_MS = 15000;
const STATUS_TTL_SECONDS = 30; // status.json freshness window (readers treat older as stale)
const STATUS_REFRESH_MS = 10000; // low-frequency heartbeat that re-stamps status.json
// Orphan-run reconciliation: a run's process can die (kill, crash, daemon
// restart) without ever writing a terminal status, leaving `status='running'`
// forever. STALE_RUN_MS is the no-activity window after which a still-running
// row is presumed dead; RECONCILE_INTERVAL_MS is how often the periodic sweep
// re-checks, so long-dead runs get reaped even without a daemon restart.
const STALE_RUN_MS = 15 * 60 * 1000; // 15 min with no event activity => presumed dead
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000; // re-sweep every 5 min

const HOME = os.homedir();
const DATA_DIR = path.join(HOME, '.sidewrite');
const DB_PATH = path.join(DATA_DIR, 'sidewrite.db');
const ACTIVE_PATH = path.join(DATA_DIR, 'active.json');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const STATUS_PATH = path.join(DATA_DIR, 'status.json');
const DAEMON_JSON_PATH = path.join(DATA_DIR, 'daemon.json');
const DAEMON_TOKEN_PATH = path.join(DATA_DIR, 'daemon.token');
const RUNS_DIR = path.join(DATA_DIR, 'runs');
const PROVIDERS_DIR = path.join(HOME, '.claude-providers');
const ESSENTIAL_SKILLS_PATH = path.join(DATA_DIR, 'essential-skills.json');

const VIEWER_HTML_PATH = path.join(__dirname, '..', 'ui', 'viewer.html');

// Static-asset root (plugin/ui, sibling of scripts/). The modular dashboard
// loads viewer.css + js/**.js from here. Assets are served RAW (no token
// injection), Host-guarded but unauthenticated — same posture as GET /.
const UI_DIR = path.resolve(__dirname, '..', 'ui');
const STATIC_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

// Bearer token (generated at boot).
const TOKEN = crypto.randomBytes(24).toString('hex');

// Runtime state used for health / pipeline snapshots.
const state = {
  port: DEFAULT_PORT,
  pipelineStage: 'idle',
  activeProvider: null,
  isProcessing: false,
  queueDepth: 0,
  startedAt: Date.now(),
  lastActivity: Date.now(),
};

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------
function ensureDirs() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  } catch (_) {}
  try {
    fs.chmodSync(DATA_DIR, 0o700);
  } catch (_) {}
  try {
    fs.mkdirSync(RUNS_DIR, { recursive: true, mode: 0o700 });
  } catch (_) {}
}

function writeFileMode(file, data, mode) {
  fs.writeFileSync(file, data, { mode });
  try {
    fs.chmodSync(file, mode);
  } catch (_) {}
}

function readJsonSafe(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// redact() — deep clone, scrub secrets from every string value.
// Applied BEFORE storing to DB and BEFORE SSE broadcast.
// ---------------------------------------------------------------------------
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_\-]{8,}/g,
  /Bearer\s+[A-Za-z0-9._\-]+/gi,
  /(ANTHROPIC_[A-Z_]*|CCX_TOKEN|API_KEY|TOKEN)\s*[=:]\s*\S+/g,
];

function redactString(s) {
  let out = s;
  if (TOKEN && out.indexOf(TOKEN) !== -1) {
    out = out.split(TOKEN).join('[REDACTED]');
  }
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, '[REDACTED]');
  }
  return out;
}

function redact(obj, seen) {
  if (obj === null || obj === undefined) return obj;
  const t = typeof obj;
  if (t === 'string') return redactString(obj);
  if (t === 'number' || t === 'boolean') return obj;
  if (t !== 'object') return obj; // functions/symbols dropped implicitly by JSON later
  seen = seen || new WeakSet();
  if (seen.has(obj)) return '[Circular]';
  seen.add(obj);
  if (Array.isArray(obj)) {
    const arr = new Array(obj.length);
    for (let i = 0; i < obj.length; i++) arr[i] = redact(obj[i], seen);
    return arr;
  }
  const out = {};
  for (const k of Object.keys(obj)) {
    out[k] = redact(obj[k], seen);
  }
  return out;
}

// ---------------------------------------------------------------------------
// SQLite schema + prepared statements
// ---------------------------------------------------------------------------
let db;
let dbReady = false;
const stmts = {};

// Analytics (#4) breakdown dimension allowlist: request `by` value -> the ACTUAL
// costs column it groups on. This map is the ONLY bridge between a client string
// and a SQL identifier — a `by` that is not an own-key here is rejected (400), so
// no caller-controlled string is ever interpolated into SQL. The column literals
// are constants authored here, reused Batch-1 dimensions on `costs`.
const BREAKDOWN_COLUMNS = {
  model: 'model',
  provider: 'provider',
  agent: 'agent',
  worker: 'worker',
  session: 'session_id',
  project: 'project_id',
};

// History (#6) keyset run-list statement cache. Keys are a 3-bit shape
// (status?/project?/cursor?) — at most 8 entries — so the SQL text is fully
// determined by structural booleans, never by request values (those are bound
// params). Built lazily against the live `db` after ensureDb().
const _runsStmtCache = new Map();

// Lazily (idempotently) initialize the DB. initDb() is deferred off the
// socket-bind hot path (see main(): called on setImmediate after listen), so a
// DB-backed request or a queued write may arrive first — ensureDb() guarantees
// the DB + prepared statements exist before any such consumer touches them.
function ensureDb() {
  if (!dbReady) initDb();
}

function initDb() {
  if (dbReady) return;
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  // Multi-project (#9): a concurrent writer (parallel workers, sweeper) must wait
  // rather than fail with SQLITE_BUSY. Bounded to 5s so a wedged writer can't hang.
  db.exec('PRAGMA busy_timeout = 5000;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      task TEXT,
      provider TEXT,
      model TEXT,
      project TEXT,
      plan_path TEXT,
      plan_summary TEXT,
      branch TEXT,
      diff_stat TEXT,
      status TEXT,
      started_at INT,
      finished_at INT
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT,
      stage TEXT,
      type TEXT NOT NULL,
      provider TEXT,
      payload TEXT NOT NULL,
      ts INT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS costs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT,
      provider TEXT,
      model TEXT,
      tokens_in INT,
      tokens_out INT,
      cache_read INT DEFAULT 0,
      cache_create INT DEFAULT 0,
      usd REAL,
      estimated INT DEFAULT 1,
      ts INT
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT,
      verdict TEXT,
      findings TEXT,
      ts INT
    );

    CREATE TABLE IF NOT EXISTS projects (
      project_id TEXT PRIMARY KEY,
      root_path TEXT UNIQUE,
      name TEXT,
      first_seen INT,
      last_seen INT
    );

    CREATE INDEX IF NOT EXISTS idx_events_run_ts ON events(run_id, ts);
    CREATE INDEX IF NOT EXISTS idx_costs_run ON costs(run_id);
    CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);
  `);

  // Additive, nullable migration. Each ALTER is guarded so it is idempotent
  // across restarts (throws once the column exists). NEVER drop/rewrite a column.
  //   - events: worker/title (pre-existing) + project_id (#9 multi-project).
  //   - costs (#11 token accounting): attempt_id + usage_source + price_version +
  //     unpriced + worker are the idempotent per-attempt cost contract; (#4
  //     analytics) session_id + agent + day + project_id are read dimensions.
  //   - runs (#6 history): denormalized, corrected per-run cost totals.
  for (const alter of [
    'ALTER TABLE events ADD COLUMN worker INTEGER',
    'ALTER TABLE events ADD COLUMN title TEXT',
    'ALTER TABLE events ADD COLUMN project_id TEXT',
    'ALTER TABLE costs ADD COLUMN attempt_id TEXT',
    "ALTER TABLE costs ADD COLUMN usage_source TEXT DEFAULT 'exact'",
    'ALTER TABLE costs ADD COLUMN price_version TEXT',
    'ALTER TABLE costs ADD COLUMN unpriced INT DEFAULT 0',
    'ALTER TABLE costs ADD COLUMN worker INTEGER',
    'ALTER TABLE costs ADD COLUMN session_id TEXT',
    'ALTER TABLE costs ADD COLUMN agent TEXT',
    'ALTER TABLE costs ADD COLUMN day TEXT',
    'ALTER TABLE costs ADD COLUMN project_id TEXT',
    'ALTER TABLE runs ADD COLUMN tokens_in INT',
    'ALTER TABLE runs ADD COLUMN tokens_out INT',
    'ALTER TABLE runs ADD COLUMN cache_read INT DEFAULT 0',
    'ALTER TABLE runs ADD COLUMN cache_create INT DEFAULT 0',
    'ALTER TABLE runs ADD COLUMN usd REAL',
  ]) {
    try {
      db.exec(alter);
    } catch (_) {
      /* column already present */
    }
  }

  // Indexes that reference the just-added columns MUST be created after the ALTER
  // loop. Each is guarded independently so one failure never blocks the rest.
  //   idx_costs_attempt is UNIQUE(run_id, attempt_id): it is BOTH the analytics
  //   dedupe key and the ON CONFLICT target that makes insertCost idempotent.
  //   NULL attempt_id rows (pre-migration) stay distinct under SQLite UNIQUE, so
  //   the index builds cleanly over existing data and legacy rows never collide.
  for (const idx of [
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_costs_attempt ON costs(run_id, attempt_id)',
    'CREATE INDEX IF NOT EXISTS idx_costs_ts ON costs(ts)',
    'CREATE INDEX IF NOT EXISTS idx_costs_day ON costs(day, provider, model)',
    'CREATE INDEX IF NOT EXISTS idx_costs_project ON costs(project_id)',
    'CREATE INDEX IF NOT EXISTS idx_costs_session ON costs(session_id)',
    'CREATE INDEX IF NOT EXISTS idx_costs_agent ON costs(agent)',
    'CREATE INDEX IF NOT EXISTS idx_costs_run_worker ON costs(run_id, worker)',
    'CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id)',
    'CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project)',
  ]) {
    try {
      db.exec(idx);
    } catch (_) {
      /* index already present or benign build race */
    }
  }

  // Lock down db file permissions (WAL/SHM created lazily on first write).
  chmodDbFiles();

  stmts.insertEvent = db.prepare(
    'INSERT INTO events (run_id, stage, type, provider, worker, title, project_id, payload, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  // Attempt-keyed idempotent cost UPSERT (#11): costs is the single source of
  // truth for token accounting. A re-POSTed cost_update (SSE re-delivery, or a
  // SIGTERM 'accumulated' row later superseded by the 'exact' result row for the
  // same attempt) UPDATEs in place — last-write-wins — instead of inserting a
  // duplicate. Rows WITHOUT an attempt_id (NULL) never conflict and are inserted
  // as distinct rows, preserving legacy/append behaviour. Failover attempts carry
  // distinct attempt_ids and therefore sum legitimately.
  stmts.insertCost = db.prepare(
    `INSERT INTO costs (
       run_id, provider, model, tokens_in, tokens_out, cache_read, cache_create,
       usd, estimated, ts, attempt_id, usage_source, price_version, unpriced,
       worker, session_id, agent, day, project_id
     ) VALUES (
       @run_id, @provider, @model, @tokens_in, @tokens_out, @cache_read, @cache_create,
       @usd, @estimated, @ts, @attempt_id, @usage_source, @price_version, @unpriced,
       @worker, @session_id, @agent, @day, @project_id
     )
     ON CONFLICT(run_id, attempt_id) DO UPDATE SET
       provider = excluded.provider,
       model = excluded.model,
       tokens_in = excluded.tokens_in,
       tokens_out = excluded.tokens_out,
       cache_read = excluded.cache_read,
       cache_create = excluded.cache_create,
       usd = excluded.usd,
       estimated = excluded.estimated,
       ts = excluded.ts,
       usage_source = excluded.usage_source,
       price_version = excluded.price_version,
       unpriced = excluded.unpriced,
       worker = COALESCE(excluded.worker, costs.worker),
       session_id = COALESCE(excluded.session_id, costs.session_id),
       agent = COALESCE(excluded.agent, costs.agent),
       day = COALESCE(excluded.day, costs.day),
       project_id = COALESCE(excluded.project_id, costs.project_id)`
  );
  // Multi-project (#9): upsert a project row on run_init/plan_written. first_seen
  // is preserved across conflicts; last_seen bumps. root_path/name only overwrite
  // when a non-null value is supplied (COALESCE) so a later event missing them
  // never blanks the record.
  stmts.upsertProject = db.prepare(
    `INSERT INTO projects (project_id, root_path, name, first_seen, last_seen)
     VALUES (@project_id, @root_path, @name, @first_seen, @last_seen)
     ON CONFLICT(project_id) DO UPDATE SET
       root_path = COALESCE(excluded.root_path, projects.root_path),
       name = COALESCE(excluded.name, projects.name),
       last_seen = excluded.last_seen`
  );
  // History (#6): sum the CORRECTED costs table (deduped by the UPSERT above) for
  // a run so the denormalized runs totals never double-count on re-delivery.
  stmts.costRunTotals = db.prepare(
    `SELECT COALESCE(SUM(tokens_in), 0)    AS tokens_in,
            COALESCE(SUM(tokens_out), 0)   AS tokens_out,
            COALESCE(SUM(cache_read), 0)   AS cache_read,
            COALESCE(SUM(cache_create), 0) AS cache_create,
            COALESCE(SUM(usd), 0)          AS usd
     FROM costs WHERE run_id = ?`
  );
  // Per-worker drill-in (#11): roll up the SAME deduped costs table, grouped by
  // worker, so the run-detail/snapshot totals agree with the runs-list totals and
  // never double-count re-delivered/superseded cost_update snapshots. (Reads the
  // append-only cost_update EVENTS table here would sum every SSE re-delivery.)
  stmts.costRollupByWorker = db.prepare(
    `SELECT worker,
            COALESCE(SUM(tokens_in), 0)    AS tokens_in,
            COALESCE(SUM(tokens_out), 0)   AS tokens_out,
            COALESCE(SUM(cache_read), 0)   AS cache_read,
            COALESCE(SUM(cache_create), 0) AS cache_create,
            COALESCE(SUM(usd), 0)          AS usd
     FROM costs WHERE run_id = ? GROUP BY worker`
  );
  stmts.updateRunCost = db.prepare(
    `UPDATE runs SET tokens_in = ?, tokens_out = ?, cache_read = ?, cache_create = ?, usd = ?
     WHERE id = ?`
  );
  stmts.upsertRun = db.prepare(
    `INSERT INTO runs (id, session_id, task, provider, model, project, plan_path, plan_summary, branch, diff_stat, status, started_at, finished_at)
     VALUES (@id, @session_id, @task, @provider, @model, @project, @plan_path, @plan_summary, @branch, @diff_stat, @status, @started_at, @finished_at)
     ON CONFLICT(id) DO UPDATE SET
       session_id = COALESCE(excluded.session_id, runs.session_id),
       task = COALESCE(excluded.task, runs.task),
       provider = COALESCE(excluded.provider, runs.provider),
       model = COALESCE(excluded.model, runs.model),
       project = COALESCE(excluded.project, runs.project),
       plan_path = COALESCE(excluded.plan_path, runs.plan_path),
       plan_summary = COALESCE(excluded.plan_summary, runs.plan_summary),
       branch = COALESCE(excluded.branch, runs.branch),
       diff_stat = COALESCE(excluded.diff_stat, runs.diff_stat),
       status = COALESCE(excluded.status, runs.status),
       started_at = COALESCE(runs.started_at, excluded.started_at),
       finished_at = COALESCE(excluded.finished_at, runs.finished_at)`
  );
  stmts.eventsSinceId = db.prepare(
    'SELECT id, run_id, stage, type, provider, project_id, payload, ts FROM events WHERE id > ? ORDER BY id ASC LIMIT 2000'
  );
  stmts.eventsForRun = db.prepare(
    'SELECT id, run_id, stage, type, provider, payload, ts FROM events WHERE run_id = ? ORDER BY id ASC LIMIT 5000'
  );
  stmts.recentEvents = db.prepare(
    'SELECT id, run_id, stage, type, provider, payload, ts FROM events ORDER BY id DESC LIMIT ?'
  );
  stmts.runsPage = db.prepare(
    'SELECT * FROM runs ORDER BY started_at DESC LIMIT ? OFFSET ?'
  );
  stmts.costsAgg = db.prepare(
    `SELECT provider, model,
            SUM(tokens_in) AS tokens_in,
            SUM(tokens_out) AS tokens_out,
            SUM(cache_read) AS cache_read,
            SUM(cache_create) AS cache_create,
            SUM(usd) AS usd,
            COUNT(*) AS entries
     FROM costs GROUP BY provider, model ORDER BY usd DESC`
  );
  stmts.insertReview = db.prepare(
    'INSERT INTO reviews (run_id, verdict, findings, ts) VALUES (?, ?, ?, ?)'
  );
  stmts.runsPageStatus = db.prepare(
    'SELECT * FROM runs WHERE status = ? ORDER BY started_at DESC LIMIT ? OFFSET ?'
  );
  stmts.runById = db.prepare('SELECT * FROM runs WHERE id = ?');
  stmts.runningCount = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status = 'running'");
  stmts.distinctWorkers = db.prepare(
    'SELECT DISTINCT worker FROM events WHERE run_id = ?'
  );
  stmts.latestRunWorkers = db.prepare(
    "SELECT payload FROM events WHERE run_id = ? AND type = 'run_workers' ORDER BY id DESC LIMIT 1"
  );
  stmts.eventsForRunByType = db.prepare(
    'SELECT worker, payload, ts FROM events WHERE run_id = ? AND type = ? ORDER BY id ASC'
  );
  stmts.fileLandedForRun = db.prepare(
    "SELECT worker, payload FROM events WHERE run_id = ? AND type = 'file_landed' ORDER BY id ASC"
  );
  // Orphan-run reconciliation: a run is presumed dead once it has gone
  // STALE_RUN_MS with no fresh signal. "Fresh signal" prefers the run's most
  // recent event timestamp (a live run keeps emitting events); only when a run
  // has NO events at all does it fall back to started_at. This means a
  // genuinely long-running-but-active run is never killed just for being old.
  // WHERE status = 'running' makes the sweep a no-op on any terminal row
  // (idempotent, safe to run repeatedly), and both timestamps are bound
  // parameters (never string-built).
  stmts.reconcileOrphanRuns = db.prepare(
    `UPDATE runs
     SET status = 'failed', finished_at = @now
     WHERE status = 'running'
       AND COALESCE(
             (SELECT MAX(e.ts) FROM events e WHERE e.run_id = runs.id),
             started_at
           ) < @threshold`
  );

  // ---- Analytics (#4): query-on-read over the deduped `costs` table using the
  // Batch-1 dimensions. Every read is date-filtered (ts epoch-ms, half-open bounds
  // applied by the caller as `ts >= from AND ts <= to`), fully parameterized, and
  // BOUNDED (single-row aggregate or an explicit LIMIT) — never an unbounded scan.
  stmts.analyticsSummary = db.prepare(
    `SELECT
       COALESCE(SUM(tokens_in), 0)    AS tokens_in,
       COALESCE(SUM(tokens_out), 0)   AS tokens_out,
       COALESCE(SUM(cache_read), 0)   AS cache_read,
       COALESCE(SUM(cache_create), 0) AS cache_create,
       COALESCE(SUM(usd), 0)          AS usd,
       COUNT(*)                       AS entries,
       COALESCE(SUM(estimated), 0)    AS estimated_entries,
       COUNT(DISTINCT run_id)         AS runs,
       COUNT(DISTINCT provider)       AS providers,
       COUNT(DISTINCT model)          AS models
     FROM costs WHERE ts >= ? AND ts <= ?`
  );
  stmts.analyticsTimeseries = db.prepare(
    `SELECT day AS day,
       COALESCE(SUM(tokens_in), 0)    AS tokens_in,
       COALESCE(SUM(tokens_out), 0)   AS tokens_out,
       COALESCE(SUM(cache_read), 0)   AS cache_read,
       COALESCE(SUM(cache_create), 0) AS cache_create,
       COALESCE(SUM(usd), 0)          AS usd,
       COUNT(*)                       AS entries,
       COALESCE(SUM(estimated), 0)    AS estimated_entries
     FROM costs WHERE ts >= ? AND ts <= ?
     GROUP BY day ORDER BY day ASC LIMIT 1000`
  );
  // breakdown: ONE prepared statement per allowlisted dimension. The GROUP BY /
  // SELECT column is a CONSTANT taken from BREAKDOWN_COLUMNS (authored above), so
  // the request handler only chooses WHICH prepared statement to run — a caller's
  // `by` string can never reach SQL. NULL group keys (worker/session/agent/project
  // on legacy rows) fold to a single NULL bucket and are tolerated by the reader.
  stmts.breakdown = {};
  for (const bk of Object.keys(BREAKDOWN_COLUMNS)) {
    const col = BREAKDOWN_COLUMNS[bk];
    stmts.breakdown[bk] = db.prepare(
      `SELECT ${col} AS key,
         COALESCE(SUM(tokens_in), 0)    AS tokens_in,
         COALESCE(SUM(tokens_out), 0)   AS tokens_out,
         COALESCE(SUM(cache_read), 0)   AS cache_read,
         COALESCE(SUM(cache_create), 0) AS cache_create,
         COALESCE(SUM(usd), 0)          AS usd,
         COUNT(*)                       AS entries,
         COALESCE(SUM(estimated), 0)    AS estimated_entries
       FROM costs WHERE ts >= ? AND ts <= ?
       GROUP BY ${col} ORDER BY COALESCE(SUM(usd), 0) DESC LIMIT 1000`
    );
  }
  // Usage-digest support: run counts by terminal status within a window.
  stmts.runStatusCounts = db.prepare(
    `SELECT status AS status, COUNT(*) AS n
     FROM runs WHERE started_at >= ? AND started_at <= ?
     GROUP BY status`
  );
  // S7: MAX(events.id) is the monotonic seq handed to the client as `lastSeq` for
  // snapshot-then-subscribe (first connect appends it as last_event_id).
  stmts.maxEventId = db.prepare('SELECT COALESCE(MAX(id), 0) AS seq FROM events');
  // Multi-project (#9): projects list + per-project run rollups (runs, active,
  // last_run, denormalized usd). Bounded LIMIT; root_path is intentionally NOT
  // selected (absolute host path — local-only, never surfaced).
  stmts.projectsList = db.prepare(
    `SELECT p.project_id AS project_id, p.name AS name,
            p.first_seen AS first_seen, p.last_seen AS last_seen,
            COUNT(r.id) AS runs,
            COALESCE(SUM(CASE WHEN r.status = 'running' THEN 1 ELSE 0 END), 0) AS active,
            MAX(r.started_at) AS last_run,
            COALESCE(SUM(r.usd), 0) AS usd
     FROM projects p LEFT JOIN runs r ON r.project = p.project_id
     GROUP BY p.project_id, p.name, p.first_seen, p.last_seen
     ORDER BY (last_run IS NULL) ASC, last_run DESC LIMIT 1000`
  );

  dbReady = true;
}

function chmodDbFiles() {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.chmodSync(DB_PATH + suffix, 0o600);
    } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Async write queue: POST handlers enqueue and return immediately; a drain
// loop performs the synchronous SQLite writes off the request path.
// ---------------------------------------------------------------------------
const writeQueue = [];
let draining = false;

function enqueueWrite(job) {
  writeQueue.push(job);
  state.queueDepth = writeQueue.length;
  if (!draining) {
    draining = true;
    setImmediate(drainQueue);
  }
}

function drainQueue() {
  // Writes can be enqueued before the deferred initDb() completes; make sure the
  // DB + prepared statements exist before draining (idempotent, off the bind path).
  ensureDb();
  const BATCH = 100;
  let processed = 0;
  while (writeQueue.length && processed < BATCH) {
    const job = writeQueue.shift();
    processed++;
    try {
      job();
    } catch (err) {
      process.stderr.write('[sidewrite] write-queue job failed: ' + err.message + '\n');
    }
  }
  state.queueDepth = writeQueue.length;
  chmodDbFiles();
  if (writeQueue.length) {
    setImmediate(drainQueue);
  } else {
    draining = false;
  }
}

// ---------------------------------------------------------------------------
// SSEBroadcaster — manages connected SSE clients, heartbeats, eviction.
// ---------------------------------------------------------------------------
class SSEBroadcaster {
  constructor() {
    this.clients = new Set();
    this.nextClientId = 1;
    this.heartbeat = setInterval(() => this.ping(), HEARTBEAT_MS);
    if (this.heartbeat.unref) this.heartbeat.unref();
  }

  add(res, req) {
    const client = { id: this.nextClientId++, res, req };
    this.clients.add(client);
    res.on('close', () => this.evict(client));
    res.on('error', () => this.evict(client));
    return client;
  }

  evict(client) {
    if (!this.clients.has(client)) return;
    this.clients.delete(client);
    try {
      client.res.end();
    } catch (_) {}
  }

  size() {
    return this.clients.size;
  }

  // Send a single already-redacted event object to one client.
  writeTo(client, id, event) {
    try {
      client.res.write('id: ' + id + '\ndata: ' + JSON.stringify(event) + '\n\n');
      return true;
    } catch (_) {
      this.evict(client);
      return false;
    }
  }

  // Broadcast an already-redacted event to all clients. Multi-project (#9): a
  // client that opened /stream?project=<id> receives ONLY events stamped with that
  // project_id; an unscoped client (client.project == null) receives everything.
  // Unattributed events (null project_id) never match a scoped client — fail-closed.
  broadcast(id, event) {
    const pid = event && event.project_id != null ? event.project_id : null;
    for (const client of this.clients) {
      if (client.project && client.project !== pid) continue;
      this.writeTo(client, id, event);
    }
  }

  ping() {
    for (const client of this.clients) {
      try {
        client.res.write(': ping\n\n');
      } catch (_) {
        this.evict(client);
      }
    }
  }

  close() {
    clearInterval(this.heartbeat);
    for (const client of this.clients) {
      try {
        client.res.end();
      } catch (_) {}
    }
    this.clients.clear();
  }
}

const broadcaster = new SSEBroadcaster();

// ---------------------------------------------------------------------------
// Event ingestion: redact -> persist (async) -> broadcast.
// Returns the event object (redacted). Broadcast uses the DB row id when
// available; since inserts are async we broadcast with best-effort id.
// ---------------------------------------------------------------------------
function nowTs() {
  return Date.now();
}

function ingestEvent(rawEvent) {
  state.lastActivity = Date.now();
  const evt = redact(rawEvent) || {};
  if (!evt.type) evt.type = 'log_line';
  if (evt.ts === undefined) evt.ts = nowTs();
  const runId = evt.run_id || null;
  const stage = evt.stage || null;
  const provider = evt.provider || null;
  const wRaw = evt.worker;
  const worker =
    wRaw == null || !Number.isFinite(Number(wRaw)) ? null : Number(wRaw);
  const title = evt.title || null;
  const ts = evt.ts;
  // Multi-project (#9): remember an explicit stamp, then resolve (own stamp wins,
  // else last-known for this run) so every event row carries project_id.
  if (runId && evt.project_id) rememberProject(runId, evt.project_id);
  const projectId = projectIdForEvent(evt);
  // S7/#9: stamp the RESOLVED project_id onto the event object BEFORE serialising,
  // so the DB payload, the live SSE frame, and the DB-replay frame all carry it.
  // The per-client `?project` filter can then match on the live stream AND on
  // reconnect replay. Only fills when unset (own explicit stamp always wins).
  if (projectId && evt.project_id == null) evt.project_id = projectId;
  const payload = JSON.stringify(evt);

  // Track pipeline-affecting events for health snapshot.
  applyStateFromEvent(evt);

  // Persist asynchronously, then broadcast with the real id.
  enqueueWrite(() => {
    let info;
    try {
      info = stmts.insertEvent.run(runId, stage, evt.type, provider, worker, title, projectId, payload, ts);
    } catch (err) {
      process.stderr.write('[sidewrite] insertEvent failed: ' + err.message + '\n');
    }
    const id = info && info.lastInsertRowid != null ? Number(info.lastInsertRowid) : 0;

    // Side-effects for special event types.
    handleSideEffects(evt);

    broadcaster.broadcast(id, evt);
  });

  // Re-stamp the status mirror (throttled/coalesced) so readers see fresh state
  // without an fsync/readdir on every event.
  scheduleStatusWrite();

  return evt;
}

// Multi-project (#9): upsert the projects table from a run_init/plan_written event
// carrying project_id (+ optional project_root/project_name). Isolated in its own
// try/catch so a UNIQUE(root_path) collision (e.g. a bind-mounted repo mapping to
// two project_ids — documented) can never abort the run/plan upsert.
function upsertProjectFromEvent(evt) {
  const pid = evt && typeof evt.project_id === 'string' && evt.project_id ? evt.project_id : null;
  if (!pid) return;
  try {
    const now = evt.ts || nowTs();
    stmts.upsertProject.run({
      project_id: pid,
      root_path: evt.project_root ? String(evt.project_root) : null,
      name: evt.project_name ? String(evt.project_name) : null,
      first_seen: now,
      last_seen: now,
    });
  } catch (err) {
    process.stderr.write('[sidewrite] upsertProject failed: ' + err.message + '\n');
  }
}

function handleSideEffects(evt) {
  try {
    if (evt.type === 'run_init') {
      upsertProjectFromEvent(evt);
      stmts.upsertRun.run({
        id: evt.run_id || null,
        session_id: evt.session_id || null,
        task: evt.task || null,
        provider: evt.provider || null,
        model: evt.model || null,
        project: evt.project_id || evt.project || null,
        plan_path: evt.plan_path || null,
        plan_summary: evt.plan_summary || null,
        branch: evt.branch || null,
        diff_stat: null,
        status: 'running',
        started_at: evt.ts || nowTs(),
        finished_at: null,
      });
    } else if (evt.type === 'implement_finished') {
      stmts.upsertRun.run({
        id: evt.run_id || null,
        session_id: evt.session_id || null,
        task: null,
        provider: evt.provider || null,
        model: evt.model || null,
        project: null,
        plan_path: null,
        plan_summary: null,
        branch: evt.branch || null,
        diff_stat: evt.diff_stat || evt.diffStat || null,
        status: evt.status || 'success',
        started_at: null,
        finished_at: evt.ts || nowTs(),
      });
    } else if (evt.type === 'plan_written') {
      upsertProjectFromEvent(evt);
      stmts.upsertRun.run({
        id: evt.run_id || null,
        session_id: null,
        task: evt.task || null,
        provider: null,
        model: null,
        project: evt.project_id || evt.project || null,
        plan_path: evt.plan_path || evt.planPath || null,
        plan_summary: evt.plan_summary || evt.summary || null,
        branch: null,
        diff_stat: null,
        status: null,
        started_at: null,
        finished_at: null,
      });
    } else if (evt.type === 'review_finished') {
      stmts.insertReview.run(
        evt.run_id || null,
        evt.verdict || null,
        typeof evt.findings === 'string' ? evt.findings : JSON.stringify(evt.findings || []),
        evt.ts || nowTs()
      );
    }

    // Opt-in telemetry: provider/implement failures only (not every event —
    // successes and routine progress carry no diagnostic value and would just
    // inflate the queue). 'crash' is reserved for actual process crashes
    // (not wired here); 'error'/'all' both cover these classified failures.
    if (
      evt.type === 'provider_failover' ||
      evt.type === 'provider_skipped' ||
      (evt.type === 'implement_finished' && evt.status && evt.status !== 'success')
    ) {
      maybeReportTelemetry(evt);
    }
  } catch (err) {
    process.stderr.write('[sidewrite] side-effect failed: ' + err.message + '\n');
  }
}

// Scrub + locally enqueue a classified failure event, gated by the user's own
// telemetry.level (default OFF). Never throws, never blocks the real event
// pipeline — a telemetry failure must be invisible to everything else.
function maybeReportTelemetry(evt) {
  try {
    const cfg = readConfig();
    const level = (cfg.telemetry && cfg.telemetry.level) || 'off';
    if (level === 'off') return;

    const safe = errorScrub.scrub({
      kind: evt.type,
      code: evt.reason || null,
      provider: evt.provider || null,
      model: evt.model || null,
      message: evt.detail || null,
    });
    if (!safe) return; // scrub() drops the event outright if anything looks unsafe

    telemetryReporter.enqueue(safe);
  } catch (_) {
    // best-effort only
  }
}

function applyStateFromEvent(evt) {
  switch (evt.type) {
    case 'run_init':
    case 'provider_activity':
      state.isProcessing = true;
      if (evt.provider) state.activeProvider = evt.provider;
      break;
    case 'pipeline_stage_changed':
      if (evt.stage) state.pipelineStage = evt.stage;
      if (evt.provider) state.activeProvider = evt.provider;
      break;
    case 'implement_finished':
    case 'review_finished':
      state.isProcessing = false;
      state.pipelineStage = 'idle';
      break;
    default:
      break;
  }
}

function ingestCost(evt) {
  // evt already redacted upstream in ingestEvent; here we persist a cost row.
  // Snapshot every derived field OUTSIDE the async job so a mutation/GC of evt
  // between enqueue and drain can't change what we write.
  const runId = evt.run_id || null;
  const ts = evt.ts || nowTs();
  const wRaw = evt.worker;
  const worker =
    wRaw == null || !Number.isFinite(Number(wRaw)) ? null : Number(wRaw);
  // usage_source drives the estimated flag when the bridge doesn't send one:
  // only an 'exact' result is authoritative (#11 Gap H). Fail closed — silence is
  // NOT authoritative, so an unspecified source is treated as 'estimated'.
  const usageSource =
    typeof evt.usage_source === 'string' && evt.usage_source ? evt.usage_source : 'estimated';
  const estimated =
    evt.estimated === false ? 0 : evt.estimated === true ? 1 : usageSource === 'exact' ? 0 : 1;
  const row = {
    run_id: runId,
    provider: evt.provider || null,
    model: evt.model || null,
    tokens_in: numOr0(evt.tokensIn != null ? evt.tokensIn : evt.tokens_in),
    tokens_out: numOr0(evt.tokensOut != null ? evt.tokensOut : evt.tokens_out),
    cache_read: numOr0(evt.cacheIn != null ? evt.cacheIn : evt.cache_read),
    cache_create: numOr0(evt.cacheCreate != null ? evt.cacheCreate : evt.cache_create),
    usd: typeof evt.usd === 'number' ? evt.usd : numOr0(evt.usd),
    estimated,
    ts,
    // #11 idempotency contract. A NULL attempt_id never conflicts (legacy path).
    attempt_id: typeof evt.attempt_id === 'string' && evt.attempt_id ? evt.attempt_id : null,
    usage_source: usageSource,
    price_version:
      typeof evt.price_version === 'string' && evt.price_version ? evt.price_version : null,
    unpriced: evt.unpriced ? 1 : 0,
    worker,
    // #4 analytics dimensions.
    session_id: evt.session_id ? String(evt.session_id) : null,
    agent: evt.agent ? String(evt.agent) : null,
    day: localDay(ts),
    project_id: projectIdForEvent(evt),
  };
  enqueueWrite(() => {
    try {
      stmts.insertCost.run(row);
    } catch (err) {
      process.stderr.write('[sidewrite] insertCost failed: ' + err.message + '\n');
    }
    // History (#6): recompute the run's corrected totals from the deduped costs
    // table and denormalize onto runs (O(1) list reads later). Recompute-from-sum
    // — never `+=` — so a re-POSTed/UPSERTed row can't double-count.
    if (runId) {
      try {
        const t = stmts.costRunTotals.get(runId);
        if (t) {
          stmts.updateRunCost.run(
            numOr0(t.tokens_in),
            numOr0(t.tokens_out),
            numOr0(t.cache_read),
            numOr0(t.cache_create),
            numOr0(t.usd),
            runId
          );
        }
      } catch (err) {
        process.stderr.write('[sidewrite] run cost denorm failed: ' + err.message + '\n');
      }
    }
  });
}

function numOr0(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Multi-project attribution (#9). project_id is minted upstream (bin/sidewrite-run
// = sha256(realpath.native(git-toplevel|cwd)).slice(0,16)); the daemon only reads
// it off events. A bounded in-memory run_id -> project_id map lets insertEvent
// stamp events.project_id without a per-event join. The map is best-effort: on a
// daemon restart it is empty, so mid-restart events fall back to a NULL
// project_id and downstream reads recover it via runs.project (documented in #9).
// ---------------------------------------------------------------------------
const PROJECT_MAP_MAX = 5000;
const runProjectMap = new Map();

function rememberProject(runId, projectId) {
  if (!runId || !projectId) return;
  // Refresh recency (Map preserves insertion order → cheap FIFO eviction).
  if (runProjectMap.has(runId)) runProjectMap.delete(runId);
  runProjectMap.set(runId, projectId);
  while (runProjectMap.size > PROJECT_MAP_MAX) {
    const oldest = runProjectMap.keys().next().value;
    if (oldest === undefined) break;
    runProjectMap.delete(oldest);
  }
}

// Resolve the project_id for an event: the event's own stamp wins; otherwise fall
// back to the last-known project_id for its run. Returns null when unknown.
function projectIdForEvent(evt) {
  const pid = evt && typeof evt.project_id === 'string' && evt.project_id ? evt.project_id : null;
  if (pid) return pid;
  const runId = evt && evt.run_id ? evt.run_id : null;
  return runId && runProjectMap.has(runId) ? runProjectMap.get(runId) : null;
}

// Local-timezone YYYY-MM-DD for a cost row (#4 analytics day bucket). Fail-safe:
// a missing/invalid ts falls back to "now" rather than producing a null day.
function localDay(ts) {
  const n = Number(ts);
  const d = Number.isFinite(n) && n > 0 ? new Date(n) : new Date();
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return y + '-' + mo + '-' + da;
}

// ---------------------------------------------------------------------------
// Provider registry helpers (~/.claude-providers/<name>.env)
// ---------------------------------------------------------------------------
function parseEnvFile(content) {
  const out = {};
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    let key = trimmed.slice(0, eq).trim();
    if (key.startsWith('export ')) key = key.slice(7).trim();
    let val = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes. Double-quoted values were written by
    // serializeEnvFile with bash-style backslash escaping of `"`, so unescape
    // them here (mirrors how ccx's `source` reads the same file).
    if (
      val.length >= 2 &&
      val[0] === '"' &&
      val[val.length - 1] === '"'
    ) {
      val = val.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
    } else if (
      val.length >= 2 &&
      val[0] === "'" &&
      val[val.length - 1] === "'"
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function serializeEnvFile(map) {
  let out = '';
  for (const key of Object.keys(map)) {
    const val = map[key] == null ? '' : String(map[key]);
    // Escape any double quotes in the value.
    const escaped = val.replace(/"/g, '\\"');
    out += key + '="' + escaped + '"\n';
  }
  return out;
}

function providerNameSafe(name) {
  return typeof name === 'string' && /^[A-Za-z0-9._-]+$/.test(name);
}

function providerFilePath(name) {
  return path.join(PROVIDERS_DIR, name + '.env');
}

function listProviders() {
  const result = [];
  let files = [];
  try {
    files = fs.readdirSync(PROVIDERS_DIR);
  } catch (_) {
    return result;
  }
  for (const f of files) {
    if (!f.endsWith('.env')) continue;
    const name = f.slice(0, -4);
    // freetier.env lives in this same directory only so `ccx`/`sidewrite code`
    // can find it — it's the Free Lane pool (a separate registry, see
    // pool-store.cjs), not a Track A provider. Excluded here so it doesn't
    // show up twice; manage it from the Free Lane pane instead.
    if (name === 'freetier') continue;
    let env;
    try {
      env = parseEnvFile(fs.readFileSync(path.join(PROVIDERS_DIR, f), 'utf8'));
    } catch (_) {
      continue;
    }
    let prices = {};
    if (env.CCX_PRICES) {
      try {
        prices = JSON.parse(env.CCX_PRICES);
      } catch (_) {
        prices = {};
      }
    }
    const models = env.CCX_MODELS
      ? env.CCX_MODELS.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    result.push({
      name,
      baseUrl: env.CCX_BASE_URL || '',
      models,
      prices,
      hasKey: !!env.CCX_TOKEN,
    });
  }
  return result;
}

// Auto-writes ~/.claude-providers/freetier.env so `sidewrite code` (no args)
// resolves straight to the Free-Tier Pool the same way it resolves to any
// other registered provider — no separate command/path needed for the pool
// track. The synthetic pool-sonnet/pool-opus/pool-haiku aliases only steer
// pool-router's tier selection (see routeMessage/tierForModel); they are
// never forwarded upstream. Idempotent: safe to call on every standalone-
// settings save.
function writeFreetierCcxEnv() {
  if (!fs.existsSync(PROVIDERS_DIR)) {
    fs.mkdirSync(PROVIDERS_DIR, { recursive: true, mode: 0o700 });
  }
  const token = pool.getOrCreatePoolToken();
  const endpoint = 'http://' + HOST + ':' + state.port;
  const body =
    'CCX_BASE_URL="' + endpoint + '"\n' +
    'CCX_TOKEN="' + token + '"\n' +
    'CCX_MODELS="pool-sonnet,pool-opus,pool-haiku"\n' +
    'CCX_ALIAS_SONNET="pool-sonnet"\n' +
    'CCX_ALIAS_OPUS="pool-opus"\n' +
    'CCX_ALIAS_HAIKU="pool-haiku"\n';
  const file = providerFilePath('freetier');
  const tmp = file + '.tmp' + process.pid;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch (_) {}
  fs.renameSync(tmp, file);
}

function isForbiddenBaseUrl(url) {
  // Case-insensitive: hostnames are case-insensitive, so 'API.Anthropic.Com' must
  // be blocked too (keeps the daemon guard as strong as the client-side one).
  return typeof url === 'string' && url.toLowerCase().indexOf('api.anthropic.com') !== -1;
}

function writeProvider(name, { baseUrl, apiKey, models, prices }) {
  if (!fs.existsSync(PROVIDERS_DIR)) {
    fs.mkdirSync(PROVIDERS_DIR, { recursive: true, mode: 0o700 });
  }
  const file = providerFilePath(name);
  let existing = {};
  try {
    existing = parseEnvFile(fs.readFileSync(file, 'utf8'));
  } catch (_) {}
  const map = Object.assign({}, existing);
  if (baseUrl !== undefined) map.CCX_BASE_URL = baseUrl;
  // Keep the existing token unless a REAL new key is supplied. An empty key —
  // or a masked placeholder the UI shows for an already-saved key (••••) — must
  // NOT overwrite the stored token, so users never re-enter their key.
  const isMask = typeof apiKey === 'string' && apiKey.trim() !== '' && /^[•*•·\s]+$/.test(apiKey.trim());
  if (apiKey !== undefined && apiKey !== null && apiKey !== '' && !isMask) map.CCX_TOKEN = apiKey;
  if (Array.isArray(models) && models.length) {
    // UNION with the existing models so adding models APPENDS — it never
    // overrides the user's existing selection (existing order first, then new).
    const existingModels = map.CCX_MODELS
      ? map.CCX_MODELS.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    const merged = existingModels.slice();
    for (const m of models) {
      const mm = String(m).trim();
      if (mm && merged.indexOf(mm) === -1) merged.push(mm);
    }
    map.CCX_MODELS = merged.join(',');
  } else if (models !== undefined && !map.CCX_MODELS) {
    map.CCX_MODELS = '';
  }
  if (prices !== undefined) {
    // Merge into existing prices (new entries win) so prices for previously
    // added models survive when new models are added.
    let existingPrices = {};
    if (map.CCX_PRICES) { try { existingPrices = JSON.parse(map.CCX_PRICES) || {}; } catch (_) {} }
    map.CCX_PRICES = JSON.stringify(Object.assign(existingPrices, prices || {}));
  }
  writeFileMode(file, serializeEnvFile(map), 0o600);
}

function addModelToProvider(name, model, priceIn, priceOut) {
  const file = providerFilePath(name);
  let existing;
  try {
    existing = parseEnvFile(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    existing = {};
  }
  const models = existing.CCX_MODELS
    ? existing.CCX_MODELS.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  if (model && models.indexOf(model) === -1) models.push(model);
  existing.CCX_MODELS = models.join(',');

  let prices = {};
  if (existing.CCX_PRICES) {
    try {
      prices = JSON.parse(existing.CCX_PRICES);
    } catch (_) {
      prices = {};
    }
  }
  if (model) {
    prices[model] = {
      in: numOr0(priceIn),
      out: numOr0(priceOut),
    };
  }
  existing.CCX_PRICES = JSON.stringify(prices);
  writeFileMode(file, serializeEnvFile(existing), 0o600);
}

// ---------------------------------------------------------------------------
// active.json helpers
// ---------------------------------------------------------------------------
function readActive() {
  const v = readJsonSafe(ACTIVE_PATH, {});
  return {
    provider: v && v.provider ? v.provider : null,
    model: v && v.model ? v.model : null,
  };
}

function writeActive(provider, model) {
  writeFileMode(
    ACTIVE_PATH,
    JSON.stringify({ provider: provider || null, model: model || null }),
    0o600
  );
}

// There must ALWAYS be an active model when at least one provider has models —
// otherwise runs/delegation fail with "no active model". If nothing is active,
// auto-activate the first model of the first provider that has one. Returns the
// {provider, model} that is now active (or null if no provider has any model).
function ensureActiveDefault() {
  const act = readActive();
  if (act.provider && act.model) return act;
  const provs = listProviders();
  for (const p of provs) {
    if (Array.isArray(p.models) && p.models.length) {
      writeActive(p.name, p.models[0]);
      state.activeProvider = p.name;
      ingestEvent({ type: 'active_changed', provider: p.name, model: p.models[0], ts: nowTs() });
      return { provider: p.name, model: p.models[0] };
    }
  }
  return null;
}

// Model used for the connectivity ping (POST /api/providers/:id/test): prefer
// an explicit CCX_ALIAS_OPUS (the same opus-alias env bin/ccx exports as
// ANTHROPIC_DEFAULT_OPUS_MODEL, when the provider config sets one), else the
// currently active model IF this provider is the active one, else just the
// provider's first configured model. Never invents a model id — an empty
// string here means the provider has no model configured at all.
function pickTestModel(name, env) {
  if (env.CCX_ALIAS_OPUS) return env.CCX_ALIAS_OPUS;
  const act = readActive();
  if (act.provider === name && act.model) return act.model;
  const models = env.CCX_MODELS
    ? env.CCX_MODELS.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  return models[0] || '';
}

// ---------------------------------------------------------------------------
// config.json helpers  (mode/onboarding state; distinct from active.json)
//   Reads are FAIL-CLOSED: a missing/corrupt/partial file yields DEFAULT_CONFIG
//   (mode:null => "unknown" downstream). Writes are ATOMIC (temp+fsync+rename).
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG = {
  version: 1,
  mode: null,
  onboarded: false,
  session: { provider: null },
  planner: { provider: null, model: null },
  reviewer: { provider: null, model: null },
  autoMergeOnClean: false,
  // Opt-in telemetry (S4/S5). Default OFF (fail-closed): egress only when
  // level !== 'off'. Read by the privacy/data panel; the reporter/scrubber live
  // in their own modules. Never carries keys/prompts/paths (allowlist scrub).
  telemetry: { level: 'off' },
  // Cost budgets + alerts. Stored HERE (~/.sidewrite/config.json), never
  // ~/.claude. Fail-closed: a dispatch is blocked ONLY when enforce===true AND a
  // KNOWN estimated cost pushes the month over the cap; an unknown cost warns.
  budgets: { enabled: false, monthlyUsd: null, perRunUsd: null, warnPct: 80, enforce: false },
  // Parallel worker concurrency (Sub-agents page). null maxConcurrency means
  // "use bin/sidewrite-run's nproc-based default" (min(N,nproc-1,4)); a set
  // value overrides it. Bounds real concurrent ccx|sj-bridge pipelines.
  parallel: { maxConcurrency: null },
  // Feature flags (#3 / S8). THREE layers, all resolved in the daemon and
  // consumed downstream as PLAIN BOOLEANS:
  //   - `flags`         : the resolved snapshot — the single authoritative
  //                       surface both the daemon and the shell runner
  //                       (bin/sidewrite-run BOOT reader) read. Recomputed on
  //                       every writeConfig + at startup so config.json always
  //                       carries fresh booleans; fail-closed to OFF on absence.
  //   - `flagOverrides` : explicit user/CLI on/off (+kill) that wins absolutely.
  //   - `remoteConfig`  : opt-in remote toggle channel (S2). Default OFF; never
  //                       api.anthropic.com; GET-only; install-id never sent.
  flags: {},
  flagOverrides: {},
  remoteConfig: { enabled: false, url: null, snapshot: null },
};

// Compiled feature-flag registry (#3 / S8). Adding a flag here makes it
// available to every reader with a fail-closed compiled default. Values are
// resolved to plain booleans by resolveFlags(); `fast` and `fullTools` are the
// two the shell runner reads at boot (cfg.flags.fast / cfg.flags.fullTools).
const FLAG_REGISTRY = {
  fast: { default: false },
  fullTools: { default: false },
};

// Allowlisted telemetry levels (S4/S5). Default 'off' (opt-in egress only when
// level !== 'off'). Mirrors the `sidewrite telemetry` CLI vocabulary.
const TELEMETRY_LEVELS = ['off', 'crash', 'error', 'all'];

// Resolve every registered flag to a plain boolean. Precedence (fail-closed):
//   (a) an explicit boolean in cfg.flagOverrides[name] wins absolutely (manual
//       on/off + kill switch);
//   (b) else, when remoteConfig.enabled === true AND a snapshot is present, the
//       remote value applies (object {enabled} kills/forces; bare boolean used
//       as-is; rollout% bucketing deferred to S2);
//   (c) else the compiled registry default.
// Never throws; anything malformed collapses to the compiled default (OFF). The
// resolved snapshot is what gets persisted into cfg.flags and read by the shell.
function resolveFlags(cfg) {
  const out = {};
  const overrides =
    cfg && cfg.flagOverrides && typeof cfg.flagOverrides === 'object' && !Array.isArray(cfg.flagOverrides)
      ? cfg.flagOverrides
      : {};
  const remote = cfg && cfg.remoteConfig && typeof cfg.remoteConfig === 'object' ? cfg.remoteConfig : null;
  const snapshot =
    remote &&
    remote.enabled === true &&
    remote.snapshot &&
    typeof remote.snapshot === 'object' &&
    remote.snapshot.flags &&
    typeof remote.snapshot.flags === 'object' &&
    !Array.isArray(remote.snapshot.flags)
      ? remote.snapshot.flags
      : null;
  for (const name of Object.keys(FLAG_REGISTRY)) {
    const spec = FLAG_REGISTRY[name];
    let val = !!(spec && spec.default === true);
    if (snapshot && Object.prototype.hasOwnProperty.call(snapshot, name)) {
      const rf = snapshot[name];
      if (rf && typeof rf === 'object' && !Array.isArray(rf)) {
        if (rf.enabled === false) val = false;
        else if (rf.enabled === true) val = true;
      } else if (typeof rf === 'boolean') {
        val = rf;
      }
    }
    if (Object.prototype.hasOwnProperty.call(overrides, name) && typeof overrides[name] === 'boolean') {
      val = overrides[name];
    }
    out[name] = val === true;
  }
  return out;
}

// Validate an incoming `flagOverrides` patch. Only keys in FLAG_REGISTRY are
// accepted; each value must be a boolean (explicit on/off) or null (clear the
// override — stored as null, ignored by resolveFlags so it falls back to remote/
// default). Returns { ok:true, value } or { ok:false, error } (fail-closed).
function sanitizeFlagOverrides(raw) {
  if (raw === null || raw === undefined) return { ok: true, value: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'flagOverrides must be an object' };
  }
  const value = {};
  for (const k of Object.keys(raw)) {
    if (!Object.prototype.hasOwnProperty.call(FLAG_REGISTRY, k)) {
      return { ok: false, error: 'unknown flag: ' + k };
    }
    const v = raw[k];
    if (v !== true && v !== false && v !== null) {
      return { ok: false, error: 'flag ' + k + ' must be true|false|null' };
    }
    value[k] = v;
  }
  return { ok: true, value };
}

// Validate an incoming `remoteConfig` patch. `enabled` must be boolean; `url`
// must be an https:// URL or null and NEVER api.anthropic.com (anthropic-wire
// isolation). `snapshot` is server-managed (set by the S2 fetch path), never
// accepted from a client here. Returns { ok, value } / { ok:false, error }.
function sanitizeRemoteConfig(raw) {
  if (raw === null || raw === undefined) return { ok: true, value: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'remoteConfig must be an object' };
  }
  const value = {};
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') return { ok: false, error: 'remoteConfig.enabled must be boolean' };
    value.enabled = raw.enabled;
  }
  if (raw.url !== undefined) {
    if (raw.url === null) {
      value.url = null;
    } else if (typeof raw.url === 'string') {
      let u;
      try {
        u = new URL(raw.url);
      } catch (_) {
        return { ok: false, error: 'remoteConfig.url must be a valid https URL or null' };
      }
      if (u.protocol !== 'https:') return { ok: false, error: 'remoteConfig.url must be https' };
      if (/(^|\.)api\.anthropic\.com$/i.test(u.hostname)) {
        return { ok: false, error: 'remoteConfig.url must not be api.anthropic.com' };
      }
      value.url = raw.url;
    } else {
      return { ok: false, error: 'remoteConfig.url must be a string or null' };
    }
  }
  return { ok: true, value };
}

// Build the SAFE config surface (#3 / S8) served by GET/POST /api/config/safe:
// feature flags resolved to plain booleans, the explicit boolean overrides, the
// budgets block, and the telemetry opt-in (default OFF). Deliberately omits
// secrets and host-internal fields (no install-id, no remoteConfig.url, no
// absolute paths) — a browser-safe projection of ~/.sidewrite/config.json.
function safeConfigView(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : readConfig();
  const overridesRaw =
    c.flagOverrides && typeof c.flagOverrides === 'object' && !Array.isArray(c.flagOverrides)
      ? c.flagOverrides
      : {};
  const flagOverrides = {};
  for (const k of Object.keys(FLAG_REGISTRY)) {
    if (Object.prototype.hasOwnProperty.call(overridesRaw, k) && typeof overridesRaw[k] === 'boolean') {
      flagOverrides[k] = overridesRaw[k];
    }
  }
  const level = c.telemetry && typeof c.telemetry.level === 'string' ? c.telemetry.level : 'off';
  return {
    flags: resolveFlags(c),
    flagOverrides,
    registry: Object.keys(FLAG_REGISTRY),
    budgets: normalizeBudget(c.budgets),
    telemetry: { level, enabled: level !== 'off' },
  };
}

// Deep-merge plain objects: values from `src` win, nested objects merged.
function deepMergeConfig(base, src) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  if (!src || typeof src !== 'object') return out;
  for (const k of Object.keys(src)) {
    const sv = src[k];
    const bv = out[k];
    if (
      sv &&
      typeof sv === 'object' &&
      !Array.isArray(sv) &&
      bv &&
      typeof bv === 'object' &&
      !Array.isArray(bv)
    ) {
      out[k] = deepMergeConfig(bv, sv);
    } else if (sv !== undefined) {
      out[k] = sv;
    }
  }
  return out;
}

function readConfig() {
  const parsed = readJsonSafe(CONFIG_PATH, null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return deepMergeConfig(DEFAULT_CONFIG, {});
  }
  return deepMergeConfig(DEFAULT_CONFIG, parsed);
}

function writeConfig(patch) {
  ensureDirs();
  const next = deepMergeConfig(readConfig(), patch || {});
  // Re-resolve feature flags into cfg.flags on EVERY write so the persisted
  // config always carries fresh plain booleans for the shell runner's direct
  // read (bin/sidewrite-run reads cfg.flags.fast / cfg.flags.fullTools). The
  // daemon is the single resolver; resolveFlags never throws but guard anyway so
  // a bad flag block can never break an unrelated config write (fail-closed).
  try {
    next.flags = resolveFlags(next);
  } catch (_) {
    next.flags = {};
  }
  const data = JSON.stringify(next);
  const tmp = CONFIG_PATH + '.tmp';
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, data);
    try {
      fs.fsyncSync(fd);
    } catch (_) {}
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chmodSync(tmp, 0o600);
  } catch (_) {}
  fs.renameSync(tmp, CONFIG_PATH);
  return next;
}

// ---------------------------------------------------------------------------
// OpenRouter model catalog
//   Fetched server-side so the browser never needs CORS or to hold the key for
//   the request. OpenRouter exposes a native Anthropic endpoint ("Anthropic
//   Skin") at https://openrouter.ai/api, so ccx can point ANTHROPIC_BASE_URL
//   straight at it with the user's key as ANTHROPIC_AUTH_TOKEN — no proxy.
// ---------------------------------------------------------------------------
const OPENROUTER_ANTHROPIC_BASE = 'https://openrouter.ai/api';
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
// Bundled snapshot ships in the plugin (works offline, no key). A successful
// live refresh mirrors to ~/.sidewrite. Read order: memory -> disk -> bundled.
const BUNDLED_MODELS_PATH = path.join(__dirname, '..', 'data', 'openrouter-models.json');
const MODELS_CACHE_PATH = path.join(DATA_DIR, 'openrouter-models.json');
let _orCache = { at: 0, models: null };

// Claude Code is agentic: it needs tool/function calling + text output. This is
// the compatibility gate for OpenRouter's Anthropic endpoint (verified: selects
// 256 of 340 models; excludes image/audio/moderation/no-tools models).
function isAnthropicCompatibleModel(m) {
  return !!(
    m &&
    Array.isArray(m.supported_parameters) &&
    m.supported_parameters.includes('tools') &&
    m.architecture &&
    Array.isArray(m.architecture.output_modalities) &&
    m.architecture.output_modalities.includes('text')
  );
}

// Raw OpenRouter model -> the normalized shape the dashboard/snapshot use.
// Prices are USD per 1M tokens; negative sentinels (e.g. openrouter/auto) clamp to 0.
function normalizeOrModel(m) {
  const perMillion = (v) => {
    const n = parseFloat(v);
    if (!isFinite(n) || n < 0) return 0;
    return Math.round(n * 1e6 * 1e6) / 1e6;
  };
  return {
    id: m.id,
    name: m.name || m.id,
    vendor: String(m.id || '').split('/')[0] || 'other',
    context:
      m.context_length || (m.top_provider && m.top_provider.context_length) || 0,
    in: perMillion(m.pricing && m.pricing.prompt),
    out: perMillion(m.pricing && m.pricing.completion),
  };
}

// Offline-first catalog: fresh in-memory cache -> ~/.sidewrite cache -> bundled
// snapshot. NEVER hits the network; always returns something after install.
function loadModelCatalog() {
  if (_orCache.models && Date.now() - _orCache.at < 10 * 60 * 1000) {
    return _orCache.models;
  }
  for (const p of [MODELS_CACHE_PATH, BUNDLED_MODELS_PATH]) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const models = Array.isArray(j) ? j : (j && j.models) || [];
      if (models.length) {
        _orCache = { at: Date.now(), models };
        return models;
      }
    } catch (_) {
      /* try the next source */
    }
  }
  return [];
}

// Atomically mirror a refreshed catalog to ~/.sidewrite (tmp + rename, 0644) so
// a killed refresh can never corrupt the cache and fall through to the bundle.
function persistModelsCache(models) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    const envelope = JSON.stringify(
      { version: 1, source: 'openrouter', baseUrl: OPENROUTER_ANTHROPIC_BASE, count: models.length, models },
      null,
      2
    );
    const tmp = MODELS_CACHE_PATH + '.tmp';
    fs.writeFileSync(tmp, envelope, { mode: 0o644 });
    fs.renameSync(tmp, MODELS_CACHE_PATH);
  } catch (_) {
    /* refresh cache is best-effort; the bundled snapshot always remains */
  }
}

// Live refresh: fetch, keep only Anthropic-compatible models, normalize, cache.
// The listing API works without a key (OpenRouter /models is public).
function fetchOpenRouterModels(apiKey, cb) {
  const https = require('https');
  const u = new URL(OPENROUTER_MODELS_URL);
  const headers = { Accept: 'application/json', 'User-Agent': 'sidewrite' };
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
  const req = https.request(
    { method: 'GET', hostname: u.hostname, path: u.pathname + u.search, headers },
    (r) => {
      let body = '';
      let size = 0;
      r.setEncoding('utf8');
      r.on('data', (c) => {
        size += c.length;
        if (size > 8 * 1024 * 1024) req.destroy();
        else body += c;
      });
      r.on('end', () => {
        if (r.statusCode !== 200) {
          return cb(new Error('OpenRouter returned HTTP ' + r.statusCode), null);
        }
        let j;
        try {
          j = JSON.parse(body);
        } catch (_) {
          return cb(new Error('OpenRouter sent malformed JSON'), null);
        }
        const models = ((j && j.data) || [])
          .filter(isAnthropicCompatibleModel)
          // Sidewrite is anthropic-wire-only (ccx never speaks OpenAI/Gemini/etc
          // wire, and aborts if the base URL is api.anthropic.com — see ccx guard).
          // OpenRouter's "Anthropic Skin" endpoint accepts the Messages wire for
          // its whole catalog, but only the `anthropic/*` family is the real
          // Anthropic wire underneath; every other vendor slug is translated and
          // isn't a model Claude Code can drive directly. Keep only `anthropic/*`.
          .filter((m) => typeof m.id === 'string' && m.id.indexOf('anthropic/') === 0)
          .map(normalizeOrModel)
          .filter((m) => m.id)
          .sort((a, b) => a.vendor.localeCompare(b.vendor) || a.name.localeCompare(b.name));
        _orCache = { at: Date.now(), models };
        persistModelsCache(models);
        cb(null, models);
      });
    }
  );
  req.on('error', (e) => cb(e, null));
  req.setTimeout(12000, () => {
    req.destroy();
    cb(new Error('OpenRouter request timed out'), null);
  });
  req.end();
}

// ---------------------------------------------------------------------------
// Bundled provider catalog (plugin/data/providers.json)
//   Read once and cached in memory (no secrets involved). A missing/corrupt
//   file yields the empty envelope {version:0, providers:[]} so the picker can
//   still render. The base URL a provider ships is what sidewrite uses; the
//   catalog just seeds the (editable) fields in the dashboard.
// ---------------------------------------------------------------------------
const PROVIDERS_CATALOG_PATH = path.resolve(__dirname, '..', 'data', 'providers.json');
let _catalogCache = null;

function loadProvidersCatalog() {
  if (_catalogCache) return _catalogCache;
  try {
    const j = JSON.parse(fs.readFileSync(PROVIDERS_CATALOG_PATH, 'utf8'));
    _catalogCache =
      j && typeof j === 'object' && Array.isArray(j.providers)
        ? j
        : { version: 0, providers: [] };
  } catch (_) {
    _catalogCache = { version: 0, providers: [] };
  }
  return _catalogCache;
}

// ---------------------------------------------------------------------------
// Server-side provider model listing (CORS-avoiding proxy)
//   The browser cannot call arbitrary provider APIs directly (CORS), so the
//   daemon performs the outbound GET and normalizes the many response shapes to
//   { models:[{ id, name, in, out, context }] }. in/out are USD per 1M tokens.
//   Supports BOTH https and plain http (a local Anthropic gateway may listen on
//   http://127.0.0.1:PORT). The API key is used only as a Bearer header and is
//   NEVER written to any log/stderr.
// ---------------------------------------------------------------------------

// Resolve the URL to GET for a provider's model listing.
//   - absolute http(s) modelsEndpoint -> used as-is
//   - relative modelsEndpoint -> joined onto baseUrl with exactly one slash
//   - empty modelsEndpoint -> baseUrl + '/v1/models'
function resolveModelsUrl(baseUrl, modelsEndpoint) {
  const ep = typeof modelsEndpoint === 'string' ? modelsEndpoint.trim() : '';
  if (/^https?:\/\//i.test(ep)) return ep;
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!ep) return base + '/v1/models';
  return base + '/' + ep.replace(/^\/+/, '');
}

// USD-per-token (string or number) -> USD-per-1M, clamped >= 0, 6dp (mirrors
// normalizeOrModel). Negative sentinels (e.g. -1) clamp to 0.
function perMillionPrice(v) {
  const n = parseFloat(v);
  if (!isFinite(n) || n < 0) return 0;
  return Math.round(n * 1e6 * 1e6) / 1e6;
}

// Strip a Gemini-style 'models/…' prefix so ids/names read cleanly.
function stripModelsPrefix(s) {
  return typeof s === 'string' && s.indexOf('models/') === 0
    ? s.slice('models/'.length)
    : s;
}

// Best-effort normalization across provider shapes:
//   OpenAI            { data:[{ id }] }
//   OpenRouter        { data:[{ id, name, context_length, pricing:{prompt,completion} }] }
//   Gemini            { models:[{ name:'models/…' }] }
//   bare array        [ ... ]
// Unknown fields default to 0. Returns [] when nothing parseable is found.
function normalizeProviderModels(parsed) {
  let arr = [];
  if (Array.isArray(parsed)) arr = parsed;
  else if (parsed && Array.isArray(parsed.data)) arr = parsed.data;
  else if (parsed && Array.isArray(parsed.models)) arr = parsed.models;
  else if (parsed && Array.isArray(parsed.body)) arr = parsed.body;

  const out = [];
  const seen = Object.create(null);
  for (const m of arr) {
    if (!m) continue;
    let id;
    let name;
    let inP = 0;
    let outP = 0;
    let context = 0;
    if (typeof m === 'string') {
      id = m;
      name = m;
    } else if (typeof m === 'object') {
      id = stripModelsPrefix(m.id || m.name || m.model || m.slug || '');
      name = stripModelsPrefix(
        m.name || m.display_name || m.displayName || m.description || id
      );
      context = numOr0(
        m.context_length ||
          m.context_window ||
          m.contextLength ||
          (m.top_provider && m.top_provider.context_length) ||
          0
      );
      if (m.pricing && typeof m.pricing === 'object') {
        inP = perMillionPrice(
          m.pricing.prompt != null ? m.pricing.prompt : m.pricing.input
        );
        outP = perMillionPrice(
          m.pricing.completion != null ? m.pricing.completion : m.pricing.output
        );
      }
    } else {
      continue;
    }
    id = id ? String(id) : '';
    if (!id || seen[id]) continue;
    seen[id] = true;
    out.push({ id, name: String(name || id), in: inP, out: outP, context });
  }
  return out;
}

// Match an actual (possibly account-substituted) baseUrl against a catalog
// template that may contain a literal '<ACCOUNT_ID>' placeholder (e.g. the
// Cloudflare AI Gateway entry). Exact match short-circuits; otherwise the
// placeholder is turned into a '[^/]+' wildcard so a filled-in base URL still
// matches its catalog template.
function baseUrlMatchesTemplate(actual, template) {
  if (!actual || !template) return false;
  if (actual === template) return true;
  if (template.indexOf('<ACCOUNT_ID>') === -1) return false;
  const escaped = template
    .split('<ACCOUNT_ID>')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]+');
  try {
    return new RegExp('^' + escaped + '$').test(actual);
  } catch (_) {
    return false;
  }
}

// Look up a bundled catalog provider (plugin/data/providers.json) by baseUrl,
// but only return it when it's a manual-catalog provider (modelsEndpoint:null
// — e.g. Cloudflare AI Gateway's meta-router, which has no live models-list
// endpoint at all; same absence-of-endpoint shape as any future hand-curated
// entry). Used to short-circuit fetchProviderModels below instead of firing a
// GET that can only 404/error.
function findManualCatalogProviderByBaseUrl(baseUrl) {
  const norm = String(baseUrl || '').replace(/\/+$/, '');
  if (!norm) return null;
  const catalog = loadProvidersCatalog();
  const list = (catalog && Array.isArray(catalog.providers)) ? catalog.providers : [];
  for (const p of list) {
    if (!p || p.modelsEndpoint != null) continue; // only modelsEndpoint:null entries
    const tmpl = String(p.baseUrl || '').replace(/\/+$/, '');
    if (baseUrlMatchesTemplate(norm, tmpl)) return p;
  }
  return null;
}

// Outbound GET of a provider's model listing. Always calls cb(result) where
// result is the JSON body the UI receives — { ok:true, models:[...] } on success
// or { ok:false, error, status } on any failure (network/HTTP/timeout). The key
// is sent only as a Bearer header (when non-empty) and never logged.
function fetchProviderModels(baseUrl, modelsEndpoint, apiKey, cb) {
  // Manual-catalog providers (modelsEndpoint:null/undefined — no live
  // models-list endpoint exists, e.g. Cloudflare AI Gateway) would otherwise
  // fall through to the base+'/v1/models' default below and fire a doomed GET.
  // Short-circuit with the curated overlay models instead of a wasted round-trip.
  if (modelsEndpoint === null || modelsEndpoint === undefined || modelsEndpoint === '') {
    const manual = findManualCatalogProviderByBaseUrl(baseUrl);
    if (manual) {
      cb({ ok: true, models: Array.isArray(manual.models) ? manual.models : [] });
      return;
    }
  }
  let target;
  try {
    target = new URL(resolveModelsUrl(baseUrl, modelsEndpoint));
  } catch (_) {
    cb({ ok: false, error: 'invalid models URL', status: 0 });
    return;
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    cb({ ok: false, error: 'unsupported URL scheme', status: 0 });
    return;
  }
  const isHttps = target.protocol === 'https:';
  const mod = isHttps ? require('node:https') : require('node:http');
  const headers = { Accept: 'application/json', 'User-Agent': 'sidewrite' };
  if (apiKey) {
    // Google Gemini authenticates with an `x-goog-api-key` header, not Bearer.
    // (Keeps the key out of the URL / logs, unlike the ?key= query form.)
    if (/(^|\.)googleapis\.com$/i.test(target.hostname)) {
      headers['x-goog-api-key'] = apiKey;
    } else {
      headers.Authorization = 'Bearer ' + apiKey;
    }
  }

  let done = false;
  const finish = (result) => {
    if (done) return;
    done = true;
    cb(result);
  };

  const req = mod.request(
    {
      method: 'GET',
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: (target.pathname || '/') + (target.search || ''),
      headers,
    },
    (r) => {
      let body = '';
      let size = 0;
      r.setEncoding('utf8');
      r.on('data', (c) => {
        size += c.length;
        if (size > 8 * 1024 * 1024) req.destroy();
        else body += c;
      });
      r.on('end', () => {
        const status = r.statusCode || 0;
        if (status === 401 || status === 403) {
          return finish({ ok: false, error: 'provider rejected the key', status });
        }
        if (status < 200 || status >= 300) {
          return finish({ ok: false, error: 'provider returned HTTP ' + status, status });
        }
        let parsed = null;
        try {
          parsed = JSON.parse(body);
        } catch (_) {
          /* fall through: normalize handles null best-effort */
        }
        finish({ ok: true, models: normalizeProviderModels(parsed) });
      });
    }
  );
  // NOTE: never include apiKey in an error string — e.message here is a
  // network-level message and carries no secret.
  req.on('error', (e) => finish({ ok: false, error: e.message || 'request failed', status: 0 }));
  req.setTimeout(12000, () => {
    req.destroy();
    finish({ ok: false, error: 'request timed out', status: 0 });
  });
  req.end();
}

// Provider connectivity probe: a minimal anthropic-wire POST /v1/messages
// "ping" (max_tokens:1). Some anthropic-wire providers (confirmed: mimo) don't
// serve GET /v1/models at all — that endpoint 404s even though the provider is
// perfectly healthy for real delegation, which always POSTs /v1/messages. This
// probes the SAME endpoint+verb sidewrite actually uses, so "test connection"
// agrees with reality.
//
// Response shape: { ok, reachable, status, error }.
//   status 200                -> reachable:true,  ok:true  (auth + endpoint good)
//   status 400/401/403/429    -> reachable:true,  ok:false (endpoint exists;
//                                 auth/quota/request-shape issue — NOT a dead probe)
//   404 / 5xx / network / timeout -> reachable:false, ok:false
// The key is sent only as the x-api-key header and never echoed back.
function fetchAnthropicPing(baseUrl, apiKey, model, cb) {
  let target;
  try {
    target = new URL(String(baseUrl || '').replace(/\/+$/, '') + '/v1/messages');
  } catch (_) {
    cb({ ok: false, reachable: false, error: 'invalid base URL', status: 0 });
    return;
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    cb({ ok: false, reachable: false, error: 'unsupported URL scheme', status: 0 });
    return;
  }
  const isHttps = target.protocol === 'https:';
  const mod = isHttps ? require('node:https') : require('node:http');
  const payload = JSON.stringify({
    model: model || '',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'ping' }],
  });
  const headers = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    'Content-Length': Buffer.byteLength(payload),
    'User-Agent': 'sidewrite',
  };
  if (apiKey) headers['x-api-key'] = apiKey;

  let done = false;
  const finish = (result) => {
    if (done) return;
    done = true;
    cb(result);
  };

  const req = mod.request(
    {
      method: 'POST',
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: (target.pathname || '/') + (target.search || ''),
      headers,
    },
    (r) => {
      let body = '';
      let size = 0;
      r.setEncoding('utf8');
      r.on('data', (c) => {
        size += c.length;
        if (size > 1024 * 1024) req.destroy();
        else body += c;
      });
      r.on('end', () => {
        const status = r.statusCode || 0;
        if (status === 200) {
          return finish({ ok: true, reachable: true, status });
        }
        if (status === 400 || status === 401 || status === 403 || status === 429) {
          let msg = 'provider reachable but request was rejected (HTTP ' + status + ')';
          try {
            const parsed = JSON.parse(body);
            if (parsed && parsed.error && parsed.error.message) {
              msg = String(parsed.error.message);
            }
          } catch (_) {
            /* non-JSON error body: keep the generic message */
          }
          return finish({ ok: false, reachable: true, error: msg, status });
        }
        return finish({ ok: false, reachable: false, error: 'provider returned HTTP ' + status, status });
      });
    }
  );
  // NOTE: never include apiKey in an error string — e.message here is a
  // network-level message and carries no secret.
  req.on('error', (e) => finish({ ok: false, reachable: false, error: e.message || 'request failed', status: 0 }));
  req.setTimeout(5000, () => {
    req.destroy();
    finish({ ok: false, reachable: false, error: 'request timed out', status: 0 });
  });
  req.write(payload);
  req.end();
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, cb) {
  let size = 0;
  const chunks = [];
  let aborted = false;
  req.on('data', (chunk) => {
    if (aborted) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      aborted = true;
      cb(new Error('body too large'), null);
      try {
        req.destroy();
      } catch (_) {}
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (aborted) return;
    cb(null, Buffer.concat(chunks).toString('utf8'));
  });
  req.on('error', (err) => {
    if (aborted) return;
    aborted = true;
    cb(err, null);
  });
}

function parseJsonSafe(str) {
  if (!str) return {};
  try {
    const v = JSON.parse(str);
    return v && typeof v === 'object' ? v : {};
  } catch (_) {
    return null; // signals parse error
  }
}

function withBody(req, res, handler) {
  readBody(req, (err, raw) => {
    if (err) {
      sendJson(res, err.message === 'body too large' ? 413 : 400, {
        ok: false,
        error: err.message,
      });
      return;
    }
    const parsed = parseJsonSafe(raw);
    if (parsed === null) {
      sendJson(res, 400, { ok: false, error: 'invalid JSON' });
      return;
    }
    try {
      handler(parsed);
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
    }
  });
}

// ---------------------------------------------------------------------------
// Security guards
// ---------------------------------------------------------------------------
function hostAllowed(req) {
  const host = req.headers.host || '';
  const allowed = [
    '127.0.0.1:' + state.port,
    'localhost:' + state.port,
  ];
  if (allowed.indexOf(host) === -1) return false;
  const origin = req.headers.origin;
  if (origin) {
    const okOrigins = [
      'http://127.0.0.1:' + state.port,
      'http://localhost:' + state.port,
    ];
    if (okOrigins.indexOf(origin) === -1) return false;
  }
  return true;
}

function tokenMatches(provided) {
  if (typeof provided !== 'string') return false;
  provided = provided.trim();
  if (provided.length !== TOKEN.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(TOKEN));
  } catch (_) {
    return false;
  }
}

function bearerOk(req) {
  const auth = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return false;
  return tokenMatches(m[1]);
}

// EventSource cannot set Authorization headers, so /stream also accepts the
// bearer token via a ?token= query param. All other routes require the header.
function queryTokenOk(parsedUrl) {
  return tokenMatches(parsedUrl.searchParams.get('token'));
}

// ---------------------------------------------------------------------------
// viewer.html (cached at boot, token/port injected)
// ---------------------------------------------------------------------------
let VIEWER_HTML = null;

function loadViewerHtml() {
  try {
    VIEWER_HTML = fs.readFileSync(VIEWER_HTML_PATH, 'utf8');
  } catch (_) {
    VIEWER_HTML =
      '<!doctype html><meta charset="utf-8"><title>sidewrite viewer</title>' +
      '<body><h1>sidewrite viewer</h1>' +
      '<p>viewer.html not found at ' +
      VIEWER_HTML_PATH +
      '</p>' +
      '<script>window.__SIDEWRITE_TOKEN__="__SIDEWRITE_TOKEN__";' +
      'window.__SIDEWRITE_PORT__="__SIDEWRITE_PORT__";</script></body>';
  }
}

function renderViewerHtml() {
  return VIEWER_HTML.split('__SIDEWRITE_TOKEN__')
    .join(TOKEN)
    .split('__SIDEWRITE_PORT__')
    .join(String(state.port));
}

// ---------------------------------------------------------------------------
// serveStatic — plugin/ui/*.css + plugin/ui/js/**.js (and .mjs/.svg/.json/.map).
//   Same security posture as GET /: Host-guarded, UNAUTHENTICATED, TOKEN-FREE.
//   Assets are served RAW (no __SIDEWRITE_TOKEN__ injection, no redact()); they
//   carry no secret. Two-layer traversal defence (mirrors the worker-snapshot
//   fix): reject any '..'/NUL + allowlist charset, then path.resolve within
//   UI_DIR and assert containment, then realpath + re-assert (no symlink escape).
//   Returns true when it has answered (hit or guarded miss) so router() stops;
//   returns false ONLY when the pathname is not a static request (router falls
//   through to the API/SSE routes).
// ---------------------------------------------------------------------------
function send404(res) {
  sendJson(res, 404, { ok: false, error: 'not found' });
}

function serveStatic(req, res, pathname) {
  if ((req.method || 'GET') !== 'GET') {
    sendJson(res, 405, { ok: false, error: 'method not allowed' });
    return true;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (_) {
    send404(res);
    return true;
  }
  // Reject traversal / NUL before any filesystem touch.
  if (decoded.indexOf('..') !== -1 || decoded.indexOf('\0') !== -1) {
    send404(res);
    return true;
  }
  // Strict allowlist charset + extension. A non-match is NOT a static request,
  // so return false and let the router try its API/SSE routes.
  if (!/^\/[A-Za-z0-9._\-\/]+\.(css|js|mjs|svg|json|map)$/.test(decoded)) {
    return false;
  }
  const ext = path.extname(decoded).toLowerCase();
  const type = STATIC_TYPES[ext];
  if (!type) {
    send404(res);
    return true;
  }
  // Resolve within UI_DIR and assert containment (belt-and-suspenders with the
  // '..' reject above).
  const abs = path.resolve(UI_DIR, '.' + decoded);
  if (abs !== UI_DIR && !abs.startsWith(UI_DIR + path.sep)) {
    send404(res);
    return true;
  }
  // realpath + re-assert containment: no symlink may escape UI_DIR. Fail-closed
  // (404) on any throw (ENOENT, EACCES, dangling symlink, …).
  let real, st;
  try {
    real = fs.realpathSync(abs);
    st = fs.statSync(real);
  } catch (_) {
    send404(res);
    return true;
  }
  if (real !== UI_DIR && !real.startsWith(UI_DIR + path.sep)) {
    send404(res);
    return true;
  }
  if (!st.isFile()) {
    send404(res);
    return true;
  }
  let buf;
  try {
    buf = fs.readFileSync(real);
  } catch (_) {
    send404(res);
    return true;
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(buf);
  return true;
}

// ---------------------------------------------------------------------------
// Route helpers for read APIs
// ---------------------------------------------------------------------------
function pipelineSnapshot() {
  return { stage: state.pipelineStage, activeProvider: state.activeProvider };
}

// Count of runs with status='running' across ALL projects/providers — this is
// what the main subscription's statusline polls to show "N delegate agents
// running", distinct from pipelineSnapshot()'s single current-stage value.
function runningAgentCount() {
  try {
    return stmts.runningCount.get().n;
  } catch (_) {
    return 0;
  }
}

function healthSnapshot() {
  const providers = listProviders().map((p) => p.name);
  const cfg = readConfig();
  return {
    port: state.port,
    version: VERSION,
    providers,
    active: readActive(),
    mode: cfg.mode,
    onboarded: cfg.onboarded,
    pipeline: pipelineSnapshot(),
    runningAgents: runningAgentCount(),
    uptime: Math.floor((Date.now() - state.startedAt) / 1000),
  };
}

// Mirror the health snapshot to ~/.sidewrite/status.json (0600) so slash
// commands / `sidewrite status` can read it directly (no HTTP, no node spawn).
// Carries a heartbeat_ts + ttl_seconds; readers treat a file older than the TTL
// as stale and fall back to HTTP. Written atomically (temp + rename); best-effort
// (a failed write never disturbs the request path). healthSnapshot() carries NO
// secret (no TOKEN / CCX_TOKEN), so this file is safe to expose at 0600.
function writeStatusFile() {
  try {
    const snap = healthSnapshot();
    snap.heartbeat_ts = nowTs();
    snap.ttl_seconds = STATUS_TTL_SECONDS;
    const data = JSON.stringify(snap);
    const tmp = STATUS_PATH + '.tmp';
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, data);
      try {
        fs.fsyncSync(fd);
      } catch (_) {}
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.chmodSync(tmp, 0o600);
    } catch (_) {}
    fs.renameSync(tmp, STATUS_PATH);
  } catch (_) {
    /* status mirror is best-effort; HTTP /api/health remains authoritative */
  }
}

// Throttle/coalesce event-driven status.json writes so the hot ingest path never
// performs a per-event fsync or a per-event readdir (writeStatusFile ->
// healthSnapshot -> listProviders reads PROVIDERS_DIR). A single trailing write
// absorbs bursts; the low-frequency heartbeat (startStatusHeartbeat) also
// re-stamps on its own timer, so readers still see fresh state promptly.
let _statusWriteTimer = null;
const STATUS_WRITE_MIN_MS = 1000;
function scheduleStatusWrite() {
  if (_statusWriteTimer) return;
  _statusWriteTimer = setTimeout(() => {
    _statusWriteTimer = null;
    writeStatusFile();
  }, STATUS_WRITE_MIN_MS);
  if (_statusWriteTimer.unref) _statusWriteTimer.unref();
}

function rowEventToObj(row) {
  let payload;
  try {
    payload = JSON.parse(row.payload);
  } catch (_) {
    payload = { type: row.type, raw: row.payload };
  }
  return { id: row.id, ...payload };
}

// ---------------------------------------------------------------------------
// Run drill-in / snapshot derivation (§2.4-2.7, §5)
// ---------------------------------------------------------------------------
// worker==null ⇒ implicit worker 0 (read/derivation rule only).
function workerOf(v) {
  return v == null || !Number.isFinite(Number(v)) ? 0 : Number(v);
}

// Basename-relative path guard for snapshots: never leak an absolute host path.
function basenameRel(p) {
  if (typeof p !== 'string' || !p) return '';
  let s = p.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  if (s.startsWith('/') || s.indexOf('..') !== -1) s = path.basename(s);
  return s;
}

// Authoritative roster for a run: (1) latest run_workers payload, else
// (2) DISTINCT non-null workers, else (3) a single implicit worker-0 lane.
function runWorkerRoster(runId) {
  try {
    const row = stmts.latestRunWorkers.get(runId);
    if (row) {
      const p = JSON.parse(row.payload);
      if (p && Array.isArray(p.workers) && p.workers.length) {
        return p.workers.map((w) => ({
          worker: workerOf(w.worker),
          title: w.title != null ? String(w.title) : null,
        }));
      }
    }
  } catch (_) {}
  const set = new Set();
  try {
    for (const r of stmts.distinctWorkers.all(runId)) set.add(workerOf(r.worker));
  } catch (_) {}
  const list = [...set].sort((a, b) => a - b).map((w) => ({ worker: w, title: null }));
  return list.length ? list : [{ worker: 0, title: null }];
}

function zeroCost() {
  return { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheCreate: 0, usd: 0 };
}

// Per-worker cost rollup from the deduped `costs` table (the #11 UPSERT source of
// truth), grouped by worker. NULL worker folds to lane 0. Deriving this from the
// same table as the runs-list/`/api/costs` totals keeps the drill-in in agreement
// and immune to cost_update re-delivery/supersession double-counting.
function runCostRollup(runId) {
  const byWorker = new Map();
  const total = zeroCost();
  let rows = [];
  try { rows = stmts.costRollupByWorker.all(runId); } catch (_) {}
  for (const r of rows) {
    const w = workerOf(r.worker);
    // Distinct NULL / non-finite workers can each GROUP into their own row yet
    // fold to the same lane 0 here — accumulate rather than overwrite.
    const acc = byWorker.get(w) || zeroCost();
    const tokensIn = numOr0(r.tokens_in);
    const tokensOut = numOr0(r.tokens_out);
    const cacheRead = numOr0(r.cache_read);
    const cacheCreate = numOr0(r.cache_create);
    const usd = numOr0(r.usd);
    acc.tokensIn += tokensIn; total.tokensIn += tokensIn;
    acc.tokensOut += tokensOut; total.tokensOut += tokensOut;
    acc.cacheRead += cacheRead; total.cacheRead += cacheRead;
    acc.cacheCreate += cacheCreate; total.cacheCreate += cacheCreate;
    acc.usd += usd; total.usd += usd;
    byWorker.set(w, acc);
  }
  return { byWorker, total };
}

// Latest payload of `type` per worker for a run (ASC order => last write wins).
function latestByWorker(runId, type) {
  const m = new Map();
  let rows = [];
  try { rows = stmts.eventsForRunByType.all(runId, type); } catch (_) {}
  for (const r of rows) {
    let p;
    try { p = JSON.parse(r.payload); } catch (_) { continue; }
    m.set(workerOf(r.worker), p);
  }
  return m;
}

// GET /api/runs/:id — run row + derived worker roster + per-worker cost rollup.
function sendRunDetail(res, id) {
  let run = null;
  try { run = stmts.runById.get(id) || null; } catch (_) {}
  const roster = runWorkerRoster(id);
  const { byWorker, total } = runCostRollup(id);
  const finished = latestByWorker(id, 'implement_finished');
  const staged = latestByWorker(id, 'pipeline_stage_changed');
  const running = !!(run && run.status === 'running');
  const workers = roster.map((r) => {
    const w = r.worker;
    const c = byWorker.get(w) || zeroCost();
    const fin = finished.get(w);
    const stg = staged.get(w);
    return {
      worker: w,
      title: r.title,
      stage: stg && stg.stage ? stg.stage : null,
      status: fin && fin.status ? fin.status : running ? 'running' : null,
      tokensIn: c.tokensIn, tokensOut: c.tokensOut,
      cacheRead: c.cacheRead, cacheCreate: c.cacheCreate, usd: c.usd,
    };
  });
  sendJson(res, 200, { ok: true, run, workers, cost: total });
}

// GET /api/runs/:id/snapshot — disk sidecars preferred, DB fallback for live
// runs (never 404 on a known run). Basename-relative paths only.
function sendRunSnapshot(res, id) {
  let run = null;
  try { run = stmts.runById.get(id) || null; } catch (_) {}

  let done = null;
  let haveDisk = false;
  try {
    done = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, id + '.done'), 'utf8'));
    haveDisk = true;
  } catch (_) { done = null; }

  const files = [];
  const filesByWorker = new Map();
  const pushFile = (w, rel, action) => {
    const entry = { path: rel, action, worker: w };
    files.push(entry);
    if (!filesByWorker.has(w)) filesByWorker.set(w, []);
    filesByWorker.get(w).push(entry);
  };

  let landed = [];
  try { landed = stmts.fileLandedForRun.all(id); } catch (_) {}
  for (const r of landed) {
    let p;
    try { p = JSON.parse(r.payload); } catch (_) { continue; }
    const rel = basenameRel(p.path || p.file || '');
    if (!rel) continue;
    pushFile(workerOf(r.worker), rel, p.action === 'delete' ? 'delete' : 'write');
  }
  // Fallback: single-worker .touched TSV (rel<TAB>existed<TAB>posthash) -> worker 0.
  if (!files.length) {
    try {
      const raw = fs.readFileSync(path.join(RUNS_DIR, id + '.touched'), 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const parts = line.split('\t');
        const rel = basenameRel(parts[0] || '');
        if (!rel) continue;
        pushFile(0, rel, (parts[2] || '') ? 'write' : 'delete');
      }
    } catch (_) {}
  }

  const roster = runWorkerRoster(id);
  const single = roster.length <= 1;
  const { byWorker } = runCostRollup(id);
  const finished = latestByWorker(id, 'implement_finished');
  const running = !!(run && run.status === 'running');

  const workers = roster.map((r) => {
    const w = r.worker;
    const c = byWorker.get(w) || zeroCost();
    const fin = finished.get(w);
    const status = fin && fin.status ? fin.status
      : single && done && done.status ? done.status
      : running ? 'running' : null;
    const branch = fin && fin.branch ? fin.branch
      : single && done && done.branch && done.branch !== '(parallel)' ? done.branch : null;
    const diff = fin && (fin.diff_stat || fin.diffStat) ? (fin.diff_stat || fin.diffStat)
      : single && done && done.diff_stat ? done.diff_stat : null;
    return {
      worker: w,
      title: r.title,
      status,
      branch: branch || null,
      diff_stat: diff || null,
      pass: status ? status === 'success' : null,
      files: filesByWorker.get(w) || [],
      tokensIn: c.tokensIn, tokensOut: c.tokensOut,
      cacheRead: c.cacheRead, cacheCreate: c.cacheCreate, usd: c.usd,
    };
  });

  sendJson(res, 200, {
    ok: true,
    run_id: id,
    source: haveDisk ? 'disk' : 'db',
    done,
    workers,
    files,
  });
}

// ---------------------------------------------------------------------------
// Skills management (§2.1-2.4, §3)  — all station writes target ~/.claude-<provider>/,
// NEVER ~/.claude. providerNameSafe + the '.claude-' prefix are the hard guard.
// ---------------------------------------------------------------------------
function stationDir(provider) {
  return path.join(HOME, '.claude-' + provider);
}

// Forced station env for `claude plugin …`: CLAUDE_CONFIG_DIR is ALWAYS the
// station, never ~/.claude. Asserted defensively.
function stationEnv(provider) {
  const dir = stationDir(provider);
  if (!path.basename(dir).startsWith('.claude-')) {
    throw new Error('refusing non-station config dir');
  }
  const env = Object.assign({}, process.env);
  env.CLAUDE_CONFIG_DIR = dir;
  return env;
}

function readStationSettings(provider) {
  return readJsonSafe(path.join(stationDir(provider), 'settings.json'), {}) || {};
}

// Atomic temp+rename write of a station's settings.json, deep-merged (0600).
function writeStationSettings(provider, patch) {
  const dir = stationDir(provider);
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (_) {}
  const file = path.join(dir, 'settings.json');
  const next = deepMergeConfig(readStationSettings(provider), patch || {});
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch (_) {}
  fs.renameSync(tmp, file);
  return next;
}

// enabledPlugins may be an object map {name:bool} or an array of names. Normalize
// to an object map; {} on anything malformed (fail-soft).
function normalizeEnabledPlugins(ep) {
  const out = {};
  if (Array.isArray(ep)) {
    for (const n of ep) if (typeof n === 'string') out[n] = true;
  } else if (ep && typeof ep === 'object') {
    for (const k of Object.keys(ep)) out[k] = !!ep[k];
  }
  return out;
}

// Parse a SKILL.md YAML frontmatter `description:` (scalar or > / | block). Fail-soft ''.
function parseFrontmatterDescription(md) {
  if (typeof md !== 'string' || md.slice(0, 3) !== '---') return '';
  const end = md.indexOf('\n---', 3);
  if (end === -1) return '';
  const lines = md.slice(3, end).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^description\s*:\s*(.*)$/i.exec(lines[i]);
    if (!m) continue;
    let v = m[1].trim();
    if (v === '>' || v === '|' || v === '>-' || v === '|-' || v === '') {
      const buf = [];
      for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) buf.push(lines[j].trim());
      if (buf.length) return buf.join(' ');
    }
    if ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'")) {
      v = v.slice(1, -1);
    }
    return v;
  }
  return '';
}

// Enumerate <dir>/*/SKILL.md into skill entries. tokenCost = ceil(bytes/4).
function enumSkillDir(dir, source, plugin, essentialSet) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const mdPath = path.join(dir, e.name, 'SKILL.md');
    let md;
    try { md = fs.readFileSync(mdPath, 'utf8'); } catch (_) { continue; }
    let description = '';
    try { description = parseFrontmatterDescription(md); } catch (_) {}
    out.push({
      name: e.name,
      description: description || '',
      source,
      plugin: plugin || null,
      enabled: true,
      essential: essentialSet.has(e.name),
      tokenCost: Math.ceil(Buffer.byteLength(md, 'utf8') / 4),
      path: mdPath,
    });
  }
  return out;
}

// Resolve the Claude Code plugin id matching settings.json's enabledPlugins keys
// (the "<name>@<marketplace>" form seen throughout ~/.claude/settings.json) from
// a skills/ dir's parent chain, relative to <station>/plugins. Two layouts exist
// on disk:
//   marketplaces/<mkt>/plugins/<name>/skills/*          (installed, no version dir)
//   marketplaces/<mkt>/external_plugins/<name>/skills/* (same, external variant)
//   cache/<mkt>/<name>/<version>/skills/*               (cached — has an EXTRA
//                                                         version dir the other
//                                                         two don't; naively
//                                                         taking the immediate
//                                                         parent dir name here
//                                                         returns the version,
//                                                         e.g. "6.1.1", not the
//                                                         plugin id)
function resolvePluginId(pluginsBase, skillParentDir) {
  const rel = path.relative(pluginsBase, skillParentDir);
  const parts = rel.split(path.sep).filter(Boolean);
  if (parts[0] === 'marketplaces' && parts.length >= 4) {
    return parts[3] + '@' + parts[1]; // .../marketplaces/<mkt>/(plugins|external_plugins)/<name>
  }
  if (parts[0] === 'cache' && parts.length >= 3) {
    return parts[2] + '@' + parts[1]; // .../cache/<mkt>/<name>/<version>
  }
  return path.basename(skillParentDir); // unknown layout: fall back to the old behavior
}

// Discover plugin skill dirs under a station: pairs of [pluginId, skillsDir].
// Best-effort scan of <station>/plugins/** for any `skills` dir. Fail-soft.
function discoverPluginSkillDirs(station) {
  const found = [];
  const base = path.join(station, 'plugins');
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const child = path.join(dir, e.name);
      if (e.name === 'skills') {
        found.push([resolvePluginId(base, path.dirname(child)), child]);
      } else if (e.name !== 'node_modules' && e.name !== '.git') {
        walk(child, depth + 1);
      }
    }
  };
  walk(base, 0);
  return found;
}

function readEssential() {
  const j = readJsonSafe(ESSENTIAL_SKILLS_PATH, null);
  if (!j || typeof j !== 'object' || !Array.isArray(j.skills)) return { version: 1, skills: [] };
  return { version: 1, skills: j.skills.filter((s) => s && typeof s.name === 'string') };
}
function essentialNames() { return readEssential().skills.map((s) => s.name); }

function writeEssential(obj) {
  ensureDirs();
  const tmp = ESSENTIAL_SKILLS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, skills: obj.skills }, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch (_) {}
  fs.renameSync(tmp, ESSENTIAL_SKILLS_PATH);
}

// Global (provider-agnostic) personal-skill enable/disable. essential-skills.json
// is now the ONE shared record of "this skill is on" — there is no separate
// per-station enabled bit anymore, so enabling/disabling fans the skill dir itself
// into (or out of) every station's skills/, in addition to editing the JSON list.
function setPersonalSkillGlobal(name, source, enabled) {
  const cur = readEssential();
  if (enabled) {
    let srcDir = null;
    for (const st of listStationDirs()) {
      const cand = path.join(st, 'skills', name);
      if (fs.existsSync(path.join(cand, 'SKILL.md'))) { srcDir = cand; break; }
      const candDisabled = path.join(st, 'skills-disabled', name);
      if (fs.existsSync(path.join(candDisabled, 'SKILL.md'))) { srcDir = candDisabled; break; }
    }
    if (srcDir) {
      for (const st of listStationDirs()) {
        const dest = path.join(st, 'skills', name);
        try {
          fs.mkdirSync(path.join(st, 'skills'), { recursive: true, mode: 0o700 });
          if (path.resolve(dest) !== path.resolve(srcDir) && !fs.existsSync(path.join(dest, 'SKILL.md'))) {
            fs.cpSync(srcDir, dest, { recursive: true });
          }
          const disabledCopy = path.join(st, 'skills-disabled', name);
          if (fs.existsSync(disabledCopy)) fs.rmSync(disabledCopy, { recursive: true, force: true });
        } catch (_) { /* fail-soft per station */ }
      }
    }
    const canonical = srcDir ? path.join(srcDir, 'SKILL.md') : null;
    if (!cur.skills.some((s) => s.name === name)) {
      cur.skills.push({ name, source, path: canonical });
    }
  } else {
    cur.skills = cur.skills.filter((s) => s.name !== name);
    // Retroactive disable: move the fanned copy out of every station so a
    // global-off is actually global, not just an edit to the JSON list.
    for (const st of listStationDirs()) {
      const on = path.join(st, 'skills', name);
      if (fs.existsSync(on)) {
        try {
          fs.mkdirSync(path.join(st, 'skills-disabled'), { recursive: true, mode: 0o700 });
          fs.renameSync(on, path.join(st, 'skills-disabled', name));
        } catch (_) { /* fail-soft per station */ }
      }
    }
  }
  writeEssential(cur);
}

// Fan a plugin's enabledPlugins[plugin]=enabled bit across EVERY station, so
// enabling/disabling a plugin skill is global rather than tied to one provider.
function setPluginSkillGlobal(plugin, enabled) {
  for (const st of listStationDirs()) {
    const prov = path.basename(st).slice('.claude-'.length);
    try {
      const ep = normalizeEnabledPlugins(readStationSettings(prov).enabledPlugins);
      ep[plugin] = enabled;
      writeStationSettings(prov, { enabledPlugins: ep });
    } catch (_) { /* fail-soft per station */ }
  }
}

// Resolve a plugin skill's owning plugin name by scanning every station (not just
// one), since skill enablement is now provider-agnostic.
function findPluginForSkill(name) {
  for (const st of listStationDirs()) {
    for (const [p, dir] of discoverPluginSkillDirs(st)) {
      if (fs.existsSync(path.join(dir, name, 'SKILL.md'))) return p;
    }
  }
  return null;
}

// All station dirs (~/.claude-*), excluding the provider-registry dir.
function listStationDirs() {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(HOME, { withFileTypes: true }); } catch (_) {}
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!e.name.startsWith('.claude-')) continue;
    if (e.name === path.basename(PROVIDERS_DIR)) continue; // .claude-providers
    out.push(path.join(HOME, e.name));
  }
  return out;
}

// Global (provider-agnostic) skill list: unions personal+plugin skills across every
// station, collapsing duplicates by name. A personal skill's enabled state is
// essential-skills.json membership (the one shared record); a plugin skill's
// enabled state is true if ANY station's enabledPlugins map has it on (toggling
// fans the same value to every station, so any single station already reflects
// the shared state — this just tolerates drift instead of trusting one station).
function listSkillsGlobal(cwd) {
  const essentialSet = new Set(essentialNames());
  const personal = new Map(); // name -> entry
  const plugin = new Map(); // "plugin:name" -> entry

  for (const station of listStationDirs()) {
    for (const s of enumSkillDir(path.join(station, 'skills'), 'personal', null, essentialSet)) {
      if (!personal.has(s.name)) personal.set(s.name, s);
    }
    for (const s of enumSkillDir(path.join(station, 'skills-disabled'), 'personal', null, essentialSet)) {
      if (!personal.has(s.name)) personal.set(s.name, s);
    }
    const settings = readJsonSafe(path.join(station, 'settings.json'), {}) || {};
    const enabledMap = normalizeEnabledPlugins(settings.enabledPlugins);
    for (const [pluginName, skillsDir] of discoverPluginSkillDirs(station)) {
      for (const s of enumSkillDir(skillsDir, 'plugin', pluginName, essentialSet)) {
        const key = pluginName + ':' + s.name;
        const enabledHere = enabledMap[pluginName] !== undefined ? !!enabledMap[pluginName] : false;
        const existing = plugin.get(key);
        if (!existing) {
          s.enabled = enabledHere;
          plugin.set(key, s);
        } else if (enabledHere) {
          existing.enabled = true;
        }
      }
    }
  }
  // Personal skills' global enabled state IS essential-list membership — the
  // on-disk skills/ vs skills-disabled/ split is a per-station implementation
  // detail of the fan-out, not the source of truth.
  for (const s of personal.values()) s.enabled = essentialSet.has(s.name);

  const project = [];
  for (const s of enumSkillDir(path.join(cwd || process.cwd(), '.claude', 'skills'), 'project', null, essentialSet)) {
    project.push(s);
  }

  const skills = [...personal.values(), ...plugin.values(), ...project];
  skills.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { skills, essential: essentialNames() };
}

// ---------------------------------------------------------------------------
// SSE stream handler
// ---------------------------------------------------------------------------
function handleStream(req, res) {
  ensureDb(); // replay below reads from SQLite; init on demand if not yet ready.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const client = broadcaster.add(res, req);

  // Parse the query once (bounded, fail-safe). Multi-project (#9): ?project=<id>
  // scopes both the live broadcast AND the reconnect replay to one project_id.
  let sp;
  try {
    sp = new URL(req.url, 'http://' + HOST + ':' + state.port).searchParams;
  } catch (_) {
    sp = new URLSearchParams();
  }
  const projectParam = sp.get('project');
  client.project =
    projectParam && /^[A-Za-z0-9._-]{1,64}$/.test(projectParam) ? projectParam : null;

  // Helper that writes with eviction on failure.
  const send = (id, event) => broadcaster.writeTo(client, id, event);

  // 1. connected — always delivered (control frame, not project-scoped).
  send(0, { type: 'connected', ts: nowTs() });

  // 2. S7 snapshot-then-subscribe: replay everything AFTER Last-Event-ID so a
  // reconnect rehydrates from the DB, not just the live stream. Accept the seq
  // from the standard EventSource `Last-Event-ID` header OR a query param
  // (last_event_id / lastEventId) for first-connect priming. When ?project is set,
  // the replay is filtered to that project_id too.
  const lastIdRaw =
    req.headers['last-event-id'] || sp.get('last_event_id') || sp.get('lastEventId');
  const lastId = lastIdRaw != null ? parseInt(lastIdRaw, 10) : NaN;
  if (Number.isFinite(lastId) && lastId >= 0) {
    try {
      const rows = stmts.eventsSinceId.all(lastId);
      for (const row of rows) {
        if (client.project && row.project_id !== client.project) continue;
        if (!send(row.id, rowEventToObj(row))) return;
      }
    } catch (err) {
      process.stderr.write('[sidewrite] replay failed: ' + err.message + '\n');
    }
  }

  // 3. initial_load {active, providers, pipeline}
  send(0, {
    type: 'initial_load',
    ts: nowTs(),
    active: readActive(),
    providers: listProviders(),
    pipeline: pipelineSnapshot(),
  });

  // 4. processing_status
  send(0, {
    type: 'processing_status',
    ts: nowTs(),
    isProcessing: state.isProcessing,
    queueDepth: state.queueDepth,
  });
}

// ---------------------------------------------------------------------------
// Main request router
// ---------------------------------------------------------------------------
function router(req, res) {
  let parsedUrl;
  try {
    parsedUrl = new URL(req.url, 'http://' + HOST + ':' + state.port);
  } catch (_) {
    sendJson(res, 400, { ok: false, error: 'bad url' });
    return;
  }
  const pathname = parsedUrl.pathname;
  const method = req.method || 'GET';
  state.lastActivity = Date.now();

  // Host / Origin guard applies to everything.
  if (!hostAllowed(req)) {
    sendJson(res, 403, { ok: false, error: 'forbidden host/origin' });
    return;
  }

  // GET / : viewer.html (no bearer, but host-guarded).
  if (pathname === '/' && method === 'GET') {
    const html = renderViewerHtml();
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
      'Cache-Control': 'no-store',
    });
    res.end(html);
    return;
  }

  // Static assets (viewer.css, js/**.js): unauthenticated, Host-guarded,
  // token-free — resolved BEFORE the authRequired block so the public,
  // host-guarded, token-free set (/, static, /api/health) stays grouped and no
  // future /api/* prefix check can accidentally capture them. serveStatic()
  // returns true once it has answered (a hit or a guarded miss), false only
  // when the path is not a static request so the router keeps matching routes.
  if (method === 'GET' && pathname !== '/' && !pathname.startsWith('/api/')) {
    if (serveStatic(req, res, pathname)) return;
  }

  // GET /api/health : unauthenticated (but still Host-guarded, like GET /).
  // healthSnapshot() carries NO secret, so it is safe for curl-only status
  // checks. Every OTHER /api/* route stays bearer-protected below.
  const healthUnauthed = pathname === '/api/health' && method === 'GET';

  // Everything below requires a valid bearer token.
  const authRequired =
    !healthUnauthed &&
    (pathname === '/stream' ||
      pathname === '/event' ||
      pathname === '/stream-json' ||
      pathname.startsWith('/api/'));
  if (authRequired && !bearerOk(req)) {
    // /stream additionally accepts ?token= for EventSource clients.
    const streamQueryOk = pathname === '/stream' && queryTokenOk(parsedUrl);
    if (!streamQueryOk) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
  }

  // SSE stream
  if (pathname === '/stream' && method === 'GET') {
    handleStream(req, res);
    return;
  }

  // POST /event
  if (pathname === '/event' && method === 'POST') {
    withBody(req, res, (body) => {
      const evt = ingestEvent(body);
      // Mirror /stream-json: a cost_update must land in the deduped `costs` table,
      // else it is invisible to /api/costs + the runs totals (and would only ever
      // be counted by the drill-in) — the two totals must never diverge.
      if (evt && evt.type === 'cost_update') ingestCost(evt);
      sendJson(res, 200, { ok: true });
    });
    return;
  }

  // POST /stream-json (from sj-bridge)
  if (pathname === '/stream-json' && method === 'POST') {
    withBody(req, res, (body) => {
      const evt = ingestEvent(body);
      if (evt.type === 'cost_update') {
        ingestCost(evt);
      }
      sendJson(res, 200, { ok: true });
    });
    return;
  }

  // POST /v1/messages — the Free-Tier Pool's Anthropic-wire endpoint. This is
  // what ccx/Claude Code actually calls, so it does NOT use the dashboard's
  // per-boot bearer TOKEN (that's for the UI only) — it checks the pool's own
  // persistent token instead (see GET /api/freetier/token), the same
  // separation freellmapi's own "unified API key vs admin dashboard login"
  // draws, arrived at independently for the same reason: ccx needs a
  // credential that survives a daemon restart.
  if (pathname === '/v1/messages' && method === 'POST') {
    const auth = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    const provided = (req.headers['x-api-key']) || (m && m[1]) || '';
    if (!pool.poolTokenMatches(provided)) {
      sendJson(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid Free-Tier Pool token' } });
      return;
    }
    withBody(req, res, (body) => {
      // routeMessage streams directly to `res` itself on the success path
      // (real incremental SSE, not a buffered blob) and only RETURNS a value
      // when it hasn't already written anything — i.e. an error, or the
      // client didn't ask for streaming.
      poolRouter.routeMessage(req, res, body).then((result) => {
        if (result.handled) return; // already streamed + res.end()'d
        sendJson(res, result.status, result.json);
      }).catch((err) => {
        if (res.headersSent) { try { res.end(); } catch (_) {} return; }
        sendJson(res, 500, { type: 'error', error: { type: 'api_error', message: err.message } });
      });
    });
    return;
  }

  // ---- Control + Read API ----
  if (pathname === '/api/health' && method === 'GET') {
    sendJson(res, 200, healthSnapshot());
    return;
  }

  if (pathname === '/api/providers' && method === 'GET') {
    sendJson(res, 200, listProviders());
    return;
  }

  if (pathname === '/api/providers' && method === 'POST') {
    withBody(req, res, (body) => {
      const name = body.name;
      if (!providerNameSafe(name)) {
        sendJson(res, 400, { ok: false, error: 'invalid provider name' });
        return;
      }
      if (isForbiddenBaseUrl(body.baseUrl)) {
        sendJson(res, 400, {
          ok: false,
          error: 'baseUrl must not be api.anthropic.com',
        });
        return;
      }
      if (!body.baseUrl) {
        sendJson(res, 400, { ok: false, error: 'baseUrl required' });
        return;
      }
      writeProvider(name, {
        baseUrl: body.baseUrl,
        apiKey: body.apiKey,
        models: Array.isArray(body.models) ? body.models : [],
        prices: body.prices && typeof body.prices === 'object' ? body.prices : {},
      });
      // Guarantee an active model exists (auto-activate the first one if none).
      ensureActiveDefault();
      sendJson(res, 200, { ok: true, active: readActive() });
    });
    return;
  }

  // /api/providers/:name  (DELETE)  and  /api/providers/:name/models (POST)
  if (pathname.startsWith('/api/providers/')) {
    const rest = pathname.slice('/api/providers/'.length);
    const segs = rest.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
    const name = segs[0];
    if (!providerNameSafe(name)) {
      sendJson(res, 400, { ok: false, error: 'invalid provider name' });
      return;
    }
    if (segs.length === 1 && method === 'DELETE') {
      try {
        fs.unlinkSync(providerFilePath(name));
      } catch (_) {}
      sendJson(res, 200, { ok: true });
      return;
    }
    if (segs.length === 2 && segs[1] === 'models' && method === 'POST') {
      withBody(req, res, (body) => {
        if (!body.model) {
          sendJson(res, 400, { ok: false, error: 'model required' });
          return;
        }
        addModelToProvider(name, body.model, body.priceIn, body.priceOut);
        ensureActiveDefault();
        sendJson(res, 200, { ok: true, active: readActive() });
      });
      return;
    }
    // POST /api/providers/:id/test — connectivity test (S11). The stored 0600
    // key is read SERVER-SIDE and sent only as an x-api-key header by
    // fetchAnthropicPing; it is NEVER placed in the response. The probe POSTs a
    // minimal /v1/messages ping (the SAME endpoint+verb sidewrite actually uses
    // to delegate) rather than GET /v1/models — some anthropic-wire providers
    // (confirmed: mimo) don't serve a models list at all and 404 on that GET
    // even though they are perfectly healthy, which used to misreport a
    // healthy provider as "failed · 404". Bounded by an outer 6s guard.
    // api.anthropic.com is refused (same invariant as everywhere else).
    if (segs.length === 2 && segs[1] === 'test' && method === 'POST') {
      let env = {};
      try {
        env = parseEnvFile(fs.readFileSync(providerFilePath(name), 'utf8'));
      } catch (_) {
        sendJson(res, 404, { ok: false, error: 'unknown provider', status: 0, latencyMs: 0 });
        return;
      }
      const baseUrl = env.CCX_BASE_URL || '';
      const key = env.CCX_TOKEN || '';
      if (isForbiddenBaseUrl(baseUrl)) {
        sendJson(res, 200, { ok: false, error: 'api.anthropic.com is not allowed', status: 0, latencyMs: 0 });
        return;
      }
      if (!baseUrl) {
        sendJson(res, 200, { ok: false, error: 'provider has no base URL', status: 0, latencyMs: 0 });
        return;
      }
      const model = pickTestModel(name, env);
      const started = Date.now();
      let settled = false;
      const guard = setTimeout(() => {
        if (settled) return;
        settled = true;
        sendJson(res, 200, { ok: false, error: 'request timed out', status: 0, latencyMs: Date.now() - started });
      }, 6000);
      if (guard.unref) guard.unref();
      fetchAnthropicPing(baseUrl, key || null, model, (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        sendJson(res, 200, {
          ok: !!(result && result.ok),
          status: (result && result.status) || 0,
          latencyMs: Date.now() - started,
          error: result && result.ok ? null : (result && result.error) || 'probe failed',
        });
      });
      return;
    }
    sendJson(res, 404, { ok: false, error: 'not found' });
    return;
  }

  // ---- Free-Tier Pool (Track B) — dashboard-authenticated CRUD ----
  // GET /api/freetier — list registered keys (redacted: apiKey never leaves
  // this process, same "never echo the key back" invariant as /api/providers).
  if (pathname === '/api/freetier' && method === 'GET') {
    const now = Date.now();
    const keys = pool.listFreetierKeys().map((k) => {
      const red = pool.redact(k);
      const until = poolRouter._debugCooldowns.get(k.id);
      red.cooling = !!(until && until > now);
      // Live rpm/rpd/tpm/tpd usage against this key's OWN declared limits
      // (pool-limiter.cjs) — only present for axes the user actually
      // declared a limit on, same "no limit declared = no data" contract
      // limitsText() already renders around.
      red.usage = poolRouter.usageSnapshot(k);
      return red;
    });
    sendJson(res, 200, {
      keys,
      catalog: require('../data/pool-providers.json').providers,
      endpoint: 'http://' + HOST + ':' + state.port,
    });
    return;
  }

  // POST /api/freetier — register a new free-tier key.
  //
  // apiKey is optional when this provider already has at least one
  // registered key: a provider only ever issues ONE key regardless of how
  // many of its models are added, so re-pasting the identical value for a
  // 2nd/3rd/4th model is pure friction — reuse the existing plaintext value
  // server-side instead (listFreetierKeys() already decrypts at-rest; the
  // raw key is never sent to or requested from the client for this path).
  // Still required for a provider's very first key, and a caller MAY still
  // pass apiKey explicitly to register a different credential for the same
  // provider (e.g. a second account) — an explicit value always wins.
  if (pathname === '/api/freetier' && method === 'POST') {
    withBody(req, res, (body) => {
      if (!body.providerId) {
        sendJson(res, 400, { ok: false, error: 'providerId required' });
        return;
      }
      let apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      if (!apiKey) {
        const existing = pool.listFreetierKeys().find((k) => k.providerId === body.providerId && k.apiKey);
        if (existing) apiKey = existing.apiKey;
      }
      if (!apiKey) {
        sendJson(res, 400, { ok: false, error: 'providerId and apiKey required' });
        return;
      }
      const catalog = require('../data/pool-providers.json').providers;
      const meta = catalog.find((p) => p.id === body.providerId);
      if (!meta) {
        sendJson(res, 400, { ok: false, error: 'unknown providerId' });
        return;
      }
      const id = pool.genId(body.providerId);
      const rec = pool.writeFreetierKey(id, {
        providerId: body.providerId,
        label: body.label || meta.name,
        baseUrl: body.baseUrl || '',
        model: body.model || '',
        contextWindow: body.contextWindow,
        tier: body.tier || 'sonnet',
        priority: body.priority,
        enabled: body.enabled !== false,
        limits: body.limits,
        apiKey,
      });
      sendJson(res, 200, { ok: true, key: pool.redact(rec) });
    });
    return;
  }

  // GET /api/freetier/token — the pool's persistent unified access token
  // (distinct from the dashboard's per-boot bearer TOKEN). Needed once, to
  // wire ccx's CCX_TOKEN at http://127.0.0.1:<port> for the "freetier" provider.
  if (pathname === '/api/freetier/token' && method === 'GET') {
    sendJson(res, 200, { token: pool.getOrCreatePoolToken(), endpoint: 'http://' + HOST + ':' + state.port });
    return;
  }
  if (pathname === '/api/freetier/token' && method === 'POST') {
    sendJson(res, 200, { token: pool.regeneratePoolToken() });
    return;
  }

  // POST /api/freetier/reorder — body {ids:[...]} in the caller's intended
  // top-to-bottom order (already scoped to one tier by the dashboard).
  if (pathname === '/api/freetier/reorder' && method === 'POST') {
    withBody(req, res, (body) => {
      pool.reorderFreetierKeys(Array.isArray(body.ids) ? body.ids : []);
      sendJson(res, 200, { ok: true, keys: pool.listFreetierKeys().map(pool.redact) });
    });
    return;
  }

  // PATCH /api/freetier/:id (edit) and DELETE /api/freetier/:id (remove).
  if (pathname.startsWith('/api/freetier/')) {
    const id = decodeURIComponent(pathname.slice('/api/freetier/'.length));
    if (!pool.idSafe(id)) {
      sendJson(res, 400, { ok: false, error: 'invalid id' });
      return;
    }
    if (method === 'PATCH') {
      withBody(req, res, (body) => {
        if (!pool.readFreetierKey(id)) {
          sendJson(res, 404, { ok: false, error: 'not found' });
          return;
        }
        const rec = pool.writeFreetierKey(id, body);
        sendJson(res, 200, { ok: true, key: pool.redact(rec) });
      });
      return;
    }
    if (method === 'DELETE') {
      pool.deleteFreetierKey(id);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  // POST /api/openrouter/models — the Anthropic-compatible OpenRouter catalog.
  // Default: served instantly from the offline snapshot (no network, no key), so
  // the picker always lists models right after install. {refresh:true} does a
  // live fetch and mirrors it to the on-disk cache; on any error it falls back
  // to the offline catalog rather than failing the picker.
  if (pathname === '/api/openrouter/models' && method === 'POST') {
    withBody(req, res, (body) => {
      const wantRefresh = !!(body && body.refresh === true);
      const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      if (!wantRefresh) {
        const models = loadModelCatalog();
        sendJson(res, 200, {
          ok: true,
          baseUrl: OPENROUTER_ANTHROPIC_BASE,
          source: 'offline',
          count: models.length,
          models,
        });
        return;
      }
      fetchOpenRouterModels(apiKey || null, (err, models) => {
        if (err) {
          const offline = loadModelCatalog();
          sendJson(res, 200, {
            ok: true,
            baseUrl: OPENROUTER_ANTHROPIC_BASE,
            source: 'offline',
            stale: true,
            error: err.message,
            count: offline.length,
            models: offline,
          });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          baseUrl: OPENROUTER_ANTHROPIC_BASE,
          source: 'live',
          count: models.length,
          models,
        });
      });
    });
    return;
  }

  // GET /api/providers-catalog — the bundled provider catalog (no secrets).
  // Read + cached in memory; a missing/corrupt file yields {version:0,providers:[]}.
  if (pathname === '/api/providers-catalog' && method === 'GET') {
    sendJson(res, 200, loadProvidersCatalog());
    return;
  }

  // POST /api/provider-models — CORS-avoiding server-side model listing.
  // Body: { baseUrl, modelsEndpoint, apiKey }. Always answers HTTP 200 so the UI
  // can surface the outcome; failures come back as { ok:false, error, status }.
  // The api.anthropic.com invariant is enforced here too.
  if (pathname === '/api/provider-models' && method === 'POST') {
    withBody(req, res, (body) => {
      const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
      const modelsEndpoint =
        typeof body.modelsEndpoint === 'string' ? body.modelsEndpoint.trim() : '';
      const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      if (isForbiddenBaseUrl(baseUrl) || isForbiddenBaseUrl(modelsEndpoint)) {
        sendJson(res, 200, { ok: false, error: 'api.anthropic.com is not allowed' });
        return;
      }
      if (!baseUrl && !modelsEndpoint) {
        sendJson(res, 200, { ok: false, error: 'baseUrl required', status: 0 });
        return;
      }
      fetchProviderModels(baseUrl, modelsEndpoint, apiKey || null, (result) => {
        sendJson(res, 200, result);
      });
    });
    return;
  }

  if (pathname === '/api/active' && method === 'GET') {
    sendJson(res, 200, readActive());
    return;
  }

  if (pathname === '/api/active' && method === 'POST') {
    withBody(req, res, (body) => {
      writeActive(body.provider, body.model);
      state.activeProvider = body.provider || state.activeProvider;
      ingestEvent({
        type: 'active_changed',
        provider: body.provider || null,
        model: body.model || null,
        ts: nowTs(),
      });
      sendJson(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/config' && method === 'GET') {
    sendJson(res, 200, readConfig());
    return;
  }

  if (pathname === '/api/config' && method === 'POST') {
    withBody(req, res, (body) => {
      body = body || {};
      if (
        body.mode !== undefined &&
        body.mode !== 'subscription' &&
        body.mode !== 'standalone'
      ) {
        sendJson(res, 400, { ok: false, error: 'invalid mode' });
        return;
      }
      // Whitelist of top-level keys writable via POST /api/config. Anything
      // outside this set is silently ignored (fail-closed). `mode` is
      // additionally value-validated above; `flagOverrides`/`remoteConfig` are
      // shape-validated below. `onboarded`/`flags` are server-managed and never
      // accepted from the client (flags are resolved, not written directly).
      const patch = { onboarded: true };
      if (body.mode !== undefined) patch.mode = body.mode;
      if (body.session !== undefined) {
        patch.session = body.session;
        if (body.session && body.session.provider === 'freetier') {
          try { writeFreetierCcxEnv(); } catch (_) {}
        }
      }
      if (body.planner !== undefined) patch.planner = body.planner;
      if (body.reviewer !== undefined) patch.reviewer = body.reviewer;
      if (body.autoMergeOnClean !== undefined) {
        patch.autoMergeOnClean = body.autoMergeOnClean;
      }
      if (body.flagOverrides !== undefined) {
        const r = sanitizeFlagOverrides(body.flagOverrides);
        if (!r.ok) { sendJson(res, 400, { ok: false, error: r.error }); return; }
        patch.flagOverrides = r.value;
      }
      if (body.remoteConfig !== undefined) {
        const r = sanitizeRemoteConfig(body.remoteConfig);
        if (!r.ok) { sendJson(res, 400, { ok: false, error: r.error }); return; }
        patch.remoteConfig = r.value;
      }
      // parallel.maxConcurrency: the Sub-agents page's scale control. Overrides
      // bin/sidewrite-run's default nproc-based worker-pool cap (min(N,nproc-1,4))
      // when set; null clears back to that default. Clamped to a sane range —
      // this bounds concurrent ccx|sj-bridge pipelines, not a soft UI value.
      if (body.parallel !== undefined) {
        if (body.parallel === null) {
          patch.parallel = null;
        } else if (typeof body.parallel === 'object') {
          const mc = body.parallel.maxConcurrency;
          if (mc !== undefined && mc !== null) {
            const n = Number(mc);
            if (!Number.isInteger(n) || n < 1 || n > 16) {
              sendJson(res, 400, { ok: false, error: 'parallel.maxConcurrency must be an integer 1-16' });
              return;
            }
            patch.parallel = { maxConcurrency: n };
          } else {
            // Explicit null (not omitted) clears back to the automatic default —
            // deepMergeConfig only overwrites keys present in the patch, so this
            // must set maxConcurrency:null rather than {} to actually clear it.
            patch.parallel = { maxConcurrency: null };
          }
        } else {
          sendJson(res, 400, { ok: false, error: 'invalid parallel' });
          return;
        }
      }
      const cfg = writeConfig(patch);
      ingestEvent({
        type: 'config_changed',
        mode: cfg.mode,
        onboarded: true,
        ts: nowTs(),
      });
      sendJson(res, 200, { ok: true, config: readConfig() });
    });
    return;
  }

  // GET /api/config/safe — the SAFE config surface (#3 / S8). The single clean
  // read path for the new features: feature flags resolved to plain booleans,
  // the explicit boolean overrides, the budgets block, and the telemetry opt-in
  // (default OFF). No secrets, no install-id, no remoteConfig.url, no paths.
  if (pathname === '/api/config/safe' && method === 'GET') {
    sendJson(res, 200, Object.assign({ ok: true }, safeConfigView(readConfig())));
    return;
  }

  // POST /api/config/safe — write the safe surface. Accepts a whitelisted subset:
  // `flagOverrides` (per-flag true|false|null, null clears), `budgets` (same
  // validators as POST /api/budget), and `telemetry.level` (allowlisted; default
  // OFF). Every field validated + clamped before an atomic writeConfig; writeConfig
  // re-resolves cfg.flags so the shell runner sees fresh booleans. Fail-closed:
  // an empty/invalid patch 400s; mode/onboarding are NOT reachable from here.
  if (pathname === '/api/config/safe' && method === 'POST') {
    withBody(req, res, (body) => {
      body = body || {};
      const patch = {};

      if (body.flagOverrides !== undefined) {
        const r = sanitizeFlagOverrides(body.flagOverrides);
        if (!r.ok) { sendJson(res, 400, { ok: false, error: r.error }); return; }
        patch.flagOverrides = r.value;
      }

      if (body.budgets !== undefined) {
        const bIn = body.budgets;
        if (bIn === null || typeof bIn !== 'object' || Array.isArray(bIn)) {
          sendJson(res, 400, { ok: false, error: 'budgets must be an object' });
          return;
        }
        const b = {};
        if (bIn.enabled !== undefined) b.enabled = !!bIn.enabled;
        if (bIn.enforce !== undefined) b.enforce = !!bIn.enforce;
        if (bIn.monthlyUsd !== undefined) {
          const v = budgetNum(bIn.monthlyUsd);
          if (v === false) { sendJson(res, 400, { ok: false, error: 'invalid monthlyUsd' }); return; }
          b.monthlyUsd = v;
        }
        if (bIn.perRunUsd !== undefined) {
          const v = budgetNum(bIn.perRunUsd);
          if (v === false) { sendJson(res, 400, { ok: false, error: 'invalid perRunUsd' }); return; }
          b.perRunUsd = v;
        }
        if (bIn.warnPct !== undefined) {
          const n = Number(bIn.warnPct);
          if (!Number.isFinite(n) || n < 1 || n > 100) {
            sendJson(res, 400, { ok: false, error: 'invalid warnPct (1..100)' });
            return;
          }
          b.warnPct = Math.floor(n);
        }
        patch.budgets = b;
      }

      if (body.telemetry !== undefined) {
        const t = body.telemetry;
        if (t === null || typeof t !== 'object' || Array.isArray(t)) {
          sendJson(res, 400, { ok: false, error: 'telemetry must be an object' });
          return;
        }
        if (t.level !== undefined) {
          const lv = String(t.level);
          if (!TELEMETRY_LEVELS.includes(lv)) {
            sendJson(res, 400, { ok: false, error: 'invalid telemetry level (off|crash|error|all)' });
            return;
          }
          patch.telemetry = { level: lv };
        }
      }

      if (Object.keys(patch).length === 0) {
        sendJson(res, 400, { ok: false, error: 'no writable fields (flagOverrides|budgets|telemetry)' });
        return;
      }

      const cfg = writeConfig(patch);
      sendJson(res, 200, Object.assign({ ok: true }, safeConfigView(cfg)));
    });
    return;
  }

  // GET /api/runs — keyset-paginated run list (History #6 / S7), with optional
  // ?status= and ?project= (#9) filters. Response: { runs, nextCursor, lastSeq,
  // limit }. Each run row carries the denormalized cost totals. Ordering is
  // (COALESCE(started_at,0) DESC, id DESC); the opaque cursor is base64url(JSON
  // {s,id}) of the last returned row. lastSeq = MAX(events.id) primes the SSE
  // reconnect (snapshot-then-subscribe). No OFFSET, no unbounded scan.
  if (pathname === '/api/runs' && method === 'GET') {
    ensureDb();
    const limit = clampInt(parsedUrl.searchParams.get('limit'), 50, 1, 500);

    const statusRaw = parsedUrl.searchParams.get('status');
    const status = statusRaw ? String(statusRaw).slice(0, 32) : null;

    const projectRaw = parsedUrl.searchParams.get('project');
    let project = null;
    if (projectRaw != null && projectRaw !== '') {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(projectRaw)) {
        sendJson(res, 400, { ok: false, error: 'invalid project' });
        return;
      }
      project = projectRaw;
    }

    const cursorRaw = parsedUrl.searchParams.get('cursor');
    let cursor = null;
    if (cursorRaw != null && cursorRaw !== '') {
      cursor = decodeCursor(cursorRaw);
      if (!cursor) {
        sendJson(res, 400, { ok: false, error: 'invalid cursor' });
        return;
      }
    }

    // Params exactly match the placeholders in the chosen statement shape.
    const params = { lim: limit + 1 };
    if (status) params.status = status;
    if (project) params.project = project;
    if (cursor) {
      params.s = cursor.s;
      params.id = cursor.id;
    }

    let rows = [];
    try {
      rows = runsKeysetStmt(!!status, !!project, !!cursor).all(params);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message });
      return;
    }

    // n+1 fetch => has_more; emit an opaque cursor pointing at the last kept row.
    let nextCursor = null;
    if (rows.length > limit) {
      rows = rows.slice(0, limit);
      const last = rows[rows.length - 1];
      nextCursor = encodeCursor({ s: numOr0(last.started_at), id: String(last.id) });
    }

    let lastSeq = 0;
    try {
      const m = stmts.maxEventId.get();
      lastSeq = m ? numOr0(m.seq) : 0;
    } catch (_) {}

    sendJson(res, 200, { ok: true, runs: rows, nextCursor, lastSeq, limit });
    return;
  }

  // GET /api/runs/:id  and  /api/runs/:id/snapshot
  if (pathname.startsWith('/api/runs/') && method === 'GET') {
    ensureDb();
    const rest = pathname.slice('/api/runs/'.length);
    const segs = rest.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
    const id = segs[0];
    if (!id || id.indexOf('..') !== -1 || !/^[A-Za-z0-9._-]+$/.test(id)) {
      sendJson(res, 400, { ok: false, error: 'invalid run id' });
      return;
    }
    if (segs.length === 1) { sendRunDetail(res, id); return; }
    if (segs.length === 2 && segs[1] === 'snapshot') { sendRunSnapshot(res, id); return; }
    if (segs.length === 2 && segs[1] === 'diff') { sendRunDiff(res, id); return; }
    sendJson(res, 404, { ok: false, error: 'not found' });
    return;
  }

  // POST /api/runs/:id/redispatch — re-run the PERSISTED brief of a finished/failed
  // run (never fabricate one). Fail-closed: refuse a still-running or already-
  // succeeded run, and refuse when no intact brief/plan is on disk. Spawns the
  // shipped bin/sidewrite-run detached (args array => no shell => no injection);
  // the new run id is minted here and handed to the child via SIDEWRITE_RUN_ID
  // (the coordinated sidewrite-run half of the contract) and stamped onto a
  // run_redispatch SSE event so the dashboard can follow it.
  if (pathname.startsWith('/api/runs/') && method === 'POST') {
    ensureDb();
    const rest = pathname.slice('/api/runs/'.length);
    const segs = rest.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
    const id = segs[0];
    if (!id || id.indexOf('..') !== -1 || !/^[A-Za-z0-9._-]+$/.test(id)) {
      sendJson(res, 400, { ok: false, error: 'invalid run id' });
      return;
    }
    if (segs.length !== 2 || segs[1] !== 'redispatch') {
      sendJson(res, 404, { ok: false, error: 'not found' });
      return;
    }
    withBody(req, res, () => {
      let run = null;
      try { run = stmts.runById.get(id) || null; } catch (_) {}
      if (!run) { sendJson(res, 404, { ok: false, error: 'unknown run' }); return; }
      if (run.status === 'running') { sendJson(res, 409, { ok: false, error: 'run is still active' }); return; }
      if (run.status === 'success') { sendJson(res, 409, { ok: false, error: 'run succeeded; nothing to redispatch' }); return; }
      const provider = run.provider;
      if (!providerNameSafe(provider) || !fs.existsSync(providerFilePath(provider))) {
        sendJson(res, 409, { ok: false, error: 'run has no usable provider to redispatch' });
        return;
      }
      const brief = resolveRedispatchBrief(id, run);
      if (!brief) {
        sendJson(res, 409, {
          ok: false,
          error: 'no persisted brief for this run; cannot redispatch',
          hint: 'the original brief / PLAN.md was not retained for this run',
        });
        return;
      }
      // cwd = the run's original working directory sidecar; must still exist.
      let origdir = '';
      try { origdir = fs.readFileSync(path.join(RUNS_DIR, id + '.origdir'), 'utf8').trim(); } catch (_) {}
      let cwdOk = false;
      try { cwdOk = !!origdir && fs.statSync(origdir).isDirectory(); } catch (_) {}
      if (!cwdOk) {
        sendJson(res, 409, { ok: false, error: 'original working directory unavailable; cannot redispatch' });
        return;
      }
      const runnerPath = path.resolve(__dirname, '..', '..', 'bin', 'sidewrite-run');
      if (!fs.existsSync(runnerPath)) {
        sendJson(res, 500, { ok: false, error: 'runner not found' });
        return;
      }
      const newRunId =
        'run_' + Math.floor(Date.now() / 1000) + '_rd' + crypto.randomBytes(3).toString('hex');
      const briefFile = path.join(RUNS_DIR, newRunId + '.brief');
      try {
        const tmp = briefFile + '.tmp';
        writeFileMode(tmp, brief.text, 0o600);
        fs.renameSync(tmp, briefFile);
      } catch (_) {
        sendJson(res, 500, { ok: false, error: 'could not stage brief' });
        return;
      }
      try {
        const { spawn } = require('node:child_process');
        const env = Object.assign({}, process.env, { SIDEWRITE_RUN_ID: newRunId });
        const child = spawn(runnerPath, [provider, '--prompt-file', briefFile], {
          cwd: origdir,
          env,
          detached: true,
          stdio: 'ignore',
        });
        child.on('error', () => {}); // never let a spawn error crash the daemon
        child.unref();
      } catch (_) {
        sendJson(res, 500, { ok: false, error: 'could not launch redispatch' });
        return;
      }
      ingestEvent({
        type: 'run_redispatch',
        run_id: newRunId,
        source_run_id: id,
        provider,
        brief_source: brief.source,
        project_id: run.project || null,
        ts: nowTs(),
      });
      sendJson(res, 200, {
        ok: true,
        run_id: newRunId,
        source_run_id: id,
        provider,
        brief_source: brief.source,
      });
    });
    return;
  }

  if (pathname === '/api/events' && method === 'GET') {
    ensureDb();
    const runId = parsedUrl.searchParams.get('run_id');
    let rows = [];
    try {
      if (runId) {
        rows = stmts.eventsForRun.all(runId);
      } else {
        // No run_id: return the most RECENT events (any run) so the dashboard can
        // rebuild its log after a page refresh instead of showing an empty panel.
        const lim = Math.min(500, Math.max(1, parseInt(parsedUrl.searchParams.get('limit'), 10) || 200));
        rows = stmts.recentEvents.all(lim).reverse(); // newest-first from SQL -> chronological
      }
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message });
      return;
    }
    sendJson(res, 200, { events: rows.map(rowEventToObj) });
    return;
  }

  // ---- Analytics (#4): query-on-read over the deduped `costs` table. Date range
  // is epoch-ms (?from/?to, default last 30d); all params parameterized; `by` is
  // validated against BREAKDOWN_COLUMNS. All routes bearer + Host guarded above.

  // GET /api/analytics/summary?from&to — KPI totals for the window.
  if (pathname === '/api/analytics/summary' && method === 'GET') {
    ensureDb();
    const { from, to } = parseRange(parsedUrl);
    let row = null;
    try {
      row = stmts.analyticsSummary.get(from, to) || null;
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message });
      return;
    }
    sendJson(res, 200, { ok: true, from, to, summary: row || {} });
    return;
  }

  // GET /api/analytics/timeseries?from&to — per-day rollup (trend / heatmap).
  if (pathname === '/api/analytics/timeseries' && method === 'GET') {
    ensureDb();
    const { from, to } = parseRange(parsedUrl);
    let rows = [];
    try {
      rows = stmts.analyticsTimeseries.all(from, to);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message });
      return;
    }
    sendJson(res, 200, { ok: true, from, to, series: rows });
    return;
  }

  // GET /api/analytics/breakdown?by=model|provider|agent|worker|session|project
  // &from&to — grouped rollup. `by` MUST be an own-key of BREAKDOWN_COLUMNS (fixed
  // allowlist); default model; anything else -> 400. Never interpolates `by`.
  if (pathname === '/api/analytics/breakdown' && method === 'GET') {
    ensureDb();
    const { from, to } = parseRange(parsedUrl);
    const byRaw = parsedUrl.searchParams.get('by');
    const by =
      byRaw == null || byRaw === ''
        ? 'model'
        : Object.prototype.hasOwnProperty.call(BREAKDOWN_COLUMNS, byRaw)
          ? byRaw
          : null;
    if (!by) {
      sendJson(res, 400, {
        ok: false,
        error: 'invalid by (allowed: ' + Object.keys(BREAKDOWN_COLUMNS).join('|') + ')',
      });
      return;
    }
    sendBreakdown(res, by, from, to);
    return;
  }

  // GET /api/costs — retained for back-compat; DELEGATES to breakdown?by=model over
  // the same deduped costs table (default 30d window, ?from/?to honored).
  if (pathname === '/api/costs' && method === 'GET') {
    ensureDb();
    const { from, to } = parseRange(parsedUrl);
    let rows = [];
    try {
      rows = stmts.breakdown.model.all(from, to);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message });
      return;
    }
    sendJson(res, 200, { ok: true, by: 'model', from, to, costs: rows });
    return;
  }

  // GET /api/projects — multi-project (#9) list with per-project run rollups.
  if (pathname === '/api/projects' && method === 'GET') {
    ensureDb();
    let rows = [];
    try {
      rows = stmts.projectsList.all();
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message });
      return;
    }
    sendJson(res, 200, { ok: true, projects: rows });
    return;
  }

  // ---- Cost budgets + alerts. Config in ~/.sidewrite/config.json (never
  // ~/.claude). Month spend is a bounded single-row aggregate over `costs`.
  // Fail-closed: a dispatch is blocked ONLY when enforce===true AND a KNOWN est
  // cost pushes the month over the cap (unknown cost warns, never hard-blocks).

  // GET /api/budget — current budget config + this month's spend (for the ring).
  if (pathname === '/api/budget' && method === 'GET') {
    ensureDb();
    const b = normalizeBudget(readConfig().budgets);
    const monthFrom = monthStartMs();
    let monthUsd = 0;
    let entries = 0;
    try {
      const r = db
        .prepare('SELECT COALESCE(SUM(usd), 0) AS usd, COUNT(*) AS entries FROM costs WHERE ts >= ?')
        .get(monthFrom);
      monthUsd = numOr0(r && r.usd);
      entries = numOr0(r && r.entries);
    } catch (_) {}
    sendJson(res, 200, { ok: true, budget: b, month: { from: monthFrom, usd: monthUsd, entries } });
    return;
  }

  // POST /api/budget — write the budget config. Every field validated + clamped;
  // caps are non-negative numbers or null, warnPct is 1..100. Atomic writeConfig.
  if (pathname === '/api/budget' && method === 'POST') {
    withBody(req, res, (body) => {
      body = body || {};
      const patch = {};
      if (body.enabled !== undefined) patch.enabled = !!body.enabled;
      if (body.enforce !== undefined) patch.enforce = !!body.enforce;
      if (body.monthlyUsd !== undefined) {
        const v = budgetNum(body.monthlyUsd);
        if (v === false) { sendJson(res, 400, { ok: false, error: 'invalid monthlyUsd' }); return; }
        patch.monthlyUsd = v;
      }
      if (body.perRunUsd !== undefined) {
        const v = budgetNum(body.perRunUsd);
        if (v === false) { sendJson(res, 400, { ok: false, error: 'invalid perRunUsd' }); return; }
        patch.perRunUsd = v;
      }
      if (body.warnPct !== undefined) {
        const n = Number(body.warnPct);
        if (!Number.isFinite(n) || n < 1 || n > 100) {
          sendJson(res, 400, { ok: false, error: 'invalid warnPct (1..100)' });
          return;
        }
        patch.warnPct = Math.floor(n);
      }
      const cfg = writeConfig({ budgets: patch });
      sendJson(res, 200, { ok: true, budget: normalizeBudget(cfg.budgets) });
    });
    return;
  }

  // GET /api/budget/check?estUsd&run_id — pre-dispatch check helper. Emits a
  // budget_warn / budget_exceeded SSE on the respective state so the dashboard
  // toast + ring update. `allow` is the fail-closed dispatch verdict.
  if (pathname === '/api/budget/check' && method === 'GET') {
    ensureDb();
    const b = normalizeBudget(readConfig().budgets);
    const estRaw = parsedUrl.searchParams.get('estUsd');
    let estUsd = null;
    if (estRaw != null && estRaw !== '') {
      const n = Number(estRaw);
      if (Number.isFinite(n) && n >= 0) estUsd = n;
    }
    const runIdRaw = parsedUrl.searchParams.get('run_id');
    const runId = runIdRaw && /^[A-Za-z0-9._-]{1,128}$/.test(runIdRaw) ? runIdRaw : null;
    const decision = evaluateBudget(b, estUsd);
    if (decision.state === 'warn' || decision.state === 'exceeded') {
      ingestEvent({
        type: decision.state === 'exceeded' ? 'budget_exceeded' : 'budget_warn',
        run_id: runId,
        monthUsd: decision.monthUsd,
        monthlyUsd: decision.monthlyUsd,
        perRunUsd: decision.perRunUsd,
        projectedUsd: decision.projectedUsd,
        estUsd,
        enforce: b.enforce,
        allow: decision.allow,
        ts: nowTs(),
      });
    }
    sendJson(res, 200, Object.assign({ ok: true }, decision));
    return;
  }

  // GET /api/health/full — system-health panel. Consumes gate-core.cjs
  // gateChecks() (bounded child probes) + daemon self-checks, each with per-
  // failure fix text. gateChecks() is SYNCHRONOUS (spawnSync `claude`/`bash`
  // probes): running it inline would freeze the entire single-threaded daemon
  // — every route AND every live /stream SSE client — for up to ~15s if a
  // probed binary hangs. So we run it OFF the event loop in a short-lived
  // forked node child (bounded stdout + hard timeout); our loop stays
  // responsive while the child blocks. Daemon/db/disk/provider self-checks are
  // cheap and stay inline, appended once the gate result (or its failure
  // fallback) arrives.
  if (pathname === '/api/health/full' && method === 'GET') {
    ensureDb();

    const finishHealth = (gateCheckArr) => {
      const checks = Array.isArray(gateCheckArr) ? gateCheckArr.slice() : [];
      checks.push({
        name: 'daemon',
        ok: true,
        detail:
          'listening on 127.0.0.1:' + state.port + ' (pid ' + process.pid + ', up ' +
          Math.floor((Date.now() - state.startedAt) / 1000) + 's)',
        fix: null,
      });
      let dbOk = false;
      let dbDetail = '';
      try {
        const r = db.prepare('PRAGMA integrity_check').get();
        const v = r && r.integrity_check;
        dbOk = v === 'ok';
        dbDetail = 'integrity_check: ' + (v || 'unknown');
      } catch (e) {
        dbDetail = 'integrity_check failed: ' + (e && e.message ? e.message : String(e));
      }
      checks.push({
        name: 'database',
        ok: dbOk,
        detail: dbDetail,
        fix: dbOk ? null : 'the sqlite DB may be corrupt — stop the daemon and restore/rebuild ~/.sidewrite/sidewrite.db.',
      });
      let diskOk = false;
      let diskDetail = '';
      try {
        fs.accessSync(DATA_DIR, fs.constants.W_OK);
        diskOk = true;
        diskDetail = DATA_DIR + ' writable';
      } catch (_) {
        diskDetail = DATA_DIR + ' not writable';
      }
      checks.push({
        name: 'disk',
        ok: diskOk,
        detail: diskDetail,
        fix: diskOk ? null : 'ensure ' + DATA_DIR + ' exists and is writable (chmod 700).',
      });
      let provCount = 0;
      try { provCount = listProviders().length; } catch (_) {}
      checks.push({
        name: 'providers',
        ok: provCount > 0,
        detail: provCount + ' provider(s) configured',
        fix: provCount > 0 ? null : 'add a provider in the dashboard, then activate a model.',
      });
      const ok = checks.every((c) => c.ok);
      sendJson(res, 200, { ok, checks, version: VERSION });
    };

    const gateFail = (detail, fix) => [{
      name: 'gate',
      ok: false,
      detail,
      fix: fix || 'reinstall sidewrite (plugin/scripts/gate-core.cjs is missing or broken).',
    }];

    const cp = require('node:child_process');
    const gatePath = path.join(__dirname, 'gate-core.cjs');
    // -e script requires gate-core in a fresh process and emits its result as
    // JSON on stdout; never throws out of the child (fail-closed to __error).
    const gateScript =
      'try{var g=require(' + JSON.stringify(gatePath) + ').gateChecks();' +
      'process.stdout.write(JSON.stringify(g||{}));}' +
      'catch(e){process.stdout.write(JSON.stringify({__error:String((e&&e.message)||e)}));}';

    let settled = false;
    let timer = null;
    const done = (checks) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      finishHealth(checks);
    };

    let child;
    try {
      child = cp.spawn(process.execPath, ['-e', gateScript], {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: process.env,
      });
    } catch (e) {
      done(gateFail('gate probe failed to start: ' + (e && e.message ? e.message : String(e))));
      return;
    }

    let out = '';
    let size = 0;
    const OUT_CAP = 512 * 1024; // gate output is tiny; cap defends a runaway child.
    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      done(gateFail(
        'gate checks timed out',
        'a probed binary (claude/bash) may be hanging; check your PATH and shell profile.'
      ));
    }, 20000);
    if (timer.unref) timer.unref();

    child.stdout.on('data', (c) => {
      size += c.length;
      if (size > OUT_CAP) { try { child.kill('SIGKILL'); } catch (_) {} return; }
      out += c;
    });
    child.on('error', (e) => {
      done(gateFail('gate probe error: ' + (e && e.message ? e.message : String(e))));
    });
    child.on('close', () => {
      const checks = [];
      let g = null;
      try { g = JSON.parse(out || '{}'); } catch (_) { g = null; }
      if (!g) {
        checks.push.apply(checks, gateFail('gate probe returned malformed output'));
      } else if (g.__error) {
        checks.push.apply(checks, gateFail('gate-core unavailable: ' + g.__error));
      } else if (Array.isArray(g.checks)) {
        for (const c of g.checks) {
          checks.push({ name: c.name, ok: !!c.ok, detail: c.detail || '', fix: c.fix || null });
        }
      }
      done(checks);
    });
    return;
  }

  // GET /api/data/summary — privacy & data panel: counts of what is stored
  // locally + a plain-language telemetry disclosure. Pure local read, no egress.
  if (pathname === '/api/data/summary' && method === 'GET') {
    ensureDb();
    const storage = {
      db_bytes: 0,
      tables: {},
      run_sidecars: 0,
      telemetry_queue: { files: 0, bytes: 0 },
      providers: 0,
    };
    const count = (t) => {
      try { return numOr0(db.prepare('SELECT COUNT(*) AS c FROM ' + t).get().c); } catch (_) { return 0; }
    };
    for (const t of ['runs', 'events', 'costs', 'reviews', 'projects']) storage.tables[t] = count(t);
    for (const suffix of ['', '-wal', '-shm']) {
      try { storage.db_bytes += fs.statSync(DB_PATH + suffix).size; } catch (_) {}
    }
    try {
      const entries = fs.readdirSync(RUNS_DIR);
      storage.run_sidecars = Math.min(entries.length, 1000000);
    } catch (_) {}
    try {
      const qd = path.join(DATA_DIR, 'telemetry-queue');
      let files = fs.readdirSync(qd);
      if (files.length > 200000) files = files.slice(0, 200000);
      let bytes = 0;
      let n = 0;
      for (const f of files) {
        try {
          const st = fs.statSync(path.join(qd, f));
          if (st.isFile()) { bytes += st.size; n++; }
        } catch (_) {}
      }
      storage.telemetry_queue = { files: n, bytes };
    } catch (_) {}
    try { storage.providers = listProviders().length; } catch (_) {}
    const cfg = readConfig();
    const level = (cfg.telemetry && cfg.telemetry.level) || 'off';
    const on = level !== 'off';
    const telemetry = {
      level,
      enabled: on,
      disclosure: {
        summary:
          'Sidewrite stores runs, events and cost rows locally in ~/.sidewrite/sidewrite.db. ' +
          'Telemetry is ' + (on ? 'ON' : 'OFF (the default)') + '.',
        neverSent: [
          'API keys / provider tokens',
          'prompts or briefs',
          'your code or file contents',
          'absolute file paths',
          'diffs',
        ],
        sentWhenOn: on
          ? [
              'anonymized error signatures / counters',
              'provider alias (not the key)',
              'the non-reversible install id',
            ]
          : [],
      },
    };
    sendJson(res, 200, { ok: true, storage, telemetry });
    return;
  }

  // POST /api/data/purge — delete local runs/events/telemetry-queue. Requires
  // { confirm:true } (fail-closed) + at least one scope. Fixed-literal SQL (no
  // interpolation of user input); bounded sidecar/queue loops. Never ~/.claude.
  if (pathname === '/api/data/purge' && method === 'POST') {
    withBody(req, res, (body) => {
      body = body || {};
      if (body.confirm !== true) {
        sendJson(res, 400, {
          ok: false,
          error: 'confirmation required: POST { confirm:true, runs?, events?, telemetry? }',
        });
        return;
      }
      const doRuns = !!body.runs;
      const doEvents = !!body.events;
      const doTelemetry = !!body.telemetry;
      if (!doRuns && !doEvents && !doTelemetry) {
        sendJson(res, 400, {
          ok: false,
          error: 'nothing selected (set at least one of runs/events/telemetry to true)',
        });
        return;
      }
      ensureDb();
      const purged = { runs: 0, events: 0, costs: 0, reviews: 0, run_sidecars: 0, telemetry_files: 0 };
      const del = (t) => {
        // t is ALWAYS a fixed literal below — never request-derived.
        try {
          const before = numOr0(db.prepare('SELECT COUNT(*) AS c FROM ' + t).get().c);
          db.exec('DELETE FROM ' + t);
          return before;
        } catch (_) { return 0; }
      };
      if (doRuns) {
        purged.reviews = del('reviews');
        purged.costs = del('costs');
        purged.events = del('events');
        purged.runs = del('runs');
        try {
          let entries = fs.readdirSync(RUNS_DIR);
          if (entries.length > 200000) entries = entries.slice(0, 200000);
          for (const e of entries) {
            try { fs.rmSync(path.join(RUNS_DIR, e), { recursive: true, force: true }); purged.run_sidecars++; } catch (_) {}
          }
        } catch (_) {}
      } else if (doEvents) {
        purged.events = del('events');
      }
      if (doTelemetry) {
        try {
          const qd = path.join(DATA_DIR, 'telemetry-queue');
          let files = fs.readdirSync(qd);
          if (files.length > 200000) files = files.slice(0, 200000);
          for (const f of files) {
            try { fs.rmSync(path.join(qd, f), { recursive: true, force: true }); purged.telemetry_files++; } catch (_) {}
          }
        } catch (_) {}
      }
      ingestEvent({
        type: 'data_purged',
        scope: { runs: doRuns, events: doEvents, telemetry: doTelemetry },
        purged,
        ts: nowTs(),
      });
      sendJson(res, 200, { ok: true, purged });
    });
    return;
  }

  // GET /api/skills — global list, no provider dimension.
  if (pathname === '/api/skills' && method === 'GET') {
    let result;
    try {
      result = listSkillsGlobal();
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      skills: result.skills,
      essential: result.essential,
    });
    return;
  }

  // GET /api/skills/global — list the user's GLOBAL Claude Code skills
  // (~/.claude/skills) so they can be synced into every station. READ-ONLY of
  // ~/.claude (never written); flags which are already present in EVERY station.
  if (pathname === '/api/skills/global' && method === 'GET') {
    try {
      const globalDir = path.join(os.homedir(), '.claude', 'skills');
      const list = enumSkillDir(globalDir, 'global', null, new Set());
      const stations = listStationDirs();
      for (const s of list) {
        s.inStation = stations.length > 0 && stations.every((st) =>
          fs.existsSync(path.join(st, 'skills', s.name, 'SKILL.md')) ||
          fs.existsSync(path.join(st, 'skills-disabled', s.name, 'SKILL.md'))
        );
      }
      list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      sendJson(res, 200, { ok: true, skills: list });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // POST /api/skills/sync-global  { names:[] } — copy the named global
  // ~/.claude/skills dirs into EVERY station's isolated skills/ dir. Reads
  // ~/.claude (never writes it); writes only to station dirs.
  if (pathname === '/api/skills/sync-global' && method === 'POST') {
    withBody(req, res, (body) => {
      const names = Array.isArray(body.names) ? body.names : [];
      const globalDir = path.join(os.homedir(), '.claude', 'skills');
      const stations = listStationDirs();
      let copied = 0; const failed = [];
      for (const raw of names) {
        const name = String(raw || '');
        if (!/^[A-Za-z0-9._-]+$/.test(name) || name.indexOf('..') !== -1) { failed.push(raw); continue; }
        const src = path.join(globalDir, name);
        if (!fs.existsSync(path.join(src, 'SKILL.md'))) { failed.push(name); continue; }
        let anyOk = false;
        for (const st of stations) {
          const destBase = path.join(st, 'skills');
          try {
            fs.mkdirSync(destBase, { recursive: true, mode: 0o700 });
            // dereference: many global skills are symlinks (into ~/.agents/skills);
            // copy the real content so each station's SKILL.md resolves.
            fs.cpSync(src, path.join(destBase, name), { recursive: true, dereference: true });
            anyOk = true;
          } catch (_) { /* fail-soft per station */ }
        }
        if (anyOk) copied++; else failed.push(name);
      }
      sendJson(res, 200, { ok: true, copied, failed });
    });
    return;
  }

  // POST /api/skills/toggle  { name, source, enabled } — global: fans to every station.
  if (pathname === '/api/skills/toggle' && method === 'POST') {
    withBody(req, res, (body) => {
      const name = body.name;
      const source = body.source;
      const enabled = !!body.enabled;
      if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name) || name.indexOf('..') !== -1) return sendJson(res, 400, { ok: false, error: 'invalid name' });
      if (source !== 'personal' && source !== 'plugin') return sendJson(res, 400, { ok: false, error: 'invalid source' });
      try {
        if (source === 'plugin') {
          const plugin = findPluginForSkill(name);
          if (!plugin) return sendJson(res, 404, { ok: false, error: 'plugin skill not found' });
          setPluginSkillGlobal(plugin, enabled);
        } else {
          setPersonalSkillGlobal(name, source, enabled);
        }
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: e.message });
      }
      sendJson(res, 200, { ok: true, name, enabled });
    });
    return;
  }

  // POST /api/skills/pull  { plugin, marketplace? } — installs into EVERY station.
  if (pathname === '/api/skills/pull' && method === 'POST') {
    withBody(req, res, (body) => {
      const plugin = body.plugin;
      const marketplace = body.marketplace;
      if (typeof plugin !== 'string' || !plugin.trim()) return sendJson(res, 400, { ok: false, error: 'plugin required' });
      const { spawnSync } = require('node:child_process');
      const stations = listStationDirs();
      if (!stations.length) { sendJson(res, 200, { ok: true, plugin, installed: 0, failed: [] }); return; }
      let installed = 0; const failed = [];
      for (const st of stations) {
        const prov = path.basename(st).slice('.claude-'.length);
        let env;
        try { env = stationEnv(prov); } catch (e) { failed.push({ provider: prov, error: e.message }); continue; }
        const opts = { env, encoding: 'utf8', timeout: 180000 };
        try {
          if (marketplace && String(marketplace).trim()) {
            spawnSync('claude', ['plugin', 'marketplace', 'add', String(marketplace)], opts);
          }
          const r = spawnSync('claude', ['plugin', 'install', plugin], opts);
          if (r.status === 0) {
            installed++;
          } else {
            const msg = (r.stderr || r.stdout || (r.error && r.error.message) || 'install failed').toString().slice(0, 300);
            failed.push({ provider: prov, error: msg });
          }
        } catch (e) {
          failed.push({ provider: prov, error: e.message });
        }
      }
      sendJson(res, 200, { ok: installed > 0, plugin, installed, failed });
    });
    return;
  }

  // POST /api/skills/essential  { name, source, essential } — legacy alias; now
  // identical to a global skill toggle (essential and "globally enabled" are the
  // same shared essential-skills.json record for personal skills).
  if (pathname === '/api/skills/essential' && method === 'POST') {
    withBody(req, res, (body) => {
      const name = body.name;
      const source = body.source;
      const makeEssential = !!body.essential;
      if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name) || name.indexOf('..') !== -1) return sendJson(res, 400, { ok: false, error: 'invalid name' });
      if (source !== 'personal' && source !== 'plugin') return sendJson(res, 400, { ok: false, error: 'invalid source' });
      try {
        if (source === 'plugin') {
          const plugin = findPluginForSkill(name);
          if (plugin) setPluginSkillGlobal(plugin, makeEssential);
        } else {
          setPersonalSkillGlobal(name, source, makeEssential);
        }
        sendJson(res, 200, { ok: true, essential: essentialNames() });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e.message });
      }
    });
    return;
  }

  // ---------------------------------------------------------------------------
  // Tools — token-saving features (Terse Mode, Pool Compact, RTK Rewrite)
  // ---------------------------------------------------------------------------

  // GET /api/tools — read the enabled state of token-saving features from config
  if (pathname === '/api/tools' && method === 'GET') {
    try {
      const cfg = readConfig();
      const features = cfg.features || {};
      let rtkDetected = false;
      try {
        const { execFileSync } = require('node:child_process');
        execFileSync('rtk', ['--version'], { timeout: 1500 });
        rtkDetected = true;
      } catch (_) {
        rtkDetected = false;
      }
      sendJson(res, 200, {
        ok: true,
        features: {
          terseMode: features.terseMode !== false,
          poolCompact: features.poolCompact !== false,
          rtkRewrite: features.rtkRewrite !== false,
        },
        rtkDetected,
      });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // POST /api/tools/toggle  { feature, enabled } — toggle a feature flag
  if (pathname === '/api/tools/toggle' && method === 'POST') {
    withBody(req, res, (body) => {
      const feature = body.feature;
      const enabled = !!body.enabled;
      const validFeatures = ['terseMode', 'poolCompact', 'rtkRewrite'];
      if (!validFeatures.includes(feature)) {
        return sendJson(res, 400, { ok: false, error: 'invalid feature' });
      }
      try {
        writeConfig({ features: { [feature]: enabled } });
        sendJson(res, 200, { ok: true, feature, enabled });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e.message });
      }
    });
    return;
  }

  // ---------------------------------------------------------------------------
  // Context7 MCP integration — one shared API key, fanned into every station.
  // ---------------------------------------------------------------------------

  // GET /api/context7 — never returns the key itself, only {hasKey}.
  if (pathname === '/api/context7' && method === 'GET') {
    sendJson(res, 200, Object.assign({ ok: true }, context7Store.redact()));
    return;
  }

  // POST /api/context7  { apiKey } — save (encrypted) + fan the MCP registration
  // into every station via the real `claude mcp add` CLI (settings.json's
  // mcpServers key is dead — see the websearch/webfetch bootstrap in bin/sidewrite).
  if (pathname === '/api/context7' && method === 'POST') {
    withBody(req, res, (body) => {
      const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      if (!apiKey) return sendJson(res, 400, { ok: false, error: 'apiKey required' });
      try {
        context7Store.writeContext7Key(apiKey);
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: e.message });
      }
      const stations = fanContext7(apiKey);
      sendJson(res, 200, { ok: true, hasKey: true, stations });
    });
    return;
  }

  // POST /api/context7/remove — delete the key + unregister the MCP everywhere.
  if (pathname === '/api/context7/remove' && method === 'POST') {
    try {
      context7Store.deleteContext7Key();
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
      return;
    }
    const stations = fanContext7(null);
    sendJson(res, 200, { ok: true, hasKey: false, stations });
    return;
  }

  // POST /api/context7/test — server-side liveness + key-validity check
  // (GET .../libs/search, the light endpoint — not the per-doc-quota /context
  // one). The key is read and used only inside this process; never echoed.
  if (pathname === '/api/context7/test' && method === 'POST') {
    const { apiKey } = context7Store.readContext7Key();
    if (!apiKey) { sendJson(res, 200, { ok: false, status: 'no-key' }); return; }
    const https = require('node:https');
    const started = Date.now();
    let responded = false;
    const finish = (status, extra) => {
      if (responded) return;
      responded = true;
      sendJson(res, 200, Object.assign({ ok: status === 'live' || status === 'throttled', status }, extra || {}));
    };
    const testReq = https.request(
      {
        method: 'GET',
        hostname: 'context7.com',
        path: '/api/v2/libs/search?libraryName=react',
        headers: { Authorization: 'Bearer ' + apiKey, 'User-Agent': 'sidewrite' },
        timeout: 10000,
      },
      (r) => {
        let respBody = '';
        r.setEncoding('utf8');
        r.on('data', (c) => { respBody += c; if (respBody.length > 65536) testReq.destroy(); });
        r.on('end', () => {
          const latencyMs = Date.now() - started;
          if (r.statusCode === 200) finish('live', { latencyMs });
          else if (r.statusCode === 401) finish('invalid', { latencyMs });
          else if (r.statusCode === 429) finish('throttled', { latencyMs });
          else finish('unreachable', { latencyMs, httpStatus: r.statusCode });
        });
      }
    );
    testReq.on('timeout', () => testReq.destroy());
    testReq.on('error', () => finish('unreachable'));
    testReq.end();
    return;
  }

  // ---------------------------------------------------------------------------
  // Custom sub-agents — defined once, materialized as a real agents/<name>.md
  // in every station (the native Claude Code convention), so a sub-agent works
  // no matter which provider/model a run ends up on.
  // ---------------------------------------------------------------------------

  // GET /api/agents — list every defined sub-agent.
  if (pathname === '/api/agents' && method === 'GET') {
    try {
      sendJson(res, 200, { ok: true, agents: agentStore.listAgents() });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // POST /api/agents  { name, description, instructions, model } — create +
  // fan agents/<name>.md into every station.
  if (pathname === '/api/agents' && method === 'POST') {
    withBody(req, res, (body) => {
      let rec;
      try {
        rec = agentStore.createAgent({
          name: body.name,
          description: body.description,
          instructions: body.instructions,
          model: body.model,
          createdAt: nowTs(),
        });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message });
      }
      fanAgentMarkdown(rec);
      sendJson(res, 200, { ok: true, agent: rec });
    });
    return;
  }

  // /api/agents/:id  (PATCH update, DELETE remove) — both re-fan (or unlink)
  // agents/<name>.md across every station.
  if (pathname.startsWith('/api/agents/')) {
    const id = decodeURIComponent(pathname.slice('/api/agents/'.length));
    if (!id || id.indexOf('/') !== -1) {
      sendJson(res, 400, { ok: false, error: 'invalid agent id' });
      return;
    }
    if (method === 'PATCH' || method === 'POST') {
      withBody(req, res, (body) => {
        const rec = agentStore.updateAgent(id, {
          description: body.description,
          instructions: body.instructions,
          model: body.model,
        });
        if (!rec) return sendJson(res, 404, { ok: false, error: 'agent not found' });
        fanAgentMarkdown(rec);
        sendJson(res, 200, { ok: true, agent: rec });
      });
      return;
    }
    if (method === 'DELETE') {
      const rec = agentStore.readAgent(id);
      agentStore.deleteAgent(id);
      if (rec) unfanAgentMarkdown(rec.name);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  // Unknown route.
  sendJson(res, 404, { ok: false, error: 'not found' });
}

// Materialize a sub-agent record as agents/<name>.md in every station.
// Fail-soft per station (one bad station dir never aborts the save).
function fanAgentMarkdown(rec) {
  const md = agentStore.renderAgentMarkdown(rec);
  for (const st of listStationDirs()) {
    try {
      const dir = path.join(st, 'agents');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, rec.name + '.md'), md, { mode: 0o600 });
    } catch (_) { /* fail-soft per station */ }
  }
}

// Remove a deleted sub-agent's agents/<name>.md from every station.
function unfanAgentMarkdown(name) {
  if (!agentStore.nameSafe(name)) return;
  for (const st of listStationDirs()) {
    try { fs.unlinkSync(path.join(st, 'agents', name + '.md')); } catch (_) { /* fail-soft per station */ }
  }
}

// Fan Context7's MCP registration (or removal, when apiKey is null) across
// every station via the real `claude mcp add`/`claude mcp remove` CLI.
// `claude mcp add` can't update an existing --header in place, so a rotate is
// always remove-then-add. Fail-soft per station (one bad station never aborts
// the others).
function fanContext7(apiKey) {
  const { spawnSync } = require('node:child_process');
  const results = [];
  for (const st of listStationDirs()) {
    const prov = path.basename(st).slice('.claude-'.length);
    let env;
    try { env = stationEnv(prov); } catch (e) { results.push({ provider: prov, ok: false, error: e.message }); continue; }
    const opts = { env, encoding: 'utf8', timeout: 30000 };
    try {
      spawnSync('claude', ['mcp', 'remove', 'context7'], opts); // no-op if not registered
      if (apiKey) {
        const r = spawnSync('claude', [
          'mcp', 'add', '--transport', 'http', '--scope', 'user', 'context7',
          'https://mcp.context7.com/mcp',
          '--header', 'CONTEXT7_API_KEY: ' + apiKey,
        ], opts);
        results.push({ provider: prov, ok: r.status === 0 });
      } else {
        results.push({ provider: prov, ok: true });
      }
    } catch (e) {
      results.push({ provider: prov, ok: false, error: e.message });
    }
  }
  return results;
}

function clampInt(raw, def, min, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// ---------------------------------------------------------------------------
// Read-API helpers (analytics range, keyset cursor, breakdown, run-list stmt).
// ---------------------------------------------------------------------------

// Analytics (#4) default window when neither ?from nor ?to is supplied: 30 days.
const ANALYTICS_DEFAULT_RANGE_MS = 30 * 24 * 60 * 60 * 1000;

// Parse a non-negative epoch-ms query value; fall back to `def` on anything
// missing / non-finite / negative (fail-safe, never NaN into a bound param).
function parseEpochMs(raw, def) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : def;
}

// Resolve the { from, to } epoch-ms window for an analytics request. `to` defaults
// to now, `from` to (to - 30d). A reversed range is swapped so from <= to always.
function parseRange(parsedUrl) {
  const now = Date.now();
  let to = parseEpochMs(parsedUrl.searchParams.get('to'), now);
  let from = parseEpochMs(
    parsedUrl.searchParams.get('from'),
    to - ANALYTICS_DEFAULT_RANGE_MS
  );
  if (from > to) {
    const t = from;
    from = to;
    to = t;
  }
  return { from, to };
}

// Run breakdown for an ALREADY-allowlisted `by` (own-key of BREAKDOWN_COLUMNS).
function sendBreakdown(res, by, from, to) {
  const st = stmts.breakdown && stmts.breakdown[by];
  if (!st) {
    sendJson(res, 400, { ok: false, error: 'invalid by' });
    return;
  }
  let rows = [];
  try {
    rows = st.all(from, to);
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err.message });
    return;
  }
  sendJson(res, 200, { ok: true, by, from, to, rows });
}

// Opaque keyset cursor: base64url(JSON{ s:coalesced started_at, id:run id }).
function encodeCursor(obj) {
  try {
    return Buffer.from(
      JSON.stringify({ s: numOr0(obj.s), id: String(obj.id) }),
      'utf8'
    ).toString('base64url');
  } catch (_) {
    return null;
  }
}

// Decode + validate a keyset cursor. Returns { s:number, id:string } or null on
// any malformed / oversized input (the caller fails the request closed with 400).
function decodeCursor(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 512) return null;
  let obj;
  try {
    obj = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const s = Number(obj.s);
  if (!Number.isFinite(s)) return null;
  const id = obj.id != null ? String(obj.id) : '';
  if (!id || id.length > 128) return null;
  return { s, id };
}

// Lazily build + cache a keyset run-list statement for a given shape. The SQL text
// is derived ENTIRELY from the three structural booleans (never from request
// values — status/project/cursor arrive as bound named params), so there are at
// most 8 cached statements and no user string is ever interpolated into SQL.
function runsKeysetStmt(hasStatus, hasProject, hasCursor) {
  const key = (hasStatus ? 'S' : '') + (hasProject ? 'P' : '') + (hasCursor ? 'C' : '');
  let st = _runsStmtCache.get(key);
  if (st) return st;
  const conds = [];
  if (hasStatus) conds.push('status = @status');
  if (hasProject) conds.push('project = @project');
  if (hasCursor) {
    conds.push(
      '(COALESCE(started_at, 0) < @s OR (COALESCE(started_at, 0) = @s AND id < @id))'
    );
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  st = db.prepare(
    `SELECT * FROM runs ${where} ORDER BY COALESCE(started_at, 0) DESC, id DESC LIMIT @lim`
  );
  _runsStmtCache.set(key, st);
  return st;
}

// ---------------------------------------------------------------------------
// Committed additions: budgets, redispatch brief resolution, diff preview.
// ---------------------------------------------------------------------------

// First epoch-ms of the current local month (budget window start).
function monthStartMs() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

// Coerce a stored budget block to a safe, fully-shaped object. Caps are a
// non-negative finite number or null; warnPct is clamped into 1..100 (default
// 80); booleans default false. Fail-closed on anything malformed.
function normalizeBudget(raw) {
  const b = raw && typeof raw === 'object' ? raw : {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  let warn = Number(b.warnPct);
  if (!Number.isFinite(warn) || warn < 1 || warn > 100) warn = 80;
  return {
    enabled: !!b.enabled,
    enforce: !!b.enforce,
    monthlyUsd: num(b.monthlyUsd),
    perRunUsd: num(b.perRunUsd),
    warnPct: Math.floor(warn),
  };
}

// Validate an incoming budget cap: null (clear), or a non-negative finite
// number. Returns the value, or the sentinel `false` for an invalid input.
function budgetNum(v) {
  if (v === null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return false;
  return n;
}

// Pre-dispatch budget decision. Reads this month's spend (bounded aggregate) and
// compares projected spend (month + est) against the caps. Fail-closed dispatch
// verdict: `allow` is false ONLY when enforce is on, the state is 'exceeded', AND
// the est cost is KNOWN — an unknown cost warns but never hard-blocks.
function evaluateBudget(b, estUsd) {
  const monthFrom = monthStartMs();
  let monthUsd = 0;
  try {
    const r = db.prepare('SELECT COALESCE(SUM(usd), 0) AS usd FROM costs WHERE ts >= ?').get(monthFrom);
    monthUsd = numOr0(r && r.usd);
  } catch (_) {}
  const projected = monthUsd + (estUsd || 0);
  const base = {
    monthUsd,
    monthlyUsd: b.monthlyUsd,
    perRunUsd: b.perRunUsd,
    projectedUsd: projected,
    enforce: b.enforce,
    warnPct: b.warnPct,
    costKnown: estUsd != null,
  };
  if (!b.enabled) return Object.assign({ allow: true, state: 'disabled' }, base);
  const perRunOver = estUsd != null && b.perRunUsd != null && estUsd > b.perRunUsd;
  let state = 'ok';
  if (b.monthlyUsd != null && projected >= b.monthlyUsd) state = 'exceeded';
  else if (perRunOver) state = 'exceeded';
  else if (b.monthlyUsd != null && projected >= b.monthlyUsd * (b.warnPct / 100)) state = 'warn';
  else if (estUsd == null && b.monthlyUsd != null && monthUsd >= b.monthlyUsd) state = 'exceeded';
  const blocked = b.enforce && state === 'exceeded' && estUsd != null;
  return Object.assign({ allow: !blocked, state }, base);
}

// Read up to `max` bytes of a file as UTF-8; '' on any error / empty / non-file.
function readCappedFile(p, max) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size === 0) return '';
    const fd = fs.openSync(p, 'r');
    try {
      const len = Math.min(st.size, max);
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, 0);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    return '';
  }
}

// Resolve the PERSISTED brief for a run, in precedence order. NEVER fabricates:
// returns null when nothing intact is on disk (caller fails closed). `id` is
// regex-validated by the route, so the RUNS_DIR joins carry no traversal.
function resolveRedispatchBrief(id, run) {
  const MAX = 512 * 1024;
  const candidates = [
    { p: path.join(RUNS_DIR, id, 'BRIEF.md'), src: 'brief' },
    { p: path.join(RUNS_DIR, id, 'PLAN.md'), src: 'plan' },
  ];
  for (const c of candidates) {
    const t = readCappedFile(c.p, MAX);
    if (t && t.trim()) return { text: t, source: c.src };
  }
  if (run && typeof run.plan_path === 'string' && run.plan_path) {
    const t = readCappedFile(run.plan_path, MAX);
    if (t && t.trim()) return { text: t, source: 'plan_path' };
  }
  return null;
}

// Basename a diff-header path target ("a/x", "b/x", or "/dev/null"), never
// leaking an absolute host path.
function basenameDiffTarget(s) {
  if (s === '/dev/null') return '/dev/null';
  const m = /^([ab])\/(.*)$/.exec(s);
  if (m) return m[1] + '/' + basenameRel(m[2]);
  return basenameRel(s);
}

// Rewrite the paths in a single diff line to basenames so no absolute host path
// can leak. Content (+/-/space) lines pass through unchanged.
function scrubDiffPath(line) {
  if (line.startsWith('diff --git ')) {
    const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (m) return 'diff --git a/' + basenameRel(m[1]) + ' b/' + basenameRel(m[2]);
    return 'diff --git';
  }
  if (line.startsWith('--- ')) return '--- ' + basenameDiffTarget(line.slice(4));
  if (line.startsWith('+++ ')) return '+++ ' + basenameDiffTarget(line.slice(4));
  const rc = /^((?:rename|copy) (?:from|to) )(.*)$/.exec(line);
  if (rc) return rc[1] + basenameRel(rc[2]);
  return line;
}

// GET /api/runs/:id/diff — LOCAL-ONLY diff preview. Bounded bytes + lines,
// basename-only path guard on every header, secrets scrubbed. NEVER telemetry.
// When no captured patch exists, returns the shortstat summary (never 404 —
// keeps parity with the other run reads that never leak a known run).
function sendRunDiff(res, id) {
  let run = null;
  try { run = stmts.runById.get(id) || null; } catch (_) {}
  const MAX_BYTES = 256 * 1024;
  const MAX_LINES = 2000;
  const candidates = [path.join(RUNS_DIR, id + '.diff'), path.join(RUNS_DIR, id, 'diff.patch')];
  let raw = '';
  let found = false;
  for (const p of candidates) {
    const t = readCappedFile(p, MAX_BYTES);
    if (t) { raw = t; found = true; break; }
  }
  const diffStat = run && run.diff_stat ? run.diff_stat : null;
  if (!found) {
    sendJson(res, 200, {
      ok: true,
      run_id: id,
      source: 'stat',
      diff: null,
      diff_stat: diffStat,
      note: 'full patch was not captured for this run',
    });
    return;
  }
  const all = raw.split('\n');
  const truncated = all.length > MAX_LINES;
  const src = truncated ? all.slice(0, MAX_LINES) : all;
  const lines = src.map((line) => redactString(scrubDiffPath(line)));
  sendJson(res, 200, { ok: true, run_id: id, source: 'disk', truncated, diff_stat: diffStat, lines });
}

// ---------------------------------------------------------------------------
// Server bootstrap with EADDRINUSE retry.
// ---------------------------------------------------------------------------
function writeDaemonJson() {
  const info = {
    port: state.port,
    pid: process.pid,
    token: TOKEN,
    version: VERSION,
  };
  writeFileMode(DAEMON_JSON_PATH, JSON.stringify(info), 0o600);
  writeFileMode(DAEMON_TOKEN_PATH, TOKEN, 0o600);
}

// Probe a port: is a HEALTHY sidewrite daemon already listening there? Calls
// cb(true) if GET /api/health returns a sidewrite-shaped body, else cb(false).
function probeSidewriteDaemon(port, cb) {
  const req = http.request(
    { host: HOST, port, path: '/api/health', method: 'GET', headers: { Host: HOST + ':' + port } },
    (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return cb(false);
        try {
          const j = JSON.parse(b);
          cb(!!(j && typeof j.port === 'number' && j.pipeline));
        } catch (_) { cb(false); }
      });
    }
  );
  req.on('error', () => cb(false));
  req.setTimeout(800, () => { req.destroy(); cb(false); });
  req.end();
}

function startServer() {
  const server = http.createServer((req, res) => {
    try {
      router(req, res);
    } catch (err) {
      process.stderr.write('[sidewrite] request handler crashed: ' + err.stack + '\n');
      try {
        if (!res.headersSent) {
          sendJson(res, 500, { ok: false, error: 'internal error' });
        } else {
          res.end();
        }
      } catch (_) {}
    }
  });

  server.on('clientError', (err, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    } catch (_) {}
  });

  let attempt = 0;
  const basePort = (() => {
    const envPort = parseInt(process.env.SIDEWRITE_VIEWER_PORT, 10);
    return Number.isFinite(envPort) && envPort > 0 ? envPort : DEFAULT_PORT;
  })();

  function tryListen() {
    const port = basePort + attempt;
    state.port = port;
    server.listen(port, HOST);
  }

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      // Robust port handling: if a HEALTHY sidewrite daemon already owns this
      // port, exit (don't spawn a duplicate). If it's a FOREIGN process, bump to
      // the next port, up to MAX_PORT_TRIES.
      probeSidewriteDaemon(state.port, (isOurs) => {
        if (isOurs) {
          process.stdout.write(
            '[sidewrite] a healthy viewer daemon already owns port ' + state.port +
              '; not starting a duplicate.\n'
          );
          process.exit(0);
        }
        if (attempt < MAX_PORT_TRIES) {
          attempt++;
          setTimeout(tryListen, 50);
          return;
        }
        process.stderr.write(
          '[sidewrite] no free port in ' + basePort + '..' + (basePort + MAX_PORT_TRIES) +
            ' — another service may be using them.\n'
        );
        process.exit(1);
      });
      return;
    }
    process.stderr.write('[sidewrite] server error: ' + err.message + '\n');
    process.exit(1);
  });

  server.on('listening', () => {
    writeDaemonJson();
    // Guarantee an active model at boot if a provider already has one.
    try { ensureActiveDefault(); } catch (_) {}
    writeStatusFile();
    process.stdout.write(
      '[sidewrite] viewer-daemon listening on http://' +
        HOST +
        ':' +
        state.port +
        ' (pid ' +
        process.pid +
        ')\n'
    );
  });

  tryListen();
  return server;
}

// ---------------------------------------------------------------------------
// Status heartbeat: re-stamp status.json on a low-frequency timer so a reader
// can trust `heartbeat_ts` even when no events are flowing. Unref'd so it never
// keeps the process alive on its own.
// ---------------------------------------------------------------------------
function startStatusHeartbeat() {
  const timer = setInterval(writeStatusFile, STATUS_REFRESH_MS);
  if (timer.unref) timer.unref();
}

// ---------------------------------------------------------------------------
// Orphan-run reconciliation: reap `status='running'` rows whose underlying
// process is gone (killed, crashed, or the daemon itself restarted mid-run) so
// they don't stay "running" forever in the history/analytics views. Run once
// on boot (catches anything orphaned by the previous process going down) and
// then on a periodic timer (catches a run that goes stale while this daemon
// keeps running). Best-effort: any failure is swallowed so a DB hiccup never
// takes the daemon down.
// ---------------------------------------------------------------------------
function reconcileOrphanRuns() {
  try {
    ensureDb();
    const now = Date.now();
    const info = stmts.reconcileOrphanRuns.run({ now, threshold: now - STALE_RUN_MS });
    if (info && info.changes) {
      process.stdout.write(
        '[sidewrite] reconciled ' + info.changes + ' orphaned running run(s) to failed\n'
      );
    }
  } catch (err) {
    process.stderr.write(
      '[sidewrite] orphan-run reconciliation failed: ' +
        (err && err.stack ? err.stack : String(err)) +
        '\n'
    );
  }
}

function startOrphanRunSweep() {
  const timer = setInterval(reconcileOrphanRuns, RECONCILE_INTERVAL_MS);
  if (timer.unref) timer.unref();
}

// ---------------------------------------------------------------------------
// Telemetry flush: drain the local queue (already-scrubbed events; see
// maybeReportTelemetry above) to TELEMETRY_ENDPOINT on a low-frequency timer.
// Gated on config.telemetry.level !== 'off' at call time (not just at
// enqueue time), so flipping the setting to 'off' immediately stops egress
// without needing a daemon restart. Best-effort, fire-and-forget: a failed
// flush just retries next tick — telemetry-reporter.cjs's own MAX_ATTEMPTS
// backoff handles per-file retry within a single flush() call.
// ---------------------------------------------------------------------------
function runTelemetryFlush() {
  let cfg;
  try {
    cfg = readConfig();
  } catch (_) {
    return;
  }
  const level = (cfg.telemetry && cfg.telemetry.level) || 'off';
  telemetryReporter
    .flush({ enabled: level !== 'off', endpoint: TELEMETRY_ENDPOINT })
    .catch(() => {});
}

function startTelemetryFlush() {
  runTelemetryFlush(); // opportunistic attempt on boot, in case the queue has backlog
  const timer = setInterval(runTelemetryFlush, TELEMETRY_FLUSH_INTERVAL_MS);
  if (timer.unref) timer.unref();
}

// ---------------------------------------------------------------------------
// Usage digest: an anonymized once-a-day rollup (run counts, tokens, $ spend,
// top providers/models by usage — no task text, no file paths, no project
// names) queued through the same scrub->enqueue->flush pipeline as error
// telemetry. Gated on config.telemetry.level === 'all' — the most verbose
// opt-in tier, one step above error-only reporting. install-id.cjs's UUID
// (already generated but previously never read anywhere) tags each digest so
// repeat digests from the same install can be told apart from a fresh one,
// without carrying anything that identifies the person or their work.
// ---------------------------------------------------------------------------
const USAGE_SUMMARY_STATE_PATH = path.join(DATA_DIR, 'telemetry-queue', '.usage-summary-state.json');

function readUsageSummaryState() {
  try {
    const raw = fs.readFileSync(USAGE_SUMMARY_STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.lastReportedAt === 'number') return parsed;
  } catch (_) {
    // missing/corrupt — treat as "never reported"
  }
  return { lastReportedAt: null };
}

function writeUsageSummaryState(state) {
  try {
    fs.mkdirSync(path.dirname(USAGE_SUMMARY_STATE_PATH), { recursive: true, mode: 0o700 });
    const tmp = USAGE_SUMMARY_STATE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, USAGE_SUMMARY_STATE_PATH);
  } catch (_) {
    // best-effort; a failed write just means the next check retries the same window
  }
}

function buildUsageSummary(from, to) {
  ensureDb();
  const totals = stmts.analyticsSummary.get(from, to) || {};
  const statusRows = stmts.runStatusCounts.all(from, to) || [];
  const byStatus = {};
  for (const row of statusRows) {
    byStatus[row.status || 'unknown'] = row.n;
  }
  const topProviders = (stmts.breakdown.provider ? stmts.breakdown.provider.all(from, to) : [])
    .slice(0, USAGE_SUMMARY_TOP_N)
    .map((r) => ({ name: errorScrub.scrubString(String(r.key || 'unknown')), entries: r.entries, usd: r.usd }));
  const topModels = (stmts.breakdown.model ? stmts.breakdown.model.all(from, to) : [])
    .slice(0, USAGE_SUMMARY_TOP_N)
    .map((r) => ({ name: errorScrub.scrubString(String(r.key || 'unknown')), entries: r.entries, usd: r.usd }));

  return {
    kind: 'usage_summary',
    install_id: getInstallId(),
    version: VERSION,
    period: { from, to },
    runs: { total: statusRows.reduce((s, r) => s + r.n, 0), by_status: byStatus },
    tokens_in: totals.tokens_in || 0,
    tokens_out: totals.tokens_out || 0,
    usd: totals.usd || 0,
    providers: topProviders,
    models: topModels,
  };
}

function runUsageSummaryReport() {
  let cfg;
  try {
    cfg = readConfig();
  } catch (_) {
    return;
  }
  const level = (cfg.telemetry && cfg.telemetry.level) || 'off';
  if (level !== USAGE_SUMMARY_LEVEL) return;

  const state = readUsageSummaryState();
  const now = Date.now();
  const from = typeof state.lastReportedAt === 'number' ? state.lastReportedAt : now - USAGE_SUMMARY_INTERVAL_MS;
  if (now - from < USAGE_SUMMARY_INTERVAL_MS) return; // not due yet

  try {
    const summary = buildUsageSummary(from, now);
    telemetryReporter.enqueue(summary);
    writeUsageSummaryState({ lastReportedAt: now });
  } catch (_) {
    // best-effort — never let a digest failure affect the daemon
  }
}

function startUsageSummaryReport() {
  runUsageSummaryReport(); // catches a install that's been up >24h with the daemon rarely restarting
  const timer = setInterval(runUsageSummaryReport, USAGE_SUMMARY_CHECK_MS);
  if (timer.unref) timer.unref();
}

// ---------------------------------------------------------------------------
// Graceful shutdown.
// ---------------------------------------------------------------------------
let shuttingDown = false;
function shutdown(server, code) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    broadcaster.close();
  } catch (_) {}
  // Drain remaining writes synchronously.
  try {
    while (writeQueue.length) {
      const job = writeQueue.shift();
      try {
        job();
      } catch (_) {}
    }
  } catch (_) {}
  try {
    if (db) db.close();
  } catch (_) {}
  try {
    if (server) server.close();
  } catch (_) {}
  process.exit(code || 0);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function main() {
  ensureDirs();
  // Materialize the resolved feature-flag snapshot (#3 / S8) into config.json so
  // the shell runner's fail-closed direct read sees fresh booleans even before
  // the first API write. writeConfig re-resolves cfg.flags; best-effort — a
  // failure here must never block the daemon from binding its socket.
  try {
    writeConfig({});
  } catch (_) {}
  loadViewerHtml();
  // Bind the socket FIRST so GET / and GET /api/health answer immediately;
  // neither depends on the DB. initDb() (schema + prepared statements) is
  // deferred off the bind hot path onto the next tick. Any DB-backed consumer
  // that races ahead of it self-initializes via ensureDb() (idempotent).
  const server = startServer();
  setImmediate(() => {
    try {
      ensureDb();
    } catch (err) {
      process.stderr.write(
        '[sidewrite] deferred initDb failed: ' + (err && err.stack ? err.stack : String(err)) + '\n'
      );
      return;
    }
    // Boot-time sweep: catches runs orphaned by a crash/restart of the
    // *previous* process (they were left mid-flight with no one left to
    // finish them).
    reconcileOrphanRuns();
  });
  startStatusHeartbeat();
  startOrphanRunSweep();
  startTelemetryFlush();
  startUsageSummaryReport();

  process.on('SIGINT', () => shutdown(server, 0));
  process.on('SIGTERM', () => shutdown(server, 0));
  process.on('uncaughtException', (err) => {
    process.stderr.write('[sidewrite] uncaughtException: ' + err.stack + '\n');
    // Never crash the daemon on a single bad code path.
  });
  process.on('unhandledRejection', (err) => {
    process.stderr.write('[sidewrite] unhandledRejection: ' + String(err) + '\n');
  });
}

main();
