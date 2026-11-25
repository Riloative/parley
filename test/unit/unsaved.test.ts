// A conversation whose file cannot be created (read-only file system, full
// disk, no permission) goes on unsaved, with one plain notice. Nothing is
// thrown into the interface, and no half-written file is started later.
import { describe, expect, it } from 'vitest';
import { storageProblem } from '../../src/core/store.js';

const err = (code: string, message = `${code}: something, open '/data/taria/conversations/x.jsonl.lock'`) => Object.assign(new Error(message), { code });

describe('storageProblem(): a file error in plain words', () => {
  it('names the usual causes without Node\'s wording', () => {
    expect(storageProblem(err('EROFS'), '/data/taria/conversations')).toBe('/data/taria/conversations is on a read-only file system.');
    expect(storageProblem(err('EACCES'), '/d')).toBe('you do not have permission to write in /d.');
    expect(storageProblem(err('EPERM'), '/d')).toBe('you do not have permission to write in /d.');
    expect(storageProblem(err('ENOSPC'), '/d')).toBe('the disk that holds /d is full.');
    expect(storageProblem(err('EDQUOT'), '/d')).toBe('the disk that holds /d is full.');
    expect(storageProblem(err('EEXIST'), '/d')).toBe('/d exists but is not a folder.');
    expect(storageProblem(err('ENOTDIR'), '/d')).toBe('/d exists but is not a folder.');
  });
  it('falls back to the system message, without a stack', () => {
    expect(storageProblem(err('EIO', 'EIO: i/o error, write'), '/d')).toBe('EIO: i/o error, write (/d).');
  });
});
