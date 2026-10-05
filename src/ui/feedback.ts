// Non-visual feedback: short beeps (WebAudio) + vibration where supported.
// Always guarded: no AudioContext without user intent issues (resume on call),
// no-ops on unsupported platforms.

let audio: AudioContext | null = null;

function context(): AudioContext | null {
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    audio ??= new Ctor();
    if (audio.state === 'suspended') void audio.resume().catch(() => undefined);
    return audio;
  } catch {
    return null;
  }
}

export function beep(frequency = 880, durationMs = 120): void {
  const ctx = context();
  if (!ctx) return;
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = frequency;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + durationMs / 1000);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + durationMs / 1000 + 0.05);
  } catch {
    // Audio is decoration; never throw.
  }
}

export function vibrate(pattern: number | number[]): void {
  try {
    if (typeof navigator.vibrate === 'function') navigator.vibrate(pattern);
  } catch {
    // Ignore.
  }
}

export type NotifyKind = 'meta' | 'frame' | 'complete' | 'error';

export function notify(kind: NotifyKind, enabled: boolean): void {
  if (!enabled) return;
  if (kind === 'meta') {
    beep(660, 90);
  } else if (kind === 'complete') {
    beep(880, 140);
    setTimeout(() => {
      beep(1174, 200);
    }, 160);
    vibrate([60, 60, 120]);
  } else if (kind === 'error') {
    beep(220, 250);
    vibrate(200);
  }
}
