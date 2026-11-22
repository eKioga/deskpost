/** A read-only code balance reading from a repository's ordered bucket rules (c172). */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repositoryNeutralEnv } from './gitenv.ts';

type Counts = { added: number; removed: number; net: number; binary_files: number };
type FileCount = Counts & { path: string; bucket: string };
type BalanceConfig = { schema: 1; buckets: Record<string, string[]>; heavy: number; bloated: number };
const empty = (): Counts => ({ added: 0, removed: 0, net: 0, binary_files: 0 });
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const escape = (s: string): string => s.replace(/[\x00-\x1f\x7f-\x9f]/g, c =>
  c === '\t' ? '\\t' : c === '\n' ? '\\n' : c === '\r' ? '\\r' : '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

export function readBalanceConfig(repo: string): BalanceConfig {
  const file = path.join(repo, '.deskpost/code-balance.json');
  const bad = (key: string): never => { throw Error(`${file}: invalid ${key}. Use schema 1, buckets as an ordered object of names to glob lists, and optional heavy and bloated numbers.`); };
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { throw Error(`${file}: cannot read the code balance setting (${(e as Error).message}). Use {"schema":1,"buckets":{"product":["src/**"],"tests":["test/**"],"tools":["tools/**"],"docs":["**/*.md"]}}.`); }
  if (!object(value) || value.schema !== 1) bad('schema');
  const v = value as Record<string, unknown>;
  if (!object(v.buckets) || Object.keys(v.buckets).length === 0) bad('buckets');
  for (const [name, globs] of Object.entries(v.buckets as Record<string, unknown>)) {
    if (!name || name === 'other' || /[\x00-\x1f\x7f-\x9f]/.test(name) || !Array.isArray(globs) || globs.some(g => typeof g !== 'string' || g.length === 0)) bad(`buckets.${name}`);
  }
  const heavy = v.heavy === undefined ? 3 : v.heavy;
  const bloated = v.bloated === undefined ? 6 : v.bloated;
  if (typeof heavy !== 'number' || !Number.isFinite(heavy) || heavy < 0) bad('heavy');
  if (typeof bloated !== 'number' || !Number.isFinite(bloated) || bloated < (heavy as number)) bad('bloated');
  return {schema: 1, buckets: v.buckets as Record<string, string[]>, heavy: heavy as number, bloated: bloated as number};
}

/** A double star followed by a slash may match zero directories; a single star stays in one name. */
function glob(pattern: string): RegExp {
  let result = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') { result += '(?:.*/)?'; i++; } else result += '.*';
    } else if (c === '*') result += '[^/]*';
    else result += c!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(result + '$', 's');
}

