/**
 * Binary min-heap keyed by a numeric priority. Callers may push the same
 * value again with a better priority and skip stale pops themselves.
 */
export class MinHeap<T> {
  private items: Array<{ value: T; priority: number }> = [];

  get size(): number {
    return this.items.length;
  }

  push(value: T, priority: number): void {
    this.items.push({ value, priority });
    this.siftUp(this.items.length - 1);
  }

  pop(): { value: T; priority: number } | undefined {
    const top = this.items[0];
    const last = this.items.pop();
    if (top && last && this.items.length > 0) {
      this.items[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  private siftUp(index: number): void {
    const item = this.items[index]!;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      const parentItem = this.items[parent]!;
      if (parentItem.priority <= item.priority) break;
      this.items[index] = parentItem;
      index = parent;
    }
    this.items[index] = item;
  }

  private siftDown(index: number): void {
    const length = this.items.length;
    const item = this.items[index]!;
    while (true) {
      const left = index * 2 + 1;
      if (left >= length) break;
      const right = left + 1;
      const child =
        right < length && this.items[right]!.priority < this.items[left]!.priority
          ? right
          : left;
      if (this.items[child]!.priority >= item.priority) break;
      this.items[index] = this.items[child]!;
      index = child;
    }
    this.items[index] = item;
  }
}
