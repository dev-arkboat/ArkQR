import { describe, expect, it } from 'vitest';
import {
  classify,
  judgeColor,
  meanColor,
  PROBE_PALETTE,
  rgbDistance,
  type RGB,
} from '../src/lab/color.js';

/** Simulate a warm-lit room: gain on red/green, loss on blue, plus noise. */
function warmShift(c: RGB, noise = 0): RGB {
  return {
    r: Math.min(255, c.r + 18 + noise),
    g: Math.min(255, c.g + 8 + noise),
    b: Math.max(0, c.b - 22 - noise),
  };
}

describe('color probe math', () => {
  it('measures euclidean RGB distance', () => {
    expect(rgbDistance({ r: 255, g: 0, b: 0 }, { r: 255, g: 0, b: 0 })).toBe(0);
    expect(rgbDistance({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(
      441.67,
      1,
    );
  });

  it('classifies pure emitted colors to themselves with huge margins', () => {
    for (const entry of PROBE_PALETTE) {
      const c = classify(entry.sent);
      expect(c.match).toBe(entry.name);
      expect(c.margin).toBeGreaterThan(200);
    }
  });

  it('survives a realistic warm-light shift', () => {
    for (const entry of PROBE_PALETTE) {
      const received = warmShift(entry.sent, 6);
      const c = classify(received);
      expect(c.match).toBe(entry.name);
    }
  });

  it('fails honestly when hues smear together', () => {
    // Heavy orange cast: red drifts toward... still red, but a near-gray
    // ambiguous sample must not pass.
    const ambiguous: RGB = { r: 128, g: 120, b: 110 };
    const c = classify(ambiguous);
    expect(c.margin).toBeLessThan(60);
    const verdict = judgeColor('red', [ambiguous, ambiguous, ambiguous]);
    expect(verdict.pass).toBe(false);
  });

  it('passes tight clusters, fails misclassified samples', () => {
    const good: RGB[] = [
      { r: 244, g: 12, b: 8 },
      { r: 250, g: 6, b: 14 },
      { r: 238, g: 18, b: 4 },
    ];
    expect(judgeColor('red', good).pass).toBe(true);
    expect(judgeColor('red', []).pass).toBe(false);
    expect(judgeColor('red', [...good, { r: 10, g: 240, b: 12 }]).pass).toBe(false);
    expect(judgeColor('green', good).pass).toBe(false);
  });

  it('averages samples', () => {
    expect(
      meanColor([
        { r: 0, g: 0, b: 0 },
        { r: 100, g: 200, b: 50 },
      ]),
    ).toEqual({ r: 50, g: 100, b: 25 });
    expect(() => meanColor([])).toThrow();
  });
});
