import { describe, test, expect } from "bun:test";
import {
  classifyAttachments,
  buildStorageObjectRow,
  defaultStorageKey,
  type AttachmentDescriptor,
} from "../../src/telegram/attachment_metadata.ts";
import type { TelegramMessage } from "../../src/telegram/types.ts";

const BASE_MSG = {
  message_id: 11,
  date: 1_700_000_000,
  chat: { id: 1, type: "private" },
} satisfies Partial<TelegramMessage> as TelegramMessage;

const ALLOW_FILENAME = () => true;
const BLOCK_FILENAME = () => false;

describe("classifyAttachments", () => {
  test("returns [] for text-only messages", () => {
    expect(classifyAttachments({ ...BASE_MSG, text: "hi" })).toEqual([]);
  });

  test("photo: picks the largest by area", () => {
    const msg: TelegramMessage = {
      ...BASE_MSG,
      photo: [
        { file_id: "s1", file_unique_id: "u1", width: 90, height: 90, file_size: 1000 },
        { file_id: "s2", file_unique_id: "u2", width: 640, height: 480, file_size: 80_000 },
        { file_id: "s3", file_unique_id: "u3", width: 320, height: 240, file_size: 20_000 },
      ],
    };
    const [desc] = classifyAttachments(msg);
    expect(desc?.kind).toBe("photo");
    expect(desc?.file_id).toBe("s2");
    expect(desc?.claimed_size_bytes).toBe(80_000);
    expect(desc?.claimed_filename).toBeNull();
  });

  test("document: pulls mime_type + file_name + file_size", () => {
    const [desc] = classifyAttachments({
      ...BASE_MSG,
      document: {
        file_id: "d1",
        file_unique_id: "u1",
        file_name: "report.pdf",
        mime_type: "application/pdf",
        file_size: 12345,
      },
    });
    expect(desc?.kind).toBe("document");
    expect(desc?.claimed_mime_type).toBe("application/pdf");
    expect(desc?.claimed_size_bytes).toBe(12345);
    expect(desc?.claimed_filename).toBe("report.pdf");
  });

  test("message with both photo and document produces two descriptors", () => {
    const descs = classifyAttachments({
      ...BASE_MSG,
      photo: [{ file_id: "p1", file_unique_id: "u1", width: 1, height: 1 }],
      document: {
        file_id: "d1",
        file_unique_id: "u2",
        file_name: "x.bin",
        mime_type: "application/octet-stream",
      },
    });
    expect(descs.map((d) => d.kind).sort()).toEqual(["document", "photo"]);
  });

  test("audio/video/voice are recognised", () => {
    const descs = classifyAttachments({
      ...BASE_MSG,
      audio: { file_id: "a1", file_unique_id: "u1", mime_type: "audio/mpeg" },
      video: { file_id: "v1", file_unique_id: "u2", width: 1, height: 1, mime_type: "video/mp4" },
      voice: { file_id: "o1", file_unique_id: "u3", mime_type: "audio/ogg" },
    });
    expect(descs.map((d) => d.kind).sort()).toEqual(["audio", "video", "voice"]);
  });
});

// ---------------------------------------------------------------
// buildStorageObjectRow — metadata-only, no network
// ---------------------------------------------------------------

const CONFIG = { max_inbound_size_bytes: 20 * 1024 * 1024 };

function desc(overrides: Partial<AttachmentDescriptor> = {}): AttachmentDescriptor {
  return {
    kind: "document",
    file_id: "tg-file-id-xyz",
    file_unique_id: "uu",
    claimed_mime_type: "application/pdf",
    claimed_size_bytes: 1024,
    claimed_filename: "doc.pdf",
    ...overrides,
  };
}

// Fixed date for deterministic key checks (PRD §12.8.4 format).
const TEST_NOW = new Date("2026-04-23T00:00:00.000Z");

