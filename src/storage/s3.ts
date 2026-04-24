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
// Production: Bun.S3Client wrapper
// ---------------------------------------------------------------

export interface BunS3Config {
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly access_key_id: string;
  readonly secret_access_key: string;
}

export class BunS3Transport implements S3Transport {
  private readonly client: InstanceType<typeof Bun.S3Client>;
  private readonly bucket: string;

  constructor(config: BunS3Config) {
    this.bucket = config.bucket;
    this.client = new Bun.S3Client({
      endpoint: config.endpoint,
      bucket: config.bucket,
      region: config.region,
      accessKeyId: config.access_key_id,
      secretAccessKey: config.secret_access_key,
    });
  }

  async put(args: S3PutArgs): Promise<void> {
    const key = args.bucket !== this.bucket
      ? `${args.bucket}/${args.key}`
      : args.key;
    try {
      const file = this.client.file(key);
      await file.write(args.bytes, args.content_type ? { type: args.content_type } : undefined);
    } catch (e) {
      throw new S3TransportError(
        `put failed: ${(e as Error).message}`,
        "retryable",
        "put",
      );
    }
  }

  async delete(args: S3DeleteArgs): Promise<void> {
    const key = args.bucket !== this.bucket
      ? `${args.bucket}/${args.key}`
      : args.key;
    try {
      await this.client.delete(key);
    } catch (e) {
      throw new S3TransportError(
        `delete failed: ${(e as Error).message}`,
        "retryable",
        "delete",
      );
    }
  }

  /**
   * Doctor smoke test: put → get → stat → list → delete on a sentinel object
   * (PRD §12.8 / AC-OBS-001, review Blocker 8).
   *
   * Previously this only exercised put+delete, so path-style vs virtual-hosted
   * misconfigurations, read permissions, and list/prefix issues could slip
   * through a green /doctor. The deep check now covers every operation that
   * the sync worker actually uses, and attributes failures to the specific
   * stage so deployment gates aren't falsely green.
   */
  async ping(): Promise<{ ok: boolean; detail?: string }> {
    const sentinelKey = `_actwyn_ping_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const prefix = "_actwyn_ping_";
    const payload = new Uint8Array([0xac, 0x74, 0x77, 0x79, 0x6e]); // "actwyn"

    let stage: "put" | "get" | "stat" | "list" | "delete" = "put";
    try {
      // put
      stage = "put";
      await this.put({
        bucket: this.bucket,
        key: sentinelKey,
        bytes: payload,
        content_type: "application/octet-stream",
      });

      const file = this.client.file(sentinelKey);

      // get — round-trip verification
      stage = "get";
      const read = new Uint8Array(await file.arrayBuffer());
      if (read.byteLength !== payload.byteLength) {
        return { ok: false, detail: `get returned ${read.byteLength} bytes; expected ${payload.byteLength}` };
      }

      // stat — HEAD / metadata
      stage = "stat";
      const stat = await file.stat();
      if (typeof stat?.size === "number" && stat.size !== payload.byteLength) {
        return { ok: false, detail: `stat size mismatch: ${stat.size} vs ${payload.byteLength}` };
      }

      // list — prefix visibility
      stage = "list";
      const listing = await this.client.list({ prefix });
      const contents = (listing?.contents ?? []) as Array<{ key?: string }>;
      const seen = contents.some((o) => o.key === sentinelKey);
      if (!seen) {
        // Attempt cleanup before reporting, but keep the original signal.
        try { await this.delete({ bucket: this.bucket, key: sentinelKey }); } catch { /* ignore */ }
        return { ok: false, detail: `list did not return sentinel under prefix '${prefix}'` };
      }

      // delete
      stage = "delete";
      await this.delete({ bucket: this.bucket, key: sentinelKey });
      return { ok: true };
    } catch (e) {
      // Best-effort cleanup so repeated smoke tests don't leave garbage behind.
      try { await this.delete({ bucket: this.bucket, key: sentinelKey }); } catch { /* ignore */ }
      return { ok: false, detail: `${stage} failed: ${(e as Error).message}` };
    }
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
