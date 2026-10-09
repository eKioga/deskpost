/**
 * THE DOCS GATE: a commit that stages only documents runs only the checks a document can fail (S104 row 0b; Eric,
 * 2026-10-08: "do we need this gate?"). `.githooks/pre-commit` runs this first, as `node tools/docs-gate.ts`:
 *
 *   exit 0  every staged path is a document and every check below passed (a WARN passes, as the runner's does);
 *   exit 3  every staged path is a document and a check failed, so the hook refuses the commit;
 *   exit 4  this is not a docs-only commit, so the hook runs `tools/Invoke-LibraryChecks.ps1 -Fast` exactly as before.
 *
 * Any other exit (node missing, this file missing, a crash) also sends the hook to the full runner, so the docs gate
 * can only ever narrow the work for a commit it has fully understood, never skip a check for one it has not.
 *
 * A DOCUMENT is a `*.md` file outside `kernel/`, `tools/`, `templates/` and every top-level dot-folder (`.claude/`,
 * `.githooks/`, `.agents/`, `.codex/` and the plugin folders hold behaviour, not prose), added or modified. A deletion,
 * a rename or a copy of anything, and any other path, is not docs-only. Neither is a document that a runner check
 * reads through PowerShell logic or that the program reads at runtime (`CONTRACT_DOCUMENTS` below): those keep the
 * full runner, because a port of those checks would be a second copy of PowerShell this repository would then have to
 * keep at parity.
 *
 * WHAT RUNS, each the runner check it stands for (`tools/Invoke-LibraryChecks.ps1`). Every text check reads the
 * INDEX, which is what the commit publishes; existence of a link's target is answered from the index or the disk,
 * as the runner's Test-Path answers it.
 *   - workspace.plans-declare-their-owner: ported.
 *   - context.always-on-budget: ported; runs when CLAUDE.md or AGENTS.md is staged.
 *   - docs.links-resolve, docs.adr-index-is-complete: ported.
 *   - skill.library-help-pointers-resolve: its third half (the reader guides, both ways), the one half a document
 *     can break; the first two read only `.claude/`.
 *   - workspace.no-foreign-install, reset.vocabulary-routes, retrieval.hit-is-a-location,
 *     codex.delegation-runs-hooks: their document halves, ported. Their fixture halves exercise PowerShell helpers
 *     a document cannot change.
 *   - public.identity-scan: tools/DeploymentScan.ps1's own Invoke-IdentityScan, over the staged blobs (and the commit
 *     message with --commit-message-file; .githooks/commit-msg scans the message on every commit as before).
 *   - public.no-deployment-defaults: the same file's Find-DeploymentScanHits, over the staged documents its product
 *     file set holds, against Get-DeploymentScanDenylist from the workspace the runner would resolve.
 *   - kernel.selftest: section 119 only, the one section that reads repository documents (the rules register's homes
 *     and anchors).
 * Both scans run in one `powershell.exe -NoProfile -Command` that dot-sources the existing files: one denylist, never
 * two, and no PowerShell file changes.
 *
 * Usage: node tools/docs-gate.ts [--commit-message-file <file>]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EXIT_PASS = 0;
const EXIT_FAIL = 3;
const EXIT_NOT_DOCS = 4;

/** The behaviour folders: a `*.md` under one of these is not a document (top-level dot-folders are added by rule). */
const BEHAVIOUR_ROOTS = new Set(['kernel', 'tools', 'templates']);

/**
 * Documents the runner reads through PowerShell logic, or the program reads at runtime. Staging one keeps the full
 * runner. Each names the checks that read it.
 */
