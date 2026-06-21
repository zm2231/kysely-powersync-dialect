import type BetterSqlite3 from "better-sqlite3";
import type { CompiledQuery, DatabaseConnection, QueryResult } from "kysely";
import type { PowerSyncDatabase } from "@powersync/node";

export type PowerSyncMode = "daemon" | "in-process" | "auto";
export type ReadQueryClassifier = (compiledQuery: CompiledQuery) => boolean;

export interface PowerSyncConfig {
  type?: "powersync";
  mode?: PowerSyncMode;
  powersync_url: string;
  auth_url?: string;
  upload_url?: string;
  user_id: string;
  db_path: string;
  cf_access_client_id?: string;
  cf_access_client_secret?: string;
}

export interface PowerSyncDialectConfig {
  readDatabase:
    | BetterSqlite3.Database
    | (() => Promise<BetterSqlite3.Database> | BetterSqlite3.Database);
  writeDatabase:
    | PowerSyncDatabase
    | (() => Promise<PowerSyncDatabase> | PowerSyncDatabase);
  readQueryClassifier?: ReadQueryClassifier;
  onCreateConnection?: (connection: DatabaseConnection) => Promise<void>;
}

export interface RemotePowerSyncDialectConfig {
  readDatabase:
    | BetterSqlite3.Database
    | (() => Promise<BetterSqlite3.Database> | BetterSqlite3.Database);
  writeEndpoint: string;
  writeHeaders?: Record<string, string>;
  writeBody?: (sql: string, parameters: readonly unknown[]) => unknown;
  mapResult?: <R>(payload: unknown) => QueryResult<R>;
  readQueryClassifier?: ReadQueryClassifier;
  onCreateConnection?: (connection: DatabaseConnection) => Promise<void>;
}

export interface PowerSyncRuntimeStatus {
  connected?: boolean;
  connecting?: boolean;
  hasSynced?: boolean;
  lastSyncedAt?: string | Date | null;
  downloading?: boolean;
  uploading?: boolean;
}

export interface CreatePowerSyncDatabaseOptions {
  onStatusChanged?: (status: PowerSyncRuntimeStatus) => void;
  fetchCredentials?: (config: PowerSyncConfig) => Promise<PowerSyncCredentials>;
  uploadTransaction?: (transaction: PowerSyncCrudTransaction, context: PowerSyncUploadContext) => Promise<PowerSyncUploadResult | void>;
}

export interface TokenResponse {
  token: string;
  expires_at: number;
}

export interface PowerSyncCredentials {
  endpoint: string;
  token: string;
  expiresAt: Date;
}

export interface PowerSyncCrudEntry {
  op: "PUT" | "PATCH" | "DELETE" | string;
  table: string;
  id: string;
  opData?: Record<string, unknown>;
}

export interface PowerSyncCrudTransaction {
  crud: PowerSyncCrudEntry[];
  complete: (checkpoint?: string) => Promise<void>;
  transactionId?: number;
}

export interface PowerSyncUploadContext {
  config: PowerSyncConfig;
  headers: Record<string, string>;
}

export interface PowerSyncUploadResult {
  checkpoint?: string;
}
