/**
 * Rate limiter utility for throttling function calls.
 * Ensures minimum time interval between executions and only keeps the latest call data.
 */

export interface RateLimitedItem<T> {
  id: string;
  data: T;
}

export type FlushCallback<T> = (items: Map<string, RateLimitedItem<T>>) => Promise<void>;

export class RateLimiter<T> {
  private pendingItems: Map<string, RateLimitedItem<T>> = new Map();
  private flushTimer?: ReturnType<typeof setTimeout>;
  private lastFlushTime: number = 0;
  private isFlushing: boolean = false;

  constructor(
    private minIntervalMs: number,
    private flushCallback: FlushCallback<T>,
  ) { }

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
   */
  private async executeFlush(): Promise<void> {
    if (this.isFlushing || this.pendingItems.size === 0) {
      return;
    }

    this.isFlushing = true;
    this.lastFlushTime = Date.now();

    // Create a copy of pending items and clear the map
    while (this.pendingItems.size > 0) {
      const itemsToFlush = new Map(this.pendingItems);
      this.pendingItems.clear();

      try {
        await this.flushCallback(itemsToFlush);
      } catch (err) {
        console.error("RateLimiter flush failed:", (err as Error).message);
      }
    }
    this.isFlushing = false;
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
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.pendingItems.clear();
  }
}
