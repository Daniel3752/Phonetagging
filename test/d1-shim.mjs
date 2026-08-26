// Minimal D1 shim over node:sqlite, so tests exercise the real SQL — real constraints, real
// ON CONFLICT behaviour, real types — instead of a hand-rolled fake that agrees with whatever the
// code happens to do.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export function makeDB(schemaPath) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(schemaPath, 'utf8'));

  return {
    _db: db,
    prepare(sql) {
      const stmt = { sql, args: [] };
      stmt.bind = (...a) => { stmt.args = a.map((v) => (v === undefined ? null : v)); return stmt; };
      stmt.first = async () => db.prepare(sql).get(...stmt.args) ?? null;
      stmt.all = async () => ({ results: db.prepare(sql).all(...stmt.args) });
      // Real D1 reports how many rows a statement touched, and code legitimately branches on it
      // (an UPDATE that changed nothing means "no such row"). A shim that omitted it would let that
      // branch pass tests while always taking the wrong path in production.
      stmt.run = async () => {
        const r = db.prepare(sql).run(...stmt.args);
        return { success: true, meta: { changes: Number(r.changes ?? 0), last_row_id: Number(r.lastInsertRowid ?? 0) } };
      };
      return stmt;
    },
  };
}
