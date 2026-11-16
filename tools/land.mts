#!/usr/bin/env node
/** Land the pushed branch through Forgejo. No server identity or credential is committed here. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
// The gate lock and child environment load only on the Windows path, so tools/lander.mts can import this file
// inside its image, which carries tools/land.mts and tools/lander.mts and nothing of kernel/.

type Runner = (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<string>;
export type Label = { id: number; name: string };
export type Pull = { number: number; head: { sha: string; ref: string; repo?: { full_name: string } }; base: { ref: string };
  labels?: Label[]; created_at?: string };
export type Reply = { code: number; ok: boolean; data: any; text: string };
/** The label the lander adds to start the check (PLAN-build-regroup.md point 7). */
export const CHECKING_LABEL = 'lander: checking';
type CheckStatus = { context: string; status?: string; state?: string; target_url?: string };
type Status = { state: string; statuses: CheckStatus[]; total_count: number };
const checkResult = (row: CheckStatus): string | undefined => row.status ?? row.state;
export interface Options {
  cwd?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; waitMinutes?: number; tokenItem?: string;
  close?: boolean; landedAt?: string; open?: boolean;
  pollMs?: number; say?: (line: string) => void;
  // In-process test seam; never controlled by command-line flags or environment variables.
  sections?: number[]; runner?: Runner;
}
export const SHA = /^[a-f0-9]{40}$/;

/** owner/repository and its API root from an HTTP(S) repository URL, with any user information dropped. */
export function repositoryApi(url: string): { origin: string; repository: string; api: string } {
  const remote = new URL(url);
  if (!['https:', 'http:'].includes(remote.protocol) || remote.search || remote.hash)
    throw Error('origin must be an HTTP or HTTPS repository URL');
  remote.username = ''; remote.password = '';
  const parts = remote.pathname.replace(/\.git\/?$/, '').split('/').filter(Boolean);
  if (parts.length !== 2) throw Error('origin must name owner/repository');
  const repository = parts.map(part => decodeURIComponent(part)).join('/');
  return { origin: remote.origin, repository,
    api: `${remote.origin}/api/v1/repos/${parts.map(part => encodeURIComponent(decodeURIComponent(part))).join('/')}` };
}

/** Forgejo requests with the token only in the Authorization header and never a redirect. `timeout` gives each
 * request's limit in milliseconds and may throw to refuse it (the waiting mode's time limit). */
