#!/usr/bin/env node
// Cache compiled bytecode between runs (Node 22.1+); this roughly halves the
// time spent compiling the bundled interface on every start.
import module from 'node:module';
try {
  module.enableCompileCache?.();
} catch {
  /* optional */
}
await import('../dist/cli.js');
