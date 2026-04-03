/**
 * Rate limiter utility for throttling function calls.
 * Ensures minimum time interval between executions and only keeps the latest call data.
 * On failure, retries individual items with exponential backoff.
 */

import logger from "../utils/logger.js";

export interface RateLimitedItem<T> {
  id: string;
  data: T;
}

export interface RateLimiterOptions {
  minIntervalMs: number;
  maxRetries?: number;
  retryBaseMs?: number;
}

export type FlushCallback<T> = (id: string, data: T) => Promise<void>;

export class RateLimiter<T> {
  private pendingItems: Map<string, RateLimitedItem<T>> = new Map();
  private flushTimer?: ReturnType<typeof setTimeout>;
  private lastFlushTime: number = 0;
  private currentFlush?: Promise<void>;
  private retries: Map<string, { count: number; timer: ReturnType<typeof setTimeout> }> = new Map();
  private minIntervalMs: number;
  private maxRetries: number;
  private retryBaseMs: number;

  constructor(
    private flushCallback: FlushCallback<T>,
    options: RateLimiterOptions,
  ) {
    this.minIntervalMs = options.minIntervalMs;
    this.maxRetries = options.maxRetries ?? 5;
    this.retryBaseMs = options.retryBaseMs ?? 500;
  }

  /**
   * Add an item to be flushed with rate limiting.
   * If an item with the same ID already exists, it will be replaced with the new data.
   */
  add(id: string, data: T): void {
    this.pendingItems.set(id, { id, data });
    this.scheduleFlush();
  }

  /**
   * Schedule a flush operation respecting the rate limit.
   */
  private scheduleFlush(): void {
    // Clear existing timer
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }

    const now = Date.now();
    const timeSinceLastFlush = now - this.lastFlushTime;
    const delay = Math.max(0, this.minIntervalMs - timeSinceLastFlush);

    this.flushTimer = setTimeout(() => {
      this.executeFlush();
    }, delay);
  }

  /**
   * Execute the flush operation.
   * If a flush is already in progress, returns its promise.
   */
  private executeFlush(): Promise<void> {
    if (this.currentFlush) {
      return this.currentFlush;
    }

    if (this.pendingItems.size === 0) {
      return Promise.resolve();
    }

    this.lastFlushTime = Date.now();

    // Take all current items and clear the map BEFORE await
    // This prevents race condition where new items added during flush are lost
    const itemsToFlush = new Map(this.pendingItems);
    this.pendingItems.clear();

    this.currentFlush = (async () => {
      for (const [id, item] of itemsToFlush) {
        // Do not retry if the item to flush is added later
        if (this.pendingItems.has(id)) {
          continue;
        }

        try {
          // Attempt to flush
          await this.flushCallback(id, item.data);
          this.retries.delete(id);
        } catch (err) {
          // Retry logic
          const retry = this.retries.get(id);
          const count = retry?.count ?? 0;
          if (count >= this.maxRetries) {
            logger.error(`RateLimiter item ${id} failed after ${this.maxRetries} retries: ${(err as Error).message}`);
            this.retries.delete(id);
            continue;
          }
          const delay = this.retryBaseMs * Math.pow(2, count);
          logger.warn(`RateLimiter item ${id} failed (retry ${count + 1}/${this.maxRetries}), backing off ${delay}ms: ${(err as Error).message}`);
          const timer = setTimeout(() => {
            this.retries.delete(id);
            // Don't overwrite newer data if add() was called during backoff
            if (!this.pendingItems.has(id)) {
              this.pendingItems.set(id, item);
            }
            this.scheduleFlush();
          }, delay);
          this.retries.set(id, { count: count + 1, timer });
        }
      }

      this.currentFlush = undefined;

      // If new items were added during the flush, schedule another flush
      if (this.pendingItems.size > 0) {
        this.scheduleFlush();
      }
    })();

    return this.currentFlush;
  }

  /**
   * Force flush all pending items immediately.
   */
  async forceFlush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.executeFlush();
  }

  /**
   * Get the number of pending items.
   */
  get pendingCount(): number {
    return this.pendingItems.size;
  }

  /**
   * Clear all pending items without flushing.
   */
  clear(): void {
    for (const { timer } of this.retries.values()) {
      clearTimeout(timer);
    }
    this.retries.clear();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.pendingItems.clear();
  }
}
