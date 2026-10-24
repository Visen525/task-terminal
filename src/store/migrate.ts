/**
 * 数据库迁移（SPEC §4.2）。
 * 驱动：Node 24 内置 node:sqlite（零 native 依赖；WAL + FTS5 + trigram 已在本机验证）。
 * 迁移幂等：带版本号表 schema_migrations，重复打开不报错。
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 2;

/** v1 DDL 保持不变；v2 只在文件末尾追加新表，避免旧库升级时重建/改写既有表。 */
const V1_DDL = `
CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  parent_id     TEXT REFERENCES tasks(id),
  title         TEXT NOT NULL,
  goal          TEXT NOT NULL,
  status        TEXT NOT NULL,
  revision      INTEGER NOT NULL DEFAULT 1,
  permission    TEXT NOT NULL DEFAULT 'workspace-write',
  workspace     TEXT NOT NULL,
  budget_tokens INTEGER NOT NULL DEFAULT 120000,
  spent_tokens  INTEGER NOT NULL DEFAULT 0,
  result_json   TEXT,
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  ended_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, created_at);

CREATE TABLE IF NOT EXISTS runs (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id),
  attempt      INTEGER NOT NULL,
  status       TEXT NOT NULL,
  lease_until  INTEGER NOT NULL,
  steps        INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id, attempt);

CREATE TABLE IF NOT EXISTS events (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id   TEXT,
  run_id    TEXT,
  ts        INTEGER NOT NULL,
  type      TEXT NOT NULL,
  actor     TEXT NOT NULL,
  payload   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_run  ON events(run_id, seq);

-- events 只 INSERT，永不 UPDATE / DELETE（运行期硬约束）
CREATE TRIGGER IF NOT EXISTS events_no_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;
CREATE TRIGGER IF NOT EXISTS events_no_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  task_id    TEXT,
  seq        INTEGER NOT NULL,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  tokens     INTEGER,
  ts         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_seq ON messages(seq);

CREATE TABLE IF NOT EXISTS artifacts (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  run_id      TEXT,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  path        TEXT,
  sha256      TEXT,
  bytes       INTEGER,
  summary     TEXT NOT NULL,
  tags        TEXT,
  findings    TEXT,
  trust       TEXT NOT NULL DEFAULT 'unverified',
  verified_by TEXT,
  verified_at INTEGER,
  embedding   BLOB,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id, created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS artifact_fts USING fts5(
  title, summary, tags, findings,
  content='artifacts', content_rowid='rowid',
  tokenize='trigram'
);

CREATE TABLE IF NOT EXISTS memory_facts (
  id             TEXT PRIMARY KEY,
  scope          TEXT NOT NULL,
  key            TEXT NOT NULL,
  value          TEXT NOT NULL,
  confidence     REAL NOT NULL DEFAULT 0.6,
  source_task_id TEXT,
  source_seqs    TEXT,
  superseded_by  TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_facts_scope ON memory_facts(scope, key);

CREATE TABLE IF NOT EXISTS llm_calls (
  id            TEXT PRIMARY KEY,
  task_id       TEXT,
  run_id        TEXT,
  purpose       TEXT NOT NULL,
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL,
  latency_ms    INTEGER,
  estimated     INTEGER NOT NULL DEFAULT 0,
  ts            INTEGER NOT NULL
);
`;

/** v2：单行 JSON 应用设置（M10-01）。只追加，不改 v1 任何表。 */
const V2_DDL = `
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

/** 打开（必要时创建）数据库并完成迁移。 */
export function openDatabase(file: string): DatabaseSync {
  if (file !== ':memory:') {
    mkdirSync(dirname(file), { recursive: true });
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

/** 幂等迁移：版本已达则直接返回。 */
export function migrate(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  );`);
  const row = db
    .prepare('SELECT MAX(version) AS version FROM schema_migrations')
    .get() as unknown as { version: number | null } | undefined;
  const current = row?.version ?? 0;
  if (current >= SCHEMA_VERSION) return;

  db.exec('BEGIN IMMEDIATE');
  try {
    // 按版本逐段执行：v1 库只跑 v2 增量 DDL；新库从 v1 顺序建到最新。
    if (current < 1) db.exec(V1_DDL);
    if (current < 2) db.exec(V2_DDL);

    const appliedAt = Date.now();
    if (current === 0) {
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)').run(
        SCHEMA_VERSION,
        appliedAt,
      );
    } else {
      // 沿用“单行当前版本”的既有形态（m0/m1 断言版本记录恰好 1 条）。
      db.prepare('UPDATE schema_migrations SET version = ?, applied_at = ? WHERE version = ?').run(
        SCHEMA_VERSION,
        appliedAt,
        current,
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
