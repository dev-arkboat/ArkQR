import { describe, expect, it } from 'vitest';
import { advise, type IntakeSnapshot } from '../src/advisor/advise.js';

const base: IntakeSnapshot = {
  elapsedSec: 30,
  totalScans: 100,
  accepted: 80,
  rejected: 10,
  duplicates: 10,
  hasMetadata: true,
  done: false,
};

describe('advise', () => {
  it('stays quiet while warming up', () => {
    expect(advise({ ...base, elapsedSec: 1, totalScans: 2 }).state).toBe('idle');
  });

  it('flags missing metadata', () => {
    const a = advise({
      ...base,
      hasMetadata: false,
      accepted: 0,
      rejected: 90,
      duplicates: 0,
    });
    expect(a.state).toBe('no-signal');
    expect(a.actions.length).toBeGreaterThan(0);
  });

  it('flags lossy intake', () => {
    const a = advise({ ...base, accepted: 40, rejected: 50, duplicates: 10 });
    expect(a.state).toBe('lossy');
    expect(a.headline).toMatch(/failing checks/);
  });

  it('flags starvation', () => {
    const a = advise({
      ...base,
      accepted: 12,
      rejected: 2,
      duplicates: 1,
      elapsedSec: 20,
    });
    expect(a.state).toBe('starved');
  });

  it('spots headroom', () => {
    const a = advise({ ...base, accepted: 50, rejected: 2, duplicates: 48 });
    expect(a.state).toBe('keeping-up');
  });

  it('reassures on a healthy stream and on completion', () => {
    expect(advise(base).state).toBe('locked');
    expect(advise({ ...base, done: true }).actions).toEqual([]);
  });

  it('prioritizes loss over starvation', () => {
    // Slow AND lossy: fix the signal first.
    const a = advise({
      ...base,
      accepted: 10,
      rejected: 60,
      duplicates: 5,
      elapsedSec: 30,
    });
    expect(a.state).toBe('lossy');
  });
});
