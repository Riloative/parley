// The setup screens store keys from a masked prompt. storeKey() refuses a key
// with a control character; that must become a notice, never an unhandled
// rejection (which would take the interface down).
import { describe, expect, it } from 'vitest';
import { saveKey } from '../../src/ui/screens.js';

describe('saving a key from the setup screens', () => {
  it('a key with a control character gives an error notice, stores nothing, and does not throw', async () => {
    const notices: Array<[string, string | undefined]> = [];
    const ok = await saveKey('acme', 'sk-test-FAKE\t0123456789', (text, tone) => notices.push([text, tone]));
    expect(ok).toBe(false);
    expect(notices).toHaveLength(1);
    expect(notices[0]![1]).toBe('error');
    expect(notices[0]![0]).toMatch(/key/i);
    expect(notices[0]![0]).not.toContain('FAKE');
  });
});