export function forgejoClient(base: string, token: () => string, timeout: () => number = () => 30_000) {
  const request = async (route: string, method = 'GET', body?: object): Promise<Reply> => {
    let response: Response;
    try {
      response = await fetch(base + route, { method, redirect: 'error',
        headers: { Authorization: `token ${token()}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeout()) });
    } catch { timeout(); throw Error(`Forgejo ${method} request failed`); }
    const text = await response.text();
    let data: any = null;
    if (text) try { data = JSON.parse(text); } catch { if (response.ok) throw Error('Forgejo returned invalid JSON'); }
    return { code: response.status, ok: response.ok, data, text };
  };
  const get = async (route: string) => {
    const response = await request(route);
    if (!response.ok) throw Error(`Forgejo read refused (HTTP ${response.code})`);
    return response.data;
  };
  return { request, get };
}

/** Remove and re-add a label by its id, so Forgejo sends a fresh `labeled` event (REGROUP-R8-005). */
export async function relabel(request: (route: string, method?: string, body?: object) => Promise<Reply>, number: number, label: Label): Promise<void> {
  const removed = await request(`/issues/${number}/labels/${label.id}`, 'DELETE');
  if (!removed.ok) throw Error(`Removing label '${label.name}' refused (HTTP ${removed.code})`);
  const added = await request(`/issues/${number}/labels`, 'POST', { labels: [label.id] });
  if (!added.ok) throw Error(`Adding label '${label.name}' refused (HTTP ${added.code})`);
}
export const pythonCommand = (platform: string = process.platform): string => platform === 'win32' ? 'python' : 'python3';
const READ_CREDENTIAL = `import os, sys
sys.dont_write_bytecode = True
sys.path.insert(0, os.environ['DESKPOST_SECRETS_DIR'])
import deskpost_secrets
try:
    sys.stdout.write(deskpost_secrets.get_field(sys.argv[1], 'credential'))
except deskpost_secrets.SecretError as exc:
    print('error:', exc, file=sys.stderr)
    sys.exit(1)
`;
export const execute: Runner = (command, args, cwd, env) => new Promise((resolve, reject) => {
  const reader = command === 'python' || command === 'python3';
  const manifest = args[0]?.endsWith('ci-manifest.mts');
  const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', chunk => { out += String(chunk); });
  // Relay only the reader's SecretError or the credential-free manifest's own diagnostic line.
  let error = '';
  child.stderr.on('data', chunk => { if (reader || manifest) error += String(chunk); });
  child.on('error', () => reject(Error(`${path.basename(command)} could not start`)));
  child.on('close', code => {
    const failed = args[0] === 'test/run-parallel.ts' ? [...out.matchAll(/^section (\d+): FAIL/gm)].map(m => m[1]) : [];
    const diagnostic = manifest ? error.split(/\r?\n/).find(line => line.startsWith('ci-manifest:'))?.slice(0, 300) : undefined;
    if (code === 0) resolve(reader ? out : out.trim());
    else reject(Error(reader ? error.split(/\r?\n/).find(line => line.startsWith('error:')) ?? 'python secret reader failed; nothing sent'
      : `${path.basename(command)} failed (exit ${code})${diagnostic ? '; ' + diagnostic : ''}${failed.length ? '; section ' + failed.join(',') : ''}`));
  });
});

export async function land(branch: string, options: Options = {}): Promise<number> {
  let token = '';
  const scrub = (value: string) => {
    let text = token ? value.split(token).join('[redacted]') : value;
    text = text.replace(/https?:\/\/[^\s]+/gi, raw => {
      try { const url = new URL(raw); url.username = ''; url.password = ''; return url.href; } catch { return '[invalid URL]'; }
    });
    return text.replace(/[\r\n]+/g, ' ');
  };
  const say = (line: string) => (options.say ?? console.log)(scrub(line));
  const cwd = options.cwd ?? process.cwd(), env = options.env ?? process.env;
  const runner = options.runner ?? execute;
  const minutes = options.waitMinutes ?? 60, poll = options.pollMs ?? 5000;
  try {
    if (!branch || branch === 'master' || branch.startsWith('-') || !Number.isFinite(minutes) || minutes <= 0)
      throw Error('usage: node tools/land.mts <branch> --token-item <1Password item title> [--wait-minutes <positive number>]');
    if (options.close && !SHA.test(options.landedAt ?? '')) throw Error('--close requires --landed-at <40-character commit SHA>; nothing sent');
    if (options.close && options.open) throw Error('--open and --close cannot be combined; nothing sent');
    if (!options.tokenItem?.trim()) throw Error('Set --token-item to the 1Password item title; nothing sent');
    if (!env['DESKPOST_SECRETS_DIR']) throw Error('Set DESKPOST_SECRETS_DIR to the folder containing deskpost_secrets.py; nothing sent');
    const readerFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpost-reader-'));
    let readerFailure = '';
    try {
      token = (await runner(pythonCommand(options.platform), ['-I', '-c', READ_CREDENTIAL, options.tokenItem], readerFolder,
        { ...env, NoDefaultCurrentDirectoryInExePath: '1' })).replace(/\r?\n$/, '');
    } catch (error) {
      readerFailure = error instanceof Error ? error.message : String(error);
    } finally {
      // Only the empty private directory made for this reader invocation is removed.
      try { fs.rmdirSync(readerFolder); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
        readerFailure = `${readerFailure || 'reader succeeded'}; reader cleanup failed (${code}); folder retained: ${readerFolder}`;
      }
    }
    if (readerFailure) throw Error(readerFailure);
    if (!token || /\s/.test(token)) throw Error('1Password credential must be nonempty and contain no whitespace; nothing sent');
    const git = (...args: string[]) => runner('git', args, cwd, env);
    await git('check-ref-format', '--branch', branch);
    const localHead = await git('rev-parse', '--verify', `refs/heads/${branch}^{commit}`);
    if (!SHA.test(localHead)) throw Error('Local branch did not resolve to a commit');
    const { repository, api } = repositoryApi(await git('remote', 'get-url', 'origin'));
    const deadline = Date.now() + minutes * 60_000;
    const remaining = () => { const left = deadline - Date.now(); if (left <= 0) throw Error('Landing time limit reached'); return left; };
    const pause = async () => { await new Promise(resolve => setTimeout(resolve, Math.min(poll, remaining()))); remaining(); };
    const { request, get } = forgejoClient(api, () => token, () => Math.max(1, Math.min(remaining(), 30_000)));
    const isWindows = (options.platform ?? process.platform) === 'win32';
    // Only the Windows class: --sections windows also includes both, which CI already ran.
    const windowsSections = async (root: string) => options.sections ?? (JSON.parse(await runner(process.execPath,
      [path.join(root, 'tools/ci-manifest.mts'), 'plan'], root, env)) as {sections: {section: number; class: string}[]})
      .sections.filter(s => s.class === 'windows').map(s => s.section);
    /** The `windows` sections on `head` in a detached worktree (Windows), or the named skip line elsewhere. Returns the result line. */
    const windowsCheck = async (head: string, fetchFirst: boolean): Promise<string> => {
      let planned: number[] = [];
      if (!isWindows) {
        planned = await windowsSections(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
        const line = `windows sections: skipped on Linux (${planned.length}); the next Windows landing runs them`;
        say(line);
        return line;
      }
      const { acquireGateLock } = await import('../kernel/test/gate-lock.ts');
      const { childEnv } = await import('../kernel/test/gate-env.ts');
      const lock = await acquireGateLock('land');
      let folder = '', worktree = '', added = false, step = 'worktree', failure = '';
      try {
        folder = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpost-land-')); worktree = path.join(folder, 'head');
        const checkEnv = childEnv();
        if (fetchFirst) {
          step = 'fetch';
          await runner('git', ['fetch', 'origin', branch], cwd, checkEnv);
        }
        step = 'worktree';
        await runner('git', ['worktree', 'add', '--detach', worktree, head], cwd, checkEnv); added = true;
        const kernel = path.join(worktree, 'kernel');
        // npm-cli.js avoids a visible shell and Windows .cmd quoting.
        const npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
        step = 'install';
        await runner(process.execPath, [npm, 'ci', '--prefer-offline'], kernel, checkEnv);
        step = 'plan';
        planned = await windowsSections(worktree);
        say(`Running Windows sections: ${planned.join(',')}`);
        if (planned.length) {
          step = 'sections';
          await runner(process.execPath, ['test/run-parallel.ts', '--workers', '2', '--require-sections', planned.join(',')], kernel,
            { ...checkEnv, LIBRARY_SELFTEST_SECTIONS: planned.join(',') });
        }
        say(`Windows sections passed: ${planned.join(',')}`);
      } catch (error) {
        const cause = scrub(error instanceof Error ? error.message : String(error));
        const failed = step === 'sections' ? /section ([\d,]+)/.exec(cause)?.[1] : undefined;
        failure = `Windows ${step} failed${failed ? ': ' + failed : ''}; ${cause}; ${options.open ? 'nothing pushed or opened' : 'merge refused'}`;
      }
      finally {
        try {
          if (added) await runner('git', ['worktree', 'remove', '--force', worktree], cwd, env);
          // This folder was created above solely for this detached test worktree.
          if (folder) fs.rmdirSync(folder);
        } catch (error) {
          const cause = scrub(error instanceof Error ? error.message : String(error));
          failure = `${failure ? failure + '; ' : ''}Windows cleanup failed; ${cause}; merge refused`;
        } finally {
          try { await lock.release(); }
          catch (error) { failure += `${failure ? '; ' : ''}Windows cleanup failed; ${scrub(String(error))}; merge refused`; }
        }
      }
      if (failure) throw Error(failure);
      return `Windows sections passed: ${planned.join(',')}`;
    };
    // --open (plan point 8): the windows sections on the local head, a push when the remote is behind, the pull
    // request opened or found, a comment naming the head and the result, and its number. It never waits.
    let openResult = '';
    if (options.open) {
      openResult = await windowsCheck(localHead, false);
      const listed = await git('ls-remote', 'origin', `refs/heads/${branch}`);
      const remoteHead = listed.split(/\s+/)[0] ?? '';
      if (remoteHead !== localHead) {
        if (remoteHead) {
          try { await git('merge-base', '--is-ancestor', remoteHead, localHead); }
          catch { throw Error(`Remote ${branch} has commits the local branch lacks; fetch and reconcile; nothing pushed`); }
        }
        await git('push', 'origin', `refs/heads/${branch}:refs/heads/${branch}`);
        say(`Pushed ${branch} at ${localHead}`);
      } else say(`Remote ${branch} already at ${localHead}`);
    }
    if (options.close) await git('fetch', 'origin');
    let pull: Pull | undefined;
    for (let page = 1; ; page++) {
      const list = await get(`/pulls?state=open&base=master&limit=50&page=${page}`) as Pull[];
      if (!Array.isArray(list)) throw Error('Forgejo pull request list is invalid');
      const matches = list.filter(p => p.head.ref === branch && p.base.ref === 'master' && p.head.repo?.full_name === repository);
      if (matches.length > 1 || pull && matches.length) throw Error('More than one open pull request matches this branch');
      pull = matches[0] ?? pull;
      if (list.length < 50) break;
    }
    if (options.close) {
      if (!pull) throw Error('No open pull request matches this branch; nothing sent');
      if (!Number.isInteger(pull.number) || !SHA.test(pull.head?.sha)) throw Error('Forgejo pull request head is invalid');
      try { await git('merge-base', '--is-ancestor', options.landedAt!, 'refs/remotes/origin/master'); }
      catch { throw Error('Landed-at commit is not on origin/master or ancestry could not be checked; nothing sent'); }
      const fetched = await git('rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`);
      if (fetched !== pull.head.sha) throw Error('Fetched branch and pull request head differ; nothing sent');
      let alreadyOnMaster = false;
      try { await git('merge-base', '--is-ancestor', pull.head.sha, 'refs/remotes/origin/master'); alreadyOnMaster = true; }
      catch { /* The remaining proofs still refuse if Git cannot establish the change. */ }
      if (alreadyOnMaster) throw Error('Pull request head is already on master; nothing sent');
      const patches = await git('cherry', 'refs/remotes/origin/master', pull.head.sha);
      if (patches && !patches.split(/\r?\n/).every(line => /^- [a-f0-9]{40}$/.test(line)))
        throw Error('Pull request has commits not landed on master by patch; nothing sent');
      const proof = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpost-close-proof-'));
      try {
        const mergeBase = await git('merge-base', 'refs/remotes/origin/master', pull.head.sha);
        const patch = path.join(proof, 'change.patch');
        await git('diff', '--no-textconv', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', '--binary', '--output=' + patch, mergeBase, pull.head.sha);
        if (!fs.statSync(patch).size) throw Error('Pull request diff is empty; nothing sent');
        const changed = (await git('diff', '--no-textconv', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', '--raw', '--no-abbrev', '--no-renames', '-z', mergeBase, pull.head.sha)).split('\0');
        for (const commit of [options.landedAt!, 'refs/remotes/origin/master']) {
          for (let i = 0; i + 1 < changed.length; i += 2) {
            const expected = changed[i]!.split(' ')[1]!;
            const name = changed[i + 1]!;
            const entry = await git('ls-tree', '-z', '--full-tree', commit, '--', name);
            const actual = entry ? entry.split(' ')[0]! : '000000';
            if (actual !== expected)
              throw Error(`Commit ${commit} lacks the change: ${JSON.stringify(name)} mode ${actual}, expected ${expected}; nothing sent`);
          }
          const proofEnv = { ...env, GIT_INDEX_FILE: path.join(proof, 'index') };
          try {
            await runner('git', ['read-tree', commit], cwd, proofEnv);
            await runner('git', ['apply', '--cached', '--reverse', '--check', '--whitespace=nowarn', patch], cwd, proofEnv);
          } catch { throw Error(`Commit ${commit} lacks the change or its content proof failed; nothing sent`); }
        }
      } finally {
        // Remove only the patch and private index created for this content proof.
        fs.rmSync(proof, { recursive: true, force: true });
      }
      const current = await get(`/pulls/${pull.number}`) as Pull;
      if (current.head?.sha !== pull.head.sha) throw Error('Pull request head moved; nothing sent');
      const closed = await request(`/pulls/${pull.number}`, 'PATCH', { state: 'closed' });
      if (!closed.ok) throw Error(`Close refused (HTTP ${closed.code})`);
      try {
        const after = await get(`/pulls/${pull.number}`) as Pull;
        if (after.head?.sha !== pull.head.sha)
          throw Error(`Pull request head moved during the close: ${pull.head.sha} to ${after.head?.sha}; reopen it and check`);
        const comment = await request(`/issues/${pull.number}/comments`, 'POST', {
          body: `Landed on master at ${options.landedAt} by push; closed by the lander.`,
        });
        if (!comment.ok) throw Error(`the landing comment was refused (HTTP ${comment.code})`);
        say(`Closed pull request ${pull.number}: landed on master at ${options.landedAt}`);
      } catch (error) { throw Error(`Closed pull request ${pull.number}; ${(error as Error).message}`); }
      return 0;
    }
    if (!pull) {
      await git('fetch', 'origin');
      const title = (await git('log', '--reverse', '--format=%s', `origin/master..refs/heads/${branch}`)).split(/\r?\n/)[0];
      if (!title) throw Error('Branch has no commits after origin/master; nothing sent');
      const opened = await request('/pulls', 'POST', { head: branch, base: 'master', title });
      if (!opened.ok) throw Error(`Opening pull request refused (HTTP ${opened.code})`);
      pull = opened.data as Pull;
      say(`Opened pull request ${pull.number}`);
    } else say(`Using pull request ${pull.number}`);
    const headOf = (p: Pull) => {
      if (!p || !Number.isInteger(p.number) || !SHA.test(p.head?.sha)) throw Error('Forgejo pull request head is invalid');
      return p.head.sha;
    };
    if (options.open) {
      // Forgejo may still be moving an existing pull request to the pushed head; the comment names the head tested.
      const number = headOf(pull) && pull.number;
      const comment = await request(`/issues/${number}/comments`, 'POST', { body: `land --open: head ${localHead}; ${openResult}` });
      if (!comment.ok) throw Error(`The head comment was refused (HTTP ${comment.code})`);
      say(`Pull request ${number} open at ${localHead}`);
      return 0;
    }
    let head = headOf(pull);
    if (head !== localHead) throw Error(`Pull request head ${head} differs from local branch ${localHead}; push and test the same head`);
    const number = pull.number;
    const readPull = () => get(`/pulls/${number}`) as Promise<Pull>;
    const update = async () => {
      say(`Updating pull request ${number} by rebase`);
      const updated = await request(`/pulls/${number}/update?style=rebase`, 'POST');
      if (!updated.ok) throw Error(`Pull request update refused (HTTP ${updated.code})`);
      const current = await readPull();
      const next = headOf(current);
      if (next === head) throw Error(`Update did not change pull request head ${head}`);
      head = next;
      // The check starts only on the label (REGROUP-R8-005): re-add it so it runs on the new head.
      const checking = current.labels?.find(label => label.name === CHECKING_LABEL);
      if (checking) { await relabel(request, number, checking); say(`Re-added '${CHECKING_LABEL}' on ${head}`); }
    };
    let outdatedRetries = 0;
    while (true) {
      remaining();
      say(`Waiting for checks on ${head}`);
      while (true) {
        const status = await get(`/commits/${head}/status`) as Status;
        if (status && (status.statuses as unknown) === null) status.statuses = []; // Forgejo's reply for a head with no check yet.
        if (!Array.isArray(status?.statuses)) throw Error('Forgejo combined status is invalid');
        status.statuses = status.statuses.filter(s => checkResult(s) !== 'skipped');
        const failed = status.statuses.filter(s => ['failure', 'error'].includes(checkResult(s) ?? ''));
        const printChecks = () => {
          say(`Combined checks: state ${status.state}, total_count ${status.total_count}, rows ${status.statuses.length}`);
          for (const s of status.statuses) say(`check: ${s.context} ${checkResult(s)} ${s.target_url ?? ''}`);
        };
        if (failed.length || ['failure', 'error'].includes(status.state)) {
          printChecks();
          if (!status.statuses.length) say(`Forgejo reports the head as failed but lists no check: no check run reported on ${head}`);
          throw Error('Required checks failed; review the reported checks before landing');
        }
        if (status.state === 'success' && status.statuses.length > 0 && status.statuses.every(s => checkResult(s) === 'success')) {
          printChecks();
          break;
        }
        await pause();
      }
      const current = headOf(await readPull());
      if (current !== head) throw Error(`Pull request head moved: tested ${head}, now ${current}`);
      await windowsCheck(head, true);
      const compare = await get(`/compare/${head}...master`) as { total_commits: number };
      if (!Number.isInteger(compare?.total_commits) || compare.total_commits < 0) throw Error('Forgejo comparison is invalid');
      if (compare.total_commits > 0) { await update(); continue; }
      remaining();
      say(`Merging pull request ${number} at ${head}`);
      const merged = await request(`/pulls/${number}/merge`, 'POST', { Do: 'merge', head_commit_id: head });
      if (merged.code === 409) throw Error(`Pull request head moved: tested ${head}, now ${headOf(await readPull())} (HTTP 409)`);
      if (merged.code === 405 && /outdated|out.of.date/i.test(merged.text)) {
        if (outdatedRetries++ >= 1) throw Error('Pull request stayed out of date after one merge retry (HTTP 405)');
        await update(); continue;
      }
      if (!merged.ok) throw Error(`Merge refused (HTTP ${merged.code})`);
      const master = await get('/branches/master') as { commit: { id: string } };
      if (!SHA.test(master?.commit?.id)) throw Error('Merged master tip could not be read back');
      say(`Merged master: ${master.commit.id}`);
      return 0;
    }
  } catch (error) { say(`land: ${(error as Error).message}`); return 1; }
  finally { token = ''; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const close = args[0] === '--close', open = args[0] === '--open';
  if (close || open) args.shift();
  const flags = args.slice(1), values = new Map<string, string>();
  let valid = args.length > 0 && flags.length % 2 === 0;
  for (let i = 0; i < flags.length; i += 2) {
    const key = flags[i]!, value = flags[i + 1];
    if (!['--token-item', ...(open ? [] : ['--wait-minutes']), ...(close ? ['--landed-at'] : [])].includes(key) || values.has(key) || !value || value.startsWith('--')) valid = false;
    else values.set(key, value);
  }
  if (!valid || close && !SHA.test(values.get('--landed-at') ?? '')) {
    console.error('usage: node tools/land.mts [--close | --open] <branch> [--landed-at <sha>] --token-item <1Password item title> [--wait-minutes <positive number>]'); process.exitCode = 1;
  } else process.exitCode = await land(args[0]!, { close, open, landedAt: values.get('--landed-at'), tokenItem: values.get('--token-item'), waitMinutes: Number(values.get('--wait-minutes') ?? 60) });
}
