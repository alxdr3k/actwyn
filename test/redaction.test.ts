import { describe, test, expect } from "bun:test";
import {
  createRedactor,
  shannonBitsPerChar,
  type Redactor,
} from "../src/observability/redact.ts";
import type { RedactionConfig } from "../src/config.ts";

const BASE_CONFIG: RedactionConfig = {
  email_pii_mode: true,
  phone_pii_mode: true,
  high_entropy_min_length: 32,
  high_entropy_min_bits_per_char: 4.0,
};

const SECRETS = {
  exact_values: [
    "1234567890:AAE-exactbottoken-value-xyz",
    "very-secret-s3-access-key-string",
  ],
};

function redactor(overrides: Partial<RedactionConfig> = {}): Redactor {
  return createRedactor({ ...BASE_CONFIG, ...overrides }, SECRETS);
}

// ---------------------------------------------------------------
// Pattern matrix
// ---------------------------------------------------------------

describe("redactor — exact-value secrets", () => {
  test("redacts the full Telegram bot token verbatim", () => {
    const r = redactor();
    const out = r.apply("token=1234567890:AAE-exactbottoken-value-xyz;ok");
    expect(out.text).toContain("[REDACTED:exact_secret]");
    expect(out.text).not.toContain("AAE-exactbottoken-value-xyz");
    expect(out.categories).toContain("exact_secret");
  });

  test("redacts multiple exact secrets in one string", () => {
    const r = redactor();
    const out = r.apply(
      "tg=1234567890:AAE-exactbottoken-value-xyz s3=very-secret-s3-access-key-string",
    );
    expect(out.text).not.toContain("AAE-exactbottoken-value-xyz");
    expect(out.text).not.toContain("very-secret-s3-access-key-string");
    expect(out.replacements).toBeGreaterThanOrEqual(2);
  });

  test("short (<4 chars) exact values are ignored (avoid false positives)", () => {
    const r = createRedactor(BASE_CONFIG, { exact_values: ["ab", "xyz"] });
    expect(r.apply("ab xyz safe").text).toBe("ab xyz safe");
  });
});

describe("redactor — auth headers and bearer tokens", () => {
  test("redacts Authorization: Bearer header", () => {
    const r = redactor();
    const out = r.apply("Authorization: Bearer eyJabc.def.ghi-long-token-here");
    expect(out.text).toMatch(/Authorization:\s*Bearer \[REDACTED:(auth_header|jwt)\]/);
    expect(out.text).not.toContain("eyJabc.def.ghi-long-token-here");
  });

  test("redacts bare Bearer prefix", () => {
    const r = redactor();
    const out = r.apply("sent Bearer abcdefg1234567890XYZ to api");
    expect(out.text).toContain("[REDACTED:bearer]");
    expect(out.text).not.toContain("abcdefg1234567890XYZ");
  });
});

describe("redactor — provider api keys", () => {
  test("redacts sk-... OpenAI-style keys", () => {
    const r = redactor();
    const out = r.apply("key=sk-abcdefghijklmnop12345678");
    expect(out.text).toContain("[REDACTED:");
    expect(out.text).not.toContain("sk-abcdefghijklmnop12345678");
  });

  test("redacts sk-ant-... Anthropic-style keys", () => {
    const r = redactor();
    const out = r.apply("sk-ant-api03-abcdef0123456789ABCDEF");
    expect(out.text).toContain("[REDACTED:");
    expect(out.text).not.toContain("sk-ant-api03-abcdef0123456789ABCDEF");
  });

  test("redacts Slack xoxb tokens", () => {
    const r = redactor();
    const out = r.apply("xoxb-1234-5678-abcdefghijk");
    expect(out.text).toContain("[REDACTED:");
    expect(out.text).not.toContain("xoxb-1234-5678-abcdefghijk");
  });

  test("redacts Google API keys (AIza...)", () => {
    const r = redactor();
    const out = r.apply("AIzaSyA1234567890abcdefghij_XYZ");
    expect(out.text).toContain("[REDACTED:");
    expect(out.text).not.toContain("AIzaSyA1234567890abcdefghij_XYZ");
  });
});

