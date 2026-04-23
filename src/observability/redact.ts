// Personal Agent P0 — single redaction module.
//
// This is the ONLY module allowed to apply redaction. Every other
// component (telegram/poller, providers/claude, queue/worker,
// storage/sync, commands/*) MUST route payloads through
// `redact.apply` before persistence. The "single-redactor"
// invariant is enforced by a CI grep check
// (`scripts/check-single-redactor.ts`) referenced from HLD §13.1
// ("The redactor is a single module; multiple call sites share the
// same patterns. No inline ad-hoc redaction.").
//
// Spec references:
//   - HLD §13.1–13.2 (boundary + starting patterns)
//   - PRD §15 P0 redaction pattern list (DEC-010)
//   - AC-SEC-001 (redacted-at-rest), AC-SEC-005 (entropy)
//
// Design notes:
//   - Exposes BOTH `apply` (replace with placeholder) and `detect`
//     (boolean + category list) so the attachment policy
//     (PRD §12.8.3) can refuse promotion without mutating content.
//   - Exact-value secrets (`TELEGRAM_BOT_TOKEN`, S3 keys, env vars
//     ending TOKEN/SECRET/KEY/PASSWORD) are registered at boot via
//     `createRedactor(config, secrets)` so they are redacted even
//     when they do not match a pattern.
//   - Structural redaction (`applyToJson`) walks values — it NEVER
//     rewrites object keys, so stable ids (`job_id`, update_id)
//     survive.

import type { RedactionConfig } from "~/config.ts";

export type RedactionCategory =
  | "exact_secret"
  | "bearer"
  | "auth_header"
  | "provider_api_key"
  | "aws_key_id"
  | "pem_block"
  | "jwt"
  | "email"
  | "phone"
  | "high_entropy";

export interface RedactResult {
  readonly text: string;
  readonly categories: readonly RedactionCategory[];
  readonly replacements: number;
}

export interface DetectResult {
  readonly matched: boolean;
  readonly categories: readonly RedactionCategory[];
}

export interface Redactor {
  apply(input: string): RedactResult;
  detect(input: string): DetectResult;
  applyToJson<T>(value: T): T;
}

// ---------------------------------------------------------------
// Pattern table. Order matters: PEM blocks and JWTs must be tried
// before generic high-entropy so we categorize them correctly.
// ---------------------------------------------------------------

interface PatternRule {
  readonly category: RedactionCategory;
  readonly regex: RegExp;
  readonly placeholder: string;
}

const STATIC_PATTERNS: readonly PatternRule[] = [
  // Authorization: Bearer xxxxx | Token xxxxx | Basic xxxxx
  {
    category: "auth_header",
    regex: /\b(Authorization:\s*)(Bearer|Token|Basic)\s+[A-Za-z0-9._\-+/=]+/gi,
    placeholder: "$1$2[REDACTED:auth_header]",
  },
  {
    category: "bearer",
    regex: /\bBearer\s+[A-Za-z0-9._\-+/=]{8,}/g,
    placeholder: "Bearer [REDACTED:bearer]",
  },
  // PEM blocks (multi-line).
  {
    category: "pem_block",
    regex: /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
    placeholder: "[REDACTED:pem_block]",
  },
  // JWTs: 3 base64url segments separated by dots, first starts with eyJ.
  {
    category: "jwt",
    regex: /\beyJ[A-Za-z0-9_\-]{5,}\.[A-Za-z0-9_\-]{5,}\.[A-Za-z0-9_\-]{5,}\b/g,
    placeholder: "[REDACTED:jwt]",
  },
  // Provider API keys: sk-..., xoxb-..., anthropic sk-ant-, google AIza.
  {
    category: "provider_api_key",
    regex: /\b(?:sk-ant-[A-Za-z0-9_\-]{16,}|sk-[A-Za-z0-9]{16,}|xox[aboprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_\-]{20,})\b/g,
    placeholder: "[REDACTED:provider_api_key]",
  },
  // AWS-style access key ids: AKIA/ASIA + exactly 16 upper-alphanum.
  // We intentionally omit a trailing boundary: AWS keys have a
  // fixed 20-char format, so matching the first 20 chars is safe
  // even when the raw text has more alphanum characters glued on
  // afterwards (property-test corner case).
  {
    category: "aws_key_id",
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}/g,
    placeholder: "[REDACTED:aws_key_id]",
  },
];

