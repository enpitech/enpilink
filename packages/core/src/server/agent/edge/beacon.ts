import type { AgentRequestRecord } from "../../storage/types.js";

/**
 * The edge beacon sink client (M8) — batches captured records and POSTs them to
 * the Node-side ingest endpoint (`ingest.ts`) via `fetch`. Web-standard only:
 * no `node:*`, no timers-as-batching. Edge-safe.
 *
 * ── WHY NOT REUSE `buffer.ts` (the Node write buffer)? ───────────────────────
 * `AgentWriteBuffer` batches on a `setTimeout` interval — correct for a
 * long-lived Node process. The **edge is different**: an isolate can be frozen
 * or recycled between requests, so a background timer is NOT guaranteed to fire,
 * and anything left in a queue below the flush threshold can be silently lost.
 * So this buffer uses a **drain-on-every-invocation** model instead:
 *
 * - Each captured request calls {@link add} then {@link drainAndSend}, and the
 *   caller passes the returned promise to `event.waitUntil()`.
 * - {@link drainAndSend} splices up to `maxBatch` records and POSTs them.
 * - Because EVERY invocation drains, a record is guaranteed to be sent by its
 *   OWN invocation at the latest — nothing lingers between requests. When
 *   several requests land in a warm isolate close together, their records
 *   coalesce into one POST (opportunistic batching) with zero lingering risk.
 *
 * - **Bounded + drop-on-overflow.** Past {@link BeaconSinkOptions.maxQueue} new
 *   records are DROPPED and counted ({@link dropped}) — capture must never be a
 *   memory leak or backpressure onto the response.
 * - **Fire-and-forget + swallow.** A sink failure (network, 4xx/5xx) is
 *   swallowed; it must NEVER reject onto `waitUntil` in a way that breaks the
 *   page. The batch is simply lost.
 */

/** Injectable fetch — matches the global `fetch` signature. */
export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    keepalive?: boolean;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number }>;

/** Options for {@link BeaconSink}. */
export interface BeaconSinkOptions {
  /** The Node ingest endpoint, e.g. `https://app.com/__enpilink/agents/ingest`. */
  sinkUrl: string;
  /** Shared bearer token the sink validates (`agent.ingestToken`). */
  token?: string;
  /** Max records per POST (default 20). Keep small — the sink body is bounded. */
  maxBatch?: number;
  /** Hard cap on the pending queue; enqueue past this DROPS (default 1000). */
  maxQueue?: number;
  /** Injectable fetch (tests). Defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Per-request timeout in ms for the beacon POST (default 5000). */
  timeoutMs?: number;
}

const DEFAULT_MAX_BATCH = 20;
const DEFAULT_MAX_QUEUE = 1000;
const DEFAULT_TIMEOUT_MS = 5000;

export class BeaconSink {
  private readonly sinkUrl: string;
  private readonly token: string | undefined;
  private readonly maxBatch: number;
  private readonly maxQueue: number;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  private queue: AgentRequestRecord[] = [];
  private droppedCount = 0;

  constructor(opts: BeaconSinkOptions) {
    this.sinkUrl = opts.sinkUrl;
    this.token = opts.token;
    this.maxBatch =
      opts.maxBatch && opts.maxBatch > 0 ? opts.maxBatch : DEFAULT_MAX_BATCH;
    this.maxQueue =
      opts.maxQueue && opts.maxQueue > 0 ? opts.maxQueue : DEFAULT_MAX_QUEUE;
    this.timeoutMs =
      opts.timeoutMs && opts.timeoutMs > 0
        ? opts.timeoutMs
        : DEFAULT_TIMEOUT_MS;
    // `globalThis.fetch` exists in every edge runtime; bind so `this` is right.
    this.fetchImpl =
      opts.fetchImpl ??
      ((input, init) =>
        (globalThis.fetch as unknown as FetchLike)(input, init));
  }

  /** Records dropped so far because the queue was full. */
  get dropped(): number {
    return this.droppedCount;
  }

  /** Current pending-queue depth (for tests/metrics). */
  get size(): number {
    return this.queue.length;
  }

  /**
   * Queue a record. Synchronous, non-blocking, never throws. Drops (and counts)
   * when the queue is full. Does NOT send — the caller drives sending via
   * {@link drainAndSend} inside `event.waitUntil()`.
   */
  add(record: AgentRequestRecord): void {
    if (this.queue.length >= this.maxQueue) {
      this.droppedCount++;
      return;
    }
    this.queue.push(record);
  }

  /**
   * Splice up to `maxBatch` records and POST them to the sink. Returns a promise
   * that ALWAYS resolves (never rejects) — pass it to `event.waitUntil()` so the
   * runtime keeps the isolate alive until the beacon completes, without ever
   * surfacing a failure onto the response. A no-op (resolved) when the queue is
   * empty.
   */
  async drainAndSend(): Promise<void> {
    if (this.queue.length === 0) {
      return;
    }
    const batch = this.queue.splice(0, this.maxBatch);
    await this.post(batch);
  }

  /** POST one batch, swallowing every error. Bounded by an abort timeout. */
  private async post(records: AgentRequestRecord[]): Promise<void> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.token) {
      headers.authorization = `Bearer ${this.token}`;
    }
    const controller =
      typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => controller.abort(), this.timeoutMs)
      : null;
    try {
      await this.fetchImpl(this.sinkUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ records }),
        keepalive: true,
        ...(controller ? { signal: controller.signal } : {}),
      });
    } catch {
      // Fire-and-forget: a beacon failure must never break the page. Lost batch.
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }
  }
}
