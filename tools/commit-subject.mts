/** The commit message on an integration branch identifies the Kickoff that owns it. */
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';

const branch = spawnSync('git', ['symbolic-ref', '--short', '-q', 'HEAD'],
  {encoding: 'utf8', windowsHide: true});
if (branch.status !== 0 && branch.status !== 1) {
  process.stderr.write('commit-msg: could not read the current branch.\n');
  process.exit(1);
}
const name = branch.stdout?.trim() ?? '';
if (branch.status === 1 || !name.startsWith('int/')) process.exit(0);
const unit = name.slice('int/'.length);
const subject = fs.readFileSync(process.argv[2]!, 'utf8').replace(/^\uFEFF/, '')
  .split(/\r?\n/).find(line => line.trim() && !line.startsWith('#')) ?? '';
if (/^(?:fixup!|amend!) /.test(subject)) process.exit(0);

const merge = spawnSync('git', ['rev-parse', '--verify', '-q', 'MERGE_HEAD'], {stdio: 'ignore', windowsHide: true});
if (merge.status === 0) process.exit(0);

const suffix = subject.startsWith(unit) ? subject.slice(unit.length) : '';
if (!/^(?:-r[1-9]\d*)?(?: row [1-9]\d*:| spare [\w-]+:|:)/.test(suffix)) {
  process.stderr.write('commit-msg: ' + name + ' requires ' + unit + ' row <n>:, ' +
    unit + ' spare <id>:, or ' + unit + ': (optionally add -r<n> after the unit).\n');
  process.exitCode = 1;
}
