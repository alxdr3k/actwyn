// Personal Agent P0 — MIME type probe from magic bytes.
//
// Inspects the first few bytes of a file to determine its content
// type. Falls back to application/octet-stream for unknown types.
//
// Implements the MimeProbe interface from attachment_capture.ts.

import type { MimeProbe } from "~/telegram/attachment_capture.ts";

interface MagicEntry {
  readonly offset: number;
  readonly bytes: readonly number[];
  readonly mime: string;
}

const MAGIC: readonly MagicEntry[] = [
  // Images
  { offset: 0, bytes: [0xff, 0xd8, 0xff], mime: "image/jpeg" },
  { offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], mime: "image/png" },
  { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38], mime: "image/gif" },
  { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46], mime: "image/webp" }, // RIFF header; refined below
  { offset: 0, bytes: [0x42, 0x4d], mime: "image/bmp" },
  // Documents
  { offset: 0, bytes: [0x25, 0x50, 0x44, 0x46], mime: "application/pdf" },
  // Archives / Office
  { offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04], mime: "application/zip" },
  { offset: 0, bytes: [0x50, 0x4b, 0x05, 0x06], mime: "application/zip" },
  // Audio
  { offset: 0, bytes: [0x49, 0x44, 0x33], mime: "audio/mpeg" }, // MP3 ID3 tag
  { offset: 0, bytes: [0xff, 0xfb], mime: "audio/mpeg" },
  { offset: 0, bytes: [0xff, 0xf3], mime: "audio/mpeg" },
  { offset: 0, bytes: [0xff, 0xf2], mime: "audio/mpeg" },
  { offset: 0, bytes: [0x4f, 0x67, 0x67, 0x53], mime: "audio/ogg" },
  { offset: 0, bytes: [0x66, 0x4c, 0x61, 0x43], mime: "audio/flac" },
  // Video
  { offset: 0, bytes: [0x1a, 0x45, 0xdf, 0xa3], mime: "video/webm" },
  // Text (rough heuristics — these must come last)
];

function matchesMagic(bytes: Uint8Array, entry: MagicEntry): boolean {
  if (bytes.length < entry.offset + entry.bytes.length) return false;
  for (let i = 0; i < entry.bytes.length; i++) {
    if (bytes[entry.offset + i] !== entry.bytes[i]) return false;
  }
  return true;
}

function detectFromMagic(bytes: Uint8Array): string | null {
  // RIFF files: check sub-format at offset 8.
  if (bytes.length >= 12 && matchesMagic(bytes, MAGIC.find(m => m.mime === "image/webp")!)) {
    const sub = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
    if (sub === "WEBP") return "image/webp";
    if (sub === "WAVE") return "audio/wav";
    return "application/octet-stream";
  }

  // MP4 / QuickTime: ftyp box at offset 4-8.
  if (bytes.length >= 8) {
    const ftyp = String.fromCharCode(bytes[4]!, bytes[5]!, bytes[6]!, bytes[7]!);
    if (ftyp === "ftyp") {
      const brand = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
      if (brand.startsWith("qt")) return "video/quicktime";
      return "video/mp4";
    }
  }

  for (const entry of MAGIC) {
    if (entry.mime === "image/webp") continue; // handled above
    if (matchesMagic(bytes, entry)) return entry.mime;
  }
  return null;
}

export class MagicMimeProbe implements MimeProbe {
  async probe(bytes: Uint8Array, hint?: string | undefined): Promise<string> {
    const detected = detectFromMagic(bytes);
    if (detected) return detected;

    // Fall back to hint (e.g., from Telegram's mime_type field).
    if (hint && hint.includes("/")) return hint;

    return "application/octet-stream";
  }
}
