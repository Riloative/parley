// Command-line arguments → Args. No side effects, so tests can import it
// (importing cli.ts runs the program).

export interface Args {
  print: boolean;
  prompt?: string;
  model?: string;
  system?: string;
  continue: boolean;
  resume: boolean;
  resumeId?: string;
  json: boolean;
  debug: boolean;
  debugFile?: string;
  noColor: boolean;
  theme?: string;
  command?: 'doctor' | 'key' | 'help' | 'version' | 'completions' | 'man';
  rest: string[];
}

export function parseArgs(argv: string[]): Args | { error: string } {
  const a: Args = { print: false, continue: false, resume: false, json: false, debug: false, noColor: false, rest: [] };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || (v.startsWith('-') && v !== '-')) return undefined;
      i++;
      return v;
    };
    const need = (name: string) => {
      const v = next();
      if (v === undefined) throw new Error(`${name} needs a value`);
      return v;
    };
    try {
      if (arg === '--') {
        positional.push(...argv.slice(i + 1));
        break;
      }
      if (arg.startsWith('--') && arg.includes('=')) {
        const [k, ...v] = arg.split('=');
        argv.splice(i + 1, 0, v.join('='));
        argv[i] = k!;
        i--;
        continue;
      }
      switch (arg) {
        case '-p':
        case '--print':
          a.print = true;
          break;
        case '-m':
        case '--model':
          a.model = need(arg);
          break;
        case '-s':
        case '--system':
          a.system = need(arg);
          break;
        case '-c':
        case '--continue':
          a.continue = true;
          break;
        case '-r':
        case '--resume':
          a.resume = true;
          a.resumeId = next();
          break;
        case '--json':
          a.json = true;
          break;
        case '--debug':
          a.debug = true;
          a.debugFile = next();
          break;
        case '--no-color':
          a.noColor = true;
          break;
        case '--theme':
          a.theme = need(arg);
          break;
        case '-h':
        case '--help':
          a.command = 'help';
          break;
        case '-v':
        case '--version':
          a.command = 'version';
          break;
        default:
          if (arg.startsWith('-') && arg !== '-') return { error: `Unknown option ${arg}. Run taria --help.` };
          positional.push(arg);
      }
    } catch (e) {
      return { error: `${(e as Error).message}. Run taria --help.` };
    }
  }
  if (!a.command && (positional[0] === 'doctor' || positional[0] === 'key' || positional[0] === 'completions' || positional[0] === 'man')) {
    a.command = positional[0];
    a.rest = positional.slice(1);
  } else if (positional.length) {
    a.prompt = positional.join(' ');
  }
  return a;
}
