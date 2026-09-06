import { describe, expect, test } from "bun:test";
import { createMutex } from "../src/mutex.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("mutex", () => {
  test("serializes concurrent holders", async () => {
    const m = createMutex();
    const order: string[] = [];
    const use = async (name: string, ms: number) => {
      const release = await m.acquire();
      order.push(`${name}:in`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${name}:out`);
      release();
    };
    await Promise.all([use("a", 20), use("b", 0)]);
    expect(order).toEqual(["a:in", "a:out", "b:in", "b:out"]);
  });

  test("grants are FIFO", async () => {
    const m = createMutex();
    const first = await m.acquire();
    const order: string[] = [];
    const waiter = async (name: string) => {
      const release = await m.acquire();
      order.push(name);
      release();
    };
    const p1 = waiter("one");
    await tick();
    const p2 = waiter("two");
    await tick();
    first();
    await Promise.all([p1, p2]);
    expect(order).toEqual(["one", "two"]);
  });

  test("reusable after release", async () => {
    const m = createMutex();
    for (let i = 0; i < 3; i++) {
      const release = await m.acquire();
      release();
    }
    const again = await m.acquire();
    expect(typeof again).toBe("function");
    again();
  });
});
