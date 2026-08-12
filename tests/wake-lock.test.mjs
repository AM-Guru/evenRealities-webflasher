import assert from "node:assert/strict";
import test from "node:test";

import {
  IDLE_WAKE_LOCK_STATUS,
  MutationWakeLock,
} from "../src/lib/wakeLock.js";

class FakeDocument {
  constructor() {
    this.visibilityState = "visible";
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

class FakeSentinel {
  constructor() {
    this.released = false;
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  async release() {
    if (this.released) return;
    this.released = true;
    for (const listener of this.listeners.get("release") ?? []) listener();
  }
}

test("reports unsupported wake lock without blocking the operation", async () => {
  const statuses = [];
  const documentObject = new FakeDocument();
  const wakeLock = new MutationWakeLock({
    navigatorObject: {},
    documentObject,
    onStatus: (status) => statuses.push(status),
  });

  const result = await wakeLock.start();
  assert.equal(result.state, "unsupported");
  assert.match(result.message, /disable automatic sleep/i);
  assert.equal(documentObject.listeners.get("visibilitychange").size, 1);

  await wakeLock.stop();
  assert.deepEqual(wakeLock.status, {
    ...IDLE_WAKE_LOCK_STATUS,
    supported: false,
    error: null,
  });
  assert.equal(documentObject.listeners.get("visibilitychange").size, 0);
  assert.equal(statuses.at(-1).state, "idle");
});

test("acquires one screen wake lock and releases it when the operation ends", async () => {
  const requests = [];
  const sentinel = new FakeSentinel();
  const wakeLock = new MutationWakeLock({
    navigatorObject: {
      wakeLock: {
        request: async (type) => {
          requests.push(type);
          return sentinel;
        },
      },
    },
    documentObject: new FakeDocument(),
  });

  const result = await wakeLock.start();
  assert.equal(result.state, "active");
  assert.equal(result.reacquired, false);
  assert.deepEqual(requests, ["screen"]);

  await wakeLock.stop();
  assert.equal(sentinel.released, true);
  assert.equal(wakeLock.status.state, "idle");
});

test("reacquires the wake lock when a hidden operation tab becomes visible", async () => {
  const documentObject = new FakeDocument();
  const sentinels = [];
  const wakeLock = new MutationWakeLock({
    navigatorObject: {
      wakeLock: {
        request: async () => {
          const sentinel = new FakeSentinel();
          sentinels.push(sentinel);
          return sentinel;
        },
      },
    },
    documentObject,
  });

  await wakeLock.start();
  documentObject.visibilityState = "hidden";
  documentObject.dispatch("visibilitychange");
  await Promise.resolve();
  assert.equal(sentinels[0].released, true);
  assert.equal(wakeLock.status.state, "suspended");

  documentObject.visibilityState = "visible";
  documentObject.dispatch("visibilitychange");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(sentinels.length, 2);
  assert.equal(wakeLock.status.state, "active");
  assert.equal(wakeLock.status.reacquired, true);

  await wakeLock.stop();
});

test("surfaces an operating-system rejection as a nonfatal warning", async () => {
  const wakeLock = new MutationWakeLock({
    navigatorObject: {
      wakeLock: {
        request: async () => {
          throw new DOMException("Battery saver is active", "NotAllowedError");
        },
      },
    },
    documentObject: new FakeDocument(),
  });

  const result = await wakeLock.start();
  assert.equal(result.state, "failed");
  assert.equal(result.error, "Battery saver is active");
  assert.match(result.message, /disable automatic sleep/i);
  await wakeLock.stop();
});

test("warns without immediately looping when the operating system releases a visible lock", async () => {
  let requests = 0;
  const sentinel = new FakeSentinel();
  const wakeLock = new MutationWakeLock({
    navigatorObject: {
      wakeLock: {
        request: async () => {
          requests += 1;
          return sentinel;
        },
      },
    },
    documentObject: new FakeDocument(),
  });

  await wakeLock.start();
  await sentinel.release();
  assert.equal(wakeLock.status.state, "released");
  assert.match(wakeLock.status.message, /keep the computer awake manually/i);
  assert.equal(requests, 1);
  await wakeLock.stop();
});

test("releases a late wake-lock response after the operation has ended", async () => {
  let resolveRequest;
  const sentinel = new FakeSentinel();
  const wakeLock = new MutationWakeLock({
    navigatorObject: {
      wakeLock: {
        request: () =>
          new Promise((resolve) => {
            resolveRequest = resolve;
          }),
      },
    },
    documentObject: new FakeDocument(),
  });

  const startPromise = wakeLock.start();
  await Promise.resolve();
  await wakeLock.stop();
  resolveRequest(sentinel);
  await startPromise;

  assert.equal(sentinel.released, true);
  assert.equal(wakeLock.status.state, "idle");
});
