# @zm2231/kysely-powersync-dialect

A small Kysely dialect for PowerSync Node clients.

PowerSync gives Node apps a local SQLite replica plus an upload queue. Kysely expects one database connection. This dialect splits the path:

- read queries use the local SQLite replica through `better-sqlite3`
- writes go through `PowerSyncDatabase.execute()`, or through a remote write endpoint
- PowerSync credentials and uploads use explicit URLs by default
- auth, upload, read classification, and write routing can be replaced with hooks

This is intentionally only the dialect layer. It does not ship app schemas, migrations, CRM tables, sync rules, or schema engines.

## Install

```bash
npm install @zm2231/kysely-powersync-dialect kysely @powersync/common @powersync/node better-sqlite3
```

## Examples

- [Examples index](examples/README.md)
- [Local PowerSync database](examples/local-powersync.md)
- [Remote writes](examples/remote-writes.md)
- [Extension hooks](examples/extension-hooks.md)

## Limitations

- The dialect is designed for PowerSync's local-first model. Reads inside Kysely transactions still read from the local replica, so they are useful for read-only transactional code but should not be treated as read-your-write guarantees after queued PowerSync writes.
- Kysely transactions are read-only in this dialect. Writes inside a Kysely transaction throw instead of pretending the split read/write paths are atomic.
- Raw SQL read/write routing is conservative. Override `readQueryClassifier` when your app has SQL forms the default classifier should not decide.
- The package does not delete SQLite `-wal` or `-shm` sidecars. Those files can contain uncheckpointed data. Handle recovery explicitly in your app if you need it.
- Users provide their own PowerSync schema. No built-in tables are created for you.
- `RETURNING` rows are passed through when the underlying PowerSync SDK returns rows. If your PowerSync runtime does not return rows for a write, Kysely receives an empty row list.

## Why this exists

PowerSync's web SDK has Kysely-friendly patterns, but Node apps need a small bridge between Kysely's dialect API and PowerSync's local replica/write queue split. This package is that bridge.
