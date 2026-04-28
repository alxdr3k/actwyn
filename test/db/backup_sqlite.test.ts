import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  BackupError,
  createSqliteBackup,
  parseBackupArgs,
  verifySqliteBackup,
} from "../../scripts/backup-sqlite.ts";

let tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe("backup-sqlite — WAL-safe snapshot", () => {
  test("captures rows that are still in a live WAL connection", () => {
    const dir = tempDir();
    const sourcePath = join(dir, "live.db");
    const outputPath = join(dir, "backup.sqlite");

    const live = new Database(sourcePath, { create: true, strict: true });
    try {
      live.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA wal_autocheckpoint = 0;
        CREATE TABLE items (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
        INSERT INTO items(body) VALUES ('before backup');
      `);

      expect(existsSync(`${sourcePath}-wal`)).toBe(true);

      const result = createSqliteBackup({
        sourcePath,
        outputPath,
      });

      expect(result.integrity_check).toBe("ok");
      expect(result.bytes).toBeGreaterThan(0);
      expect(readItemBodies(outputPath)).toEqual(["before backup"]);
    } finally {
      live.close();
    }
  });

  test("refuses to overwrite an existing backup unless force is set", () => {
    const dir = tempDir();
    const sourcePath = join(dir, "live.db");
    const outputPath = join(dir, "backup.sqlite");
    seedSource(sourcePath, "first");

    createSqliteBackup({ sourcePath, outputPath });
    seedSource(sourcePath, "second");

    expect(() => createSqliteBackup({ sourcePath, outputPath })).toThrow(BackupError);
    expect(readItemBodies(outputPath)).toEqual(["first"]);

    createSqliteBackup({ sourcePath, outputPath, force: true });
    expect(readItemBodies(outputPath)).toEqual(["second"]);
  });

  test("can skip integrity verification when requested", () => {
    const dir = tempDir();
    const sourcePath = join(dir, "live.db");
    const outputPath = join(dir, "backup.sqlite");
    seedSource(sourcePath, "unverified");

    const result = createSqliteBackup({ sourcePath, outputPath, verify: false });

    expect(result.integrity_check).toBe("not_run");
    expect(readItemBodies(outputPath)).toEqual(["unverified"]);
  });

  test("rejects source/output aliasing and non-files", () => {
    const dir = tempDir();
    const sourcePath = join(dir, "live.db");
    seedSource(sourcePath, "row");

    expect(() => createSqliteBackup({ sourcePath, outputPath: sourcePath })).toThrow(
      /source and output paths must differ/,
    );
    expect(() => createSqliteBackup({ sourcePath: dir, outputPath: join(dir, "out.db") })).toThrow(
      /source path is not a file/,
    );
  });

  test("rejects source/output aliasing through symlinked directories", () => {
    const dir = tempDir();
    const dataDir = join(dir, "data");
    const aliasDir = join(dir, "alias");
    mkdirSync(dataDir);
    symlinkSync(dataDir, aliasDir, "dir");
    const sourcePath = join(dataDir, "live.db");
    const outputPath = join(aliasDir, "live.db");
    seedSource(sourcePath, "row");

    expect(() => createSqliteBackup({ sourcePath, outputPath, force: true })).toThrow(
      /source and output paths must differ/,
    );
    expect(readItemBodies(sourcePath)).toEqual(["row"]);
  });

  test("verifySqliteBackup reports a corrupt output deterministically", () => {
    const dir = tempDir();
    const badPath = join(dir, "bad.sqlite");
    writeFileSync(badPath, "not sqlite", "utf8");

    expect(() => verifySqliteBackup(badPath)).toThrow();
  });

  test("parseBackupArgs supports required flags and safety options", () => {
    expect(
      parseBackupArgs([
        "--db",
        "actwyn.db",
        "--out",
        "backup.sqlite",
        "--force",
        "--json",
        "--busy-timeout-ms",
        "100",
      ]),
    ).toEqual({
      sourcePath: "actwyn.db",
      outputPath: "backup.sqlite",
      force: true,
      verify: true,
      json: true,
      busyTimeoutMs: 100,
    });

    expect(parseBackupArgs(["--db", "actwyn.db", "--out", "backup.sqlite", "--no-verify"]))
      .toEqual({
        sourcePath: "actwyn.db",
        outputPath: "backup.sqlite",
        force: false,
        verify: false,
        json: false,
      });
  });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "actwyn-backup-"));
  tmpDirs.push(dir);
  return dir;
}

function seedSource(path: string, body: string): void {
  const db = new Database(path, { create: true, strict: true });
  try {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("DROP TABLE IF EXISTS items;");
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, body TEXT NOT NULL);");
    db.prepare("INSERT INTO items(body) VALUES (?)").run(body);
  } finally {
    db.close();
  }
}

function readItemBodies(path: string): string[] {
  const db = new Database(path, { readonly: true, create: false, strict: true });
  try {
    return db
      .prepare<{ body: string }, []>("SELECT body FROM items ORDER BY id")
      .all()
      .map((row) => row.body);
  } finally {
    db.close();
  }
}
