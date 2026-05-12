import { describe, expect, it } from 'vitest';

import { chunked } from '@shared/chunk';

describe('chunked', () => {
  it('returns the empty value WITHOUT calling fn on empty input', async () => {
    let calls = 0;
    const result = await chunked<number, readonly number[]>(
      [],
      100,
      async (chunk) => {
        calls += 1;
        return chunk;
      },
      (acc, next) => [...acc, ...next],
      [],
    );
    expect(result).toEqual([]);
    expect(calls).toBe(0);
  });

  it('single chunk: fn called once with the whole input', async () => {
    const seen: number[][] = [];
    const result = await chunked<number, readonly number[]>(
      [1, 2, 3, 4, 5],
      100,
      async (chunk) => {
        seen.push([...chunk]);
        return chunk;
      },
      (acc, next) => [...acc, ...next],
      [],
    );
    expect(seen).toEqual([[1, 2, 3, 4, 5]]);
    expect(result).toEqual([1, 2, 3, 4, 5]);
  });

  it('two chunks: 150 items at chunkSize 100 → calls (100, 50), reduces in order', async () => {
    const seen: number[][] = [];
    const items = Array.from({ length: 150 }, (_, i) => i);
    const result = await chunked<number, readonly number[]>(
      items,
      100,
      async (chunk) => {
        seen.push([...chunk]);
        return chunk;
      },
      (acc, next) => [...acc, ...next],
      [],
    );
    expect(seen).toHaveLength(2);
    expect(seen[0]).toHaveLength(100);
    expect(seen[1]).toHaveLength(50);
    expect(result).toEqual(items);
  });

  it('three chunks: 250 items → (100, 100, 50) — pins the chunking-helper math the Real client tests reuse', async () => {
    // The exact shape the call-count assertions in
    // real-mister-client.test.ts pin: ceil(250/100) = 3 chunks of
    // 100/100/50. Sliding any of these constants would shift those
    // assertions and trip them.
    const seen: number[][] = [];
    const items = Array.from({ length: 250 }, (_, i) => i);
    const result = await chunked<number, readonly number[]>(
      items,
      100,
      async (chunk) => {
        seen.push([...chunk]);
        return chunk;
      },
      (acc, next) => [...acc, ...next],
      [],
    );
    expect(seen.map((c) => c.length)).toEqual([100, 100, 50]);
    expect(result).toEqual(items);
  });

  it('combiner runs in input order so order-sensitive merges are stable', async () => {
    // Object-spread for a path→value map: a later chunk's keys
    // override an earlier chunk's if they collide. Caller-controlled
    // semantics — the helper just preserves order. Useful for
    // shapes where last-write-wins matters (rare, but pinned).
    type Bag = Readonly<Record<string, number>>;
    const items = ['a', 'b', 'c', 'd'];
    const result = await chunked<string, Bag>(
      items,
      2,
      async (chunk) => Object.fromEntries(chunk.map((k, i) => [k, i])),
      (acc, next) => ({ ...acc, ...next }),
      {},
    );
    // First chunk: { a: 0, b: 1 }. Second chunk: { c: 0, d: 1 }.
    expect(result).toEqual({ a: 0, b: 1, c: 0, d: 1 });
  });

  it('error from a middle chunk halts subsequent chunks and propagates', async () => {
    const seen: number[][] = [];
    const items = Array.from({ length: 250 }, (_, i) => i);
    let invocation = 0;
    await expect(
      chunked<number, readonly number[]>(
        items,
        100,
        async (chunk) => {
          invocation += 1;
          seen.push([...chunk]);
          if (invocation === 2) {
            throw new Error('middle-chunk fail');
          }
          return chunk;
        },
        (acc, next) => [...acc, ...next],
        [],
      ),
    ).rejects.toThrow('middle-chunk fail');
    // Chunk 1 and 2 ran (the failing one), chunk 3 never did.
    expect(seen).toHaveLength(2);
    expect(invocation).toBe(2);
  });

  it('error from the FIRST chunk halts without aggregating anything', async () => {
    const items = Array.from({ length: 150 }, (_, i) => i);
    let invocation = 0;
    await expect(
      chunked<number, readonly number[]>(
        items,
        100,
        async (chunk) => {
          invocation += 1;
          if (invocation === 1) throw new Error('first-chunk fail');
          return chunk;
        },
        (acc, next) => [...acc, ...next],
        [],
      ),
    ).rejects.toThrow('first-chunk fail');
    expect(invocation).toBe(1);
  });
});
