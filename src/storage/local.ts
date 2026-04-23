// Personal Agent P0 — local FS read helper for storage_objects.
//
// The worker's capture pass writes bytes to disk; the sync worker
// reads them back here for S3 upload. Paths are constructed by
// the caller (src/telegram/attachment_capture.ts uses
// `config.capture.local_path(id)`); this module provides a thin
// wrapper so the sync loop doesn't import node:fs directly.

import { existsSync, readFileSync, rmSync } from "node:fs";

export function readLocal(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

export function localExists(path: string): boolean {
  return existsSync(path);
}

export function removeLocal(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Best-effort; caller logs the attempt.
  }
}
