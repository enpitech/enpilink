import type { AgentRequestRecord } from "../storage/types.js";

/**
 * A bounded, batching, drop-on-overflow write buffer for captured agent
 * requests.
 *
 * The one hole the architecture calls out: `recordEvent` is one synchronous
 * INSERT per event — fine at tool-call volume, fatal at page-view volume. So
 * agent captures go through this buffer instead:
 *
 * - **Never blocks the response.** {@link enqueue} is synchronous, does no I/O,
 *   and returns immediately. The flush runs on a microtask/timer, off the hot
 *   path.
 * - **Batches.** A flush drains the queue and writes it to the sink in one batch
 *   call (a single multi-row INSERT downstream), triggered when the queue
 *   reaches {@link AgentWriteBufferOptions.batchSize} or after
 *   {@link AgentWriteBufferOptions.flushIntervalMs}.
 * - **Drops on overflow, never grows unbounded.** Past
 *   {@link AgentWriteBufferOptions.maxQueue}, new records are DROPPED and counted
 *   ({@link dropped}) rather than queued — capture must never become a memory
 *   leak or a source of backpressure onto request handling.
 * - **Swallows sink errors.** A storage failure must never surface on the hot
 *   path; the batch is simply lost and the buffer keeps going.
 *
 * The flush timer is `unref()`ed, so a pending flush never keeps the process
 * alive; {@link stop} clears it and does a final flush.
 */

/** Sink that persists a batch of captured requests. Should swallow its own errors too. */
export type AgentWriteSink = (records: AgentRequestRecord[]) => Promise<void>;

/** Options for {@link AgentWriteBuffer}. */
export interface AgentWriteBufferOptions {
  /** Where drained batches go. */
  sink: AgentWriteSink;
  /** Hard cap on queued records; enqueue past this DROPS (default 1000). */
  maxQueue?: number;
  /** Flush eagerly once the queue reaches this many records (default 100). */
  batchSize?: number;
  /** Flush a non-empty queue after at most this long (ms, default 1000). */
  flushIntervalMs?: number;
}

const DEFAULT_MAX_QUEUE = 1000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_FLUSH_INTERVAL_MS = 1000;

export class AgentWriteBuffer {
  private readonly sink: AgentWriteSink;
  private readonly maxQueue: number;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;

  private queue: AgentRequestRecord[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private droppedCount = 0;

  constructor(opts: AgentWriteBufferOptions) {
    this.sink = opts.sink;
    this.maxQueue =
      opts.maxQueue && opts.maxQueue > 0 ? opts.maxQueue : DEFAULT_MAX_QUEUE;
    this.batchSize =
      opts.batchSize && opts.batchSize > 0
        ? opts.batchSize
        : DEFAULT_BATCH_SIZE;
    this.flushIntervalMs =
      opts.flushIntervalMs && opts.flushIntervalMs > 0
        ? opts.flushIntervalMs
        : DEFAULT_FLUSH_INTERVAL_MS;
  }

  /** Number of records dropped so far because the queue was full. */
  get dropped(): number {
    return this.droppedCount;
  }

  /** Current queue depth (for tests/metrics). */
  get size(): number {
    return this.queue.length;
  }

  /**
   * Queue a record for writing. Synchronous, non-blocking, never throws. Drops
   * (and counts) when the queue is full; flushes eagerly at {@link batchSize},
   * otherwise arms the interval timer.
   */
  enqueue(record: AgentRequestRecord): void {
    if (this.queue.length >= this.maxQueue) {
      this.droppedCount++;
      return;
    }
    this.queue.push(record);
    if (this.queue.length >= this.batchSize) {
      void this.flush();
      return;
    }
    this.arm();
  }

  /** Arm the interval flush if not already armed. Unref'd — never blocks exit. */
  private arm(): void {
    if (this.timer !== null) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.flushIntervalMs);
    // A pending capture flush must never keep the process alive.
    this.timer.unref?.();
  }

  /**
   * Drain the queue to the sink in batches. Safe to call concurrently (re-entry
   * is coalesced). Swallows all sink errors — a storage failure drops the batch
   * rather than propagating onto the request path.
   */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.flushing) {
      return;
    }
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, this.batchSize);
        try {
          await this.sink(batch);
        } catch {
          // A storage failure must never break or slow request handling; the
          // batch is dropped and we move on.
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Clear the timer and do a final flush. Safe to call more than once. */
  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
  }
}
