// Intake advisor: watches receiver statistics and recommends concrete sender
// adjustments. There is no backchannel (screen -> camera is unidirectional),
// so "auto-tune" means telling the USER what to change, live. Pure logic,
// fully unit-tested; the UI just renders headline + actions.

export type IntakeState =
  'idle' | 'no-signal' | 'lossy' | 'starved' | 'keeping-up' | 'locked';

export interface IntakeSnapshot {
  elapsedSec: number;
  totalScans: number;
  accepted: number;
  rejected: number;
  duplicates: number;
  hasMetadata: boolean;
  done: boolean;
}

export interface Advice {
  state: IntakeState;
  headline: string;
  actions: string[];
}

export function advise(snap: IntakeSnapshot): Advice {
  if (snap.done) {
    return { state: 'locked', headline: 'Transfer complete.', actions: [] };
  }
  if (snap.elapsedSec < 3 || snap.totalScans < 5) {
    return { state: 'idle', headline: 'Listening for frames…', actions: [] };
  }
  if (!snap.hasMetadata && snap.elapsedSec > 8) {
    return {
      state: 'no-signal',
      headline: 'No file header yet.',
      actions: [
        'Aim so the code fills the frame',
        'Raise sender Speed',
        'Try Scan from photo',
      ],
    };
  }
  const total = snap.accepted + snap.rejected + snap.duplicates;
  const rejectShare = total > 0 ? snap.rejected / total : 0;
  const dupShare = total > 0 ? snap.duplicates / total : 0;
  const rate = snap.elapsedSec > 0 ? snap.accepted / snap.elapsedSec : 0;
  if (total > 20 && rejectShare > 0.25) {
    return {
      state: 'lossy',
      headline: 'Many frames failing checks.',
      actions: ['Move closer', 'Raise sender brightness', 'Hold both devices steady'],
    };
  }
  if (snap.elapsedSec > 10 && rate < 1.5) {
    return {
      state: 'starved',
      headline: 'Frames trickling in.',
      actions: ['Raise sender Speed or density', 'Check the code fills the frame'],
    };
  }
  if (dupShare > 0.4 && rate >= 1.5) {
    return {
      state: 'keeping-up',
      headline: 'Keeping up easily — headroom to go faster.',
      actions: ['Raise sender Speed or density'],
    };
  }
  return { state: 'locked', headline: 'Locked on — hold steady.', actions: [] };
}
