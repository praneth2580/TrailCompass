import { describe, expect, it } from 'vitest';
import { MinHeap } from './min-heap';

describe('MinHeap', () => {
  it('pops in ascending priority order', () => {
    const heap = new MinHeap<string>();
    const priorities = [5, 1, 9, 3, 7, 3, 0, 8, 2, 6];
    priorities.forEach((p, i) => heap.push(`n${i}`, p));

    const popped: number[] = [];
    while (heap.size > 0) popped.push(heap.pop()!.priority);

    expect(popped).toEqual([...priorities].sort((a, b) => a - b));
  });

  it('keeps duplicate values so callers can skip stale entries', () => {
    const heap = new MinHeap<string>();
    heap.push('a', 10);
    heap.push('a', 4);
    expect(heap.pop()).toEqual({ value: 'a', priority: 4 });
    expect(heap.pop()).toEqual({ value: 'a', priority: 10 });
    expect(heap.pop()).toBeUndefined();
  });
});
