# Extension Hooks

The high-level helper is hookable for custom auth and upload flows. When both hooks are provided, `auth_url` and `upload_url` are not required:

```ts
import {
  createConnectedPowerSyncDatabase,
  type PowerSyncConfig,
} from "@zm2231/kysely-powersync-dialect";

const appUploadEndpoint = "https://api.example.com/powersync/upload";
const config: PowerSyncConfig = {
  powersync_url: "https://powersync.example.com",
  user_id: "user-123",
  db_path: "./data/powersync.db",
};

const writeDatabase = await createConnectedPowerSyncDatabase(config, schema, {
  async fetchCredentials(config) {
    return {
      endpoint: config.powersync_url,
      token: await getTokenFromYourAuthProvider(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    };
  },
  async uploadTransaction(transaction, context) {
    const response = await fetch(appUploadEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...context.headers,
      },
      body: JSON.stringify({
        transactionId: transaction.transactionId,
        operations: transaction.crud,
      }),
    });
    if (!response.ok) {
      throw new Error(`Upload failed: ${response.status} ${await response.text()}`);
    }
    const payload = await response.json() as { checkpoint?: string };
    return { checkpoint: payload.checkpoint };
  },
});
```

If you only replace upload, keep `auth_url` in `config`. If you only replace auth, keep `upload_url` in `config`.

For lower-level routing, import `SplitPowerSyncDriver`, `WriteExecutor`, and `defaultReadQueryClassifier` and compose your own Kysely `Dialect`. Pass `readQueryClassifier` to `PowerSyncDialect` or `RemotePowerSyncDialect` when your app needs different read/write routing.

The default classifier uses Kysely's select AST when available, then falls back to SQL text after stripping leading comments.

The default uploader sends a whole PowerSync CRUD transaction in one `POST`:

```json
{
  "transactionId": 123,
  "operations": [
    { "op": "PUT", "table": "todos", "id": "todo-1", "data": { "title": "Ship it" } }
  ]
}
```