const CONTRACT_DOCUMENTS: ReadonlyArray<{ match: (p: string) => boolean; why: string }> = [
  { match: (p) => p === 'CONTEXT.md', why: 'context.seat-vocabulary reads the seat terms Get-SeatVocabulary declares' },
  { match: (p) => p === 'docs/seats.md', why: 'the seats.* checks read it against SeatCreation.ps1 and the two-seat suite, and the SessionStart hook serves it' },
  { match: (p) => p.startsWith('docs/templates/'), why: 'init and upgrade ship it' },
  { match: (p) => p === 'docs/project-hub-design.md', why: 'the hub.* checks read it against New-ProjectHub.ps1' },
  { match: (p) => p === 'docs/adr/0003-decisions-follow-their-subject.md', why: 'hub.dev-template-seeds-sections reads it' },
  { match: (p) => p === 'docs/adr/0013-a-hub-section-holds-only-what-the-project-can-close.md', why: 'hub.sections-name-their-destinations reads it' },
  { match: (p) => p === 'docs/supported-operation-matrix.md', why: 'acceptance.matrix-doc-matches-rows renders it from the matrix' },
];

type Outcome = { check: string; status: 'pass' | 'warn' | 'fail'; detail: string };

function git(root: string, args: string[], input?: string): { status: number; stdout: Buffer; stderr: string } {
  const ran = spawnSync('git', args, { cwd: root, input, maxBuffer: 1 << 30 });
  return { status: ran.status ?? 1, stdout: ran.stdout ?? Buffer.alloc(0), stderr: String(ran.stderr ?? '') };
}

/** A staged change as `git diff --cached --name-status -z` gives it. */
type Staged = { status: string; paths: string[] };

function stagedChanges(root: string): Staged[] {
  const head = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  const base = head.status === 0 ? 'HEAD' : '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  const diff = git(root, ['diff', '--cached', '--name-status', '-z', base]);
  if (diff.status !== 0) throw new Error(`git diff --cached failed: ${diff.stderr.trim()}`);
  const fields = diff.stdout.toString('utf8').split('\0').filter((field) => field.length > 0);
  const changes: Staged[] = [];
  for (let i = 0; i < fields.length; ) {
    const status = fields[i++]!;
    const count = /^[RC]/.test(status) ? 2 : 1;
    changes.push({ status, paths: fields.slice(i, i + count) });
    i += count;
  }
  return changes;
}

function isDocument(relative: string): boolean {
  if (!relative.endsWith('.md')) return false;
  const top = relative.split('/')[0]!;
  if (!relative.includes('/')) return true;
  return !top.startsWith('.') && !BEHAVIOUR_ROOTS.has(top);
}

/** Why this commit is not docs-only, or null when it is. */
function notDocsOnly(changes: Staged[]): string | null {
  if (changes.length === 0) return 'nothing is staged';
  for (const change of changes) {
    const shown = change.paths.join(' -> ');
    if (change.status !== 'A' && change.status !== 'M') return `${shown} is staged as ${change.status}, not an addition or a modification`;
    const relative = change.paths[0]!;
    if (!isDocument(relative)) return `${relative} is not a document`;
    const contract = CONTRACT_DOCUMENTS.find((entry) => entry.match(relative));
    if (contract) return `${relative} is a contract document (${contract.why})`;
  }
  return null;
}

