// End-to-end adapter test. Uses a tiny bash stub that mimics
// Claude's stream-json output. Requires /bin/sh (POSIX).
import { describe, test, expect } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRedactor } from "../../src/observability/redact.ts";
import { createClaudeAdapter } from "../../src/providers/claude.ts";
import type { AgentRequest } from "../../src/providers/types.ts";

const IS_POSIX = process.platform !== "win32";

function redactor() {
  return createRedactor(
    {
      email_pii_mode: false,
      phone_pii_mode: false,
      high_entropy_min_length: 32,
      high_entropy_min_bits_per_char: 4.0,
    },
    { exact_values: [] },
  );
}

function makeStub(workdir: string, script: string): string {
  const path = join(workdir, "fake-claude.sh");
  writeFileSync(path, `#!/bin/sh\n${script}`, { encoding: "utf8" });
  chmodSync(path, 0o755);
  return path;
}

function req(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    provider: "claude",
    message: "hello",
    session_id: "sess-1",
    user_id: "user-1",
    channel: "telegram:chat-1",
    chat_id: "chat-1",
    ...overrides,
  };
}

describe.skipIf(!IS_POSIX)("claude adapter — end-to-end via stream-json stub", () => {
  test("stream of text + end → succeeded with final_text + parser_status='parsed'", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "actwyn-claude-"));
    try {
      const stub = makeStub(
        workdir,
        `cat <<'EOF'
{"event":"meta","provider_session_id":"pvs-1"}
{"event":"text","text":"Hi "}
{"event":"text","text":"there"}
{"event":"end"}
EOF
exit 0
`,
      );
      const adapter = createClaudeAdapter({
        binary: stub,
        redactor: redactor(),
        cwd: workdir,
      });
      const outcome = await adapter.run(req());
      expect(outcome.kind).toBe("succeeded");
      if (outcome.kind === "succeeded") {
        expect(outcome.response.final_text).toBe("Hi there");
        expect(outcome.response.parser_status).toBe("parsed");
        expect(outcome.response.session_id).toBe("pvs-1");
        expect(outcome.response.exit_code).toBe(0);
      }
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  test("truncated stream (no end event) → fallback_used with final_text", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "actwyn-claude-"));
    try {
      const stub = makeStub(
        workdir,
        `cat <<'EOF'
{"event":"text","text":"partial answer"}
EOF
exit 0
`,
      );
      const adapter = createClaudeAdapter({
        binary: stub,
        redactor: redactor(),
        cwd: workdir,
      });
      const outcome = await adapter.run(req());
      expect(outcome.kind).toBe("succeeded");
      if (outcome.kind === "succeeded") {
        expect(outcome.response.parser_status).toBe("fallback_used");
        expect(outcome.response.final_text).toBe("partial answer");
      }
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  test("non-zero exit with no final text → failed with error_type=non_zero_exit", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "actwyn-claude-"));
    try {
      const stub = makeStub(workdir, `echo >&2 'permission error'\nexit 2\n`);
      const adapter = createClaudeAdapter({
        binary: stub,
        redactor: redactor(),
        cwd: workdir,
      });
      const outcome = await adapter.run(req());
      expect(outcome.kind).toBe("failed");
      if (outcome.kind === "failed") {
        expect(outcome.response.exit_code).toBe(2);
        expect(outcome.error_type).toBe("non_zero_exit");
      }
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  test("cancel signal while child is running → cancelled + cancelled_after_start observed", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "actwyn-claude-"));
    try {
      const stub = makeStub(
        workdir,
        `printf '{"event":"text","text":"begin..."}\\n'
sleep 30
printf '{"event":"end"}\\n'
`,
      );
      const adapter = createClaudeAdapter({
        binary: stub,
        redactor: redactor(),
        cwd: workdir,
        grace_ms: 200,
        hard_kill_ms: 500,
      });
      const controller = new AbortController();
      const promise = adapter.run(req(), controller.signal);
      // Let it emit the first line, then abort.
      setTimeout(() => controller.abort(), 120);
      const outcome = await promise;
      expect(outcome.kind).toBe("cancelled");
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  test("adapter rejects forbidden flag via extra_argv", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "actwyn-claude-"));
    try {
      const stub = makeStub(workdir, "exit 0\n");
      const adapter = createClaudeAdapter({
        binary: stub,
        redactor: redactor(),
        cwd: workdir,
        extra_argv: ["--dangerously-skip-permissions"],
      });
      const outcome = await adapter.run(req());
      expect(outcome.kind).toBe("failed");
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!IS_POSIX)("claude adapter — resume_mode argv (HLD §10.2)", () => {
  test("resume_mode passes --resume <provider_session_id> instead of --session-id", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "actwyn-claude-"));
    try {
      // Stub echoes its argv as JSON so we can inspect which flags were passed.
      const stub = makeStub(
        workdir,
        `printf '{"event":"text","text":"%s"}\\n' "$*"
printf '{"event":"end"}\\n'
exit 0
`,
      );
      const adapter = createClaudeAdapter({
        binary: stub,
        redactor: redactor(),
        cwd: workdir,
      });
      const outcome = await adapter.run(req({
        context_packing_mode: "resume_mode",
        provider_session_id: "pvs-abc",
      }));
      expect(outcome.kind).toBe("succeeded");
      if (outcome.kind === "succeeded") {
        expect(outcome.response.final_text).toContain("--resume");
        expect(outcome.response.final_text).toContain("pvs-abc");
        expect(outcome.response.final_text).not.toContain("--session-id");
      }
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  test("replay_mode passes --session-id (default when no provider_session_id)", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "actwyn-claude-"));
    try {
      const stub = makeStub(
        workdir,
        `printf '{"event":"text","text":"%s"}\\n' "$*"
printf '{"event":"end"}\\n'
exit 0
`,
      );
      const adapter = createClaudeAdapter({
        binary: stub,
        redactor: redactor(),
        cwd: workdir,
      });
      const outcome = await adapter.run(req({ context_packing_mode: "replay_mode" }));
      expect(outcome.kind).toBe("succeeded");
      if (outcome.kind === "succeeded") {
        expect(outcome.response.final_text).toContain("--session-id");
        expect(outcome.response.final_text).not.toContain("--resume");
      }
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  test("onSpawn callback receives the process_group_id", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "actwyn-claude-"));
    try {
      const stub = makeStub(workdir, `printf '{"event":"end"}\\n'\nexit 0\n`);
      const adapter = createClaudeAdapter({
        binary: stub,
        redactor: redactor(),
        cwd: workdir,
      });
      let spawnedPgid: number | null = null;
      await adapter.run(req(), undefined, (pgid, _pid) => { spawnedPgid = pgid; });
      expect(spawnedPgid).toBeGreaterThan(0);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!IS_POSIX)("claude adapter — timeout (HLD §14.2)", () => {
  test("max_runtime_ms exceeded → failed with error_type=timeout", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "actwyn-claude-"));
    try {
      const stub = makeStub(workdir, `sleep 10\nprintf '{"event":"end"}\\n'\nexit 0\n`);
      const adapter = createClaudeAdapter({
        binary: stub,
        redactor: redactor(),
        cwd: workdir,
        max_runtime_ms: 150,
        grace_ms: 100,
        hard_kill_ms: 200,
      });
      const outcome = await adapter.run(req());
      expect(outcome.kind).toBe("failed");
      if (outcome.kind === "failed") {
        expect(outcome.error_type).toBe("timeout");
      }
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  test("stall_timeout_ms exceeded (no output) → failed with error_type=stall_timeout", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "actwyn-claude-"));
    try {
      // Stub writes one line then stalls for 10s before finishing.
      const stub = makeStub(
        workdir,
        `printf '{"event":"text","text":"partial"}\\n'
sleep 10
printf '{"event":"end"}\\n'
exit 0
`,
      );
      const adapter = createClaudeAdapter({
        binary: stub,
        redactor: redactor(),
        cwd: workdir,
        stall_timeout_ms: 200,
        grace_ms: 100,
        hard_kill_ms: 200,
      });
      const outcome = await adapter.run(req());
      expect(outcome.kind).toBe("failed");
      if (outcome.kind === "failed") {
        expect(outcome.error_type).toBe("stall_timeout");
      }
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!IS_POSIX)("claude adapter — redaction", () => {
  test("stream line containing a bearer token is redacted in raw_events", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "actwyn-claude-"));
    try {
      const stub = makeStub(
        workdir,
        `cat <<'EOF'
{"event":"text","text":"leak Bearer abcdef1234567890ABC next"}
{"event":"end"}
EOF
exit 0
`,
      );
      const adapter = createClaudeAdapter({
        binary: stub,
        redactor: redactor(),
        cwd: workdir,
      });
      const outcome = await adapter.run(req());
      expect(outcome.kind).toBe("succeeded");
      if (outcome.kind === "succeeded") {
        for (const e of outcome.response.raw_events) {
          expect(e.payload).not.toContain("abcdef1234567890ABC");
        }
        // The final_text, however, comes from the *redacted* line,
        // so it also cannot contain the raw token.
        expect(outcome.response.final_text).not.toContain("abcdef1234567890ABC");
      }
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