// Emails (RFC 5322-ish pragmatic form).
const EMAIL_RE = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g;

// Phone numbers (deliberately conservative: international-ish
// sequences with 8+ digits).
const PHONE_RE = /(?<!\d)\+?\d[\d \-]{7,}\d(?!\d)/g;

// ---------------------------------------------------------------
// Shannon entropy for a string (bits per character). Used to flag
// high-entropy tokens above a configured threshold.
// ---------------------------------------------------------------

export function shannonBitsPerChar(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

// ---------------------------------------------------------------
// Factory.
// ---------------------------------------------------------------

export interface SecretsToRedact {
  readonly exact_values: readonly string[];
}

export function createRedactor(
  config: RedactionConfig,
  secrets: SecretsToRedact = { exact_values: [] },
): Redactor {
  const exactValues = secrets.exact_values
    .filter((v) => v && v.length >= 4)
    .sort((a, b) => b.length - a.length);

  const exactRegex =
    exactValues.length === 0
      ? null
      : new RegExp(exactValues.map(escapeRegex).join("|"), "g");

  function redactPass(input: string): RedactResult {
    const hits = new Set<RedactionCategory>();
    let text = input;
    let total = 0;

    if (exactRegex) {
      const before = text;
      text = text.replace(exactRegex, () => {
        total += 1;
        return "[REDACTED:exact_secret]";
      });
      if (text !== before) hits.add("exact_secret");
    }

    for (const rule of STATIC_PATTERNS) {
      const before = text;
      text = text.replace(rule.regex, (...m) => {
        total += 1;
        // For patterns with capture groups, replace supports $n backrefs.
        // String.replace with a function can't use $-syntax, so inline.
        if (rule.category === "auth_header") {
          const prefix = m[1] as string;
          const scheme = m[2] as string;
          return `${prefix}${scheme} [REDACTED:auth_header]`;
        }
        return rule.placeholder;
      });
      if (text !== before) hits.add(rule.category);
    }

    if (config.email_pii_mode) {
      const before = text;
      text = text.replace(EMAIL_RE, () => {
        total += 1;
        return "[REDACTED:email]";
      });
      if (text !== before) hits.add("email");
    }

    if (config.phone_pii_mode) {
      const before = text;
      text = text.replace(PHONE_RE, (match) => {
        const digits = match.replace(/\D/g, "");
        if (digits.length < 8) return match;
        total += 1;
        return "[REDACTED:phone]";
      });
      if (text !== before) hits.add("phone");
    }

    // High-entropy sweep (last pass — runs over tokens that
    // survived earlier rules).
    const entropyRe = /[A-Za-z0-9._\-+/=]{16,}/g;
    text = text.replace(entropyRe, (tok) => {
      if (tok.length < config.high_entropy_min_length) return tok;
      const bits = shannonBitsPerChar(tok);
      if (bits < config.high_entropy_min_bits_per_char) return tok;
      total += 1;
      hits.add("high_entropy");
      return "[REDACTED:high_entropy]";
    });

    return {
      text,
      categories: Array.from(hits),
      replacements: total,
    };
  }

  return {
    apply(input: string): RedactResult {
      return redactPass(input);
    },
    detect(input: string): DetectResult {
      const r = redactPass(input);
      return { matched: r.categories.length > 0, categories: r.categories };
    },
    applyToJson<T>(value: T): T {
      return walk(value, (s) => redactPass(s).text) as T;
    },
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function walk(v: unknown, onString: (s: string) => string): unknown {
  if (typeof v === "string") return onString(v);
  if (Array.isArray(v)) return v.map((x) => walk(x, onString));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      // Keys are NOT redacted; only values.
      out[k] = walk(val, onString);
    }
    return out;
  }
  return v;
}
