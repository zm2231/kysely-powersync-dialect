import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import BetterSqlite3 from "better-sqlite3";
import { Kysely } from "kysely";
import {
  RemotePowerSyncDialect,
  SplitPowerSyncDriver,
  defaultUploadTransaction,
  fetchPowerSyncToken,
  isPowerSyncReadQuery,
  parseTokenResponse,
  validatePowerSyncConfig,
} from "../dist/index.js";

function createReadDb() {
  const dir = mkdtempSync(join(tmpdir(), "kysely-powersync-"));
  const dbPath = join(dir, "replica.db");
  const readDb = new BetterSqlite3(dbPath);
  readDb.exec("CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT)");
  readDb.prepare("INSERT INTO notes (id, body) VALUES (?, ?)").run("n1", "hello");
  return {
    readDb,
    cleanup() {
      readDb.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function createTracedReadDb() {
  const fixture = createReadDb();
  const statements = [];
  const originalExec = fixture.readDb.exec.bind(fixture.readDb);
  fixture.readDb.exec = (statement) => {
    statements.push(statement.toLowerCase());
    return originalExec(statement);
  };
  return {
    ...fixture,
    statements,
  };
}

function createWriteServer(responseBody = { rows: [], numAffectedRows: 0 }) {
  const bodies = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    bodies.push(JSON.parse(body || "{}"));
    if (responseBody === null) {
      res.statusCode = 204;
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(responseBody));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        bodies,
        url: `http://127.0.0.1:${address.port}/write`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function createAuthServer() {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ token: "token-1", expires_at: Math.floor(Date.now() / 1000) + 3600 }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        requests,
        url: `http://127.0.0.1:${address.port}/token`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test("transaction SELECT returns rows from the read replica", async () => {
  const fixture = createTracedReadDb();
  const writes = await createWriteServer();
  const db = new Kysely({
    dialect: new RemotePowerSyncDialect({
      readDatabase: fixture.readDb,
      writeEndpoint: writes.url,
    }),
  });

  try {
    const rows = await db.transaction().execute(async (trx) => {
      return await trx.selectFrom("notes").selectAll().execute();
    });

    assert.deepEqual(rows, [{ id: "n1", body: "hello" }]);
    assert.deepEqual(writes.bodies, []);
    assert.equal(fixture.statements.includes("begin"), true);
    assert.equal(fixture.statements.includes("commit"), true);
  } finally {
    await db.destroy();
    await writes.close();
    fixture.cleanup();
  }
});

test("writes inside transactions are rejected", async () => {
  const fixture = createReadDb();
  const writes = await createWriteServer();
  const db = new Kysely({
    dialect: new RemotePowerSyncDialect({
      readDatabase: fixture.readDb,
      writeEndpoint: writes.url,
    }),
  });

  try {
    await assert.rejects(
      () => db.transaction().execute(async (trx) => {
        await trx.insertInto("notes").values({ id: "n2", body: "bye" }).execute();
      }),
      /only supports read queries inside Kysely transactions/,
    );
  } finally {
    await db.destroy();
    await writes.close();
    fixture.cleanup();
  }
});

test("CTE SELECT returns rows from the read replica", async () => {
  const fixture = createReadDb();
  const writes = await createWriteServer();
  const db = new Kysely({
    dialect: new RemotePowerSyncDialect({
      readDatabase: fixture.readDb,
      writeEndpoint: writes.url,
    }),
  });

  try {
    const rows = await db
      .with("selected_notes", (qb) => qb.selectFrom("notes").selectAll())
      .selectFrom("selected_notes")
      .selectAll()
      .execute();

    assert.deepEqual(rows, [{ id: "n1", body: "hello" }]);
    assert.deepEqual(writes.bodies, []);
  } finally {
    await db.destroy();
    await writes.close();
    fixture.cleanup();
  }
});

test("requires explicit http upload_url", () => {
  assert.throws(
    () => validatePowerSyncConfig({
      powersync_url: "https://powersync.example.com",
      auth_url: "https://api.example.com/auth",
      upload_url: "file:///tmp/not-http",
      user_id: "user-1",
      db_path: "/tmp/powersync.db",
    }),
    /upload_url must use http or https/,
  );
});

test("exports the read query helper", () => {
  assert.equal(isPowerSyncReadQuery("select * from notes"), true);
  assert.equal(isPowerSyncReadQuery(" pragma table_info(notes)"), true);
  assert.equal(isPowerSyncReadQuery("/* comment */ select * from notes"), true);
  assert.equal(isPowerSyncReadQuery("-- comment\nwith selected as (select * from notes) select * from selected"), true);
  assert.equal(isPowerSyncReadQuery("pragma user_version"), true);
  assert.equal(isPowerSyncReadQuery("pragma table_info(notes);"), true);
  assert.equal(isPowerSyncReadQuery("pragma user_version = 1"), false);
  assert.equal(isPowerSyncReadQuery("pragma journal_mode = WAL"), false);
  assert.equal(isPowerSyncReadQuery("insert into notes values ('n2', 'bye')"), false);
  assert.equal(isPowerSyncReadQuery("with deleted as (delete from notes returning *) select * from deleted"), false);
});

test("does not publish Cadence core tables", async () => {
  const publicApi = await import("../dist/index.js");
  assert.equal("CORE_TABLES" in publicApi, false);
});

test("exports low-level extension hooks", () => {
  assert.equal(typeof SplitPowerSyncDriver, "function");
});

test("validates malformed auth token responses", () => {
  assert.throws(
    () => parseTokenResponse({ token: "", expires_at: 123 }),
    /missing token/,
  );
  assert.throws(
    () => parseTokenResponse({ token: "abc", expires_at: "soon" }),
    /numeric expires_at/,
  );
  assert.deepEqual(parseTokenResponse({ token: "abc", expires_at: 123 }), {
    token: "abc",
    expires_at: 123,
  });
});

test("rejects partial Cloudflare Access config", () => {
  assert.throws(
    () => validatePowerSyncConfig({
      powersync_url: "https://powersync.example.com",
      auth_url: "https://api.example.com/auth",
      upload_url: "https://api.example.com/upload",
      user_id: "user-1",
      db_path: "/tmp/powersync.db",
      cf_access_client_id: "id-only",
    }),
    /requires both client id and client secret/,
  );
});

test("custom credential and upload hooks do not require auth or upload URLs", () => {
  assert.doesNotThrow(() => validatePowerSyncConfig({
    powersync_url: "https://powersync.example.com",
    user_id: "user-1",
    db_path: "/tmp/powersync.db",
  }, {
    requireAuthUrl: false,
    requireUploadUrl: false,
  }));
  assert.throws(() => validatePowerSyncConfig({
    powersync_url: "https://powersync.example.com",
    user_id: "user-1",
    db_path: "/tmp/powersync.db",
  }, {
    requireAuthUrl: false,
  }), /upload_url is required/);
});

test("default auth works with custom upload hook and no upload_url", async () => {
  const auth = await createAuthServer();
  try {
    const token = await fetchPowerSyncToken({
      powersync_url: "https://powersync.example.com",
      auth_url: auth.url,
      user_id: "user-1",
      db_path: "/tmp/powersync.db",
    });

    assert.equal(token.token, "token-1");
    assert.equal(auth.requests[0], "/token?user_id=user-1");
  } finally {
    await auth.close();
  }
});

test("default uploader sends a whole transaction in one request", async () => {
  const writes = await createWriteServer({ checkpoint: "checkpoint-1" });
  const transaction = {
    transactionId: 42,
    crud: [
      { op: "PUT", table: "notes", id: "n1", opData: { body: "hello" } },
      { op: "PATCH", table: "notes", id: "n2", opData: { body: "bye" } },
    ],
    complete: async () => {},
  };

  try {
    const result = await defaultUploadTransaction(transaction, {
      config: {
        powersync_url: "https://powersync.example.com",
        auth_url: "https://api.example.com/auth",
        upload_url: writes.url,
        user_id: "user-1",
        db_path: "/tmp/powersync.db",
      },
      headers: { "x-test": "yes" },
    });

    assert.equal(writes.bodies.length, 1);
    assert.deepEqual(writes.bodies[0], {
      transactionId: 42,
      operations: [
        { op: "PUT", table: "notes", id: "n1", data: { body: "hello" } },
        { op: "PATCH", table: "notes", id: "n2", data: { body: "bye" } },
      ],
    });
    assert.deepEqual(result, { checkpoint: "checkpoint-1" });
  } finally {
    await writes.close();
  }
});

test("remote writes accept empty success responses", async () => {
  const fixture = createReadDb();
  const writes = await createWriteServer(null);
  const db = new Kysely({
    dialect: new RemotePowerSyncDialect({
      readDatabase: fixture.readDb,
      writeEndpoint: writes.url,
    }),
  });

  try {
    await db.insertInto("notes").values({ id: "n2", body: "bye" }).executeTakeFirst();
    assert.equal(writes.bodies.length, 1);
  } finally {
    await db.destroy();
    await writes.close();
    fixture.cleanup();
  }
});
