// CI-optional S3 round-trip test (Phase 9 deliverable).
//
// Skipped unless all five S3_* env vars are present.
// Run against the SP-08 dev bucket:
//
//   S3_ENDPOINT=... S3_BUCKET=... S3_REGION=... \
//   S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... \
//   bun test test/storage/roundtrip.test.ts
//
// Tests:
//   1. PUT bytes → object exists (key matches PRD §12.8.4 / AC-SEC-002)
//   2. Retrieve bytes → match original
//   3. DELETE → object gone
import { describe, test, expect } from "bun:test";
import { BunS3Transport } from "../../src/storage/s3.ts";
import { generateStorageKey, finalizeStorageKey, safeExtensionFromMime } from "../../src/storage/objects.ts";
import { sha256Hex } from "../../src/telegram/attachment_capture.ts";

const {
  S3_ENDPOINT,
  S3_BUCKET,
  S3_REGION,
  S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY,
} = process.env;

const SKIP = !S3_ENDPOINT || !S3_BUCKET || !S3_REGION || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY;

function makeTransport(): BunS3Transport {
  return new BunS3Transport({
    endpoint: S3_ENDPOINT!,
    bucket: S3_BUCKET!,
    region: S3_REGION!,
    access_key_id: S3_ACCESS_KEY_ID!,
    secret_access_key: S3_SECRET_ACCESS_KEY!,
  });
}

// ---------------------------------------------------------------
// PRD §12.8.4 / AC-SEC-002 key format assertions (pure, no I/O)
// ---------------------------------------------------------------

describe("key format — PRD §12.8.4 (no network)", () => {
  const TEST_DATE = new Date("2026-04-23T00:00:00.000Z");
  const TEST_ID = "01hzbqz9k7g5h3j8m4n0p2r6s";
  const TEST_SHA256 = "a".repeat(64);

  test("provisional key matches sentinel pattern", () => {
    const key = generateStorageKey({ date: TEST_DATE, object_id: TEST_ID });
    expect(key).toBe(`objects/2026/04/23/${TEST_ID}/capture_pending.bin`);
    expect(key).toMatch(/^objects\/\d{4}\/\d{2}\/\d{2}\/[^/]+\/[a-z0-9_]+\.[a-z0-9]+$/);
  });

  test("final key embeds sha256 and correct extension", () => {
    const key = finalizeStorageKey({
      date: TEST_DATE,
      object_id: TEST_ID,
      sha256: TEST_SHA256,
      mime_type: "application/pdf",
    });
    expect(key).toBe(`objects/2026/04/23/${TEST_ID}/${TEST_SHA256}.pdf`);
    expect(key).not.toContain("user");
    expect(key).not.toContain("chat");
    expect(key).not.toContain("telegram");
  });

  test("key never embeds user_id, chat_id, filename (AC-SEC-002)", () => {
    const sensitiveTerms = ["user-123", "chat-456", "alice@example.com", "report.pdf"];
    const key = finalizeStorageKey({
      date: TEST_DATE,
      object_id: TEST_ID,
      sha256: TEST_SHA256,
      mime_type: "application/pdf",
    });
    for (const term of sensitiveTerms) {
      expect(key).not.toContain(term);
    }
  });

  test("safeExtensionFromMime covers all defined MIME types", () => {
    const cases: [string, string][] = [
      ["image/jpeg", "jpg"],
      ["image/png", "png"],
      ["application/pdf", "pdf"],
      ["audio/mpeg", "mp3"],
      ["video/mp4", "mp4"],
      ["text/plain", "txt"],
      ["application/octet-stream", "bin"],
      ["unknown/type", "bin"],
      [null as unknown as string, "bin"],
    ];
    for (const [mime, expected] of cases) {
      expect(safeExtensionFromMime(mime)).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------
// Real S3 round-trip (CI-optional, requires env vars)
// ---------------------------------------------------------------

describe.skipIf(SKIP)("S3 round-trip — put / retrieve / delete", () => {
  const BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"
  const OBJECT_ID = `roundtrip-test-${Date.now()}`;
  const NOW = new Date();
  const SHA256 = sha256Hex(BYTES);

  const FINAL_KEY = finalizeStorageKey({
    date: NOW,
    object_id: OBJECT_ID,
    sha256: SHA256,
    mime_type: "application/pdf",
  });

  test("PUT: bytes arrive at the expected PRD §12.8.4 key", async () => {
    const transport = makeTransport();
    await transport.put({
      bucket: S3_BUCKET!,
      key: FINAL_KEY,
      bytes: BYTES,
      content_type: "application/pdf",
    });
  });

  test("GET: fetched bytes match what was uploaded", async () => {
    const client = new Bun.S3Client({
      endpoint: S3_ENDPOINT!,
      bucket: S3_BUCKET!,
      region: S3_REGION!,
      accessKeyId: S3_ACCESS_KEY_ID!,
      secretAccessKey: S3_SECRET_ACCESS_KEY!,
    });
    const fetched = new Uint8Array(await client.file(FINAL_KEY).arrayBuffer());
    expect(fetched).toEqual(BYTES);
    expect(sha256Hex(fetched)).toBe(SHA256);
  });

  test("DELETE: object removed from bucket", async () => {
    const transport = makeTransport();
    await transport.delete({ bucket: S3_BUCKET!, key: FINAL_KEY });

    const client = new Bun.S3Client({
      endpoint: S3_ENDPOINT!,
      bucket: S3_BUCKET!,
      region: S3_REGION!,
      accessKeyId: S3_ACCESS_KEY_ID!,
      secretAccessKey: S3_SECRET_ACCESS_KEY!,
    });
    const exists = await client.file(FINAL_KEY).exists();
    expect(exists).toBe(false);
  });
});
