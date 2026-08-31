import { describe, expect, it } from 'vitest';
import { distanceKm, estimateEtaMinutes, estimatePrice, estimatePriceBreakdown, toMoney } from './pricing';

describe('estimatePrice', () => {
  it('applies the base fare plus per-km rate with no surcharge', () => {
    // base 45 + 10km * 2.25 = 67.5
    expect(estimatePrice(10, 'battery')).toBeCloseTo(67.5, 2);
  });

  it('adds the accident surcharge', () => {
    // base 45 + 10km * 2.25 + 30 = 97.5
    expect(estimatePrice(10, 'accident')).toBeCloseTo(97.5, 2);
  });

  it('ignores unknown problem types (treats as zero surcharge)', () => {
    expect(estimatePrice(0, 'unknown_type')).toBeCloseTo(45, 2);
  });

  it('rounds to the nearest cent', () => {
    const price = estimatePrice(3.333, 'battery');
    expect(price).toBe(Math.round(price * 100) / 100);
  });

  it('never returns a negative price for zero distance', () => {
    expect(estimatePrice(0, 'battery')).toBeGreaterThan(0);
  });
});

describe('estimatePriceBreakdown', () => {
  it('matches estimatePrice() when there is no tow distance (on-site service)', () => {
    const breakdown = estimatePriceBreakdown({ driverDistanceKm: 10, problemType: 'battery' });
    expect(breakdown.total).toBeCloseTo(estimatePrice(10, 'battery'), 2);
    expect(breakdown.base).toBeCloseTo(45, 2);
    expect(breakdown.distance).toBeCloseTo(22.5, 2);
    expect(breakdown.surcharge).toBe(0);
  });

  it('bills the tow distance (pickup -> destination) in addition to the approach distance', () => {
    // base 45 + (5km approach + 20km tow) * 2.25 + 30 (accident) = 131.25
    const breakdown = estimatePriceBreakdown({ driverDistanceKm: 5, towDistanceKm: 20, problemType: 'accident' });
    expect(breakdown.total).toBeCloseTo(131.25, 2);
    expect(breakdown.distance).toBeCloseTo(56.25, 2);
    expect(breakdown.surcharge).toBe(30);
  });

  it('the breakdown always sums to the total (transparent line items)', () => {
    const breakdown = estimatePriceBreakdown({ driverDistanceKm: 7.4, towDistanceKm: 12.1, problemType: 'mechanical' });
    expect(breakdown.base + breakdown.distance + breakdown.surcharge).toBeCloseTo(breakdown.total, 2);
  });

  it('treats a missing tow distance as zero, not a crash or NaN', () => {
    const breakdown = estimatePriceBreakdown({ driverDistanceKm: 8, problemType: 'lockout' });
    expect(Number.isFinite(breakdown.total)).toBe(true);
  });
});

describe('distanceKm', () => {
  it('returns 0 for identical points', () => {
    const p = { lat: 45.5019, lng: -73.5674 };
    expect(distanceKm(p, p)).toBeCloseTo(0, 6);
  });

  it('is symmetric', () => {
    const a = { lat: 45.5019, lng: -73.5674 }; // Montreal
    const b = { lat: 43.6532, lng: -79.3832 }; // Toronto
    expect(distanceKm(a, b)).toBeCloseTo(distanceKm(b, a), 6);
  });

  it('matches the known Montreal-Toronto great-circle distance (~505km)', () => {
    const montreal = { lat: 45.5019, lng: -73.5674 };
    const toronto = { lat: 43.6532, lng: -79.3832 };
    expect(distanceKm(montreal, toronto)).toBeGreaterThan(490);
    expect(distanceKm(montreal, toronto)).toBeLessThan(520);
  });

  it('is small for two nearby points', () => {
    const a = { lat: 45.5019, lng: -73.5674 };
    const b = { lat: 45.51, lng: -73.57 };
    expect(distanceKm(a, b)).toBeLessThan(2);
  });
});

describe('estimateEtaMinutes', () => {
  it('has a floor of 3 minutes even for near-zero distance', () => {
    expect(estimateEtaMinutes(0)).toBe(3);
    expect(estimateEtaMinutes(0.1)).toBe(3);
  });

  it('scales roughly linearly with distance', () => {
    const near = estimateEtaMinutes(10);
    const far = estimateEtaMinutes(100);
    expect(far).toBeGreaterThan(near);
  });
});

describe('toMoney', () => {
  it('parses a numeric-column string as returned by PostgREST', () => {
    expect(toMoney('95.00')).toBe(95);
    expect(toMoney('12.50')).toBe(12.5);
  });

  it('passes through an actual number unchanged', () => {
    expect(toMoney(42)).toBe(42);
  });

  it('falls back to 0 for null/undefined/garbage', () => {
    expect(toMoney(null)).toBe(0);
    expect(toMoney(undefined)).toBe(0);
    expect(toMoney('not-a-number')).toBe(0);
  });
});
