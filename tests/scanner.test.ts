import { describe, expect, it } from 'vitest';
import { describeCameraError } from '../src/camera/scanner.js';

function named(name: string): Error {
  const err = new Error('probe');
  err.name = name;
  return err;
}

describe('describeCameraError', () => {
  it('tells denied users exactly how to recover', () => {
    expect(describeCameraError(named('NotAllowedError'))).toMatch(/denied/i);
    expect(describeCameraError(named('NotAllowedError'))).toMatch(/site settings/i);
  });

  it('maps each platform failure to guidance', () => {
    expect(describeCameraError(named('SecurityError'))).toMatch(/HTTPS|localhost/);
    expect(describeCameraError(named('NotFoundError'))).toMatch(/No camera/);
    expect(describeCameraError(named('OverconstrainedError'))).toMatch(/photo/);
    expect(describeCameraError(named('NotReadableError'))).toMatch(/in use/);
    expect(describeCameraError(named('AbortError'))).toMatch(/try again/);
  });

  it('never returns an empty message for unknown failures', () => {
    expect(describeCameraError(named('WeirdError'))).toMatch(/WeirdError/);
    expect(describeCameraError(new Error('plain'))).toMatch(/Could not start/);
    expect(describeCameraError('a string')).toMatch(/Could not start/);
    expect(describeCameraError(undefined)).toMatch(/Could not start/);
  });
});
