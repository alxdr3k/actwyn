import { describe, test, expect } from "bun:test";
import { DEFAULT_CHUNK_SIZE, splitForTelegram } from "../../src/telegram/outbound.ts";

describe("splitForTelegram", () => {
  test("empty string → [\"\"]", () => {
    expect(splitForTelegram("")).toEqual([""]);
  });

  test("short message: 1 chunk, no marker", () => {
    expect(splitForTelegram("hello")).toEqual(["hello"]);
  });

  test("exactly-at-limit message: 1 chunk, no marker", () => {
    const s = "a".repeat(DEFAULT_CHUNK_SIZE);
    const chunks = splitForTelegram(s);
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toBe(s);
  });

  test("just-over-limit: 2 chunks with (1/2), (2/2) markers", () => {
    const s = "b".repeat(DEFAULT_CHUNK_SIZE + 10);
    const chunks = splitForTelegram(s);
    expect(chunks.length).toBe(2);
    expect(chunks[0]!.endsWith(" (1/2)")).toBe(true);
    expect(chunks[1]!.endsWith(" (2/2)")).toBe(true);
  });

  test("markers carry correct i/N for many chunks", () => {
    const s = "c".repeat(DEFAULT_CHUNK_SIZE * 3 + 50);
    const chunks = splitForTelegram(s);
    const N = chunks.length;
    expect(N).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < N; i++) {
      expect(chunks[i]!.endsWith(` (${i + 1}/${N})`)).toBe(true);
    }
  });

  test("custom chunk size", () => {
    const chunks = splitForTelegram("abcdefghij", 3);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(3 + 10 /* marker slack */);
  });

  test("roundtrip property: concatenating content-before-marker recovers the original", () => {
    const body = "Lorem ipsum ".repeat(1500); // ~18k chars
    const chunks = splitForTelegram(body);
    const rejoined = chunks.map((c) => c.replace(/ \(\d+\/\d+\)$/, "")).join("");
    expect(rejoined).toBe(body);
  });
});
