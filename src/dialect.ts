import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import {
  CompiledQuery,
  Kysely,
  SelectQueryNode,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type DialectAdapter,
  type Driver,
  type QueryCompiler,
  type QueryResult,
  type TransactionSettings,
} from "kysely";
import type { PowerSyncDatabase } from "@powersync/node";
import type { PowerSyncDialectConfig, ReadQueryClassifier } from "./types.js";

const READ_QUERY_REGEX = /^(SELECT|EXPLAIN)\b/i;
const READ_PRAGMA_REGEX = /^PRAGMA\s+(table_info|table_xinfo|index_info|index_xinfo|index_list|foreign_key_list|database_list|quick_check|integrity_check|user_version|application_id|schema_version)\b/i;

export interface WriteExecutor {
  executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>>;
  destroy(): Promise<void>;
}

export interface SplitPowerSyncDriverConfig {
  readDatabase:
    | BetterSqlite3.Database
    | (() => Promise<BetterSqlite3.Database> | BetterSqlite3.Database);
  createWriteExecutor: () => Promise<WriteExecutor>;
  readQueryClassifier?: ReadQueryClassifier;
  onCreateConnection?: (connection: DatabaseConnection) => Promise<void>;
}

export class PowerSyncDialect implements Dialect {
  readonly #config: PowerSyncDialectConfig;

  constructor(config: PowerSyncDialectConfig) {
    this.#config = Object.freeze({ ...config });
  }

