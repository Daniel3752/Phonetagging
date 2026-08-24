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
      stmt.run = async () => { db.prepare(sql).run(...stmt.args); return { success: true }; };
      return stmt;
    },
  };
}
