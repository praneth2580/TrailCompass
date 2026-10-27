import { describe, expect, it } from 'vitest';
import { formatSavedAt } from './route-naming';

describe('formatSavedAt', () => {
  const now = new Date(2026, 9, 27, 18, 0);
  const at = (...args: [number, number, number, number?]) =>
    new Date(args[0], args[1], args[2], args[3] ?? 9).toISOString();

  it('says today with the time, then yesterday, then days ago', () => {
    expect(formatSavedAt(at(2026, 9, 27, 7), now)).toMatch(/^today /);
    expect(formatSavedAt(at(2026, 9, 26, 23), now)).toBe('yesterday');
    expect(formatSavedAt(at(2026, 9, 24), now)).toBe('3 days ago');
  });

  it('gives the date after a week, with the year only when it differs', () => {
    expect(formatSavedAt(at(2026, 9, 18), now)).toMatch(/18/);
    expect(formatSavedAt(at(2026, 9, 18), now)).not.toMatch(/2026/);
    expect(formatSavedAt(at(2025, 11, 30), now)).toMatch(/2025/);
  });
});
