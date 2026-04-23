import { describe, test, expect } from "bun:test";
import { createFakeAdapter } from "../../src/providers/fake.ts";
import type { AgentRequest } from "../../src/providers/types.ts";

function req(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    provider: "fake",
    message: "hi",
    session_id: "s",
    user_id: "u",
    channel: "telegram:c",
    chat_id: "c",
    ...overrides,
  };
}

describe("fake adapter", () => {
  test("mode=ok echoes the input text and emits parser_status=parsed", async () => {
    const outcome = await createFakeAdapter().run(req({ message: "hello" }));
    expect(outcome.kind).toBe("succeeded");
    if (outcome.kind === "succeeded") {
      expect(outcome.response.final_text).toBe("echo: hello");
      expect(outcome.response.parser_status).toBe("parsed");
      expect(outcome.response.exit_code).toBe(0);
      expect(outcome.response.raw_events.length).toBeGreaterThan(0);
    }
  });

  test("mode=partial overrides final_text + parser_status=fallback_used", async () => {
    const outcome = await createFakeAdapter({
      mode: { kind: "partial", final_text_override: "hello from partial" },
    }).run(req());
    expect(outcome.kind).toBe("succeeded");
    if (outcome.kind === "succeeded") {
      expect(outcome.response.final_text).toBe("hello from partial");
      expect(outcome.response.parser_status).toBe("fallback_used");
    }
  });

  test("mode=error reports failed with error_type + non-zero exit code", async () => {
    const outcome = await createFakeAdapter({
      mode: { kind: "error", error_type: "bad", exit_code: 2 },
    }).run(req());
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.error_type).toBe("bad");
      expect(outcome.response.exit_code).toBe(2);
    }
  });

  test("mode=cancel_on_signal + pre-aborted signal: cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await createFakeAdapter({ mode: { kind: "cancel_on_signal" } }).run(
      req(),
      controller.signal,
    );
    expect(outcome.kind).toBe("cancelled");
  });

  test("mode=timeout: after_ms elapses → failed with error_type=timeout", async () => {
    const outcome = await createFakeAdapter({ mode: { kind: "timeout", after_ms: 1 } }).run(req());
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.error_type).toBe("timeout");
  });
});
