# Remote Writes

Use `RemotePowerSyncDialect` when the process can read a local replica but writes must go through an HTTP service.

```ts
import { Kysely } from "kysely";
import {
  RemotePowerSyncDialect,
  openPowerSyncReadDatabase,
} from "@zm2231/kysely-powersync-dialect";

const db = new Kysely({
  dialect: new RemotePowerSyncDialect({
    readDatabase: await openPowerSyncReadDatabase("./data/powersync.db"),
    writeEndpoint: "https://api.example.com/kysely-write",
    writeHeaders: { authorization: `Bearer ${token}` },
  }),
});
```

Kysely transactions are read-only in this dialect. Writes inside a Kysely transaction throw instead of pretending the split read/write paths are atomic.

The default remote write body is:

```json
{
  "sql": "insert into todos (id, title) values (?, ?)",
  "params": ["todo-1", "Ship it"]
}
```

Use `writeBody` and `mapResult` when your service needs a different protocol.