/** The index: every staged path, and the text of the ones asked for, read in one `git cat-file --batch`. */
class Index {
  readonly paths: string[];
  private readonly lower: Set<string>;
  private readonly folders: Set<string>;
  private readonly texts = new Map<string, string | null>();
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
    const listed = git(root, ['ls-files', '-z']);
    if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr.trim()}`);
    this.paths = listed.stdout.toString('utf8').split('\0').filter((entry) => entry.length > 0);
    if (!this.paths.length) throw new Error('git ls-files returned nothing, so this gate read no files rather than proving anything.');
    this.lower = new Set(this.paths.map((entry) => entry.toLowerCase()));
    this.folders = new Set();
    for (const entry of this.paths) {
      const parts = entry.toLowerCase().split('/');
      for (let i = 1; i < parts.length; i += 1) this.folders.add(parts.slice(0, i).join('/'));
    }
  }

  load(paths: string[]): void {
    const wanted = [...new Set(paths)].filter((entry) => !this.texts.has(entry));
    if (!wanted.length) return;
    const batch = git(this.root, ['cat-file', '--batch'], wanted.map((entry) => `:${entry}\n`).join(''));
    if (batch.status !== 0) throw new Error(`git cat-file --batch failed: ${batch.stderr.trim()}`);
    const out = batch.stdout;
    let at = 0;
    for (const entry of wanted) {
      const newline = out.indexOf(0x0a, at);
      const header = out.subarray(at, newline).toString('utf8');
      at = newline + 1;
      const parsed = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
      if (!parsed) {
        this.texts.set(entry, null);
        continue;
      }
      const size = Number(parsed[2]);
      this.texts.set(entry, out.subarray(at, at + size).toString('utf8').replace(/^﻿/, ''));
      at += size + 1;
    }
  }

  text(relative: string): string | null {
    this.load([relative]);
    return this.texts.get(relative) ?? null;
  }

  /** As the runner's Test-Path answers it: a file or a folder, in the index or on disk, case-insensitively. */
  exists(relative: string): boolean {
    const key = relative.toLowerCase();
    return this.lower.has(key) || this.folders.has(key) || fs.existsSync(path.join(this.root, ...relative.split('/')));
  }
}

/** A path relative to the repository from a link `target` in the file `from`; null when it leaves the repository. */
function resolveLink(from: string, target: string): string | null {
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(from), target.replace(/\\/g, '/')));
  return joined.startsWith('../') || joined === '..' ? null : joined.replace(/^\.\//, '');
}

const LINK = /\]\(([^)#:]+\.md)(?:#[^)]*)?\)/g;

function plansDeclareTheirOwner(index: Index): Outcome {
  const check = 'workspace.plans-declare-their-owner';
  const plans = index.paths.filter((entry) => !entry.includes('/') && /^plan.*\.md$/i.test(entry)).sort();
  if (!plans.length) return { check, status: 'pass', detail: 'no root plan files' };
  index.load(plans);
  const unqualified = ['PLAN.md', 'PLAN-REVIEW-LOG.md'];
  const owners = new Map<string, string>();
  for (const plan of plans) {
    const match = /^>\s+\*\*Owner:\*\*\s+([a-z0-9][a-z0-9-]*)\s*\r?$/m.exec(index.text(plan) ?? '');
    if (!match) {
      return { check, status: 'fail', detail: `${plan} declares no owner. Add a '> **Owner:** <project-hub-slug>' line under its heading, so a plan for another project cannot silently occupy a name this repository cites.` };
    }
    const slug = match[1]!;
    owners.set(plan, slug);
    if (unqualified.includes(plan) && slug !== 'library-dev') {
      return { check, status: 'fail', detail: `${plan} is owned by '${slug}', but the unqualified plan names belong to this workspace. A plan whose subject is anything other than the Library must be namespaced -- PLAN-${slug}.md -- because ${plan} is what docs/ and tools/ cite by item number.` };
    }
  }
  const foreign = [...owners.keys()].filter((plan) => owners.get(plan) !== 'library-dev');
  let detail = `${owners.size} root plan file(s) declare an owner`;
  if (foreign.length) detail += `; ${foreign.length} belong to another project and are namespaced: ${foreign.join(', ')}`;
  return { check, status: 'pass', detail };
}

function measureWords(text: string): number {
  return text.replace(/<!--[\s\S]*?-->/g, ' ').split(/\s+/).filter((word) => word.length > 0).length;
}

function alwaysOnBudget(index: Index, root: string): Outcome {
  const check = 'context.always-on-budget';
  const fileBudget = 900;
  const totalBudget = 1100;
  const warnFraction = 0.9;
  const claudeMd = index.text('CLAUDE.md');
  if (claudeMd === null) return { check, status: 'fail', detail: 'CLAUDE.md is missing.' };
  const fileWords = measureWords(claudeMd);
  const parts: Array<{ name: string; words: number }> = [{ name: 'CLAUDE.md', words: fileWords }];
  const frontmatterOf = (text: string): string | null => {
    const sticky = /---\r?\n([\s\S]*?)^---\r?\n/my;
    const match = sticky.exec(text);
    return match ? match[1]! : null;
  };

  const skills = index.paths.filter((entry) => entry.startsWith('.claude/skills/') && path.posix.basename(entry) === 'SKILL.md').sort();
  index.load(skills);
  for (const skill of skills) {
    const frontmatter = frontmatterOf(index.text(skill) ?? '');
    if (frontmatter === null) continue;
    const description = /^description:[ \t]*([\s\S]*?)(?=^[A-Za-z_][\w-]*:|(?![\s\S]))/m.exec(frontmatter);
    if (!description) continue;
    parts.push({ name: `skill:${path.posix.basename(path.posix.dirname(skill))}`, words: measureWords(description[1]!) });
  }

  const listItem = /^[ \t]*-[ \t]*["']?([^"'\r\n]+?)["']?[ \t]*\r?$/gm;
  const rules = index.paths.filter((entry) => entry.startsWith('.claude/rules/') && entry.endsWith('.md')).sort();
  index.load(rules);
  for (const rule of rules) {
    const text = index.text(rule) ?? '';
    const frontmatter = frontmatterOf(text);
    const paths = frontmatter === null ? null : /^paths:[ \t]*\r?\n([\s\S]*?)(?=^[A-Za-z_][\w-]*:|(?![\s\S]))/m.exec(frontmatter);
    if (!paths) {
      parts.push({ name: `rule:${path.posix.basename(rule)}`, words: measureWords(text) });
      continue;
    }
    const patterns = [...paths[1]!.matchAll(listItem)].map((match) => match[1]!);
    if (!patterns.length) return { check, status: 'fail', detail: `${path.posix.basename(rule)} declares paths: with no patterns under it` };
    for (const pattern of patterns) {
      const literal = pattern.split(/[*?[]/)[0]!.replace(/\/+$/, '');
      if (!literal.trim()) continue;
      if (!fs.existsSync(path.join(root, literal))) {
        return { check, status: 'fail', detail: `${path.posix.basename(rule)} is scoped to '${pattern}', which matches nothing in this workspace` };
      }
    }
  }

  const total = parts.reduce((sum, part) => sum + part.words, 0);
  if (fileWords > fileBudget) return { check, status: 'fail', detail: `CLAUDE.md is ${fileWords} words, over its ${fileBudget}-word budget by ${fileWords - fileBudget}` };
  if (total > totalBudget) {
    const breakdown = parts.map((part) => `${part.name} ${part.words}`).join(', ');
    return { check, status: 'fail', detail: `the always-on surface is ${total} words, over the ${totalBudget}-word budget by ${total - totalBudget}: ${breakdown}` };
  }
  const summary = `CLAUDE.md ${fileWords}/${fileBudget}, all always-on ${total}/${totalBudget} words`;
  if (fileWords >= Math.round(fileBudget * warnFraction) || total >= Math.round(totalBudget * warnFraction)) {
    return { check, status: 'warn', detail: `${summary} -- within ${Math.round(100 - warnFraction * 100)}% of a ceiling; move words to a path-scoped rule or a Skill body, never to an @import` };
  }
  return { check, status: 'pass', detail: summary };
}

function linksResolve(index: Index): Outcome {
  const check = 'docs.links-resolve';
  const files = index.paths.filter((entry) => (entry.startsWith('docs/') || !entry.includes('/')) && entry.endsWith('.md'));
  index.load(files);
  const broken: string[] = [];
  for (const file of files) {
    for (const match of (index.text(file) ?? '').matchAll(LINK)) {
      const target = match[1]!;
      const resolved = resolveLink(file, target);
      if (resolved === null ? !fs.existsSync(path.resolve(path.dirname(file), target)) : !index.exists(resolved)) {
        broken.push(`${path.posix.basename(file)} -> ${target}`);
      }
    }
  }
  if (broken.length) return { check, status: 'fail', detail: `broken link(s): ${broken.join('; ')}` };
  return { check, status: 'pass', detail: `${files.length} files scanned, all links resolve` };
}

function adrIndexIsComplete(index: Index): Outcome {
  const check = 'docs.adr-index-is-complete';
  const onDisk = index.paths.filter((entry) => /^docs\/adr\/[^/]+\.md$/.test(entry)).map((entry) => path.posix.basename(entry)).sort();
  if (!onDisk.length) return { check, status: 'fail', detail: 'docs/adr holds no ADR, so this check has no subject.' };
  const indexText = index.text('docs/_index.md');
  if (indexText === null) return { check, status: 'fail', detail: 'docs/_index.md is missing.' };
  const linked = [...new Set([...indexText.matchAll(/\]\(adr\/([^)#]+\.md)/g)].map((match) => match[1]!))].sort();
  const missing = onDisk.filter((name) => !linked.includes(name));
  const stale = linked.filter((name) => !onDisk.includes(name));
  if (missing.length) return { check, status: 'fail', detail: `docs/_index.md links no entry for: ${missing.join(', ')}` };
  if (stale.length) return { check, status: 'fail', detail: `docs/_index.md links ADR(s) that are not on disk: ${stale.join(', ')}` };
  return { check, status: 'pass', detail: `all ${onDisk.length} ADRs are linked from docs/_index.md, and every ADR link resolves to one` };
}

function sectionOf(text: string, heading: string): string | null {
  const match = new RegExp(`^##\\s+${heading}\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'm').exec(text);
  return match ? match[1]! : null;
}

