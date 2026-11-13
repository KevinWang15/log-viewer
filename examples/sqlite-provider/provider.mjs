// A log-viewer provider backed by a SQLite table (Node's built-in node:sqlite,
// no dependencies). One log per service; the row id is the cursor.
//
// Schema:
//   CREATE TABLE logs (
//     id      INTEGER PRIMARY KEY AUTOINCREMENT,
//     service TEXT NOT NULL,
//     ts      INTEGER NOT NULL,      -- epoch ms
//     level   TEXT NOT NULL,
//     thread  TEXT,
//     logger  TEXT,
//     message TEXT NOT NULL,
//     tenant  TEXT,                  -- extra columns become filterable fields
//     status  INTEGER
//   );
//   CREATE INDEX logs_service_id ON logs (service, id);
//
// The provider has list() and tail() but no watch(), so the viewer polls
// list(after) for new rows (every second by default).

import { DatabaseSync } from 'node:sqlite';

export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS logs (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    service TEXT NOT NULL,
    ts      INTEGER NOT NULL,
    level   TEXT NOT NULL,
    thread  TEXT,
    logger  TEXT,
    message TEXT NOT NULL,
    tenant  TEXT,
    status  INTEGER
  );
  CREATE INDEX IF NOT EXISTS logs_service_id ON logs (service, id);
`;

const toRecord = (row) => ({
  cursor: String(row.id),
  time: row.ts,
  level: row.level,
  thread: row.thread ?? undefined,
  logger: row.logger ?? undefined,
  message: row.message,
  // Extra columns as fields: filterable in the UI (detail pane chips,
  // right-click "Filter: tenant = acme").
  fields: Object.fromEntries(Object.entries({ tenant: row.tenant, status: row.status }).filter(([, v]) => v != null)),
});

export function createSqliteProvider(dbPath, { id = 'sqlite', name = 'SQLite logs' } = {}) {
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  const services = db.prepare('SELECT DISTINCT service FROM logs ORDER BY service');
  const after = db.prepare('SELECT * FROM logs WHERE service = ? AND id > ? ORDER BY id LIMIT ?');
  const newest = db.prepare('SELECT * FROM logs WHERE service = ? ORDER BY id DESC LIMIT ?');

  return {
    apiVersion: 1,
    id,
    name,
    async listLogs() {
      return services.all().map((r) => ({ id: r.service, name: r.service, labels: { db: 'sqlite' } }));
    },
    open(service) {
      return {
        // Rows strictly after the cursor, oldest first.
        async list({ after: cursor, limit }) {
          const rows = after.all(service, cursor === null ? 0 : Number(cursor), limit + 1);
          return { records: rows.slice(0, limit).map(toRecord), more: rows.length > limit };
        },
        // The newest rows, returned oldest first.
        async tail({ limit }) {
          return { records: newest.all(service, limit).reverse().map(toRecord) };
        },
      };
    },
    async close() {
      db.close();
    },
  };
}
