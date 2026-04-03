/**
 * Rate limiter utility for throttling function calls.
 * Ensures minimum time interval between executions and only keeps the latest call data.
 * Deduplication happens atomically at flush time to avoid races during async callbacks.
 */

import logger from "../utils/logger.js";

export interface RateLimiterOptions {
  minIntervalMs: number;
}

export type FlushCallback<T> = (id: string, data: T) => Promise<void>;

interface QueueEntry<T> {
  streamId: string;
  data: T;
}

export class RateLimiter<T> {
  private queue: QueueEntry<T>[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private flushing = false;
  private currentFlush?: Promise<void>;
  private lastFlushTime = 0;

  constructor(
    private flushCallback: FlushCallback<T>,
    private options: RateLimiterOptions,
  ) {}

  /**
   * Add an item to be flushed with rate limiting.
   * If an item with the same ID already exists, it will be deduped at flush time.
   */
  add(streamId: string, data: T): void {
    this.queue.push({ streamId, data });
    this.scheduleFlush();
  }

  /**
   * Schedule a flush operation respecting the rate limit.
   */
  private scheduleFlush(): void {
    if (this.timer !== undefined || this.flushing) return;
    if (this.queue.length === 0) return;
    const elapsed = Date.now() - this.lastFlushTime;
    const delay = Math.max(0, this.options.minIntervalMs - elapsed);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.doFlush();
    }, delay);
  }

  /**
   * Atomically dedup the head entry: merge any later entries for the same stream
   * (keeping the latest data) and remove them, then return the head.
   * This prevents race conditions where new data arrives during an async flush.
   */
  private dedupHead(): QueueEntry<T> | undefined {
    if (this.queue.length === 0) return undefined;
    const head = this.queue[0];
    let i = 1;
    while (i < this.queue.length) {
      if (this.queue[i].streamId === head.streamId) {
        head.data = this.queue[i].data;
        this.queue.splice(i, 1);
      } else {
        i++;
      }
    }
    return head;
  }

  /**
   * Execute the flush operation.
   * If a flush is already in progress, returns its promise.
   */
  private doFlush(): void {
    const head = this.dedupHead();
    if (!head) return;
    this.flushing = true;
    this.lastFlushTime = Date.now();
    this.currentFlush = this.flushCallback(head.streamId, head.data)
      .then(() => {
        this.queue.shift();
      })
      .catch((err) => {
        logger.warn(`RateLimiter flush failed for ${head.streamId}: ${(err as Error).message}`);
      })
      .finally(() => {
        this.flushing = false;
        this.currentFlush = undefined;
        this.scheduleFlush();
      });
  }

  /**
   * Force flush all pending items immediately.
   */
  async forceFlush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.currentFlush;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const head = this.dedupHead();
        if (!head) break;
        try {
          await this.flushCallback(head.streamId, head.data);
          this.queue.shift();
        } catch (err) {
          logger.warn(`RateLimiter forceFlush failed for ${head.streamId}: ${(err as Error).message}`);
          break;
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Get the number of pending items.
   */
  get pendingCount(): number {
    return this.queue.length;
  }

  /**
   * Clear all pending items without flushing.
   */
  clear(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.queue.length = 0;
  }
}
