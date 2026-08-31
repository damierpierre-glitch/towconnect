import { describe, expect, it } from 'vitest';
import { PROBLEM_TYPES, problemRequiresDestination } from './constants';

describe('problemRequiresDestination', () => {
  it('requires a destination for towing-style problems (mechanical, accident)', () => {
    expect(problemRequiresDestination('mechanical')).toBe(true);
    expect(problemRequiresDestination('accident')).toBe(true);
  });

  it('does not require a destination for on-site services named in the Phase 4 brief', () => {
    expect(problemRequiresDestination('battery')).toBe(false);
    expect(problemRequiresDestination('lockout')).toBe(false);
    expect(problemRequiresDestination('flat_tire')).toBe(false);
    expect(problemRequiresDestination('out_of_gas')).toBe(false);
  });

  it('falls back to false for an unknown problem type rather than throwing', () => {
    expect(problemRequiresDestination('not_a_real_type')).toBe(false);
  });

  it('every PROBLEM_TYPES entry explicitly declares requiresDestination', () => {
    for (const p of PROBLEM_TYPES) {
      expect(typeof p.requiresDestination).toBe('boolean');
    }
  });
});