describe("redactor — AWS key ids", () => {
  test("redacts AKIA-prefixed access key ids", () => {
    const r = redactor();
    const out = r.apply("AKIAIOSFODNN7EXAMPLE seen");
    expect(out.text).toContain("[REDACTED:aws_key_id]");
    expect(out.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  test("redacts ASIA-prefixed temporary access key ids", () => {
    const r = redactor();
    const out = r.apply("ASIAY34FZKBOKMUTVV7A");
    expect(out.text).toContain("[REDACTED:aws_key_id]");
  });
});

describe("redactor — PEM private key block", () => {
  test("redacts multi-line PEM block as a single unit", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEpAIBAAKCAQEA1234567890...",
      "abcdefghijklmnopqrstuvwxyz",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const r = redactor();
    const out = r.apply(`before\n${pem}\nafter`);
    expect(out.text).toContain("[REDACTED:pem_block]");
    expect(out.text).not.toContain("MIIEpAIBAAKCAQEA");
    expect(out.text).not.toContain("BEGIN RSA PRIVATE KEY");
  });
});

describe("redactor — JWT", () => {
  test("redacts 3-part base64url JWTs", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const r = redactor();
    const out = r.apply(`token=${jwt}`);
    expect(out.text).toContain("[REDACTED:");
    expect(out.text).not.toContain(jwt);
  });
});

describe("redactor — emails and phones (PII modes)", () => {
  test("redacts emails when email_pii_mode is on", () => {
    const r = redactor();
    const out = r.apply("contact: foo.bar+baz@example.com please");
    expect(out.text).toContain("[REDACTED:email]");
    expect(out.text).not.toContain("foo.bar+baz@example.com");
  });

  test("leaves emails untouched when email_pii_mode is off", () => {
    const r = redactor({ email_pii_mode: false });
    expect(r.apply("foo@example.com").text).toBe("foo@example.com");
  });

  test("redacts phone numbers when phone_pii_mode is on", () => {
    const r = redactor();
    const out = r.apply("call +1 415-555-1212 now");
    expect(out.text).toContain("[REDACTED:phone]");
    expect(out.text).not.toContain("415-555-1212");
  });

  test("leaves phones untouched when phone_pii_mode is off", () => {
    const r = redactor({ phone_pii_mode: false });
    expect(r.apply("call +1 415-555-1212").text).toContain("415-555-1212");
  });
});

describe("redactor — high-entropy sweep", () => {
  test("redacts long high-entropy random strings", () => {
    const r = redactor();
    // 48 random-looking base64 chars — above length + entropy thresholds.
    const tok = "X7z9Q2abKdLmNp8vWrTyUx3B4e5G6hJ0iO1lPmQnRsTu";
    const out = r.apply(`token=${tok}`);
    expect(out.text).toContain("[REDACTED:high_entropy]");
    expect(out.text).not.toContain(tok);
  });

  test("leaves low-entropy long strings alone", () => {
    const r = redactor();
    const lowEntropy = "a".repeat(64);
    expect(r.apply(lowEntropy).text).toBe(lowEntropy);
  });

  test("leaves short tokens alone even if random-looking", () => {
    const r = redactor();
    expect(r.apply("abc12").text).toBe("abc12");
  });

  test("shannonBitsPerChar: uniform distribution → high entropy", () => {
    // 16 distinct chars, uniform → 4 bits/char.
    const s = "abcdefghijklmnop";
    expect(shannonBitsPerChar(s)).toBeCloseTo(4, 5);
  });

  test("shannonBitsPerChar: empty → 0", () => {
    expect(shannonBitsPerChar("")).toBe(0);
  });
});

// ---------------------------------------------------------------
// Negative cases (no false positives on normal text)
// ---------------------------------------------------------------

describe("redactor — negative cases (normal prose untouched)", () => {
  const prose = [
    "오늘 점심 뭐 먹을까",
    "the quick brown fox jumps over the lazy dog",
    "id: job_12345",
    "count=3 status=queued",
    "short message",
    "",
  ];

  for (const s of prose) {
    test(`prose does not change: ${JSON.stringify(s).slice(0, 40)}`, () => {
      const r = redactor();
      expect(r.apply(s).text).toBe(s);
      expect(r.detect(s).matched).toBe(false);
    });
  }
});

// ---------------------------------------------------------------
// applyToJson
// ---------------------------------------------------------------

describe("redactor — applyToJson", () => {
  test("walks nested objects and arrays without changing keys", () => {
    const r = redactor();
    const input = {
      job_id: "job_42",
      update_id: 99,
      telegram_update: {
        message: {
          text: "tg token 1234567890:AAE-exactbottoken-value-xyz leaked",
          from: { username: "alice", email: "alice@example.com" },
        },
      },
      tags: ["Bearer eyJabc.def.ghi-long-token-here", "plain"],
      nested_null: null,
      ratio: 0.42,
    };
    const out = r.applyToJson(input) as typeof input;
    expect(Object.keys(out)).toEqual(Object.keys(input));
    expect(out.job_id).toBe("job_42");
    expect(out.update_id).toBe(99);
    expect(out.ratio).toBe(0.42);
    expect(out.nested_null).toBeNull();
    expect(out.telegram_update.message.text).not.toContain("AAE-exactbottoken");
    expect(out.telegram_update.message.from.email).toBe("[REDACTED:email]");
    expect(out.tags[0]).toContain("[REDACTED:");
    expect(out.tags[1]).toBe("plain");
  });

  test("does not mutate the input object", () => {
    const r = redactor();
    const input = { text: "Bearer eyJabc.def.ghi-long-token-here" };
    const snapshot = JSON.stringify(input);
    r.applyToJson(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------
// detect()
// ---------------------------------------------------------------

describe("redactor — detect()", () => {
  test("reports matched=true with categories for a secret", () => {
    const r = redactor();
    const res = r.detect("Authorization: Bearer eyJabc.def.ghijklmnop");
    expect(res.matched).toBe(true);
    expect(res.categories.length).toBeGreaterThan(0);
  });

  test("reports matched=false for clean input", () => {
    const r = redactor();
    const res = r.detect("just a message about lunch");
    expect(res.matched).toBe(false);
    expect(res.categories).toEqual([]);
  });
});

// ---------------------------------------------------------------
// Property test: "no raw payload leaks" for any registered secret.
//
// Build random strings that embed one or more registered secrets at
// arbitrary positions; the redacted output MUST NOT contain any of
// the raw secret substrings.
// ---------------------------------------------------------------

describe("redactor — property: no registered secret survives", () => {
  const candidates = [
    ...SECRETS.exact_values,
    "AKIAIOSFODNN7EXAMPLE",
    "sk-abcdefghijklmnop12345678",
    "AIzaSyA1234567890abcdefghij_XYZ",
    "xoxb-1234-5678-abcdefghijk",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  ];

  const FILLERS = [
    "",
    " ",
    "\n",
    " prefix ",
    " suffix ",
    "JSON: {\"k\":\"",
    "\"}",
    "HTTP/1.1 200 OK\nHeader: ",
    "lines\nmore lines\n",
    "log event=telegram.inbound ",
  ];

  // Deterministic pseudo-random sequence so the property test does
  // not become flaky across Bun versions.
  function mulberry32(seed: number): () => number {
    let t = seed;
    return () => {
      t = (t + 0x6d2b79f5) | 0;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  test("100 random embeddings produce no raw secret substring", () => {
    const r = redactor();
    const rnd = mulberry32(0xACC7);
    const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]!;

    for (let i = 0; i < 100; i++) {
      const parts: string[] = [];
      const nSecrets = 1 + Math.floor(rnd() * 3);
      for (let j = 0; j < nSecrets; j++) {
        parts.push(pick(FILLERS));
        parts.push(pick(candidates));
      }
      parts.push(pick(FILLERS));
      const payload = parts.join("");
      const redacted = r.apply(payload).text;
      for (const secret of candidates) {
        if (payload.includes(secret)) {
          expect(redacted).not.toContain(secret);
        }
      }
    }
  });
});

// ---------------------------------------------------------------
// Idempotence
// ---------------------------------------------------------------

describe("redactor — idempotence", () => {
  test("applying twice is the same as applying once", () => {
    const r = redactor();
    const payload =
      "Bearer abcdef1234567890ABC Authorization: Bearer eyJabc.def.ghi-long-token";
    const once = r.apply(payload).text;
    const twice = r.apply(once).text;
    expect(twice).toBe(once);
  });
});
