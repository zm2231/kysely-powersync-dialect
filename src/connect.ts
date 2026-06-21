import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Agent } from "undici";
import { PowerSyncDatabase, type NodePowerSyncDatabaseOptions } from "@powersync/node";
import type { Schema } from "@powersync/common";
import type {
  CreatePowerSyncDatabaseOptions,
  PowerSyncConfig,
  PowerSyncCrudEntry,
  PowerSyncCrudTransaction,
  PowerSyncRuntimeStatus,
  PowerSyncUploadContext,
} from "./types.js";
import { cfHeaders, fetchPowerSyncToken, validatePowerSyncConfig } from "./auth.js";
import { ensureSqliteFileExists } from "./dialect.js";

export async function createConnectedPowerSyncDatabase(
  config: PowerSyncConfig,
  schema: Schema,
  options?: CreatePowerSyncDatabaseOptions,
): Promise<PowerSyncDatabase> {
  validatePowerSyncConfig(config, {
    requireAuthUrl: !options?.fetchCredentials,
    requireUploadUrl: !options?.uploadTransaction,
  });
  mkdirSync(dirname(config.db_path), { recursive: true });
  ensureSqliteFileExists(config.db_path);

  const db = new PowerSyncDatabase({
    schema,
    database: { dbFilename: config.db_path },
  } as unknown as NodePowerSyncDatabaseOptions);

  const headers = cfHeaders(config);
  const dispatcher = Object.keys(headers).length > 0
    ? new Agent({
      interceptors: {
        Pool: [(
          dispatch: (opts: Record<string, unknown>, handler: unknown) => unknown,
        ) => (opts: Record<string, unknown> & { headers?: unknown }, handler: unknown) => {
          if (opts.headers && typeof opts.headers === "object" && !Array.isArray(opts.headers)) {
            Object.assign(opts.headers, headers);
          } else {
            opts.headers = { ...(opts.headers as Record<string, string> | undefined ?? {}), ...headers };
          }
          return dispatch(opts, handler);
        }],
      },
    } as never)
    : undefined;

  if (options?.onStatusChanged) {
    db.registerListener({
      statusChanged: (status: unknown) => {
        options.onStatusChanged?.(status as PowerSyncRuntimeStatus);
      },
    });
  }

  const connector = {
    async fetchCredentials() {
      if (options?.fetchCredentials) {
        return await options.fetchCredentials(config);
      }
      const credentials = await fetchPowerSyncToken(config);
      return {
        endpoint: config.powersync_url,
        token: credentials.token,
        expiresAt: new Date(credentials.expires_at * 1000),
      };
    },
    async uploadData() {
      await flushCrud(db, config, headers, options?.uploadTransaction);
    },
  };

  await (db.connect as (connector: unknown, options: unknown) => Promise<void>)(connector, {
    fetchOptions: { headers },
    ...(dispatcher ? { dispatcher } : {}),
  });

  options?.onStatusChanged?.(db.currentStatus as unknown as PowerSyncRuntimeStatus);

  return db;
}

async function flushCrud(
  db: PowerSyncDatabase,
  config: PowerSyncConfig,
  headers: Record<string, string>,
  uploadTransaction: CreatePowerSyncDatabaseOptions["uploadTransaction"] = defaultUploadTransaction,
): Promise<void> {
  while (true) {
    const tx = await db.getNextCrudTransaction() as PowerSyncCrudTransaction | null;
    if (!tx) return;

    try {
      const result = await uploadTransaction(tx, { config, headers });
      await tx.complete(result?.checkpoint);
    } catch (error) {
      throw error;
    }
  }
}

export async function defaultUploadTransaction(
  transaction: PowerSyncCrudTransaction,
  context: PowerSyncUploadContext,
): Promise<{ checkpoint?: string } | void> {
  if (!context.config.upload_url) {
    throw new Error("PowerSync upload_url is required for defaultUploadTransaction");
  }
  const response = await fetch(context.config.upload_url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...context.headers,
    },
    body: JSON.stringify({
      transactionId: transaction.transactionId,
      operations: transaction.crud.map(serializeCrudEntry),
    }),
  });
  if (!response.ok) {
    throw new Error(`PowerSync upload failed: ${response.status} ${await response.text()}`);
  }
  if (response.status === 204) return;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return;
  const payload = await response.json() as { checkpoint?: unknown };
  if (payload.checkpoint !== undefined && typeof payload.checkpoint !== "string") {
    throw new Error("PowerSync upload response checkpoint must be a string");
  }
  return payload.checkpoint ? { checkpoint: payload.checkpoint } : undefined;
}

function serializeCrudEntry(op: PowerSyncCrudEntry): Record<string, unknown> {
  return {
    table: op.table,
    id: op.id,
    data: op.opData,
    op: op.op,
  };
}
