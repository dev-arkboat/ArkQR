// Screen Wake Lock helper: keeps the sender screen on during the stream.
// Best-effort everywhere: absence or denial never breaks the transfer.

interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}

function lockApi(): { request(kind: 'screen'): Promise<WakeLockSentinelLike> } | null {
  const w = window as unknown as {
    navigator?: { wakeLock?: { request(kind: 'screen'): Promise<WakeLockSentinelLike> } };
  };
  const api = w.navigator?.wakeLock;
  return api && typeof api.request === 'function' ? api : null;
}

export class WakeLock {
  private sentinel: WakeLockSentinelLike | null = null;
  private wanted = false;
  private onVisibility: (() => void) | null = null;

  async acquire(): Promise<void> {
    this.wanted = true;
    const api = lockApi();
    if (!api) return;
    try {
      this.sentinel = await api.request('screen');
      this.sentinel.addEventListener('release', () => {
        this.sentinel = null;
        if (this.wanted) void this.reacquireSoon();
      });
    } catch {
      this.sentinel = null;
    }
    if (!this.onVisibility) {
      this.onVisibility = (): void => {
        if (document.visibilityState === 'visible' && this.wanted && !this.sentinel) {
          void this.acquire();
        }
      };
      document.addEventListener('visibilitychange', this.onVisibility);
    }
  }

  async release(): Promise<void> {
    this.wanted = false;
    if (this.onVisibility) {
      document.removeEventListener('visibilitychange', this.onVisibility);
      this.onVisibility = null;
    }
    if (this.sentinel) {
      try {
        await this.sentinel.release();
      } catch {
        // Already released; ignore.
      }
      this.sentinel = null;
    }
  }

  private async reacquireSoon(): Promise<void> {
    await new Promise((r) => setTimeout(r, 500));
    if (this.wanted && !this.sentinel) await this.acquire();
  }
}