function readerGuides(index: Index): Outcome {
  const check = 'skill.library-help-pointers-resolve (reader guides)';
  const indexText = index.text('docs/_index.md');
  const skillText = index.text('.claude/skills/library-help/SKILL.md');
  if (indexText === null || skillText === null) return { check, status: 'fail', detail: 'docs/_index.md or the library-help SKILL.md is missing.' };
  const indexSection = sectionOf(indexText, 'Guides');
  if (indexSection === null) return { check, status: 'fail', detail: 'docs/_index.md has no "## Guides" section, so there is no declaration of what the reader guides are' };
  const indexGuides = [...new Set([...indexSection.matchAll(/^[*-]\s+\[[^\]]*\]\(([A-Za-z0-9_./-]+\.md)\)/gm)].map((match) => match[1]!))].sort();
  if (!indexGuides.length) return { check, status: 'fail', detail: 'docs/_index.md "## Guides" lists nothing; this half would pass vacuously' };
  const problems: string[] = [];
  for (const guide of indexGuides) {
    if (!guide.startsWith('guides/')) problems.push(`docs/_index.md lists docs/${guide} as a reader guide, but a reader guide belongs under docs/guides/ where someone browsing the folder will find it`);
  }
  const skillSection = sectionOf(skillText, 'Guides to hand the reader');
  if (skillSection === null) return { check, status: 'fail', detail: 'SKILL.md has no "## Guides to hand the reader" section, so a session is never told the reader guides exist' };
  const skillGuides = [...new Set([...skillSection.matchAll(/^[*-]\s+\[[^\]]*\]\((?:\.\.\/\.\.\/\.\.\/|https:\/\/github\.com\/eKioga\/deskpost\/blob\/v[0-9A-Za-z.+-]+\/)docs\/([A-Za-z0-9_./-]+\.md)\)/gm)].map((match) => match[1]!))].sort();
  if (!skillGuides.length) return { check, status: 'fail', detail: 'SKILL.md "## Guides to hand the reader" lists nothing; this half would pass vacuously' };
  for (const guide of indexGuides) {
    if (!skillGuides.includes(guide)) problems.push(`docs/_index.md offers docs/${guide} as a reader guide and SKILL.md does not, so no session will hand it over`);
  }
  for (const guide of skillGuides) {
    if (!indexGuides.includes(guide)) problems.push(`SKILL.md offers docs/${guide} as a reader guide and docs/_index.md's ## Guides does not list it`);
  }
  if (problems.length) return { check, status: 'fail', detail: problems.join('; ') };
  return { check, status: 'pass', detail: `${indexGuides.length} reader guides listed both ways` };
}

