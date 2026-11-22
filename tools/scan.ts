/** Identity (index bytes) and deployment (product working files) scans.
 * DeploymentScan.ps1 remains the oracle until the PowerShell retirement.
 * Exit 0: pass/warn, 1: a finding or required denylist missing, 2: scan failed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveWorkspace } from '../kernel/src/workspace.ts';
import { repositoryNeutralEnv } from '../kernel/src/gitenv.ts';
import { deploymentDenylist, identityHits, lineAt, occurrences } from '../kernel/src/identityterms.ts';

export { deploymentDenylist, identityHits };

export interface Hit { file?: string; source?: string; line: number; kind: string; match: string }
export interface Scan { status: 'pass' | 'warn' | 'fail'; detail: string; hits: Hit[]; gitleaks?: { ran: boolean; clean: boolean; detail: string } }
const excluded = [/^PLAN[^/]*\.md$/i, /^codex-verdict\.txt$/i, /(^|\/)settings\.local\.json$/i];
const product = (file: string) => !excluded.some(rule => rule.test(file));
const sorted = (items: string[]) => [...new Set(items)].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
const scanGitEnv = (() => {
  const environments = new Map<string, NodeJS.ProcessEnv>();
  let caller: string | null | undefined;
  // Compare worktree-specific Git directories, not common directories: linked worktrees have different indexes.
  const directory = (cwd: string, env: NodeJS.ProcessEnv) => {
    const result = spawnSync('git', ['rev-parse', '--absolute-git-dir'], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    return result.status === 0 ? fs.realpathSync(result.stdout.trim()) : null;
  };
  return (root: string): NodeJS.ProcessEnv => {
    const key = path.resolve(root);
    const cached = environments.get(key);
    if (cached) return cached;
    const neutral = repositoryNeutralEnv();
    const target = directory(key, neutral);
    if (caller === undefined) caller = directory(process.cwd(), process.env);
    // Keep Git's temporary commit index only for the repository that supplied it.
    const env = target !== null && target === caller ? process.env : neutral;
    environments.set(key, env);
    return env;
  };
})();
function git(root: string, args: string[], optional = false): Buffer {
  const ran = spawnSync('git', args, { cwd: root, env: scanGitEnv(root), windowsHide: true, maxBuffer: 1 << 28, timeout: 60_000 });
  if (ran.error || (ran.status !== 0 && !optional)) throw Error(`git ${args.join(' ')} failed; nothing was proved clean: ${ran.error?.message ?? ran.stderr.toString().trim()}`);
  return ran.status === 0 ? ran.stdout : Buffer.alloc(0);
}
function decode(bytes: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return bytes.toString('latin1'); }
}
function terms(file: string): string[] | null {
  if (!fs.existsSync(file)) return null;
  const values = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.split('#')[0]!.trim()).filter(Boolean);
  // The oracle's empty PowerShell array unrolls to null: keep its actual verdict.
  return values.length ? values : null;
}
/** A hook can keep the path across PATH filtering, but it must name a scanner file. */
export function gitleaksCommand(): string {
  const supplied = process.env.DESKPOST_GITLEAKS;
  if (supplied) {
    const name = path.basename(supplied);
    if (name === 'gitleaks' || name === 'gitleaks.exe') {
      const file = path.resolve(supplied);
      try {
        if (fs.statSync(file).isFile()) return file;
      } catch { /* Refused below, with the supplied path. */ }
    }
    console.error(`ignored DESKPOST_GITLEAKS ${JSON.stringify(supplied)}: expected an existing file named gitleaks or gitleaks.exe`);
  }
  return 'gitleaks';
}
export function gitleaks(root: string): { ran: boolean; clean: boolean; detail: string } {
  const scanner = gitleaksCommand();
  const ran = spawnSync(scanner, ['git', '--staged', '--no-banner', '--redact'], { cwd: root, env: scanGitEnv(root), windowsHide: true, encoding: 'utf8', timeout: 60_000, maxBuffer: 1 << 24 });
  if (ran.error && 'code' in ran.error && ran.error.code === 'ENOENT') return { ran: false, clean: false, detail: 'gitleaks is not installed, so nothing scanned the staged blobs on this machine' };
  if (ran.error) throw Error(`gitleaks could not run: ${ran.error.message}`);
  if (ran.status === 0) return { ran: true, clean: true, detail: 'gitleaks found nothing in the staged blobs' };
  return { ran: true, clean: false, detail: `gitleaks reported a finding: ${(ran.stdout + ran.stderr).trim().split(/\r?\n/).slice(-6).join(' | ')}` };
}
/** gitleaks on its own, never a fallback (kickoffs/s158 row 6; PLAN-cross-office-build-loop.md step 2.3): over a folder's
 * files and over its staged index, refusing when gitleaks is not installed. A finding is named by its file, line and
 * gitleaks rule from gitleaks' own redacted JSON report, never by the secret. */
