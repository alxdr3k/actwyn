import { describe, test, expect } from "bun:test";
import { spawnDetached, SubprocessError } from "../../src/providers/subprocess.ts";

// Skip on non-POSIX (Windows has no pgid).
const IS_POSIX = process.platform !== "win32";

describe.skipIf(!IS_POSIX)("spawnDetached — happy path", () => {
  test("emits stdout and exits 0", async () => {
    const child = spawnDetached({
      argv: ["/bin/sh", "-c", "echo hello; echo world"],
      cwd: "/tmp",
    });
    const decoder = new TextDecoder();
    const reader = child.stdout!.getReader();
    let out = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) out += decoder.decode(value);
    }
    const code = await child.exited;
    expect(code).toBe(0);
    expect(out).toContain("hello");
    expect(out).toContain("world");
  });
});

describe.skipIf(!IS_POSIX)("spawnDetached — teardown", () => {
  test("SIGTERM during long sleep reaches process group (subprocess exits < grace)", async () => {
    const child = spawnDetached({
      argv: ["/bin/sh", "-c", "sleep 30"],
      cwd: "/tmp",
      grace_ms: 500,
      hard_kill_ms: 500,
    });
    // Let the subprocess get going.
    await new Promise((r) => setTimeout(r, 50));
    await child.teardown(new AbortController().signal);
    const code = await child.exited;
    expect(code).not.toBe(0);
  });

  test("process that traps SIGTERM is SIGKILLed after grace", async () => {
    const child = spawnDetached({
      argv: ["/bin/sh", "-c", "trap '' TERM; sleep 30"],
      cwd: "/tmp",
      grace_ms: 100,
      hard_kill_ms: 500,
    });
    await new Promise((r) => setTimeout(r, 50));
    await child.teardown(new AbortController().signal);
    const code = await child.exited;
    expect(code).not.toBe(0);
  });

  test("cancelled_after_start() reflects whether the child produced output", async () => {
    const child = spawnDetached({
      argv: ["/bin/sh", "-c", "echo started; sleep 30"],
      cwd: "/tmp",
      grace_ms: 200,
      hard_kill_ms: 300,
    });
    // Drain stdout so producedAnyOutput flips.
    const reader = child.stdout!.getReader();
    const { value } = await reader.read();
    expect(value).toBeDefined();
    reader.releaseLock();
    await child.teardown(new AbortController().signal);
    await child.exited;
    expect(child.cancelled_after_start()).toBe(true);
  });

});

describe("spawnDetached — argv validation", () => {
  test("empty argv throws SubprocessError", () => {
    expect(() => spawnDetached({ argv: [], cwd: "/tmp" })).toThrow(SubprocessError);
  });
});
