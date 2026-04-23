import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, ConfigError } from "../src/config.ts";

const GOOD_RUNTIME = {
  required_bun_version: "1.3.11",
  log: { level: "info" },
  redaction: {
    email_pii_mode: true,
    phone_pii_mode: false,
    high_entropy_min_length: 32,
    high_entropy_min_bits_per_char: 4.0,
  },
};

const BASE_ENV = {
  TELEGRAM_BOT_TOKEN: "1234:abcdef",
  AUTHORIZED_TELEGRAM_USER_ID: "1000001",
  S3_ENDPOINT: "https://s3.example",
  S3_BUCKET: "actwyn-test",
  S3_REGION: "eu-central-1",
  S3_ACCESS_KEY_ID: "AKIAEXAMPLE",
  S3_SECRET_ACCESS_KEY: "secretsecret",
  NODE_ENV: "test",
};

let workdir: string;
let runtimePath: string;

beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), "actwyn-cfg-"));
  runtimePath = join(workdir, "runtime.json");
  writeFileSync(runtimePath, JSON.stringify(GOOD_RUNTIME));
});

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function envWith(overrides: Record<string, string | undefined>): Record<string, string | undefined> {
  return { ...BASE_ENV, ACTWYN_CONFIG_PATH: runtimePath, ...overrides };
}

describe("loadConfig — happy path", () => {
  test("returns a frozen, fully-populated config", () => {
    const cfg = loadConfig(envWith({}));
    expect(cfg.telegram.bot_token).toBe("1234:abcdef");
    expect(cfg.telegram.authorized_user_id).toBe(1000001);
    expect(cfg.s3.bucket).toBe("actwyn-test");
    expect(cfg.runtime.required_bun_version).toBe("1.3.11");
    expect(cfg.runtime.log.level).toBe("info");
    expect(cfg.env).toBe("test");
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.isFrozen(cfg.telegram)).toBe(true);
    expect(Object.isFrozen(cfg.runtime.redaction)).toBe(true);
  });

  test("trims whitespace around env values", () => {
    const cfg = loadConfig(envWith({ TELEGRAM_BOT_TOKEN: "  tkn  " }));
    expect(cfg.telegram.bot_token).toBe("tkn");
  });
});

describe("loadConfig — missing-field failures", () => {
  for (const key of [
    "TELEGRAM_BOT_TOKEN",
    "AUTHORIZED_TELEGRAM_USER_ID",
    "S3_ENDPOINT",
    "S3_BUCKET",
    "S3_REGION",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
  ] as const) {
    test(`throws ConfigError listing ${key} when absent`, () => {
      expect(() => loadConfig(envWith({ [key]: undefined }))).toThrow(ConfigError);
      try {
        loadConfig(envWith({ [key]: undefined }));
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        expect((e as ConfigError).missing).toContain(key);
      }
    });

    test(`throws ConfigError when ${key} is blank whitespace`, () => {
      expect(() => loadConfig(envWith({ [key]: "   " }))).toThrow(ConfigError);
    });
  }

  test("all missing at once are reported in one error", () => {
    const blanks: Record<string, undefined> = {
      TELEGRAM_BOT_TOKEN: undefined,
      AUTHORIZED_TELEGRAM_USER_ID: undefined,
      S3_ENDPOINT: undefined,
      S3_BUCKET: undefined,
      S3_REGION: undefined,
      S3_ACCESS_KEY_ID: undefined,
      S3_SECRET_ACCESS_KEY: undefined,
    };
    try {
      loadConfig(envWith(blanks));
      throw new Error("expected loadConfig to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).missing.length).toBe(7);
    }
  });
});

describe("loadConfig — AUTHORIZED_TELEGRAM_USER_ID validation", () => {
  test("rejects non-numeric", () => {
    expect(() => loadConfig(envWith({ AUTHORIZED_TELEGRAM_USER_ID: "not-a-number" }))).toThrow(
      ConfigError,
    );
  });
  test("rejects zero", () => {
    expect(() => loadConfig(envWith({ AUTHORIZED_TELEGRAM_USER_ID: "0" }))).toThrow(ConfigError);
  });
  test("rejects negative", () => {
    expect(() => loadConfig(envWith({ AUTHORIZED_TELEGRAM_USER_ID: "-1" }))).toThrow(ConfigError);
  });
  test("rejects floating point", () => {
    expect(() => loadConfig(envWith({ AUTHORIZED_TELEGRAM_USER_ID: "1.5" }))).toThrow(ConfigError);
  });
});

describe("loadConfig — runtime file validation", () => {
  test("missing file throws with path in message", () => {
    expect(() =>
      loadConfig(envWith({ ACTWYN_CONFIG_PATH: join(workdir, "nope.json") })),
    ).toThrow(/runtime config file not found/);
  });

  test("invalid JSON throws ConfigError", () => {
    const bad = join(workdir, "bad.json");
    writeFileSync(bad, "{not json");
    expect(() => loadConfig(envWith({ ACTWYN_CONFIG_PATH: bad }))).toThrow(ConfigError);
  });

  test("rejects missing required_bun_version", () => {
    const bad = join(workdir, "no-bun.json");
    const { required_bun_version: _ignore, ...rest } = GOOD_RUNTIME;
    writeFileSync(bad, JSON.stringify(rest));
    expect(() => loadConfig(envWith({ ACTWYN_CONFIG_PATH: bad }))).toThrow(
      /required_bun_version/,
    );
  });

  test("rejects invalid log.level", () => {
    const bad = join(workdir, "bad-log.json");
    writeFileSync(bad, JSON.stringify({ ...GOOD_RUNTIME, log: { level: "verbose" } }));
    expect(() => loadConfig(envWith({ ACTWYN_CONFIG_PATH: bad }))).toThrow(/log.level/);
  });

  test("rejects non-positive high_entropy_min_length", () => {
    const bad = join(workdir, "bad-entropy.json");
    writeFileSync(
      bad,
      JSON.stringify({
        ...GOOD_RUNTIME,
        redaction: { ...GOOD_RUNTIME.redaction, high_entropy_min_length: 0 },
      }),
    );
    expect(() => loadConfig(envWith({ ACTWYN_CONFIG_PATH: bad }))).toThrow(
      /high_entropy_min_length/,
    );
  });
});

describe("loadConfig — NODE_ENV validation", () => {
  test("rejects unknown NODE_ENV", () => {
    expect(() => loadConfig(envWith({ NODE_ENV: "staging" }))).toThrow(/NODE_ENV/);
  });
});
