import { logger } from "../utils/logger.js";

/** Bounded FIFO queue that drops the oldest item on overflow. */
export class BoundedQueue<T> {
  private buf: T[] = [];
  private droppedTotal = 0;

  constructor(private capacity: number) {}

  push(item: T): void {
    if (this.buf.length >= this.capacity) {
      this.buf.shift();
      this.droppedTotal++;
      if (this.droppedTotal % 1000 === 1) {
        logger.warn(
          { droppedTotal: this.droppedTotal, capacity: this.capacity },
          "[queue] backpressure — dropping oldest items",
        );
      }
    }
    this.buf.push(item);
  }

  shift(): T | undefined {
    return this.buf.shift();
  }

  get size(): number {
    return this.buf.length;
  }

  get dropped(): number {
    return this.droppedTotal;
  }
}
