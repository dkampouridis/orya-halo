import { describe, expect, it } from "vite-plus/test";
import { FrameSwitcher } from "./raster-overlay.ts";

describe("FrameSwitcher", () => {
  it("loads the first frame at once", () => {
    const s = new FrameSwitcher(200, 5000);
    expect(s.busy).toBe(false);
    s.want("f1", 0);
    expect(s.busy).toBe(true);
    expect(s.next(0)).toBe("f1");
    expect(s.settle()).toBe("f1");
    expect(s.busy).toBe(false);
    expect(s.next(10)).toBeNull();
  });

  it("waits for the scrubber to rest before asking for another frame", () => {
    const s = new FrameSwitcher(200, 5000);
    s.want("f1", 0);
    s.next(0);
    s.settle();

    s.want("f2", 1000);
    expect(s.next(1000)).toBeNull();
    expect(s.next(1150)).toBeNull();
    expect(s.next(1200)).toBe("f2");
  });

  it("requests only where a sweep of the tape comes to rest", () => {
    const s = new FrameSwitcher(200, 5000);
    s.want("f1", 0);
    s.next(0);
    s.settle();

    // Thirteen frames crossed in 1.3 seconds, polled every animation frame.
    const requested: string[] = [];
    for (let t = 0; t <= 3000; t += 16) {
      const frame = Math.min(13, 1 + Math.floor(t / 100));
      s.want(`f${frame}`, 1000 + t);
      const next = s.next(1000 + t);
      if (next) {
        requested.push(next);
        s.settle();
      }
    }
    expect(requested).toEqual(["f13"]);
  });

  it("keeps one frame in flight and then catches up with the latest", () => {
    const s = new FrameSwitcher(200, 5000);
    s.want("f1", 0);
    s.next(0);
    s.settle();

    s.want("f2", 1000);
    expect(s.next(1300)).toBe("f2");
    // The tape moves on while f2 is still loading: nothing else starts.
    s.want("f3", 1400);
    expect(s.next(1700)).toBeNull();
    s.want("f4", 1800);
    expect(s.next(2100)).toBeNull();
    expect(s.loading).toBe("f2");

    expect(s.settle()).toBe("f2");
    expect(s.busy).toBe(true);
    // f3 was never rested on long enough to matter; f4 is what is wanted.
    expect(s.next(2100)).toBe("f4");
    s.settle();
    expect(s.busy).toBe(false);
  });

  it("does nothing when the tape returns to the frame on screen", () => {
    const s = new FrameSwitcher(200, 5000);
    s.want("f1", 0);
    s.next(0);
    s.settle();
    s.want("f2", 100);
    s.want("f1", 150);
    expect(s.busy).toBe(false);
    expect(s.next(1000)).toBeNull();
  });

  it("gives up on a frame that never arrives", () => {
    const s = new FrameSwitcher(200, 5000);
    s.want("f1", 0);
    s.next(0);
    s.settle();
    s.want("f2", 0);
    s.next(300);
    expect(s.timedOut(5000)).toBe(false);
    expect(s.timedOut(5301)).toBe(true);
    s.settle();
    expect(s.timedOut(9999)).toBe(false);
  });

  it("asks again for a frame that was abandoned, and for everything after a rebuild", () => {
    const s = new FrameSwitcher(200, 5000);
    s.want("f1", 0);
    s.next(0);
    s.settle();
    s.want("f2", 0);
    expect(s.next(500)).toBe("f2");
    s.abandon();
    expect(s.front).toBe("f1");
    expect(s.next(600)).toBe("f2");
    s.settle();

    s.clear();
    expect(s.busy).toBe(true);
    // Nothing is on screen, so there is nothing to wait behind.
    expect(s.next(601)).toBe("f2");
  });
});
