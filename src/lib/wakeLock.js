export const IDLE_WAKE_LOCK_STATUS = Object.freeze({
  state: "idle",
  supported: null,
  message: "",
  reacquired: false,
});

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export class MutationWakeLock {
  constructor({
    navigatorObject =
      typeof navigator === "undefined" ? null : navigator,
    documentObject =
      typeof document === "undefined" ? null : document,
    onStatus = () => {},
  } = {}) {
    this.navigatorObject = navigatorObject;
    this.documentObject = documentObject;
    this.onStatus = onStatus;
    this.status = IDLE_WAKE_LOCK_STATUS;
    this.running = false;
    this.sentinel = null;
    this.sentinelReleaseListener = null;
    this.requestPromise = null;
    this.requestGeneration = 0;
    this.acquisitionCount = 0;
    this.resumePending = false;
    this.handleVisibilityChange =
      this.handleVisibilityChange.bind(this);
  }

  isSupported() {
    return Boolean(
      this.navigatorObject?.wakeLock &&
        typeof this.navigatorObject.wakeLock.request === "function",
    );
  }

  isVisible() {
    return this.documentObject?.visibilityState !== "hidden";
  }

  emit(state, details = {}) {
    const next = {
      state,
      supported: this.isSupported(),
      message: details.message ?? "",
      reacquired: details.reacquired === true,
      error: details.error ?? null,
    };
    if (
      this.status.state === next.state &&
      this.status.message === next.message &&
      this.status.reacquired === next.reacquired
    ) {
      return this.status;
    }
    this.status = next;
    try {
      this.onStatus(next);
    } catch {
      // Status presentation must never affect a firmware operation.
    }
    return next;
  }

  async start() {
    if (this.running) return this.status;
    this.running = true;
    this.documentObject?.addEventListener?.(
      "visibilitychange",
      this.handleVisibilityChange,
    );

    if (!this.isSupported()) {
      return this.emit("unsupported", {
        message:
          "This browser does not expose Screen Wake Lock. Connect AC power and disable automatic sleep until flashing finishes.",
      });
    }
    if (!this.isVisible()) {
      this.resumePending = true;
      return this.emit("suspended", {
        message:
          "Sleep prevention is waiting for the WebFlasher tab to become visible.",
      });
    }
    return this.request(false);
  }

  async request(reacquired) {
    if (!this.running || !this.isVisible()) return this.status;
    if (this.sentinel && !this.sentinel.released) {
      return this.status;
    }
    if (this.requestPromise) return this.requestPromise;

    const generation = ++this.requestGeneration;
    this.emit("requesting", {
      message: reacquired
        ? "Restoring computer sleep prevention…"
        : "Enabling computer sleep prevention…",
      reacquired,
    });
    const pending = (async () => {
      try {
        const sentinel =
          await this.navigatorObject.wakeLock.request("screen");
        if (
          !this.running ||
          generation !== this.requestGeneration ||
          !this.isVisible()
        ) {
          await sentinel.release().catch(() => {});
          if (this.running && !this.isVisible()) {
            this.resumePending = true;
            return this.emit("suspended", {
              message:
                "Sleep prevention is waiting for the WebFlasher tab to become visible.",
            });
          }
          return this.status;
        }

        this.sentinel = sentinel;
        this.resumePending = false;
        const wasReacquired = this.acquisitionCount > 0;
        this.acquisitionCount += 1;
        this.sentinelReleaseListener = () =>
          this.handleSentinelRelease(sentinel);
        sentinel.addEventListener?.(
          "release",
          this.sentinelReleaseListener,
          { once: true },
        );
        return this.emit("active", {
          message:
            "Computer sleep prevention is active until this firmware operation finishes.",
          reacquired: wasReacquired,
        });
      } catch (error) {
        if (!this.running || generation !== this.requestGeneration) {
          return this.status;
        }
        return this.emit("failed", {
          message:
            "The browser or operating system refused sleep prevention. Connect AC power and disable automatic sleep until flashing finishes.",
          error: errorMessage(error),
        });
      }
    })();
    this.requestPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.requestPromise === pending) {
        this.requestPromise = null;
      }
    }
  }

  handleSentinelRelease(sentinel) {
    if (this.sentinel !== sentinel) return;
    this.sentinel = null;
    this.sentinelReleaseListener = null;
    if (!this.running) return;

    if (!this.isVisible()) {
      this.resumePending = true;
      this.emit("suspended", {
        message:
          "Sleep prevention paused while the WebFlasher tab is hidden. Return to this tab to restore it.",
      });
      return;
    }
    if (this.resumePending) {
      this.resumePending = false;
      void this.request(true);
      return;
    }
    this.emit("released", {
      message:
        "The browser or operating system released sleep prevention. Keep the computer awake manually until flashing finishes.",
    });
  }

  handleVisibilityChange() {
    if (!this.running) return;
    if (!this.isVisible()) {
      this.resumePending = true;
      this.emit("suspended", {
        message:
          "Sleep prevention paused while the WebFlasher tab is hidden. Return to this tab to restore it.",
      });
      if (this.sentinel && !this.sentinel.released) {
        void this.sentinel.release().catch(() => {});
      }
      return;
    }
    if (!this.sentinel || this.sentinel.released) {
      this.resumePending = false;
      void this.request(this.acquisitionCount > 0);
    }
  }

  async stop() {
    if (!this.running && this.status.state === "idle") {
      return this.status;
    }
    this.running = false;
    this.resumePending = false;
    this.requestGeneration += 1;
    this.documentObject?.removeEventListener?.(
      "visibilitychange",
      this.handleVisibilityChange,
    );

    const sentinel = this.sentinel;
    const releaseListener = this.sentinelReleaseListener;
    this.sentinel = null;
    this.sentinelReleaseListener = null;
    if (sentinel && releaseListener) {
      sentinel.removeEventListener?.("release", releaseListener);
    }
    if (sentinel && !sentinel.released) {
      await sentinel.release().catch(() => {});
    }
    return this.emit("idle");
  }
}
