// Personal Agent P0 — token estimator.
//
// PRD §12.6 + DEC-021. Char-based conservative estimate; always
// over-estimate to avoid context overflow.
//
//   ASCII-heavy:       ceil(char_count / 3)
//   Korean/CJK-heavy:  ceil(char_count / 1.5)  [default]
//   Mixed:             max(ASCII estimate, CJK estimate)
//
// A text is "CJK-heavy" when more than half its non-whitespace
// characters are in one of the common CJK unicode ranges.
// Intentionally approximate — the estimator's job is to be
// pessimistic, not to classify languages precisely.

const CJK_RANGES: readonly (readonly [number, number])[] = [
  [0x3040, 0x30ff], // Hiragana + Katakana
  [0x3400, 0x4dbf], // CJK Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xac00, 0xd7af], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
];

export function isCjkChar(codePoint: number): boolean {
  for (const [lo, hi] of CJK_RANGES) {
    if (codePoint >= lo && codePoint <= hi) return true;
  }
  return false;
}

export function cjkCharRatio(s: string): number {
  if (s.length === 0) return 0;
  let cjk = 0;
  let total = 0;
  for (const ch of s) {
    if (/\s/.test(ch)) continue;
    total += 1;
    const cp = ch.codePointAt(0) ?? 0;
    if (isCjkChar(cp)) cjk += 1;
  }
  if (total === 0) return 0;
  return cjk / total;
}

export function estimateTokens(s: string): number {
  if (s.length === 0) return 0;
  const asciiEst = Math.ceil(s.length / 3);
  const cjkEst = Math.ceil(s.length / 1.5);
  const ratio = cjkCharRatio(s);
  if (ratio >= 0.5) return cjkEst;
  if (ratio > 0) return Math.max(asciiEst, cjkEst);
  return asciiEst;
}
