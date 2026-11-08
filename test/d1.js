// Simulazione di Cloudflare D1 sopra il SQLite incluso in Node, solo per i test.
// Riproduce le parti usate dal gestionale: prepare/bind/first/all/run/batch (transazione).

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const plain = (row) => (row ? { ...row } : row);

class Stmt {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }

  bind(...args) {
    for (const a of args) {
      if (a === undefined) throw new Error(`D1_TYPE_ERROR: undefined in bind per: ${this.sql.slice(0, 80)}`);
      if (typeof a === 'boolean') throw new Error('D1_TYPE_ERROR: boolean non supportato');
    }
    return new Stmt(this.db, this.sql, args);
  }

  _isRead() {
    return /^\s*(SELECT|WITH)\b/i.test(this.sql);
  }

  _exec() {
    const st = this.db.sqlite.prepare(this.sql);
    if (this._isRead()) {
      const rows = st.all(...this.args).map(plain);
      return { results: rows, success: true, meta: { changes: 0 } };
    }
    const r = st.run(...this.args);
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }

  async first(col) {
    const row = plain(this.db.sqlite.prepare(this.sql).get(...this.args));
    if (!row) return null;
    return col ? row[col] : row;
  }

  async all() {
    return this._exec();
  }

  async run() {
    return this._exec();
  }
}

export class FakeD1 {
  constructor(path = ':memory:') {
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec('PRAGMA foreign_keys = ON');
  }

  prepare(sql) {
    return new Stmt(this, sql);
  }

  async batch(stmts) {
    this.sqlite.exec('BEGIN');
    try {
      const out = stmts.map((s) => s._exec());
      this.sqlite.exec('COMMIT');
      return out;
    } catch (e) {
      this.sqlite.exec('ROLLBACK');
      throw e;
    }
  }

  async exec(sql) {
    this.sqlite.exec(sql);
  }
}

export function freshDb() {
  const db = new FakeD1();
  const dir = new URL('../migrations/', import.meta.url).pathname;
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
    db.sqlite.exec(readFileSync(join(dir, f), 'utf8'));
  }
  return db;
}

export async function addUser(db, { email, name = 'Prova', role = 'admin' }) {
  const id = crypto.randomUUID();
  db.sqlite.prepare(`INSERT INTO users (id, email, name, role, active, created_at) VALUES (?, ?, ?, ?, 1, ?)`)
    .run(id, email, name, role, new Date().toISOString());
  return { id, email, name, role, active: 1 };
}
