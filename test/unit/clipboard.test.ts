// Which clipboard method /copy uses, for each kind of environment.
import { describe, expect, it } from 'vitest';
import { inWsl, osc52, planCopy, splitCommand, type ClipboardContext } from '../../src/term/clipboard.js';

const ctx = (env: NodeJS.ProcessEnv, tools: string[] = [], platform: NodeJS.Platform = 'linux', wsl = false): ClipboardContext => ({
  env,
  platform,
  has: (c) => tools.includes(c),
  wsl,
});
const names = (p: ReturnType<typeof planCopy>) => p.methods.map((m) => m.name);

describe('planCopy', () => {
  it('macOS: pbcopy, then OSC 52', () => {
    expect(names(planCopy({}, ctx({}, ['pbcopy'], 'darwin')))).toEqual(['pbcopy', 'OSC 52']);
  });

  it('Wayland: wl-copy first; XWayland tools after it', () => {
    const p = planCopy({}, ctx({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }, ['wl-copy', 'xclip']));
    expect(names(p)).toEqual(['wl-copy', 'xclip', 'OSC 52']);
    expect(p.skipped).toEqual(['xsel: not installed']);
  });

  it('X11: xclip, then xsel', () => {
    expect(names(planCopy({}, ctx({ DISPLAY: ':0' }, ['xclip', 'xsel'])))).toEqual(['xclip', 'xsel', 'OSC 52']);
  });

  it('a VTE terminal (GNOME Terminal, Ptyxis) without tools: nothing to try, and it says why', () => {
    const p = planCopy({}, ctx({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0', VTE_VERSION: '8002' }));
    expect(p.methods).toEqual([]);
    expect(p.skipped).toEqual(['wl-copy: not installed', 'xclip: not installed', 'xsel: not installed', expect.stringMatching(/^OSC 52: this terminal ignores it/)]);
    expect(p.hint).toMatch(/wl-clipboard/);
  });

  it('WSL: clip.exe (UTF-16), even when WSLg also sets WAYLAND_DISPLAY', () => {
    const p = planCopy({}, ctx({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0', WSL_DISTRO_NAME: 'Ubuntu' }, ['clip.exe', 'wl-copy'], 'linux', true));
    expect(names(p)).toEqual(['clip.exe', 'wl-copy', 'OSC 52']);
    expect(p.methods[0]).toMatchObject({ kind: 'command', encoding: 'utf16le-bom' });
  });

  it('WSL detection: by environment, or by /proc/version', () => {
    expect(inWsl({ WSL_DISTRO_NAME: 'Ubuntu' }, '')).toBe(true);
    expect(inWsl({}, 'Linux version 5.15.153.1-microsoft-standard-WSL2')).toBe(true);
    expect(inWsl({}, 'Linux version 6.8.0-45-generic (buildd@lcy02)')).toBe(false);
  });

  it('SSH: native tools are skipped (they would copy on the remote machine); OSC 52 to the local terminal', () => {
    const p = planCopy({}, ctx({ SSH_TTY: '/dev/pts/3', DISPLAY: 'localhost:10.0' }, ['xclip']));
    expect(names(p)).toEqual(['OSC 52']);
    expect(p.skipped[0]).toMatch(/SSH session/);
    // A VTE_VERSION forwarded over SSH says nothing about the local terminal.
    expect(names(planCopy({}, ctx({ SSH_TTY: '/dev/pts/3', VTE_VERSION: '8002' })))).toEqual(['OSC 52']);
  });

  it('tmux: its paste buffer before OSC 52, which is wrapped for passthrough', () => {
    const p = planCopy({}, ctx({ TMUX: '/tmp/tmux-1/default,1,0', TERM: 'tmux-256color' }));
    expect(names(p)).toEqual(['tmux', 'OSC 52']);
    expect(p.methods[1]).toMatchObject({ wrap: 'tmux' });
    expect(names(planCopy({}, ctx({ TMUX: '/tmp/t,1,0', VTE_VERSION: '8002' })))).toEqual(['tmux', 'OSC 52']);
  });

  it('GNU screen: OSC 52 in DCS pieces under its 768-byte limit', () => {
    const p = planCopy({}, ctx({ STY: '1234.pts-0.host' }));
    expect(p.methods[0]).toMatchObject({ kind: 'osc52', wrap: 'screen' });
    const seq = osc52('x'.repeat(3000), 'screen');
    const pieces = seq.split('\x1b\\').filter(Boolean);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.startsWith('\x1bP')).toBe(true);
      expect(piece.length).toBeLessThanOrEqual(768);
    }
    expect(pieces.map((x) => x.slice(2)).join('')).toBe(osc52('x'.repeat(3000), 'none'));
  });

  it('no graphical session and no terminal multiplexer: OSC 52 only', () => {
    const p = planCopy({}, ctx({}));
    expect(names(p)).toEqual(['OSC 52']);
    expect(p.skipped[0]).toMatch(/no graphical session/);
  });

  it('modes: native never uses OSC 52; osc52 uses only it, even where it is known to be ignored; off uses nothing', () => {
    const env = { WAYLAND_DISPLAY: 'wayland-0', VTE_VERSION: '8002' };
    expect(names(planCopy({ mode: 'native' }, ctx(env, ['wl-copy'])))).toEqual(['wl-copy']);
    expect(names(planCopy({ mode: 'native' }, ctx({ SSH_TTY: '/dev/pts/1', DISPLAY: ':10' }, ['xclip'])))).toEqual(['xclip']);
    expect(names(planCopy({ mode: 'osc52' }, ctx(env, ['wl-copy'])))).toEqual(['OSC 52']);
    expect(planCopy({ mode: 'off' }, ctx(env, ['wl-copy'])).methods).toEqual([]);
  });

  it('clipboard_command comes first, split into words without a shell', () => {
    const p = planCopy({ command: `my-copy --to "the clipboard" 'a b'` }, ctx({ DISPLAY: ':0' }, ['xclip']));
    expect(p.methods[0]).toMatchObject({ kind: 'command', name: 'my-copy', command: 'my-copy', args: ['--to', 'the clipboard', 'a b'] });
    expect(names(p)).toEqual(['my-copy', 'xclip', 'OSC 52']);
    expect(splitCommand('/usr/bin/wl-copy -p')).toEqual(['/usr/bin/wl-copy', '-p']);
    expect(planCopy({ command: 'x', mode: 'osc52' }, ctx({})).methods.map((m) => m.name)).toEqual(['OSC 52']);
  });

  it('OSC 52 bytes, plain and wrapped for tmux', () => {
    const b = Buffer.from('héllo').toString('base64');
    expect(osc52('héllo', 'none')).toBe(`\x1b]52;c;${b}\x07`);
    expect(osc52('héllo', 'tmux')).toBe(`\x1bPtmux;\x1b\x1b]52;c;${b}\x07\x1b\\`);
  });
});
