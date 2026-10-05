import { describe, expect, it } from 'vitest';
import { INK_COLORS, luminance, type InkName } from '../src/qr/paint.js';

describe('ink palette', () => {
  it('offers exactly black + pure R/G/B', () => {
    expect(Object.keys(INK_COLORS).sort()).toEqual(['black', 'blue', 'green', 'red']);
  });

  it('luminance ordering matches decoder reality', () => {
    // Decoders read luminance: black darkest, then blue, red, green lightest.
    // Green sits far from black — the documented reason it may scan worse.
    const l = (n: InkName): number => luminance(INK_COLORS[n]);
    expect(l('black')).toBe(0);
    expect(l('blue')).toBeLessThan(l('red'));
    expect(l('red')).toBeLessThan(l('green'));
    expect(l('green')).toBeLessThan(luminance('#ffffff'));
    expect(l('blue')).toBeLessThan(30);
    expect(l('green')).toBeGreaterThan(150);
  });
});
