// Pure color-classification helpers for the Lab color probe.
// Question under test: do emitted-pure R/G/B survive screen -> camera with
// enough margin to carry data? The camera never receives pure colors
// (white balance, ambient light, sensor crosstalk all shift hues), so the
// probe measures received clusters against the emitted palette and reports
// separation margins. DOM-free and fully unit-tested.

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface PaletteEntry {
  name: string;
  sent: RGB;
}

/** Emitted reference palette: pure channels only, no shades. */
export const PROBE_PALETTE: PaletteEntry[] = [
  { name: 'white', sent: { r: 255, g: 255, b: 255 } },
  { name: 'black', sent: { r: 0, g: 0, b: 0 } },
  { name: 'red', sent: { r: 255, g: 0, b: 0 } },
  { name: 'green', sent: { r: 0, g: 255, b: 0 } },
  { name: 'blue', sent: { r: 0, g: 0, b: 255 } },
];

/** Euclidean distance in RGB space (0..~442). */
export function rgbDistance(a: RGB, b: RGB): number {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

export interface Classification {
  /** Palette name of the nearest emitted color. */
  match: string;
  nearest: number;
  secondNearest: number;
  /** Gap between best and runner-up: the safety margin for decoding. */
  margin: number;
}

/** Nearest-palette classification of one received sample. */
export function classify(
  sample: RGB,
  palette: PaletteEntry[] = PROBE_PALETTE,
): Classification {
  let best = '';
  let nearest = Number.POSITIVE_INFINITY;
  let second = Number.POSITIVE_INFINITY;
  for (const entry of palette) {
    const d = rgbDistance(sample, entry.sent);
    if (d < nearest) {
      second = nearest;
      nearest = d;
      best = entry.name;
    } else if (d < second) {
      second = d;
    }
  }
  return { match: best, nearest, secondNearest: second, margin: second - nearest };
}

/** Mean of several samples (steadies hand tremor / sensor noise). */
export function meanColor(samples: RGB[]): RGB {
  if (samples.length === 0) throw new Error('no samples');
  let r = 0;
  let g = 0;
  let b = 0;
  for (const s of samples) {
    r += s.r;
    g += s.g;
    b += s.b;
  }
  const n = samples.length;
  return { r: r / n, g: g / n, b: b / n };
}

export interface ColorVerdict {
  pass: boolean;
  samples: number;
  mean: RGB;
  classifiedAs: string;
  worstMargin: number;
  reason: string;
}

/**
 * Verdict for one emitted color: every sample must classify to the expected
 * palette entry with at least `minMargin` to the runner-up. Anything less
 * means hues smear into each other in this lighting — color cannot safely
 * carry data here.
 */
export function judgeColor(
  expectedName: string,
  samples: RGB[],
  minMargin = 60,
): ColorVerdict {
  if (samples.length === 0) {
    return {
      pass: false,
      samples: 0,
      mean: { r: 0, g: 0, b: 0 },
      classifiedAs: '—',
      worstMargin: 0,
      reason: 'no samples captured',
    };
  }
  const mean = meanColor(samples);
  let worstMargin = Number.POSITIVE_INFINITY;
  let classifiedAs = '';
  for (const s of samples) {
    const c = classify(s);
    classifiedAs = c.match;
    if (c.match !== expectedName) {
      return {
        pass: false,
        samples: samples.length,
        mean,
        classifiedAs: c.match,
        worstMargin: c.margin,
        reason: `a sample classified as ${c.match} instead of ${expectedName}`,
      };
    }
    if (c.margin < worstMargin) worstMargin = c.margin;
  }
  if (worstMargin < minMargin) {
    return {
      pass: false,
      samples: samples.length,
      mean,
      classifiedAs,
      worstMargin,
      reason: `margin ${worstMargin.toFixed(0)} below safe threshold ${minMargin} — hues overlap in this light`,
    };
  }
  return {
    pass: true,
    samples: samples.length,
    mean,
    classifiedAs,
    worstMargin,
    reason: `cleanly separable (worst margin ${worstMargin.toFixed(0)})`,
  };
}
