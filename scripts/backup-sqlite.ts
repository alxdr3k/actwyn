#!/usr/bin/env bun

import { existsSync, linkSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve, basename, join } from "node:path";

import { Database } from "bun:sqlite";

export interface CreateSqliteBackupOptions {
  readonly sourcePath: string;
  readonly outputPath: string;
  readonly force?: boolean;
  readonly verify?: boolean;
  readonly busyTimeoutMs?: number;
}

export interface SqliteBackupResult {
  readonly source_path: string;
  readonly output_path: string;
  readonly bytes: number;
  readonly page_count: number;
  readonly page_size: number;
  readonly integrity_check: "ok" | string;
}

export interface BackupCliOptions extends CreateSqliteBackupOptions {
  readonly json: boolean;
}

export class BackupError extends Error {
  override readonly name = "BackupError";
}

export function createSqliteBackup(opts: CreateSqliteBackupOptions): SqliteBackupResult {
  const sourcePath = resolveRequiredPath(opts.sourcePath, "source");
  const outputPath = resolve(opts.outputPath);
  const force = opts.force ?? false;
  const verify = opts.verify ?? true;
  const busyTimeoutMs = Math.max(1, Math.trunc(opts.busyTimeoutMs ?? 5000));

  if (sourcePath === outputPath) {
    throw new BackupError("source and output paths must differ");
  }
  if (existsSync(outputPath) && !force) {
    throw new BackupError(`output already exists: ${outputPath}`);
  }

  mkdirSync(dirname(outputPath), { recursive: true });

  let serialized: Buffer;
  let pageCount: number;
  let pageSize: number;

  const db = new Database(sourcePath, {
    create: false,
    strict: true,
  });
  try {
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
    db.exec("PRAGMA query_only = ON;");
    pageCount = readPragmaNumber(db, "page_count");
    pageSize = readPragmaNumber(db, "page_size");
    serialized = db.serialize("main");
  } finally {
    db.close();
  }

  const tmpPath = makeTempPath(outputPath);
  try {
    writeFileSync(tmpPath, serialized, { flag: "wx", mode: 0o600 });
    normalizeBackupFile(tmpPath);
    const integrityCheck = verify ? verifySqliteBackup(tmpPath) : "not_run";
    if (verify && integrityCheck !== "ok") {
      throw new BackupError(`backup integrity_check failed: ${integrityCheck}`);
    }
    publishTempFile(tmpPath, outputPath, force);
    return {
      source_path: sourcePath,
      output_path: outputPath,
      bytes: serialized.byteLength,
      page_count: pageCount,
      page_size: pageSize,
      integrity_check: integrityCheck,
    };
  } catch (error) {
    tryUnlink(tmpPath);
    if (error instanceof BackupError) throw error;
    throw new BackupError((error as Error).message);
  }
}

export function verifySqliteBackup(path: string): "ok" | string {
  const backupPath = resolveRequiredPath(path, "backup");
  let db;
  try {
    db = new Database(backupPath, {
      create: false,
      readonly: true,
      strict: true,
    });
  } catch (error) {
    throw new BackupError((error as Error).message);
  }
  try {
    const row = db.prepare<{ integrity_check: string }, []>("PRAGMA integrity_check;").get();
    return row?.integrity_check ?? "missing integrity_check row";
  } catch (error) {
    throw new BackupError((error as Error).message);
  } finally {
    db.close();
  }
}

function normalizeBackupFile(path: string): void {
  const db = new Database(path, {
    create: false,
    strict: true,
  });
  try {
    // Serialized WAL-mode sources retain WAL journal mode in the
    // header. Normalize the snapshot to a standalone rollback-journal
    // file so it can be inspected read-only and restored directly.
    db.exec("PRAGMA journal_mode = DELETE;");
  } finally {
    db.close();
  }
}

export function parseBackupArgs(argv: readonly string[]): BackupCliOptions {
  let sourcePath: string | undefined;
  let outputPath: string | undefined;
  let force = false;
  let verify = true;
  let json = false;
  let busyTimeoutMs: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--db":
        sourcePath = requireValue(argv, ++i, arg);
        break;
      case "--out":
        outputPath = requireValue(argv, ++i, arg);
        break;
      case "--force":
        force = true;
        break;
      case "--no-verify":
        verify = false;
        break;
      case "--json":
        json = true;
        break;
      case "--busy-timeout-ms": {
        const raw = requireValue(argv, ++i, arg);
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0) {
          throw new BackupError("--busy-timeout-ms must be a positive integer");
        }
        busyTimeoutMs = n;
        break;
      }
      case "--help":
      case "-h":
        throw new BackupError(usage());
      default:
        throw new BackupError(`unknown argument: ${arg}`);
    }
  }

  if (!sourcePath) throw new BackupError("missing required --db <path>");
  if (!outputPath) throw new BackupError("missing required --out <path>");

  return {
    sourcePath,
    outputPath,
    force,
    verify,
    json,
    ...(busyTimeoutMs === undefined ? {} : { busyTimeoutMs }),
  };
}

function resolveRequiredPath(path: string, label: string): string {
  const resolved = resolve(path);
  let st;
  try {
    st = statSync(resolved);
  } catch {
    throw new BackupError(`${label} path does not exist: ${resolved}`);
  }
  if (!st.isFile()) {
    throw new BackupError(`${label} path is not a file: ${resolved}`);
  }
  return resolved;
}

function readPragmaNumber(db: Database, name: "page_count" | "page_size"): number {
  const row = db.prepare<Record<string, number>, []>(`PRAGMA ${name};`).get();
  const value = row?.[name];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new BackupError(`failed to read PRAGMA ${name}`);
  }
  return value;
}

function makeTempPath(outputPath: string): string {
  return join(
    dirname(outputPath),
    `.${basename(outputPath)}.${process.pid}.${Date.now()}.tmp`,
  );
}

function publishTempFile(tmpPath: string, outputPath: string, force: boolean): void {
  if (force) {
    renameSync(tmpPath, outputPath);
    return;
  }

  linkSync(tmpPath, outputPath);
  unlinkSync(tmpPath);
}

function tryUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // best-effort cleanup
  }
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new BackupError(`${flag} requires a value`);
  }
  return value;
}

function usage(): string {
  return [
    "Usage: bun run scripts/backup-sqlite.ts --db <actwyn.db> --out <backup.sqlite> [--force] [--json]",
    "",
    "Creates a WAL-safe SQLite snapshot using bun:sqlite serialize() and verifies it with PRAGMA integrity_check.",
  ].join("\n");
}

function formatResult(result: SqliteBackupResult): string {
  return [
    `backup: ${result.output_path}`,
    `source: ${result.source_path}`,
    `bytes: ${result.bytes}`,
    `pages: ${result.page_count} x ${result.page_size}`,
    `integrity_check: ${result.integrity_check}`,
  ].join("\n");
}

if (import.meta.main) {
  try {
    const opts = parseBackupArgs(Bun.argv.slice(2));
    const result = createSqliteBackup(opts);
    console.log(opts.json ? JSON.stringify(result, null, 2) : formatResult(result));
  } catch (error) {
    const message = (error as Error).message;
    if (message.startsWith("Usage:")) {
      console.log(message);
      process.exit(0);
    }
    console.error(`backup-sqlite: ${message}`);
    process.exit(1);
  }
}
