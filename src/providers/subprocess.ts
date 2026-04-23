// Personal Agent P0 — subprocess lifecycle.
//
// Spec references:
//   - HLD §14 (spawn/run/teardown) — the single most dangerous
//     piece of the runtime.
//   - PRD §15 Appendix E (forbidden flags) — argv must be
//     literal; shell-style interpolation is banned elsewhere.
//
// Responsibilities:
//   - Spawn the subprocess with argv-only, detached=true so it
//     lives in its own process group (PGID = leader PID).
//   - Stream stdout/stderr to the caller via ReadableStreams.
//   - Support cooperative cancellation via AbortSignal:
//       SIGTERM to PGID → grace → SIGKILL to PGID → hard fail.
//   - Surface `cancelled_after_start` when the subprocess had
//     already started producing output before the kill.

import { spawn, type Subprocess } from "bun";

export interface SpawnArgs {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Duration between SIGTERM and SIGKILL escalation. */
  readonly grace_ms?: number;
  /** Hard deadline after SIGKILL before we give up waiting. */
  readonly hard_kill_ms?: number;
}

export interface RunningSubprocess {
  readonly pid: number;
  readonly process_group_id: number;
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly exited: Promise<number>;
  readonly cancelled_after_start: () => boolean;
  teardown(signal: AbortSignal): Promise<void>;
}

export class SubprocessError extends Error {
  constructor(message: string, public readonly phase: "spawn" | "teardown" | "exit") {
    super(message);
    this.name = "SubprocessError";
  }
}

/**
 * Spawn the subprocess. Caller MUST await either exit naturally or
 * call teardown() before abandoning the handle, to avoid orphans.
 */
export function spawnDetached(args: SpawnArgs): RunningSubprocess {
  if (args.argv.length === 0) {
    throw new SubprocessError("argv must not be empty", "spawn");
  }
  const gracemMs = args.grace_ms ?? 2000;
  const hardMs = args.hard_kill_ms ?? 2000;

  let proc: Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = spawn([...args.argv], {
      cwd: args.cwd,
      env: { ...(args.env ?? {}) },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      // Bun sets setsid() when detached so the child is a process
      // group leader (PGID = pid). POSIX only.
      ...(process.platform !== "win32" ? { detached: true } : {}),
    }) as Subprocess<"ignore", "pipe", "pipe">;
  } catch (e) {
    throw new SubprocessError(`spawn failed: ${(e as Error).message}`, "spawn");
  }

  const pid = proc.pid;
  // On POSIX with detached:true, PGID == leader PID. On non-POSIX
  // (Windows), there is no pgid concept; we fall back to pid.
  const pgid = pid;

  let producedAnyOutput = false;
  const wrappedStdout = wrapStream(proc.stdout, () => { producedAnyOutput = true; });
  const wrappedStderr = wrapStream(proc.stderr, () => { producedAnyOutput = true; });

  const exited: Promise<number> = proc.exited
    .then((code) => (typeof code === "number" ? code : 0))
    .catch(() => -1);

  let tornDown = false;
  async function teardown(signal: AbortSignal): Promise<void> {
    if (tornDown) {
      await exited;
      return;
    }
    tornDown = true;

    sendSignal(pgid, "SIGTERM");
    const graceWinner = await Promise.race([
      exited.then(() => "exited" as const),
      wait(gracemMs, signal).then(() => "timeout" as const),
    ]);
    if (graceWinner === "exited") return;

    sendSignal(pgid, "SIGKILL");
    const hardWinner = await Promise.race([
      exited.then(() => "exited" as const),
      wait(hardMs, signal).then(() => "timeout" as const),
    ]);
    if (hardWinner === "exited") return;

    // Give up waiting; systemd KillMode=control-group (PRD §16.2) is
    // the last line of defence in prod.
    throw new SubprocessError(
      `subprocess pgid=${pgid} survived SIGKILL after ${hardMs}ms`,
      "teardown",
    );
  }

  return {
    pid,
    process_group_id: pgid,
    stdout: wrappedStdout,
    stderr: wrappedStderr,
    exited,
    cancelled_after_start: () => producedAnyOutput,
    teardown,
  };
}

function sendSignal(pgid: number, signal: "SIGTERM" | "SIGKILL"): void {
  if (process.platform === "win32") {
    // Windows has no pgid; best effort: kill the pid.
    try {
      process.kill(pgid, signal);
    } catch {
      // ignore
    }
    return;
  }
  try {
    // Negative pid → signal sent to the process group.
    process.kill(-pgid, signal);
  } catch {
    // The process may already be dead; best effort.
  }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

function wrapStream(
  upstream: ReadableStream<Uint8Array> | null | undefined,
  onData: () => void,
): ReadableStream<Uint8Array> | null {
  if (!upstream) return null;
  const reader = upstream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      if (value && value.byteLength > 0) onData();
      controller.enqueue(value);
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });
}
