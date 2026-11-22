/** Compare the tools inventory with Git's index, including staged new files. */
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {repositoryNeutralEnv} from '../kernel/src/gitenv.ts';

const INVENTORY = 'tools/INVENTORY.md';
type Tier = 'commit' | 'push';
type Outcome = {check: string; tier: Tier; status: 'pass' | 'fail' | 'skip'; seconds: number; detail: string; caught: string};

export function inventoryChecks(root: string, tier: Tier = 'commit'): Outcome[] {
  const started = performance.now();
  const result = (status: Outcome['status'], detail: string): Outcome[] => [{
    check: 'tools.inventory', tier, status, seconds: (performance.now() - started) / 1000,
    detail, caught: 'missing, untracked and duplicate inventory paths, section 1952',
  }];
  const git = spawnSync('git', ['ls-files', '-z', '--', 'tools'], {cwd: root, env: repositoryNeutralEnv(), encoding: 'utf8', windowsHide: true, timeout: 60_000});
  if (git.status !== 0) return result('fail', 'git ls-files failed: ' + (git.stderr || git.error?.message || String(git.status)).trim());
  const tracked = new Set(git.stdout.split('\0').filter(Boolean));
  if (!tracked.has(INVENTORY)) return result('skip', INVENTORY + ' is not tracked in the repository being gated');
  let text: string;
  try { text = fs.readFileSync(path.join(root, INVENTORY), 'utf8'); }
  catch (error) { return result('fail', INVENTORY + ': ' + String(error)); }
  const rows = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*\|\s*`([^`]+)`\s*\|/.exec(line);
    if (match) rows.set(match[1]!, (rows.get(match[1]!) ?? 0) + 1);
  }
  const faults: string[] = [];
  for (const file of tracked) if (!rows.has(file)) faults.push('tracked file has no row: ' + file);
  for (const [file, count] of rows) {
    if (!tracked.has(file)) faults.push('row names an untracked file: ' + file);
    if (count > 1) faults.push('path listed twice: ' + file + ' (' + count + ' rows)');
  }
  return result(faults.length ? 'fail' : 'pass', faults.length ? faults.join('\n') : INVENTORY + ' is complete (' + tracked.size + ' tracked files)');
}

function main(args: string[]): number {
  if (args.length !== 1 || args[0] !== '--check') { process.stderr.write('Usage: node tools/inventory.mts --check\n'); return 1; }
  const outcome = inventoryChecks(process.cwd())[0]!;
  for (const line of outcome.detail.split('\n')) process.stdout.write('inventory: ' + line + '\n');
  if (outcome.status !== 'pass') process.stdout.write('inventory: check failed.\n');
  return outcome.status === 'pass' ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
