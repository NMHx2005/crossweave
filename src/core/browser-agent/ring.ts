/** The newest `cap` items; the oldest fall off. */
export class RingBuffer<T> {
  private items: T[] = [];

  constructor(private readonly cap: number) {}

  get size(): number { return this.items.length; }

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.cap) this.items.splice(0, this.items.length - this.cap);
  }

  toArray(): T[] { return [...this.items]; }

  clear(): void { this.items = []; }
}

/** Cut long text to `max` characters and mark that it was cut. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