describe("buildStorageObjectRow", () => {
  test("happy path: capture_status=pending, source_external_id set, sha256/mime/size NULL", () => {
    const row = buildStorageObjectRow({
      storage_object_id: "obj-1",
      user_id: "user-1",
      message_id: 7,
      descriptor: desc(),
      config: CONFIG,
      filenameIsRedactionSafe: ALLOW_FILENAME,
      storageKey: defaultStorageKey,
      bucket: "actwyn-test",
      now: TEST_NOW,
    });
    expect(row.capture_status).toBe("pending");
    expect(row.status).toBe("pending");
    expect(row.source_external_id).toBe("tg-file-id-xyz");
    expect(row.mime_type).toBeNull();
    expect(row.size_bytes).toBeNull();
    expect(row.capture_error_json).toBeNull();
    expect(row.original_filename_redacted).toBe("doc.pdf");
    expect(row.retention_class).toBe("session");
    expect(row.artifact_type).toBe("user_upload");
    expect(row.source_channel).toBe("telegram");
    expect(row.source_message_id).toBe("7");
    expect(row.storage_backend).toBe("s3");
    expect(row.bucket).toBe("actwyn-test");
    // PRD §12.8.4: provisional key (sha256 unknown pre-capture)
    expect(row.storage_key).toBe("objects/2026/04/23/obj-1/capture_pending.bin");
  });

  test("oversize-by-claim: capture_status=failed, reason=oversize_inbound, source_external_id NULL", () => {
    const row = buildStorageObjectRow({
      storage_object_id: "obj-2",
      user_id: "user-1",
      message_id: 8,
      descriptor: desc({ claimed_size_bytes: 200 * 1024 * 1024 }),
      config: CONFIG,
      filenameIsRedactionSafe: ALLOW_FILENAME,
      storageKey: defaultStorageKey,
      bucket: "actwyn-test",
    });
    expect(row.capture_status).toBe("failed");
    expect(row.status).toBe("pending");
    expect(row.source_external_id).toBeNull();
    expect(row.capture_error_json).toContain("oversize_inbound");
    const parsed = JSON.parse(row.capture_error_json!);
    expect(parsed.claimed_size_bytes).toBe(200 * 1024 * 1024);
    expect(parsed.max_inbound_size_bytes).toBe(CONFIG.max_inbound_size_bytes);
  });

  test("filename blocked by redactor: original_filename_redacted is NULL", () => {
    const row = buildStorageObjectRow({
      storage_object_id: "obj-3",
      user_id: "user-1",
      message_id: 9,
      descriptor: desc({ claimed_filename: "alice@example.com-secret.pdf" }),
      config: CONFIG,
      filenameIsRedactionSafe: BLOCK_FILENAME,
      storageKey: defaultStorageKey,
      bucket: "actwyn-test",
    });
    expect(row.original_filename_redacted).toBeNull();
  });

  test("NULL claimed_size passes through (photos often don't send file_size)", () => {
    const row = buildStorageObjectRow({
      storage_object_id: "obj-4",
      user_id: "user-1",
      message_id: 10,
      descriptor: desc({ kind: "photo", claimed_size_bytes: null, claimed_filename: null }),
      config: CONFIG,
      filenameIsRedactionSafe: ALLOW_FILENAME,
      storageKey: defaultStorageKey,
      bucket: "actwyn-test",
      now: TEST_NOW,
    });
    expect(row.capture_status).toBe("pending");
    expect(row.size_bytes).toBeNull();
    // PRD §12.8.4: provisional key — extension is "bin" until MIME is known
    expect(row.storage_key).toBe("objects/2026/04/23/obj-4/capture_pending.bin");
  });

  test("bucket=null → storage_backend=local", () => {
    const row = buildStorageObjectRow({
      storage_object_id: "obj-5",
      user_id: "user-1",
      message_id: 11,
      descriptor: desc(),
      config: CONFIG,
      filenameIsRedactionSafe: ALLOW_FILENAME,
      storageKey: defaultStorageKey,
      bucket: null,
    });
    expect(row.storage_backend).toBe("local");
    expect(row.bucket).toBeNull();
  });
});
