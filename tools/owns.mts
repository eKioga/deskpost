/** c95: keep the running Kickoff's whole-file ownership in this worktree's Git folder. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ownsPaths, ownsPatternMatches, SENSITIVE_PATHS } from '../kernel/src/kickoffcheck.ts';

const KICKOFF_BRANCH = /^(codex|int|dev)\/[cs]\d+(-r\d+)?$/;
const BUILDER_BRANCH = /^(codex|int|dev)\//;
const oneLine = (message: string) => message.replace(/[\r\n]+/g, ' ');
function git(...args: string[]): string {
  const r = spawnSync('git', args, { encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) throw Error('Git: ' + (r.error?.message || (r.stderr || r.stdout).trim().split(/\r?\n/)[0] || `exit ${r.status}`));
  return r.stdout;
}
function branchName(): string {
  const r = spawnSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (r.status === 1) return ''; // Detached HEAD.
  if (r.status !== 0) throw Error('Git: ' + (r.error?.message || (r.stderr || r.stdout).trim().split(/\r?\n/)[0] || `exit ${r.status}`));
  return r.stdout.trim();
}
type Ownership = { schema: 1; branch: string; kickoff_title: string; kickoff_sha256: string; patterns: string[]; written_utc: string; replaced_sha256: string | null };
function recordPath(branch: string): string {
  return path.resolve(git('rev-parse', '--git-path', 'deskpost-owns/' + branch.replaceAll('/', '%2F') + '.json').trim());
}
function readRecord(file: string, branch: string): Ownership {
  try {
    const r = JSON.parse(fs.readFileSync(file, 'utf8')) as Ownership;
    if (!r || r.schema !== 1 || r.branch !== branch || !Array.isArray(r.patterns) || !r.patterns.every(p => typeof p === 'string')) throw Error('invalid schema, branch or patterns');
    const parsed = ownsPaths('OWNS PATHS:\n' + r.patterns.map(p => '- `' + p + '`').join('\n') + '\nSTAY OUT OF: none');
    if (parsed.problems.length || JSON.stringify(parsed.patterns) !== JSON.stringify(r.patterns)) throw Error('invalid OWNS PATHS patterns');
    if (typeof r.kickoff_title !== 'string' || !/^[a-f0-9]{64}$/.test(r.kickoff_sha256) || typeof r.written_utc !== 'string' || !Number.isFinite(Date.parse(r.written_utc)) ||
        !(r.replaced_sha256 === null || typeof r.replaced_sha256 === 'string' && /^[a-f0-9]{64}$/.test(r.replaced_sha256))) throw Error('invalid record metadata');
    return r;
  } catch (error) { throw Error(`record ${file}: ${oneLine((error as Error).message)}`); }
}
function stagedPaths(): string[] {
  const tokens = git('diff', '--cached', '--name-status', '-M', '-z').split('\0');
  const paths: string[] = [];
  for (let i = 0; i < tokens.length - 1;) {
    const status = tokens[i++]!;
    const count = /^[RC]/.test(status) ? 2 : 1;
    for (let n = 0; n < count; n++) {
      const file = tokens[i++];
      if (file === undefined || file === '') throw Error('Git: incomplete staged path output');
      paths.push(file);
    }
  }
  return [...new Set(paths)];
}
function mergedPaths(): Set<string> {
  const file = git('rev-parse', '--git-path', 'MERGE_HEAD').trim();
  const merged = new Set<string>();
  try {
    for (const commit of fs.readFileSync(file, 'utf8').trim().split(/\r?\n/)) {
      const base = git('merge-base', 'HEAD', commit).trim();
      for (const p of git('diff', '--no-renames', '--name-only', '-z', `${base}..${commit}`).split('\0').filter(Boolean)) merged.add(p);
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return merged;
}
function main(args: string[]): number {
  if (args[0] !== 'start' && args[0] !== 'check' || args[0] === 'check' && args.length !== 1) throw Error('usage: node tools/owns.mts start --kickoff <file> --sha256 <64 hex> | check');
  const branch = branchName();
  if (args[0] === 'check' && !KICKOFF_BRANCH.test(branch)) {
    if (BUILDER_BRANCH.test(branch)) throw Error(`${branch} is a builder branch but not a unit id (codex, int or dev, then c or s and a number, then -rN for a revision); rename it before committing. Nothing was committed.`);
    return 0;
  }
  if (!KICKOFF_BRANCH.test(branch)) throw Error('start requires a Kickoff branch (codex, int or dev with a unit id)');
  const file = recordPath(branch);
  if (args[0] === 'start') {
    if (args.length !== 5 || args[1] !== '--kickoff' || args[3] !== '--sha256' || !/^[a-fA-F0-9]{64}$/.test(args[4]!)) throw Error('usage: node tools/owns.mts start --kickoff <file> --sha256 <64 hex>');
    const bytes = fs.readFileSync(args[2]!);
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== args[4]!.toLowerCase()) throw Error('SHA-256 mismatch for ' + args[2]);
    const text = bytes.toString('utf8'), parsed = ownsPaths(text);
    if (parsed.problems.length) throw Error(parsed.problems.join('; '));
    let previous: Ownership | null = null;
    try { fs.statSync(file); previous = readRecord(file, branch); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const record: Ownership = { schema: 1, branch, kickoff_title: text.split(/\r?\n/)[0]!, kickoff_sha256: hash, patterns: parsed.patterns, written_utc: new Date().toISOString(), replaced_sha256: previous?.kickoff_sha256 ?? null };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + '.' + randomUUID() + '.tmp';
    try { fs.writeFileSync(temp, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' }); fs.renameSync(temp, file); }
    finally { try { fs.unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
    for (const pattern of record.patterns) process.stdout.write('OWNS PATHS: ' + pattern + '\n');
    process.stdout.write('record: ' + file + '\n');
    if (previous) process.stdout.write('replaced SHA-256: ' + previous.kickoff_sha256 + '\n');
    return 0;
  }
  if (!fs.existsSync(file)) throw Error(`${branch}: no record; run node tools/owns.mts start --kickoff <file> --sha256 <hash>`);
  const record = readRecord(file, branch), merged = mergedPaths();
  const refused = stagedPaths().flatMap(p => {
    if (record.patterns.length === 1 && record.patterns[0] === 'none') return [JSON.stringify(p) + ': this Kickoff owns no tracked file (OWNS PATHS: none)'];
    if (merged.has(p)) return [];
    if (!record.patterns.some(pattern => ownsPatternMatches(pattern, p))) return [JSON.stringify(p) + ': not in OWNS PATHS'];
    const sensitive = SENSITIVE_PATHS.flatMap((pattern, index) => { pattern.lastIndex = 0; const matches = pattern.test(p); pattern.lastIndex = 0; return matches ? [index] : []; });
    if (!sensitive.length || record.patterns.includes(p)) return [];
    if (sensitive.length === 1 && sensitive[0] === 2 && p.split('/').slice(0, -1).includes('fixtures') &&
        record.patterns.some(pattern => pattern.includes('*') && pattern.split('/').includes('fixtures') && ownsPatternMatches(pattern, p))) {
      process.stdout.write('sensitive fixture accepted: ' + p + '\n');
      return [];
    }
    return [JSON.stringify(p) + ': sensitive: must be named by itself in OWNS PATHS, which needs the Second read line'];
  });
  if (!refused.length) return 0;
  process.stderr.write(refused.slice(0, 10).join('\n') + '\npark the row and say which file and why in the handback; never edit a file outside OWNS (RULE 3(f)). Nothing was committed.\n');
  return 1;
}
try { process.exitCode = main(process.argv.slice(2)); }
catch (error) { process.stderr.write('owns: ' + oneLine((error as Error).message) + '\n'); process.exitCode = 1; }