function noForeignInstall(index: Index, root: string): Outcome {
  const check = 'workspace.no-foreign-install (document half)';
  const installed = ['_triage.md', 'holding.md'].filter((name) => fs.existsSync(path.join(root, name)));
  if (installed.length) {
    return { check, status: 'fail', detail: `${installed.join(', ')} at the repository root: a workspace-installing product was bootstrapped here. Remove these and check CLAUDE.md, notebook/ and shelf/ for merged content.` };
  }
  const text = index.text('CLAUDE.md');
  if (text === null) return { check, status: 'fail', detail: 'CLAUDE.md is missing; this workspace no longer introduces itself.' };
  for (const anchor of ['# The Librarian', 'You are the Librarian of **the Library**', '[CONTEXT.md](CONTEXT.md) is the glossary']) {
    if (!text.includes(anchor)) {
      return { check, status: 'fail', detail: `CLAUDE.md no longer carries '${anchor}'. Either this workspace's standing rules were rewritten by another product's install, or the anchor was edited -- update this check deliberately if the latter.` };
    }
  }
  return { check, status: 'pass', detail: 'no foreign install at the root; CLAUDE.md still declares this workspace' };
}

function resetVocabulary(index: Index): Outcome {
  const check = 'reset.vocabulary-routes (document half)';
  const surfaces = ['CLAUDE.md', 'CONTEXT.md', 'AGENTS.md', 'docs/librarian-operation-playbooks.md', '.claude/skills/library-help/SKILL.md'];
  index.load(surfaces);
  const vocabulary = /start\s+fresh/i;
  const evidence = /clean\s+(?:working tree|`?git status`?)\s+is\s+(?:never|not|no)\s+evidence/i;
  const unclaimed: string[] = [];
  const silent: string[] = [];
  for (const surface of surfaces) {
    const text = index.text(surface);
    if (text === null) return { check, status: 'fail', detail: `${surface} is missing.` };
    if (!vocabulary.test(text)) unclaimed.push(surface);
    if (!evidence.test(text)) silent.push(surface);
  }
  if (unclaimed.length) return { check, status: 'fail', detail: `the reader's own reset wording is unclaimed on: ${unclaimed.join(', ')}` };
  if (silent.length) return { check, status: 'fail', detail: `nothing says a clean working tree is not evidence of a Reset on: ${silent.join(', ')}` };
  const untriaged = ['CONTEXT.md', 'docs/librarian-operation-playbooks.md'].filter((surface) => !/triage\s+the\s+Notebook\s+first/i.test(index.text(surface) ?? ''));
  if (untriaged.length) {
    return { check, status: 'fail', detail: `nothing tells the Librarian to triage the Notebook before a reset on: ${untriaged.join(', ')}. Triage is a tidying verb; the urgency Handoff carried lives only in this sentence.` };
  }
  return { check, status: 'pass', detail: `${surfaces.length} surfaces claim the reset wording and its evidence rule` };
}