export function secretsScan(root: string): Scan {
  const reports = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-secrets-'));
  try {
    const hits: Hit[] = [];
    const scanner = gitleaksCommand();
    for (const [where, args] of [['files', ['detect', '--no-git', '--source', root]], ['staged blobs', ['git', '--staged']]] as const) {
      const report = path.join(reports, `${where.replace(' ', '-')}.json`);
      const ran = spawnSync(scanner, [...args, '--no-banner', '--redact', '--report-format', 'json', '--report-path', report], { cwd: root, env: scanGitEnv(root), windowsHide: true, encoding: 'utf8', timeout: 120_000, maxBuffer: 1 << 24 });
      if (ran.error && 'code' in ran.error && ran.error.code === 'ENOENT') return { status: 'fail', hits: [], detail: `gitleaks is not installed, so nothing scanned ${root} for secrets. Install it; this scan never falls back to another.` };
      if (ran.error) throw Error(`gitleaks could not run: ${ran.error.message}`);
      const found = (fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8') || '[]') : []) as { File: string; StartLine: number; RuleID: string }[];
      if (ran.status !== 0 && !found.length) throw Error(`gitleaks over the ${where} exited ${ran.status} with no report: ${(ran.stdout + ran.stderr).trim().split(/\r?\n/).slice(-3).join(' | ')}`);
      for (const leak of found) hits.push({ file: (path.isAbsolute(leak.File) ? path.relative(root, leak.File) : leak.File).replaceAll('\\', '/'), line: leak.StartLine, kind: `secret (${where})`, match: leak.RuleID });
    }
    return { status: hits.length ? 'fail' : 'pass', hits, detail: hits.length ? `gitleaks reported ${hits.length} finding(s): ${sorted(hits.map((hit) => `${hit.file}:${hit.line} [${hit.match}] in the ${hit.kind.slice(8, -1)}`)).join('; ')}` : `gitleaks found nothing in ${root}'s files or its staged blobs` };
  } finally {
    fs.rmSync(reports, { recursive: true, force: true });
  }
}
export function identityScan(root: string, messageFile = '', termRoot = path.join(process.env['USERPROFILE'] || os.homedir(), '.library'), requested?: string[]): Scan {
  const denyPath = path.join(termRoot, 'identity-denylist.txt'), allowPath = path.join(termRoot, 'identity-allowlist.txt');
  const deny = terms(denyPath), allow = terms(allowPath) ?? [];
  const base = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], true).length ? 'HEAD' : '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  // A named list is read whole from the index (kickoffs/s180 row 2(b)): a file identical to HEAD is still scanned.
  const staged = (requested ?? decode(git(root, ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z', base])).split('\0')).filter(Boolean);
  const files = staged.filter(product), omitted = staged.filter(file => !product(file));
  const sources = files.flatMap(source => { const bytes = git(root, ['cat-file', 'blob', `:${source}`]); return bytes.includes(0) ? [] : [{ source, text: decode(bytes) }]; });
  const scope = `${sources.length} staged blob(s)${messageFile ? ' and the commit message' : ''}; ${omitted.length} staged file(s) left out as not product files${omitted.length ? ': ' + omitted.slice(0, 5).join(', ') + (omitted.length > 5 ? ', ...' : '') : ''}`;
  if (messageFile) {
    if (!fs.existsSync(messageFile)) return { status: 'fail', detail: `The commit message file ${messageFile} does not exist, so the message was never scanned.`, hits: [] };
    sources.push({ source: '<commit message>', text: decode(fs.readFileSync(messageFile)) });
  }
  if (!deny) {
    if (process.env['LIBRARY_IDENTITY_SCAN']?.trim().toLowerCase() !== 'contributor') return { status: 'fail', hits: [], detail: `No identity denylist at ${denyPath}, so nothing scanned ${scope}. Create it -- one term per line, a '#' starts a comment -- carrying this machine's hostnames, addresses, share paths, usernames and private email, and put the approved attribution in ${allowPath}. On a machine that is not the maintainer's, set LIBRARY_IDENTITY_SCAN=contributor instead, which downgrades this to a warning and reaches for gitleaks.` };
    const leaks = gitleaks(root);
    return { status: leaks.ran && !leaks.clean ? 'fail' : 'warn', hits: [], gitleaks: leaks, detail: leaks.ran && !leaks.clean ? `${scope}; ${leaks.detail}. Contributor mode has no denylist to fall back on, so this finding stands.` : `contributor mode, no denylist at ${denyPath}; ${leaks.detail}. ${scope} went unscanned against any maintainer list; the server-side gate is what covers this boundary.` };
  }
  const hits = identityHits(sources, deny, allow);
  return hits.length ? { status: 'fail', hits, detail: `${scope}; ${hits.length} identity hit(s) in the blobs this commit would publish: ${sorted(hits.map(hit => `${hit.source}:${hit.line} [${hit.match}]`)).join('; ')}. Remove the value or generalise it; if it is approved attribution, add it to ${allowPath}.` } : { status: 'pass', hits, detail: `${scope} clean against ${deny.length} denylisted term(s) and ${allow.length} approved attribution(s)` };
}
export function textIdentityHits(text: string, termRoot = path.join(process.env['USERPROFILE'] || os.homedir(), '.library')) {
  const deny = terms(path.join(termRoot, 'identity-denylist.txt'));
  const allow = terms(path.join(termRoot, 'identity-allowlist.txt')) ?? [];
  const sources = [{ source: '<kickoff>', text }];
  const resolved = resolveWorkspace({ startDirectory: process.cwd() });
  const denyRoot = resolved.kind === 'resolved' ? fs.realpathSync(resolved.workspace!)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const deployment = resolved.kind === 'conflict' ? [] : deploymentDenylist(denyRoot);
  const hits = [
    ...identityHits(sources, deny ?? [], allow).map(({ line }) => ({ line, kind: 'identity' as const })),
    ...identityHits(sources, deployment, []).map(({ line }) => ({ line, kind: 'deployment' as const })),
  ];
  return { hits, identityDenylistMissing: deny === null };
}
const allowedHost = (host: string) => [/^localhost$/i, /^127\.0\.0\.1$/, /^\[::1\]$/, /\.invalid$/i, /\.example$/i, /\.example\.(com|net|org)$/i, /^192\.0\.2\.\d{1,3}$/, /^198\.51\.100\.\d{1,3}$/, /^203\.0\.113\.\d{1,3}$/].some(rule => rule.test(host));
export function structuralHits(text: string, file: string): Hit[] {
  const hits: Hit[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const match of line.matchAll(/\bhttps?:\/\/([^/:\s"'`]+)(?::\d+)?\/mcp\b/gi)) if (!allowedHost(match[1]!)) hits.push({ file, line: index + 1, kind: 'endpoint', match: match[0] });
    for (const match of line.matchAll(/(\\\\[^\s"'`]+|\b[A-Za-z]:[\\/][^\s"'`]*)basic-memory[^\s"'`]*/gi)) {
      const first = match[0].split(/[\\/]+/).filter(part => part && !/^[A-Za-z]:$/.test(part))[0]?.toLowerCase();
      if (first && !['nas', 'share', 'example', 'fixture', 'server', 'host'].includes(first)) hits.push({ file, line: index + 1, kind: 'share-root', match: match[0] });
    }
  }); return hits;
}
/** Read the existing canonical lists, so a new export rule is scanned immediately. */
export function productFiles(root: string): string[] {
  const tracked = decode(git(root, ['ls-files', '-z'])).split('\0').filter(Boolean);
  if (!tracked.length) throw Error('git ls-files returned nothing, so this scan read no files rather than proving anything.');
  const oracle = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'PublicTreeAllowlist.ps1'), 'utf8');
  const list = (name: string) => {
    const block = new RegExp('\\$script:' + name + ' = @\\(([\\s\\S]*?)\\n\\)').exec(oracle)?.[1];
    if (!block) throw Error(`Cannot read canonical allowlist ${name}`);
    return [...block.matchAll(/^\s*'((?:[^']|'')*)'\s*,?\s*(?:#.*)?$/gm)].map(match => match[1]!.replaceAll("''", "'"));
  };
  const deny = list('PublicTreeDenyPatterns').map(rule => new RegExp(rule, 'i'));
  const exportable: string[] = [];
  const walk = (relative: string) => {
    if (deny.some(rule => rule.test(relative))) return;
    const full = path.join(root, relative);
    if (!fs.existsSync(full)) return;
    const stat = fs.lstatSync(full);
    if (stat.isDirectory()) for (const entry of fs.readdirSync(full)) walk(`${relative}/${entry}`);
    else if (stat.isFile()) exportable.push(relative);
  };
  list('PublicTreeIncludeDirectories').forEach(walk);
  list('PublicTreeIncludeFiles').forEach(walk);
  return sorted([...tracked, ...exportable]).filter(product);
}
export function deploymentScan(root: string, requested?: string[]): Scan {
  const resolved = resolveWorkspace({ startDirectory: process.cwd() });
  if (resolved.kind === 'conflict') throw Error(resolved.reason!);
  const denyRoot = resolved.kind === 'none' ? root : fs.realpathSync(resolved.workspace!);
  const deny = deploymentDenylist(denyRoot), all = productFiles(root);
  const files = requested ? requested.filter(file => all.some(item => item.toLowerCase() === file.toLowerCase())) : all;
  const hits: Hit[] = [];
  for (const file of files) {
    let text: string; try { text = fs.readFileSync(path.join(root, file), 'utf8').replace(/^\uFEFF/, ''); } catch { continue; }
    if (text.includes('\0')) continue;
    for (const value of deny) { const at = occurrences(text, value)[0]; if (at !== undefined) hits.push({ file, line: lineAt(text, at), kind: 'configured', match: value }); }
    hits.push(...structuralHits(text, file));
  }
  const missing = ['.library-mcp-url', '.library-project', '.library-shared-root'].map(name => path.join(denyRoot, '.claude', name)).filter(file => !fs.existsSync(file));
  const uncovered = deny.length ? '' : `; configured-value part not run: zero configured values; missing configuration files: ${missing.join(', ') || 'none (existing configuration files provided no values)'}`;
  return { status: hits.length ? 'fail' : 'pass', hits, detail: (hits.length ? `${hits.length} deployment default(s) in product files: ${sorted(hits.map(hit => `${hit.file}:${hit.line} [${hit.kind}] ${hit.match}`)).join('; ')}. These ship. Move the value into generated state and resolve it through tools/LibraryDeployment.ps1.` : `${files.length} staged product document(s) clean against ${deny.length} configured value(s) from ${denyRoot} and the structural detectors`) + uncovered };
}
function main(args: string[]): number {
  let identity = false, deployment = false, secrets = false, json = false, root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), message = '', termRoot: string | undefined, files: string[] | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--identity') identity = true;
    else if (arg === '--deployment') deployment = true;
    else if (arg === '--secrets') secrets = true;
    else if (arg === '--json') json = true;
    else if (['--root', '--commit-message-file', '--term-root', '--files'].includes(arg!) && i + 1 < args.length) {
      const value = args[++i]!;
      if (arg === '--root') root = path.resolve(value);
      else if (arg === '--commit-message-file') message = path.resolve(value);
      else if (arg === '--term-root') termRoot = path.resolve(value);
      else files = value.split(/\r?\n/).filter(Boolean);
    } else throw Error(`Unknown or incomplete argument ${arg}`);
  }
  if (!identity && !deployment && !secrets) throw Error('Usage: node tools/scan.ts --identity [--commit-message-file <file>] | --deployment [--files <newline-separated paths>] | --secrets [--root <dir>] [--json]');
  const result: { identity?: Scan; deployment?: Scan; secrets?: Scan } = {};
  if (identity) result.identity = identityScan(root, message, termRoot, files);
  if (deployment) result.deployment = deploymentScan(root, files);
  if (secrets) result.secrets = secretsScan(root);
  if (json) process.stdout.write(JSON.stringify(result) + '\n');
  else for (const [name, scan] of Object.entries(result)) {
    process.stdout.write(`${name} scan${scan.status === 'fail' ? ' FAILED' : scan.status === 'warn' ? ' WARNING' : ''}: ${scan.detail}\n`);
    for (const hit of scan.hits) process.stdout.write(`${hit.file ?? hit.source}:${hit.line} [${hit.kind}] ${hit.match}\n`);
  }
  return Object.values(result).some(scan => scan.status === 'fail') ? 1 : 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`scan failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2; }
}
