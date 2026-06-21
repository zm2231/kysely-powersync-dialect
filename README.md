# @zm2231/kysely-powersync-dialect

[![npm version](https://img.shields.io/npm/v/@zm2231/kysely-powersync-dialect.svg)](https://www.npmjs.com/package/@zm2231/kysely-powersync-dialect)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.18.1-339933)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A small Kysely dialect for PowerSync Node clients.

Status: initial `0.1.x` release. The core shape is usable, but the API may evolve before `1.0`.

PowerSync gives Node apps a local SQLite replica plus an upload queue. Kysely expects one database connection. This dialect splits the path:

- read queries use the local SQLite replica through `better-sqlite3`
- writes go through `PowerSyncDatabase.execute()`, or through a remote write endpoint
- PowerSync credentials and uploads use explicit URLs by default
- auth, upload, read classification, and write routing can be replaced with hooks

This is intentionally only the dialect layer. It does not ship app tables, migrations, sync rules, or schema engines.

## Why this exists

PowerSync's web SDK has Kysely-friendly patterns, but Node apps need a small bridge between Kysely's dialect API and PowerSync's local replica/write queue split. This package is that bridge.

## Compared to `@powersync/kysely-driver`

Use PowerSync's official Kysely driver when you are building against the web SDK it targets.

Use this package when you are running a Node PowerSync client and need Kysely to:

- read from the local SQLite replica
- send writes through the PowerSync Node client, or through your own HTTP write endpoint
- keep read/write routing explicit and replaceable

## Background

I built this at Cadence, where our team runs on top of the `pi` coding agent. We were standing up a multi-tenant CRM and team-OS, and Kysely was already the SQLite query builder we used everywhere. When we added PowerSync for multi-device sync, the friction was immediate: PowerSync's Node SDK gives you a local SQLite replica plus a write queue, which is exactly what you want for offline-first work, but Kysely's dialect API assumes one connection. The official `@powersync/kysely-driver` solves this for their web SDK; on the Node side, there was nothing.

So I wrote the bridge: reads go through `better-sqlite3` against the local replica, writes go through `PowerSyncDatabase.execute()`, or through a remote HTTP endpoint when the writer lives in another process. It ran internally for several months across multiple tenant domains before I extracted and published it.

Our schema engine, sync rules, app tables, and tenant routing all stayed in the private codebase. What you get here is just the dialect layer.

## Install

```bash
npm install @zm2231/kysely-powersync-dialect kysely @powersync/common @powersync/node better-sqlite3
```

## 30-second usage

```ts
const writeDatabase = await createConnectedPowerSyncDatabase(config, schema);
const readDatabase = await openPowerSyncReadDatabase(config.db_path);

const db = new Kysely<DB>({
  dialect: new PowerSyncDialect({ readDatabase, writeDatabase }),
});

await db.insertInto("todos").values({ id: "todo-1", title: "Ship it", done: 0 }).execute();
const todos = await db.selectFrom("todos").selectAll().execute();
```

`config`, `schema`, and `DB` are app-owned. See the examples for complete setup.

## Examples

- [Examples index](examples/README.md)
- [Local PowerSync database](examples/local-powersync.md)
- [Remote writes](examples/remote-writes.md)
- [Extension hooks](examples/extension-hooks.md)

## Limitations

- Reads inside Kysely transactions hit the local replica. They do not see writes that PowerSync has queued but not yet checkpointed locally, so do not rely on read-your-write inside a transaction.
- Kysely transactions are read-only in this dialect. Writes inside a Kysely transaction throw instead of pretending the split read/write paths are atomic.
- Raw SQL read/write routing is conservative. Override `readQueryClassifier` when your app has SQL forms the default classifier should not decide.
- The package does not delete SQLite `-wal` or `-shm` sidecars. Those files can contain uncheckpointed data. Handle recovery explicitly in your app if you need it.
- Users provide their own PowerSync schema. No built-in tables are created for you.
- `RETURNING` rows are passed through when the PowerSync SDK provides them. The Node SDK does not always return rows for writes, so if your code depends on `RETURNING`, test against your specific runtime.