function hitIsALocation(index: Index): Outcome {
  const check = 'retrieval.hit-is-a-location (document half)';
  const declared = /\$script:SearchHitRuleStem\s*=\s*'([^']+)'/.exec(index.text('tools/SearchBoundaries.ps1') ?? '');
  if (!declared) return { check, status: 'fail', detail: 'tools/SearchBoundaries.ps1 declares no hit rule stem this gate can read.' };
  const stem = declared[1]!.toLowerCase();
  const surfaces = ['CLAUDE.md', 'docs/librarian-voice-and-wayfinding.md', '.claude/skills/library-help/SKILL.md'];
  index.load(surfaces);
  const silent: string[] = [];
  for (const surface of surfaces) {
    const text = index.text(surface);
    if (text === null) return { check, status: 'fail', detail: `${surface} is missing.` };
    if (!text.toLowerCase().includes(stem)) silent.push(surface);
  }
  if (silent.length) return { check, status: 'fail', detail: `the hit-is-a-location rule is absent from: ${silent.join(', ')}` };
  return { check, status: 'pass', detail: `all ${surfaces.length} surfaces carry the rule` };
}

function delegationRunsHooks(index: Index): Outcome {
  const check = 'codex.delegation-runs-hooks (document half)';
  const surfaces = ['docs/librarian-operation-playbooks.md', 'docs/model-division-of-labor.md'];
  const trustFlag = '--dangerously-bypass-hook-trust';
  const recipe = /^[ \t]*codex\s+exec\s+[^\r\n]*--sandbox\s+workspace-write[^\r\n]*\r?$/gm;
  index.load(surfaces);
  let commands = 0;
  const unguarded: string[] = [];
  const silent: string[] = [];
  for (const surface of surfaces) {
    const text = index.text(surface);
    if (text === null) return { check, status: 'fail', detail: `${surface} is missing.` };
    const found = [...text.matchAll(recipe)];
    if (!found.length) return { check, status: 'fail', detail: `${surface} carries no delegation command for this check to read; the recipe moved and the assertion is now blind.` };
    for (const hit of found) {
      commands += 1;
      if (!hit[0].includes(trustFlag)) unguarded.push(`${surface} : ${hit[0].trim()}`);
    }
    if (!text.includes('CODEX_HOME')) silent.push(surface);
  }
  if (unguarded.length) return { check, status: 'fail', detail: `a documented delegation command omits ${trustFlag}, so a delegate launched from it runs with no Library hook and nothing says so: ${unguarded.join(' | ')}` };
  if (silent.length) return { check, status: 'fail', detail: `nothing names CODEX_HOME as what decides whether a delegate's hooks run at all on: ${silent.join(', ')}` };
  return { check, status: 'pass', detail: `${commands} delegation command(s) across ${surfaces.length} surface(s) carry ${trustFlag}, and both name the CODEX_HOME precondition` };
}

