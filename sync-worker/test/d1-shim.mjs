// A minimal in-memory implementation of the bits of the Cloudflare D1 + KV
// surface that the Worker uses. It is backed by Node's built-in `node:sqlite`
// so the REAL query + Last-Write-Wins logic can be exercised locally without
// Wrangler/Miniflare. This file is for tests only and is never bundled to CF.
//
// We load the builtin through `createRequire` so Vite never tries to statically
// resolve/bundle `node:sqlite` (a newer builtin its resolver mishandles).
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let DatabaseSyncRef = null

function getDatabaseSync() {
  if (!DatabaseSyncRef) {
    const sqlite = require('node:sqlite')
    DatabaseSyncRef = sqlite.DatabaseSync
  }
  return new DatabaseSyncRef(':memory:')
}

export async function makeD1() {
  const db = getDatabaseSync()
  return {
    exec(sql) {
      db.exec(sql)
      return undefined
    },
    prepare(sql) {
      const stmt = db.prepare(sql)
      let bound = []
      const api = {
        bind(...params) {
          bound = params
          return api
        },
        async all() {
          return { results: stmt.all(...bound) }
        },
        async run() {
          const r = stmt.run(...bound)
          return { success: true, meta: { changes: r.changes ?? 0 } }
        },
        async first() {
          const row = stmt.get(...bound)
          return row ?? null
        },
        async raw() {
          return stmt.all(...bound)
        },
      }
      return api
    },
  }
}

export function makeKV(initial = {}) {
  const store = { ...initial }
  return {
    async get(key) {
      return key in store ? store[key] : null
    },
    async put(key, value) {
      store[key] = String(value)
    },
    async delete(key) {
      delete store[key]
    },
  }
}
