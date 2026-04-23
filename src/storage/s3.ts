// Personal Agent P0 — S3 transport abstraction.
//
// The sync worker (src/storage/sync.ts) talks to S3 through this
// minimal contract so production wires Bun.S3Client while tests
// wire a deterministic stub. The real Bun.S3Client wrapper is
// deferred (SP-08) — what matters at the HLD level is that the
// worker never calls into an implementation that imports
// Bun.S3Client directly. This keeps the surface testable and
// swappable with @aws-sdk/client-s3 per DEC register fallback.

export interface S3PutArgs {
  readonly bucket: string;
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly content_type?: string;
}

export interface S3DeleteArgs {
  readonly bucket: string;
  readonly key: string;
}

export interface S3Transport {
  put(args: S3PutArgs): Promise<void>;
  delete(args: S3DeleteArgs): Promise<void>;
}

export class S3TransportError extends Error {
  constructor(
    message: string,
    public readonly category: "retryable" | "non_retryable",
    public readonly op: "put" | "delete",
  ) {
    super(message);
    this.name = "S3TransportError";
  }
}

// ---------------------------------------------------------------
// Stub (for tests)
// ---------------------------------------------------------------

export class StubS3Transport implements S3Transport {
  readonly store = new Map<string, Uint8Array>();
  private plan: ReadonlyMap<string, "ok" | "fail_retryable" | "fail_non_retryable" | "fail_once">;
  private firstFails = new Set<string>();

  constructor(plan?: Map<string, "ok" | "fail_retryable" | "fail_non_retryable" | "fail_once">) {
    this.plan = plan ?? new Map();
  }

  private outcome(key: string): "ok" | "fail_retryable" | "fail_non_retryable" {
    const p = this.plan.get(key) ?? "ok";
    if (p === "fail_once") {
      if (!this.firstFails.has(key)) {
        this.firstFails.add(key);
        return "fail_retryable";
      }
      return "ok";
    }
    return p;
  }

  async put(args: S3PutArgs): Promise<void> {
    const combined = `${args.bucket}/${args.key}`;
    const outcome = this.outcome(combined);
    if (outcome === "fail_retryable") {
      throw new S3TransportError("transient", "retryable", "put");
    }
    if (outcome === "fail_non_retryable") {
      throw new S3TransportError("auth_or_404", "non_retryable", "put");
    }
    this.store.set(combined, args.bytes);
  }

  async delete(args: S3DeleteArgs): Promise<void> {
    const combined = `${args.bucket}/${args.key}`;
    const outcome = this.outcome(combined);
    if (outcome === "fail_retryable") {
      throw new S3TransportError("transient", "retryable", "delete");
    }
    if (outcome === "fail_non_retryable") {
      throw new S3TransportError("auth_or_404", "non_retryable", "delete");
    }
    this.store.delete(combined);
  }
}
