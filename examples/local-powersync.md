# Local PowerSync Database

Use this path when your process owns the PowerSync Node client.

```ts
import { Kysely } from "kysely";
import { Schema, Table, column } from "@powersync/common";
import {
  PowerSyncDialect,
  createConnectedPowerSyncDatabase,
  openPowerSyncReadDatabase,
} from "@zm2231/kysely-powersync-dialect";

interface DB {
  todos: {
    id: string;
    title: string;
    done: number;
  };
}

const schema = new Schema({
  todos: new Table({
    title: column.text,
    done: column.integer,
  }),
});

const config = {
  powersync_url: "https://powersync.example.com",
  auth_url: "https://api.example.com/api/auth/token",
  upload_url: "https://api.example.com/api/data",
  user_id: "user-123",
  db_path: "./data/powersync.db",
};

const writeDatabase = await createConnectedPowerSyncDatabase(config, schema);
const readDatabase = await openPowerSyncReadDatabase(config.db_path);

const db = new Kysely<DB>({
  dialect: new PowerSyncDialect({
    readDatabase,
    writeDatabase,
  }),
});

const rows = await db.selectFrom("todos").selectAll().execute();
```

`createConnectedPowerSyncDatabase()` uses `auth_url` for credentials and `upload_url` for the default CRUD upload handler. Use [extension hooks](extension-hooks.md) when your app already owns those flows.