  createDriver(): Driver {
    return new SplitPowerSyncDriver({
      readDatabase: this.#config.readDatabase,
      createWriteExecutor: async () =>
        new LocalPowerSyncWriteExecutor(await resolveValue(this.#config.writeDatabase)),
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

export async function openPowerSyncReadDatabase(dbPath: string): Promise<BetterSqlite3.Database> {
  ensureSqliteFileExists(dbPath);
  return new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
}

export function isPowerSyncReadQuery(sqlText: string): boolean {
  return isReadSql(sqlText);
}

export const defaultReadQueryClassifier: ReadQueryClassifier = (compiledQuery) => {
  if (SelectQueryNode.is(compiledQuery.query)) return true;
  return isReadSql(compiledQuery.sql);
};

export class SplitPowerSyncDriver implements Driver {
  readonly #config: SplitPowerSyncDriverConfig;
  readonly #connectionMutex = new ConnectionMutex();
  #readDb?: BetterSqlite3.Database;
  #writeExecutor?: WriteExecutor;
  #connection?: SplitPowerSyncConnection;

  constructor(config: SplitPowerSyncDriverConfig) {
    this.#config = Object.freeze({ ...config });
  }

  async init(): Promise<void> {
    this.#readDb = await resolveValue(this.#config.readDatabase);
    this.#writeExecutor = await this.#config.createWriteExecutor();
    this.#connection = new SplitPowerSyncConnection(
      this.#readDb,
      this.#writeExecutor,
      this.#config.readQueryClassifier ?? defaultReadQueryClassifier,
    );
    if (this.#config.onCreateConnection) {
      await this.#config.onCreateConnection(this.#connection);
    }
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    if (!this.#connection) throw new Error("PowerSync driver has not been initialized");
    await this.#connectionMutex.lock();
    return this.#connection;
  }

  async beginTransaction(connection: DatabaseConnection, _settings: TransactionSettings): Promise<void> {
    if (!(connection instanceof SplitPowerSyncConnection)) {
      throw new Error("Unsupported PowerSync connection instance");
    }
    connection.enterTransaction();
    try {
      await connection.beginReadTransaction();
    } catch (error) {
      connection.exitTransaction();
      throw error;
    }
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    if (!(connection instanceof SplitPowerSyncConnection)) {
      throw new Error("Unsupported PowerSync connection instance");
    }
    try {
      await connection.commitReadTransaction();
    } finally {
      connection.exitTransaction();
    }
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    if (!(connection instanceof SplitPowerSyncConnection)) {
      throw new Error("Unsupported PowerSync connection instance");
    }
    try {
      await connection.rollbackReadTransaction();
    } finally {
      connection.exitTransaction();
    }
  }

  async savepoint(connection: DatabaseConnection, savepointName: string): Promise<void> {
    if (!(connection instanceof SplitPowerSyncConnection)) {
      throw new Error("Unsupported PowerSync connection instance");
    }
    await connection.savepoint(savepointName);
  }

  async rollbackToSavepoint(connection: DatabaseConnection, savepointName: string): Promise<void> {
    if (!(connection instanceof SplitPowerSyncConnection)) {
      throw new Error("Unsupported PowerSync connection instance");
    }
    await connection.rollbackToSavepoint(savepointName);
  }

  async releaseSavepoint(connection: DatabaseConnection, savepointName: string): Promise<void> {
    if (!(connection instanceof SplitPowerSyncConnection)) {
      throw new Error("Unsupported PowerSync connection instance");
    }
    await connection.releaseSavepoint(savepointName);
  }

  async releaseConnection(_connection: DatabaseConnection): Promise<void> {
    this.#connectionMutex.unlock();
  }

  async destroy(): Promise<void> {
    await this.#writeExecutor?.destroy();
    this.#readDb?.close();
  }
}

class SplitPowerSyncConnection implements DatabaseConnection {
  readonly #readDb: BetterSqlite3.Database;
  readonly #writeExecutor: WriteExecutor;
  readonly #readQueryClassifier: ReadQueryClassifier;
  #transactionDepth = 0;

  constructor(
    readDb: BetterSqlite3.Database,
    writeExecutor: WriteExecutor,
    readQueryClassifier: ReadQueryClassifier,
  ) {
    this.#readDb = readDb;
    this.#writeExecutor = writeExecutor;
    this.#readQueryClassifier = readQueryClassifier;
  }

  enterTransaction(): void {
    this.#transactionDepth += 1;
  }

  exitTransaction(): void {
    this.#transactionDepth = Math.max(0, this.#transactionDepth - 1);
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    if (this.#readQueryClassifier(compiledQuery)) {
      return this.#executeReadQuery(compiledQuery);
    }
    if (this.#transactionDepth > 0) {
      throw new Error("PowerSync dialect only supports read queries inside Kysely transactions");
    }
    return this.#writeExecutor.executeQuery<R>(compiledQuery);
  }

  async beginReadTransaction(): Promise<void> {
    this.#readDb.exec("begin");
  }

  async commitReadTransaction(): Promise<void> {
    this.#readDb.exec("commit");
  }

  async rollbackReadTransaction(): Promise<void> {
    this.#readDb.exec("rollback");
  }

  async savepoint(savepointName: string): Promise<void> {
    this.#readDb.exec(`savepoint ${quoteIdentifier(savepointName)}`);
  }

  async rollbackToSavepoint(savepointName: string): Promise<void> {
    this.#readDb.exec(`rollback to ${quoteIdentifier(savepointName)}`);
  }

  async releaseSavepoint(savepointName: string): Promise<void> {
    this.#readDb.exec(`release ${quoteIdentifier(savepointName)}`);
  }

  async *streamQuery<R>(compiledQuery: CompiledQuery): AsyncIterableIterator<QueryResult<R>> {
    if (!SelectQueryNode.is(compiledQuery.query)) {
      throw new Error("PowerSync dialect only supports streaming select queries");
    }

    const stmt = this.#readDb.prepare(compiledQuery.sql);
    const iter = stmt.iterate(compiledQuery.parameters as unknown[]);
    for (const row of iter) {
      yield { rows: [row as R] };
    }
  }

  #executeReadQuery<R>(compiledQuery: CompiledQuery): QueryResult<R> {
    const stmt = this.#readDb.prepare(compiledQuery.sql);
    const rows = stmt.all(compiledQuery.parameters as unknown[]) as R[];
    return { rows };
  }
}

class LocalPowerSyncWriteExecutor implements WriteExecutor {
  readonly #db: PowerSyncDatabase;

  constructor(db: PowerSyncDatabase) {
    this.#db = db;
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const result = await this.#db.execute(compiledQuery.sql, [...compiledQuery.parameters]);
    const rows = (result as { rows?: R[] }).rows;
    return {
      rows: Array.isArray(rows) ? rows : [],
      numAffectedRows: typeof result.rowsAffected === "number" ? BigInt(result.rowsAffected) : undefined,
      insertId: toBigInt(result.insertId),
    };
  }

  async destroy(): Promise<void> {
    await this.#db.disconnect();
  }
}

export async function resolveValue<T>(value: T | (() => T | Promise<T>) | Promise<T>): Promise<T> {
  if (typeof value === "function") {
    return await (value as () => T | Promise<T>)();
  }
  return await value;
}

export function normalizeRemoteResult<R>(payload: unknown): QueryResult<R> {
  if (!payload || typeof payload !== "object") {
    return { rows: [] };
  }
  const result = payload as {
    rows?: R[];
    numAffectedRows?: number | string | bigint;
    insertId?: number | string | bigint;
  };
  return {
    rows: Array.isArray(result.rows) ? result.rows : [],
    numAffectedRows: toBigInt(result.numAffectedRows),
    insertId: toBigInt(result.insertId),
  };
}

export function ensureSqliteFileExists(dbPath: string): void {
  if (existsSync(dbPath)) return;
  mkdirSync(dirname(dbPath), { recursive: true });
  const bootstrap = new BetterSqlite3(dbPath);
  bootstrap.pragma("journal_mode = WAL");
  bootstrap.close();
}

function toBigInt(value: bigint | number | string | null | undefined): bigint | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string" && value.length > 0) return BigInt(value);
  return undefined;
}

function isReadSql(sqlText: string): boolean {
  const normalized = stripLeadingSqlTrivia(sqlText);
  if (READ_QUERY_REGEX.test(normalized)) return true;
  const statement = stripTrailingStatementTerminators(normalized);
  if (READ_PRAGMA_REGEX.test(statement) && !/=/.test(statement)) return true;
  if (!/^WITH\b/i.test(statement)) return false;
  return /\bSELECT\b/i.test(statement) &&
    !/\b(INSERT|UPDATE|DELETE|REPLACE|UPSERT|CREATE|ALTER|DROP)\b/i.test(statement);
}

function stripLeadingSqlTrivia(sqlText: string): string {
  let remaining = sqlText.trimStart();
  while (true) {
    if (remaining.startsWith("--")) {
      const nextLine = remaining.indexOf("\n");
      remaining = nextLine === -1 ? "" : remaining.slice(nextLine + 1).trimStart();
      continue;
    }
    if (remaining.startsWith("/*")) {
      const close = remaining.indexOf("*/");
      remaining = close === -1 ? "" : remaining.slice(close + 2).trimStart();
      continue;
    }
    return remaining;
  }
}

function stripTrailingStatementTerminators(sqlText: string): string {
  return sqlText.replace(/;\s*$/, "");
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll("\"", "\"\"")}"`;
}

class ConnectionMutex {
  #promise: Promise<void> | undefined;
  #resolve: (() => void) | undefined;

  async lock(): Promise<void> {
    while (this.#promise) {
      await this.#promise;
    }
    this.#promise = new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  unlock(): void {
    const resolve = this.#resolve;
    this.#promise = undefined;
    this.#resolve = undefined;
    resolve?.();
  }
}
