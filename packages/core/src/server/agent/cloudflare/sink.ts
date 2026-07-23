import type { AgentRequestRecord } from "../../storage/types.js";
import { BeaconSink, type BeaconSinkOptions } from "../edge/beacon.js";

/**
 * THE EDGE CAPTURE-STORAGE SEAM (D4b) — where a Cloudflare Worker's captured
 * records go.
 *
 * A pure edge Worker has no in-process `StorageAdapter` (no `better-sqlite3`, no
 * `pg`, no `node:fs`), so it needs a different write target. There are two, and
 * this seam lets the adapter treat them uniformly:
 *   - {@link import("./d1.js").D1CaptureSink} — write DIRECTLY to Cloudflare D1
 *     (the recommended CF-native deploy: no second service, data stays on
 *     Cloudflare).
 *   - {@link BeaconCaptureSink} — POST batches to a full Node enpilink server's
 *     beacon ingest endpoint (the alternative: reuse an existing Node deployment
 *     as the store; classification + backfill happen there).
 *
 * Both are best-effort and non-blocking — a write is driven from `waitUntil`, and
 * a failure is swallowed so it can never break the response (the same discipline
 * as every other capture write).
 */

/** A uniform write target for edge-captured records. */
export interface EdgeCaptureSink {
  /**
   * Persist a batch of captured records. MUST be best-effort — resolve even on a
   * storage/network failure (swallow it), so `waitUntil` never surfaces an error
   * onto the response. The batch may simply be lost.
   */
  write(records: AgentRequestRecord[]): Promise<void>;
}

/** Options for {@link BeaconCaptureSink} — the beacon-sink target's config. */
export type BeaconCaptureSinkOptions = BeaconSinkOptions;

/**
 * An {@link EdgeCaptureSink} that beacons records to a Node enpilink server's
 * ingest endpoint (`/__enpilink/agents/ingest`). A thin wrapper over the existing
 * {@link BeaconSink} so the Worker adapter can choose "beacon" or "D1" behind one
 * interface. Batches every record then drains — nothing lingers between requests
 * (an edge isolate can freeze), matching the beacon's drain-on-every-invocation
 * model.
 */
export class BeaconCaptureSink implements EdgeCaptureSink {
  private readonly sink: BeaconSink;

  constructor(opts: BeaconCaptureSinkOptions) {
    this.sink = new BeaconSink(opts);
  }

  async write(records: AgentRequestRecord[]): Promise<void> {
    for (const record of records) {
      this.sink.add(record);
    }
    // Drain until empty — `drainAndSend` sends one `maxBatch` at a time, and it
    // splices before it POSTs, so `size` strictly decreases regardless of network
    // success (a failed POST loses that batch, never loops).
    while (this.sink.size > 0) {
      await this.sink.drainAndSend();
    }
  }
}

/** Construct a {@link BeaconCaptureSink}. Sugar for `new BeaconCaptureSink(opts)`. */
export function beaconCaptureSink(
  opts: BeaconCaptureSinkOptions,
): BeaconCaptureSink {
  return new BeaconCaptureSink(opts);
}