/**
 * The two scans, through tools/DeploymentScan.ps1's own functions in one PowerShell process. The values travel in
 * environment variables, so nothing is quoted into the command text.
 */
const SCANS_COMMAND = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$program = $env:DOCS_GATE_PROGRAM
. (Join-Path $program 'tools/LibraryDeployment.ps1')
. (Join-Path $program 'tools/DeploymentScan.ps1')
$result = [ordered]@{}
try {
    $scan = Invoke-IdentityScan -Workspace $program -CommitMessageFile $env:DOCS_GATE_MESSAGE
    $result.identity = [ordered]@{ status = [string]$scan.status; detail = [string]$scan.detail }
} catch { $result.identity = [ordered]@{ status = 'fail'; detail = "the identity scan threw: $_" } }
try {
    $resolved = Resolve-LibraryWorkspace -Explicit ''
    if ([string]$resolved.kind -ceq 'conflict') { throw ([string]$resolved.reason) }
    $denylistRoot = if ([string]$resolved.kind -ceq 'none') { $program } else { (Resolve-Path -LiteralPath ([string]$resolved.workspace)).Path }
    $product = @(Get-DeploymentScanFiles -Workspace $program)
    $staged = @($env:DOCS_GATE_FILES -split "\n" | Where-Object { $_ })
    $files = [string[]]@($staged | Where-Object { $product -contains $_ })
    $denylist = [string[]]@(Get-DeploymentScanDenylist -Workspace $denylistRoot)
    $hits = @(Find-DeploymentScanHits -Workspace $program -Files $files -Denylist $denylist)
    if ($hits.Count) {
        $named = @($hits | ForEach-Object { "$($_.file):$($_.line) [$($_.kind)] $($_.match)" } | Sort-Object -Unique)
        $result.deployment = [ordered]@{ status = 'fail'; detail = ("$($hits.Count) deployment default(s) in product files: " + ($named -join '; ') + '. These ship. Move the value into generated state and resolve it through tools/LibraryDeployment.ps1.') }
    } else {
        $result.deployment = [ordered]@{ status = 'pass'; detail = "$($files.Count) staged product document(s) clean against $($denylist.Count) configured value(s) from $denylistRoot and the structural detectors" }
    }
} catch { $result.deployment = [ordered]@{ status = 'fail'; detail = "the deployment scan threw: $_" } }
[Console]::Out.WriteLine('DOCS-GATE-SCANS ' + ($result | ConvertTo-Json -Compress -Depth 4))
`;

function scans(root: string, documents: string[], messageFile: string): Outcome[] {
  const ran = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCANS_COMMAND], {
    cwd: root,
    env: { ...process.env, DOCS_GATE_PROGRAM: root, DOCS_GATE_FILES: documents.join('\n'), DOCS_GATE_MESSAGE: messageFile },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1 << 26,
  });
  const line = (ran.stdout ?? '').split(/\r?\n/).find((entry) => entry.startsWith('DOCS-GATE-SCANS '));
  if (!line) {
    const why = `${(ran.stderr ?? '').trim() || (ran.error ? String(ran.error) : `exit ${ran.status}`)}`.slice(0, 600);
    return [
      { check: 'public.identity-scan', status: 'fail', detail: `the scans did not run, so nothing scanned the staged blobs: ${why}` },
      { check: 'public.no-deployment-defaults', status: 'fail', detail: 'the scans did not run' },
    ];
  }
  const parsed = JSON.parse(line.slice('DOCS-GATE-SCANS '.length)) as Record<'identity' | 'deployment', { status: string; detail: string }>;
  const as = (check: string, entry: { status: string; detail: string }): Outcome => ({
    check,
    status: entry.status === 'pass' ? 'pass' : entry.status === 'warn' ? 'warn' : 'fail',
    detail: entry.detail,
  });
  return [as('public.identity-scan', parsed.identity), as('public.no-deployment-defaults (staged documents)', parsed.deployment)];
}

function rulesRegister(root: string): Outcome {
  const check = 'kernel.selftest (section 119, the rules register)';
  const ran = spawnSync(process.execPath, [path.join(root, 'kernel', 'test', 'selftest.ts')], {
    cwd: root,
    env: { ...process.env, LIBRARY_SELFTEST_SECTIONS: '119' },
    encoding: 'utf8',
  });
  const lines = `${ran.stdout ?? ''}${ran.stderr ?? ''}`.trim().split(/\r?\n/);
  if (ran.status !== 0) return { check, status: 'fail', detail: lines.slice(-4).join(' | ') };
  return { check, status: 'pass', detail: lines.at(-1) ?? '' };
}

function main(argv: string[]): number {
  let messageFile = '';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--commit-message-file' && i + 1 < argv.length) messageFile = argv[++i]!;
    else throw new Error(`unknown argument '${argv[i]}'. Usage: node tools/docs-gate.ts [--commit-message-file <file>]`);
  }
  const top = git(process.cwd(), ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) throw new Error(`not in a git working tree: ${top.stderr.trim()}`);
  const root = path.resolve(top.stdout.toString('utf8').trim());

  const changes = stagedChanges(root);
  const reason = notDocsOnly(changes);
  if (reason !== null) {
    process.stdout.write(`docs gate: not a docs-only commit (${reason}); the full runner checks it.\n`);
    return EXIT_NOT_DOCS;
  }
  const documents = changes.map((change) => change.paths[0]!);
  const started = Date.now();
  process.stdout.write(`docs gate: ${documents.length} staged document(s), every one a document; running the document checks.\n`);

  const index = new Index(root);
  const outcomes: Outcome[] = [plansDeclareTheirOwner(index)];
  if (documents.includes('CLAUDE.md') || documents.includes('AGENTS.md')) outcomes.push(alwaysOnBudget(index, root));
  outcomes.push(
    linksResolve(index),
    adrIndexIsComplete(index),
    readerGuides(index),
    noForeignInstall(index, root),
    resetVocabulary(index),
    hitIsALocation(index),
    delegationRunsHooks(index),
    ...scans(root, documents, messageFile),
    rulesRegister(root),
  );

  for (const outcome of outcomes) {
    process.stdout.write(`${outcome.status.toUpperCase().padEnd(4)}  ${outcome.check}: ${outcome.detail}\n`);
  }
  const count = (status: Outcome['status']): number => outcomes.filter((outcome) => outcome.status === status).length;
  const failed = count('fail');
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  process.stdout.write(`docs gate: ${count('pass')} passed, ${count('warn')} warned, ${failed} failed (${seconds}s)\n`);
  return failed ? EXIT_FAIL : EXIT_PASS;
}

let code: number;
try {
  code = main(process.argv.slice(2));
} catch (error) {
  // An error is never a pass and never a refusal: the hook falls back to the full runner.
  process.stderr.write(`docs gate: could not decide (${error instanceof Error ? error.message : String(error)}); the full runner checks this commit.\n`);
  code = 1;
}
process.exit(code);
