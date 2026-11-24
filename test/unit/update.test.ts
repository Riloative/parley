import { describe, expect, it } from 'vitest';
import { isNewer, parseVersion } from '../../src/core/update.js';

describe('version comparison', () => {
  it('compares numerically and ignores anything that is not X.Y.Z', () => {
    expect(parseVersion('v1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion('1.2.3-beta.1')).toBeUndefined();
    expect(isNewer('0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('v0.2.0', '0.1.0')).toBe(true);
    expect(isNewer('0.2.0', '0.2.0')).toBe(false);
    expect(isNewer('0.1.9', '0.2.0')).toBe(false);
    expect(isNewer('1.0.0-rc.1', '0.2.0')).toBe(false);
    expect(isNewer('nonsense', '0.2.0')).toBe(false);
    expect(isNewer('1.0.0', '0.0.0-dev')).toBe(false);
  });
});
