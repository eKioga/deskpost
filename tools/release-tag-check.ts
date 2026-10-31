/**
 * Check a release's source tag before publishing: 0 PASS, 1 FAIL naming the first
 * missing/mismatched tag condition, 2 refused input or unavailable git/origin.
 * Read-only; the only network read is ls-remote for the exact origin tag ref.
 */
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { repositoryNeutralEnv } from '../kernel/src/gitenv.ts';

const USAGE = 'node tools/release-tag-check.ts <checkout> <version>';
const CHECK = 'release.source-tag';

export function main(argv: string[]): number {
  const [folder, version] = argv;
  const refuse = (why: string) => { process.stderr.write(`${CHECK}: ${why.replace(/[\r\n].*/s, '')}\n`); return 2; };
  const fail = (why: string) => { process.stdout.write(`FAIL ${CHECK}: ${why}\n`); return 1; };
  if (argv.length !== 2 || !folder || !version) return refuse(`usage: ${USAGE}`);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version)) {
    return refuse('version must be major.minor.patch with an optional -prerelease or +build suffix (no leading v)');
  }
  try {
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) return refuse(`no such folder: ${folder}`);
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: folder, env: repositoryNeutralEnv(), encoding: 'utf8', windowsHide: true });
      if (result.error) throw new Error(`git ${args[0]}: ${result.error.message}`);
      return { status: result.status, out: result.stdout.trim(), err: result.stderr.trim().split(/\r?\n/)[0] || `exit ${result.status}` };
    };
    const tree = git('rev-parse', '--is-inside-work-tree');
    if (tree.status !== 0 || tree.out !== 'true') return refuse(`not a git work tree: ${folder}`);
    const tag = `v${version}`;
    const ref = `refs/tags/${tag}`;
    const local = git('rev-parse', '--verify', '--quiet', ref);
    if (local.status !== 0) return fail(`no tag ${tag} in the checkout`);
    const type = git('cat-file', '-t', local.out);
    if (type.status !== 0) return refuse(`git cat-file: ${type.err}`);
    if (type.out !== 'tag') return fail(`${tag} is a lightweight tag; an annotated tag is required`);
    const commit = git('rev-parse', '--verify', `${ref}^{commit}`);
    const head = git('rev-parse', '--verify', 'HEAD');
    if (commit.status !== 0 || head.status !== 0) return refuse(`git rev-parse: ${commit.status !== 0 ? commit.err : head.err}`);
    const shortCommit = git('rev-parse', '--short', commit.out).out;
    const shortHead = git('rev-parse', '--short', head.out).out;
    if (commit.out !== head.out) return fail(`${tag} names ${shortCommit}, but HEAD is ${shortHead}`);
    const remote = git('ls-remote', 'origin', ref);
    if (remote.status !== 0) return refuse(`git ls-remote: ${remote.err}`);
    const remoteObject = remote.out.split(/\r?\n/).map(line => line.split(/\s+/)).find(([, name]) => name === ref)?.[0];
    if (!remoteObject) return fail(`origin has no ${ref}`);
    if (remoteObject !== local.out) return fail(`${tag} differs from origin: local ${local.out}, origin ${remoteObject}`);
    process.stdout.write(`PASS ${CHECK}: ${tag} is annotated, names HEAD ${shortHead}, and origin holds the same tag\n`);
    return 0;
  } catch (error) { return refuse((error as Error).message); }
}

const invoked = process.argv[1] ?? '';
if (/release-tag-check\.ts$/.test(invoked.replace(/\\/g, '/'))) process.exit(main(process.argv.slice(2)));
