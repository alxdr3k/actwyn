import { describe, test, expect } from "bun:test";
import { cjkCharRatio, estimateTokens, isCjkChar } from "../../src/context/token_estimator.ts";

describe("isCjkChar", () => {
  test("Korean Hangul is CJK", () => {
    expect(isCjkChar("안".codePointAt(0)!)).toBe(true);
  });
  test("Japanese Hiragana is CJK", () => {
    expect(isCjkChar("あ".codePointAt(0)!)).toBe(true);
  });
  test("Chinese Ideograph is CJK", () => {
    expect(isCjkChar("字".codePointAt(0)!)).toBe(true);
  });
  test("ASCII letters are not CJK", () => {
    expect(isCjkChar("A".codePointAt(0)!)).toBe(false);
  });
});

describe("cjkCharRatio", () => {
  test("ignores whitespace when computing the ratio", () => {
    expect(cjkCharRatio("a    b")).toBe(0);
  });
  test("all-Korean is 1", () => {
    expect(cjkCharRatio("안녕하세요")).toBe(1);
  });
  test("empty string is 0", () => {
    expect(cjkCharRatio("")).toBe(0);
  });
});

describe("estimateTokens — over-estimation bias (DEC-021)", () => {
  test("ASCII-heavy: ceil(len/3)", () => {
    expect(estimateTokens("abcdef")).toBe(2);
  });

  test("CJK-heavy: ceil(len/1.5)", () => {
    const s = "안녕하세요"; // 5 chars, /1.5 = 3.33 → 4
    expect(estimateTokens(s)).toBe(4);
  });

  test("Mixed with >50% CJK uses the CJK estimate", () => {
    const s = "안녕hi"; // 4 chars; CJK ratio > 0.5 → ceil(4/1.5)=3
    expect(estimateTokens(s)).toBe(3);
  });

  test("Mixed with <50% CJK takes max(ASCII, CJK) (pessimistic)", () => {
    const s = "hello there 안"; // 13 chars; ratio < 0.5
    const ascii = Math.ceil(s.length / 3);
    const cjk = Math.ceil(s.length / 1.5);
    expect(estimateTokens(s)).toBe(Math.max(ascii, cjk));
  });

  test("empty string → 0", () => {
    expect(estimateTokens("")).toBe(0);
  });
});