export function auditBalance(options: { repo?: string; base?: string; tip?: string; since?: string }) {
  const since = options.since !== undefined;
  if (since ? !options.since?.trim() || options.base !== undefined : !options.base || !options.tip) {
    throw Error('Use audit balance <base> <tip>, or audit balance --since <date> [--tip <ref>].');
  }
  const git = (args: string[], cwd: string): string => {
    const r = spawnSync('git', args, {cwd, env: repositoryNeutralEnv({...process.env, GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0'}), encoding: 'utf8', maxBuffer: 128 * 1024 * 1024});
    if (r.error || r.status !== 0) throw Error(`Code balance: ${escape(r.stderr.trim() || String(r.error ?? r.status))}`);
    return r.stdout;
  };
  const repo = git(['rev-parse', '--show-toplevel'], path.resolve(options.repo ?? process.cwd())).trimEnd();
  const config = readBalanceConfig(repo);
  const resolve = (ref: string): string => {
    try { return git(['rev-parse', '--verify', '--end-of-options', ref + '^{commit}'], repo).trim(); }
    catch { throw Error(`Cannot resolve ref ${escape(ref)}. Run git fetch in ${escape(repo)} and check the ref.`); }
  };
  const tip = resolve(options.tip ?? 'HEAD');
  const base = since ? git(['rev-list', '-1', '--before=' + options.since, tip], repo).trim() : resolve(options.base!);
  if (!base) throw Error(`No commit before ${escape(options.since!)} in ${escape(options.tip ?? 'HEAD')}. Choose a later date.`);
  const rules = Object.entries(config.buckets).map(([name, patterns]) => ({name, patterns: patterns.map(glob)}));
  const buckets: Record<string, Counts> = Object.fromEntries(rules.map(r => [r.name, empty()]));
  buckets.other = empty();
  const files: FileCount[] = [];
  for (const record of git(['diff', '--numstat', '--no-renames', '-z', base, tip, '--'], repo).split('\0')) {
    if (!record) continue;
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record);
    if (!match) throw Error('Code balance: Git returned an invalid line count record.');
    const [, added, removed, file] = match;
    const bucket = rules.find(r => r.patterns.some(p => p.test(file!)))?.name ?? 'other';
    const binary = added === '-' || removed === '-';
    const count = {added: binary ? 0 : Number(added), removed: binary ? 0 : Number(removed), net: 0, binary_files: binary ? 1 : 0};
    count.net = count.added - count.removed;
    files.push({path: file!, bucket, ...count});
    for (const key of ['added', 'removed', 'net', 'binary_files'] as const) buckets[bucket]![key] += count[key];
  }
  const product = buckets.product ?? empty(), tests = buckets.tests ?? empty(), tools = buckets.tools ?? empty();
  const support = tests.added + tools.added;
  const rawRatio = product.added > 0 ? support / product.added : null;
  const ratio = rawRatio === null ? null : Number(rawRatio.toFixed(1));
  const verdict = product.added + product.removed + support + tests.removed + tools.removed === 0 ? 'no code'
    : tests.net + tools.net < 0 && product.added <= 50 ? 'tidy'
    : product.added === 0 && product.removed > 0 && support === 0 ? 'product-removal'
    : product.added === 0 && support > 0 ? 'test-only'
    : rawRatio !== null && rawRatio > config.bloated ? 'BLOATED'
    : rawRatio !== null && rawRatio > config.heavy ? 'HEAVY' : 'BALANCED';
  const largest = (rows: FileCount[], n: number) => rows.sort((a, b) => b.added - a.added || b.removed - a.removed || a.path.localeCompare(b.path)).slice(0, n);
  const biggest = ['HEAVY', 'BLOATED'].includes(verdict) ? largest(files.filter(f => ['tests', 'tools'].includes(f.bucket)), 5) : [];
  const value = {base, tip, config_path: path.join(repo, '.deskpost/code-balance.json'), thresholds: {heavy: config.heavy, bloated: config.bloated},
    buckets, ratio, verdict, biggest, other: {...buckets.other!, paths: largest(files.filter(f => f.bucket === 'other'), 10)}};
  const counts = (name: string, c: Counts) => `${escape(name)} +${c.added} -${c.removed} net ${c.net >= 0 ? '+' : ''}${c.net}` + (c.binary_files ? `; binary files ${c.binary_files}` : '');
  const lines = [`Code balance ${base.slice(0, 8)}..${tip.slice(0, 8)}: ${verdict} (${ratio === null ? 'none' : ratio.toFixed(1)} lines of tests and tools per product line)`];
  for (const name of ['product', 'tests', 'tools', 'docs']) lines.push(counts(name, buckets[name] ?? empty()) + (name === 'docs' ? ' (not judged)' : ''));
  const extra = Object.entries(buckets).filter(([n]) => !['product', 'tests', 'tools', 'docs'].includes(n)).map(([n, c]) => counts(n, c));
  if (biggest.length) extra.push('biggest: ' + biggest.map(f => `${escape(f.path)} +${f.added}`).join(', '));
  if (extra.length) lines.push(extra.join('; '));
  return {value, text: lines.join('\n')};
}
