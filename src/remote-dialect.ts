import {
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type CompiledQuery,
  type DatabaseIntrospector,
  type Dialect,
  type DialectAdapter,
  type Driver,
  type QueryCompiler,
  type QueryResult,
} from "kysely";
import type { RemotePowerSyncDialectConfig } from "./types.js";
import { normalizeRemoteResult, SplitPowerSyncDriver, type WriteExecutor } from "./dialect.js";

const TRANSACTION_SQL_REGEX = /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

export class RemotePowerSyncDialect implements Dialect {
  readonly #config: RemotePowerSyncDialectConfig;

  constructor(config: RemotePowerSyncDialectConfig) {
    this.#config = Object.freeze({ ...config });
  }

  createDriver(): Driver {
    return new SplitPowerSyncDriver({
      readDatabase: this.#config.readDatabase,
      createWriteExecutor: async () => new RemotePowerSyncWriteExecutor(this.#config),
      readQueryClassifier: this.#config.readQueryClassifier,
      onCreateConnection: this.#config.onCreateConnection,
    });
  }

  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }

  createAdapter(): DialectAdapter {
    return new SqliteAdapter();
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }
}

class RemotePowerSyncWriteExecutor implements WriteExecutor {
  readonly #config: RemotePowerSyncDialectConfig;

  constructor(config: RemotePowerSyncDialectConfig) {
    this.#config = config;
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    if (TRANSACTION_SQL_REGEX.test(compiledQuery.sql)) {
      throw new Error(
        "RemotePowerSyncDialect does not support remote transaction control statements",
      );
    }
    const body = this.#config.writeBody
      ? this.#config.writeBody(compiledQuery.sql, compiledQuery.parameters)
      : { sql: compiledQuery.sql, params: compiledQuery.parameters };
    const response = await fetch(this.#config.writeEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.#config.writeHeaders ?? {}),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Remote PowerSync write failed: ${response.status} ${await response.text()}`);
    }
    const payload = await readResponsePayload(response);
    if (this.#config.mapResult) return this.#config.mapResult<R>(payload);
    return normalizeRemoteResult<R>(payload);
  }

  async destroy(): Promise<void> {
    return;
  }
}

async function readResponsePayload(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (text.length === 0) return undefined;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return text;
  return JSON.parse(text) as unknown;
}
