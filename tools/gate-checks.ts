/**
 * THE CHECKS THE GATE RAN THROUGH POWERSHELL, IN TYPESCRIPT (kickoffs/s224 row 2; PLAN-powershell-retirement.md U2
 * item 1). Each judges a repository file nothing else judges, and was a block of `tools/Invoke-LibraryChecks.ps1`
 * that `gate.ts` started as `powershell.exe -File ... -Only <name>` for each changed path `tools/check-map.json`
 * attaches it to. The rule is ported, not the PowerShell structure. Each returns one row in the gate's own shape,
 * with a `caught` line naming the defect it guards. Nothing here starts a process.
 *
 * The ledger of every runner check and why the rest retired: D:/dev/scratch/deskpost/s224/ledger.md (the handback
 * copies its counts).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';
export interface CheckOutcome { check: string; tier: 'commit'; status: CheckStatus; seconds: number; detail: string; caught: string }

const PROGRAM = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
/** Kernel modules are code: always this checkout's, whichever tree is being judged. */
const kernel = async <T>(file: string): Promise<T> => import(pathToFileURL(path.join(PROGRAM, 'kernel', 'src', file)).href) as Promise<T>;

class Fault extends Error {}
const read = (root: string, relative: string): string | null => {
  const file = path.join(root, relative);
  return fs.existsSync(file) && fs.statSync(file).isFile() ? fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '') : null;
};
const parse = (text: string, label: string): unknown => {
  try { return JSON.parse(text); } catch (error) { throw new Fault(`${label} is not valid JSON: ${(error as Error).message}`); }
};
/** Every file under a folder, as root-relative paths with forward slashes, sorted. */
function walk(root: string, relative: string): string[] {
  const start = path.join(root, relative);
  if (!fs.existsSync(start)) return [];
  const found: string[] = [];
  for (const entry of fs.readdirSync(start, { withFileTypes: true })) {
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) found.push(...walk(root, child));
    else if (entry.isFile()) found.push(child);
  }
  return found.sort();
}

/** One row: the body's text (a `WARN: ` prefix warns, `SKIP: ` skips), a Fault fails, any other error fails naming it. */
async function row(check: string, caught: string, body: () => string | Promise<string>): Promise<CheckOutcome> {
  const started = performance.now();
  let status: CheckStatus = 'pass', detail: string;
  try {
    detail = await body();
    if (detail.startsWith('WARN: ')) { status = 'warn'; detail = detail.slice(6); }
    else if (detail.startsWith('SKIP: ')) { status = 'skip'; detail = detail.slice(6); }
  } catch (error) {
    status = 'fail';
    detail = error instanceof Fault ? error.message : `${check} could not run: ${error instanceof Error ? error.message : String(error)}`;
  }
  return { check, tier: 'commit', status, seconds: (performance.now() - started) / 1000, detail, caught };
}

const SETTINGS_FILES = ['.claude/settings.json', '.claude/settings.local.json'];

/** settings.parse: the program's Claude settings exist and parse; a file that does not parse is skipped whole by the harness. */
export function settingsParse(root: string): Promise<CheckOutcome> {
  return row('settings.parse', 'a settings file the harness cannot parse, which silently drops its allowlist and every guard hook', () => {
    const present = SETTINGS_FILES.filter(file => read(root, file) !== null);
    if (!present.length) throw new Fault('No .claude/settings.json or settings.local.json found.');
    for (const file of present) parse(read(root, file)!, path.posix.basename(file));
    return `parsed ${present.length} file(s)`;
  });
}

/** settings.hooks-registered: every required hook under the event it acts on, in a block the harness will load. */
export function settingsHooksRegistered(root: string): Promise<CheckOutcome> {
  return row('settings.hooks-registered', 'a guard moved to the wrong event or a malformed hooks block, which leaves the guard registered and silent (a5a6856)', async () => {
    const { REQUIRED_HOOKS, hookRegistrationProblems, claudeHookShapeFaults } = await kernel<typeof import('../kernel/src/hookregistry.ts')>('hookregistry.ts');
    const present = SETTINGS_FILES.filter(file => read(root, file) !== null);
    if (!present.length) throw new Fault('No .claude/settings.json or settings.local.json found.');
    // Both files: the harness merges them, so a hook moved from one to the other is still registered.
    const trees = present.map(file => parse(read(root, file)!, path.posix.basename(file)));
    const problems = hookRegistrationProblems(trees);
    const blocking = problems.filter(problem => !problem.optional);
    if (blocking.length) throw new Fault(blocking.map(problem => problem.detail).join('; '));
    const faults = trees.flatMap((tree, index) => tree !== null && typeof tree === 'object' && Object.hasOwn(tree, 'hooks') && (tree as Record<string, unknown>)['hooks'] !== null
      ? claudeHookShapeFaults(tree, path.posix.basename(present[index]!)) : []);
    if (faults.length) throw new Fault(`${faults.join('; ')} -- a settings file whose hooks block is malformed is skipped ENTIRELY by the harness, so every hook counted above would be silent in a session rooted here.`);
    if (problems.length) return `WARN: ${problems.map(problem => problem.detail).join('; ')}`;
    return `all ${REQUIRED_HOOKS.length} hooks registered under the events they act on`;
  });
}

/** codex.project-access-config: the Codex templates and their render bind the guards and both servers, and every path they name exists. */
export function codexProjectAccessConfig(root: string): Promise<CheckOutcome> {
  return row('codex.project-access-config', "Codex bindings that name a missing file or an event Codex rejects, so a Codex session runs with no Library hook (e75db29)", async () => {
    const configTemplate = read(root, '.codex/config.template.toml'), hooksTemplate = read(root, '.codex/hooks.template.json');
    const configText = read(root, '.codex/config.toml'), hooksText = read(root, '.codex/hooks.json');
    if (configText === null && hooksText === null) return 'SKIP: both rendered Codex files are absent (a fresh clone or worktree); render them with tools/Initialize-CodexLibrary.ps1';
    if (configTemplate === null) throw new Fault('.codex/config.template.toml is missing.');
    if (hooksTemplate === null) throw new Fault('.codex/hooks.template.json is missing.');
    if (configText === null) throw new Fault('.codex/config.toml is missing.');
    if (hooksText === null) throw new Fault('.codex/hooks.json is missing.');
    for (const [name, text] of [['config.template.toml', configTemplate], ['hooks.template.json', hooksTemplate]] as const)
      if (/(?:[a-z]:[\\/]|\/users\/|\/home\/|%userprofile%|\$env:userprofile)/i.test(text)) throw new Fault(`${name} contains a machine-specific filesystem binding.`);
    const config = configText.replace(/\r\n/g, '\n');
    const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
    for (const section of ['features', 'mcp_servers.basic-memory', 'mcp_servers.validated-book-reader'])
      if (!new RegExp(`^\\[${escape(section)}\\]\\s*$`, 'mi').test(config)) throw new Fault(`missing [${section}] in .codex/config.toml`);
    if (!/^\[features\]\s+[\s\S]*?^hooks\s*=\s*true\s*$/mi.test(config)) throw new Fault('Codex project hooks are not enabled.');
    for (const server of ['basic-memory', 'validated-book-reader']) {
      if (!new RegExp(`^\\[mcp_servers\\.${escape(server)}\\]\\s+[\\s\\S]*?^enabled\\s*=\\s*true\\s*$`, 'mi').test(config)) throw new Fault(`${server} is not enabled for trusted Codex sessions.`);
      if (!new RegExp(`^\\[mcp_servers\\.${escape(server)}\\]\\s+[\\s\\S]*?^required\\s*=\\s*true\\s*$`, 'mi').test(config)) throw new Fault(`${server} is not required for trusted Codex sessions.`);
    }
    if (/^cwd\s*=/m.test(config)) throw new Fault('Codex validated-reader startup must not depend on its process working directory.');
    const hooks = parse(hooksText, '.codex/hooks.json');
    const { codexHookShapeFaults, codexRegistrationProblems, hookEntryText, asList, isObject } = await kernel<typeof import('../kernel/src/hookregistry.ts')>('hookregistry.ts');
    const shape = codexHookShapeFaults(hooks, '.codex/hooks.json');
    if (shape.length) throw new Fault(shape.join('; '));
    const registration = codexRegistrationProblems(hooks);
    if (registration.length) throw new Fault(registration.join(' '));
    // Every absolute .ps1 a generated binding names must exist: the render is gitignored, so a program that moved leaves it behind.
    const missing: string[] = [];
    const absent = (token: string) => token.endsWith('.ps1') && path.isAbsolute(token) && fs.statSync(token, { throwIfNoEntry: false })?.isFile() !== true;
    const events = isObject(hooks) && isObject(hooks['hooks']) ? Object.entries(hooks['hooks']) : [];
    for (const [event, blocks] of events)
      for (const block of asList(blocks))
        for (const entry of isObject(block) ? asList(block['hooks']) : [])
          for (const token of hookEntryText(entry).split(/\s+/).map(text => text.replace(/^"+|"+$/g, ''))) if (absent(token)) missing.push(`${event} -> ${token}`);
    const readerArgs = /^args\s*=\s*\[([^\n]+)\]\s*$/m.exec(config);
    for (const token of readerArgs ? readerArgs[1]!.split(',').map(text => text.trim().replace(/^"+|"+$/g, '')) : []) if (absent(token)) missing.push(`mcp_servers.validated-book-reader -> ${token}`);
    if (missing.length) throw new Fault(`a generated Codex binding names a file that is not there, so it cannot start: ${missing.join('; ')}. These files are generated and gitignored, so a program that moved leaves them behind: re-run tools/Initialize-CodexLibrary.ps1.`);
    // The enabled-table rule init and the checkout renderer use, from the kernel: what the user's Codex turns on must be turned off here.
    try {
      const { codexTurnedOn, codexUserConfig, readCodexConfigTables } = await kernel<typeof import('../kernel/src/doctor.ts')>('doctor.ts');
      const user = codexUserConfig();
      if (user.state === 'unreadable') return `WARN: could not check inherited Codex servers and plugins (cannot read the user Codex config: ${user.path}); re-run tools/Initialize-CodexLibrary.ps1.`;
      const template = readCodexConfigTables(configTemplate.replace(/^enabled\s*=.*$/gm, '')), rendered = readCodexConfigTables(configText);
      if (!template || !rendered) return 'WARN: could not check inherited Codex servers and plugins (cannot read the checkout Codex tables); re-run tools/Initialize-CodexLibrary.ps1.';
      const on = user.tables ? codexTurnedOn(user.tables) : { servers: [], plugins: [] };
      const left = [...on.servers.filter(entry => !template.servers.some(table => table.name === entry.name) && !rendered.servers.some(table => table.name === entry.name && table.enabled === false)).map(entry => `server ${entry.name}`),
        ...on.plugins.filter(entry => !rendered.plugins.some(table => table.name === entry.name && table.enabled === false)).map(entry => `plugin ${entry.name}`)];
      if (left.length) return `WARN: inherited Codex entries are still enabled: ${left.join(', ')}; re-run tools/Initialize-CodexLibrary.ps1.`;
    } catch (error) { return `WARN: could not check inherited Codex servers and plugins; re-run tools/Initialize-CodexLibrary.ps1. ${error instanceof Error ? error.message : String(error)}`; }
    return 'both MCP servers required; events nested under hooks; Desk guard, shell guard, patch guard and context hook registered, and every path they name resolves';
  });
}

/** seats.session-start-section-resolves: the section the SessionStart hook serves from docs/seats.md resolves, stays bounded and carries the ask. */
export function seatsSessionStartSectionResolves(root: string): Promise<CheckOutcome> {
  return row('seats.session-start-section-resolves', 'a renamed or run-on seats section, which hands a seatless session no instruction or the whole document', async () => {
    const hook = read(root, 'kernel/src/hookseatstart.ts') ?? read(PROGRAM, 'kernel/src/hookseatstart.ts');
    const heading = hook === null ? null : /^const SECTION = '([^']+)';$/m.exec(hook)?.[1];
    if (!heading) throw new Fault("no served heading was found in kernel/src/hookseatstart.ts (const SECTION = '...'); this check read nothing rather than proving anything.");
    if (read(root, 'docs/seats.md') === null) throw new Fault('docs/seats.md is missing; the seat hook has no document to serve.');
    // The hook's own cutter, not a second reading of headings: a check that cut its own way would pass on a document the hook cannot cut.
    const { markdownSection } = await kernel<typeof import('../kernel/src/hookseatstart.ts')>('hookseatstart.ts');
    const section = markdownSection(path.join(root, 'docs', 'seats.md'), heading);
    if (!section || !section.trim()) throw new Fault(`the SessionStart seat hook serves '${heading}' from docs/seats.md, and that heading does not resolve. A seatless session would be handed a roster with no instruction.`);
    if (section.includes('## Where a Desk lives')) throw new Fault(`the '${heading}' cut ran past its own section into the next one.`);
    if (!section.includes('Ask the reader which seat')) throw new Fault(`the '${heading}' section no longer tells a seatless session to ask which seat; the hook holds no wording of its own to fall back on (ADR-0014).`);
    return `the served heading '${heading}' resolves in docs/seats.md, bounded, and carries the ask`;
  });
}

/** skill.library-help-pointers-resolve: the library-help Skill's links resolve, its reference set matches disk, and its guides match docs/_index.md. */
export function skillLibraryHelpPointersResolve(root: string): Promise<CheckOutcome> {
  return row('skill.library-help-pointers-resolve', 'a Skill reference nothing loads, a dead link out of the Skill, or a reader guide the Skill never offers', () => {
    const skillRoot = '.claude/skills/library-help';
    const skillText = read(root, `${skillRoot}/SKILL.md`);
    if (skillText === null) throw new Fault('the library-help Skill is missing its SKILL.md; nothing can load the reader help surface');
    const manifest = read(root, '.codex-plugin/plugin.json');
    const version = manifest === null ? '' : String((parse(manifest, '.codex-plugin/plugin.json') as { version?: unknown }).version ?? '');
    const problems: string[] = [];
    const skillFiles = walk(root, skillRoot).filter(file => file.endsWith('.md'));
    for (const file of skillFiles) {
      const text = read(root, file) ?? '', name = path.posix.basename(file);
      for (const match of text.matchAll(/\]\(([^)#:]+\.md)(?:#[^)]*)?\)/g))
        if (!fs.existsSync(path.join(root, path.posix.dirname(file), match[1]!))) problems.push(`${name} -> ${match[1]} does not resolve`);
      // A link pinned to the release's tag: init copies the Skill into a Library, where ../../../docs/ names nothing.
      for (const match of text.matchAll(/\]\(https:\/\/github\.com\/eKioga\/deskpost\/blob\/v([0-9A-Za-z.+-]+)\/([^)#]+\.md)(?:#[^)]*)?\)/g)) {
        if (match[1] !== version) problems.push(`${name} links docs at v${match[1]}, not this release's v${version}`);
        if (!fs.existsSync(path.join(root, match[2]!))) problems.push(`${name} -> ${match[2]} (pinned) is not in this tree`);
      }
    }
    const onDisk = walk(root, `${skillRoot}/references`).filter(file => file.endsWith('.md') && path.posix.dirname(file) === `${skillRoot}/references`).map(file => path.posix.basename(file)).sort();
    const named = [...new Set([...skillText.matchAll(/references\/([A-Za-z0-9_.-]+\.md)/g)].map(match => match[1]!))].sort();
    if (!onDisk.length) throw new Fault('the library-help Skill has no reference files; this check would pass vacuously');
    for (const name of onDisk) if (!named.includes(name)) problems.push(`references/${name} exists but SKILL.md never names it, so nothing loads it`);
    for (const name of named) if (!onDisk.includes(name)) problems.push(`SKILL.md names references/${name}, which is not on disk`);
    const index = read(root, 'docs/_index.md');
    if (index === null) throw new Fault('docs/_index.md is missing');
    const sectionOf = (text: string, heading: string) => new RegExp(`^##\\s+${heading}\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'm').exec(text.replace(/\r\n/g, '\n'))?.[1] ?? null;
    const indexSection = sectionOf(index, 'Guides');
    if (indexSection === null) throw new Fault('docs/_index.md has no "## Guides" section, so there is no declaration of what the reader guides are');
    const indexGuides = [...new Set([...indexSection.matchAll(/^[*-]\s+\[[^\]]*\]\(([A-Za-z0-9_./-]+\.md)\)/gm)].map(match => match[1]!))].sort();
    if (!indexGuides.length) throw new Fault('docs/_index.md "## Guides" lists nothing; this half would pass vacuously');
    for (const guide of indexGuides) if (!guide.startsWith('guides/')) problems.push(`docs/_index.md lists docs/${guide} as a reader guide, but a reader guide belongs under docs/guides/ where someone browsing the folder will find it`);
    const skillSection = sectionOf(skillText, 'Guides to hand the reader');
    if (skillSection === null) throw new Fault('SKILL.md has no "## Guides to hand the reader" section, so a session is never told the reader guides exist');
    const skillGuides = [...new Set([...skillSection.matchAll(/^[*-]\s+\[[^\]]*\]\((?:\.\.\/\.\.\/\.\.\/|https:\/\/github\.com\/eKioga\/deskpost\/blob\/v[0-9A-Za-z.+-]+\/)docs\/([A-Za-z0-9_./-]+\.md)\)/gm)].map(match => match[1]!))].sort();
    if (!skillGuides.length) throw new Fault('SKILL.md "## Guides to hand the reader" lists nothing; this half would pass vacuously');
    for (const guide of indexGuides) if (!skillGuides.includes(guide)) problems.push(`docs/_index.md offers docs/${guide} as a reader guide and SKILL.md does not, so no session will hand it over`);
    for (const guide of skillGuides) if (!indexGuides.includes(guide)) problems.push(`SKILL.md offers docs/${guide} as a reader guide and docs/_index.md's ## Guides does not list it`);
    if (problems.length) throw new Fault(problems.join('; '));
    return `${skillFiles.length} Skill files, ${onDisk.length} references and ${indexGuides.length} reader guides all reachable both ways`;
  });
}

/** context.always-on-budget: CLAUDE.md, every Skill description and every unscoped rule fit the words every session loads. */
export function contextAlwaysOnBudget(root: string): Promise<CheckOutcome> {
  return row('context.always-on-budget', 'an always-on surface over its word budget, or a path-scoped rule whose pattern matches nothing and so never loads', () => {
    const fileBudget = 900, totalBudget = 1100, warnFraction = 0.9;
    const words = (text: string) => text.replace(/<!--[\s\S]*?-->/g, ' ').split(/\s+/).filter(Boolean).length;
    const claude = read(root, 'CLAUDE.md');
    if (claude === null) throw new Fault('CLAUDE.md is missing.');
    const fileWords = words(claude);
    const parts = [{ name: 'CLAUDE.md', words: fileWords }];
    const frontmatter = (text: string) => { const match = /^---\r?\n([\s\S]*?)^---\r?\n/m.exec(text); return match && match.index === 0 ? match[1]! : null; };
    for (const skill of walk(root, '.claude/skills').filter(file => path.posix.basename(file) === 'SKILL.md')) {
      const front = frontmatter(read(root, skill) ?? '');
      const description = front === null ? null : /^description:[ \t]*([\s\S]*?)(?=^[A-Za-z_][\w-]*:|(?![\s\S]))/m.exec(front);
      if (description) parts.push({ name: `skill:${path.posix.basename(path.posix.dirname(skill))}`, words: words(description[1]!) });
    }
    for (const rule of walk(root, '.claude/rules').filter(file => file.endsWith('.md'))) {
      const text = read(root, rule) ?? '', front = frontmatter(text);
      const paths = front === null ? null : /^paths:[ \t]*\r?\n([\s\S]*?)(?=^[A-Za-z_][\w-]*:|(?![\s\S]))/m.exec(front);
      if (!paths) { parts.push({ name: `rule:${path.posix.basename(rule)}`, words: words(text) }); continue; }
      const patterns = [...paths[1]!.matchAll(/^[ \t]*-[ \t]*["']?([^"'\r\n]+?)["']?[ \t]*\r?$/gm)].map(match => match[1]!);
      if (!patterns.length) throw new Fault(`${path.posix.basename(rule)} declares paths: with no patterns under it`);
      for (const pattern of patterns) {
        const literal = pattern.split(/[*?[]/)[0]!.replace(/\/+$/, '');
        if (literal.trim() && !fs.existsSync(path.join(root, literal))) throw new Fault(`${path.posix.basename(rule)} is scoped to '${pattern}', which matches nothing in this workspace`);
      }
    }
    const total = parts.reduce((sum, part) => sum + part.words, 0);
    if (fileWords > fileBudget) throw new Fault(`CLAUDE.md is ${fileWords} words, over its ${fileBudget}-word budget by ${fileWords - fileBudget}`);
    if (total > totalBudget) throw new Fault(`the always-on surface is ${total} words, over the ${totalBudget}-word budget by ${total - totalBudget}: ${parts.map(part => `${part.name} ${part.words}`).join(', ')}`);
    const summary = `CLAUDE.md ${fileWords}/${fileBudget}, all always-on ${total}/${totalBudget} words`;
    if (fileWords >= Math.round(fileBudget * warnFraction) || total >= Math.round(totalBudget * warnFraction))
      return `WARN: ${summary} -- within ${Math.round(100 - warnFraction * 100)}% of a ceiling; move words to a path-scoped rule or a Skill body, never to an @import`;
    return summary;
  });
}

const GENERATED_NOTICE = 'GENERATED by tools/PluginPackage.ps1 from the canonical Codex-layout manifests at the program root. Do not hand-edit: plugin.generated-files-match fails the gate on a drift.';
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
/** Key order and indentation do not matter; values do. */
function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
/** Codex expands ${PLUGIN_ROOT}, Claude ${CLAUDE_PLUGIN_ROOT}; `literal` holds exact from/to pairs (the reader's callable prefix). */
function claudeRoot(value: unknown, literal: string[] = []): JsonValue {
  if (typeof value === 'string') {
    let text = value.replace(/\$\{PLUGIN_ROOT\}/gi, '${CLAUDE_PLUGIN_ROOT}');
    for (let i = 0; i + 1 < literal.length; i += 2) text = text.split(literal[i]!).join(literal[i + 1]!);
    return text;
  }
  if (Array.isArray(value)) return value.map(item => claudeRoot(item, literal));
  if (value === null || typeof value !== 'object') return (value ?? null) as JsonValue;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, claudeRoot(item, literal)]));
}

/** The Claude plugin files and Codex's marketplace, generated from the canonical .codex-plugin files (PluginPackage.ps1 New-ClaudeGeneratedFiles). */
export function generatedPluginFiles(root: string): Record<string, JsonValue> {
  const load = (relative: string) => {
    const text = read(root, relative);
    if (text === null) throw new Fault(`the canonical plugin package has no ${relative}; the Codex layout is the source and it is incomplete.`);
    return parse(text, relative) as Record<string, unknown>;
  };
  const manifest = load('.codex-plugin/plugin.json'), reader = load('.codex-plugin/reader.json'), hooks = load('.codex-plugin/hooks.json');
  load('.codex-plugin/mcp.json');
  const pluginId = String(manifest['name'] ?? '');
  if (!pluginId.trim()) throw new Fault('plugin.json declares no name; an installed tool name cannot be composed without it.');
  const servers = reader['mcpServers'] && typeof reader['mcpServers'] === 'object' ? Object.keys(reader['mcpServers'] as object) : null;
  if (servers === null) throw new Fault('reader.json carries no mcpServers section.');
  if (servers.length !== 1) throw new Fault(`reader.json declares ${servers.length} MCP server(s); the package must expose exactly one, the Library's own.`);
  const serverId = servers[0]!;
  const text = (key: string) => (manifest[key] === undefined || manifest[key] === null ? '' : String(manifest[key]));
  const author = (manifest['author'] ?? null) as JsonValue;
  return {
    '.claude-plugin/plugin.json': { name: text('name'), description: text('description'), version: text('version'), author, repository: text('repository'), skills: text('skills'), mcpServers: './.claude-plugin/.mcp.json', hooks: './.claude-plugin/hooks/hooks.json' },
    '.claude-plugin/.mcp.json': { _generated: GENERATED_NOTICE, mcpServers: claudeRoot(reader['mcpServers']) },
    '.claude-plugin/hooks/hooks.json': {
      description: `${GENERATED_NOTICE} Source: .codex-plugin/hooks.json. ${hooks['description'] === undefined || hooks['description'] === null ? '' : String(hooks['description'])}`,
      hooks: claudeRoot(hooks['hooks'], [`mcp__${serverId.replace(/-/g, '_')}__`, `mcp__plugin_${pluginId}_${serverId}__`]),
    },
    '.claude-plugin/marketplace.json': {
      name: text('name'), owner: author, metadata: { description: text('description'), version: text('version') },
      plugins: [{ name: text('name'), description: text('description'), version: text('version'), author, source: './' }],
    },
    '.agents/plugins/marketplace.json': { name: text('name'), plugins: [{ name: text('name'), source: { path: './', source: 'local' } }] },
  };
}

/** plugin.generated-files-match: the committed Claude plugin files equal what the canonical Codex files generate, and both hook files load. */
export function pluginGeneratedFilesMatch(root: string): Promise<CheckOutcome> {
  return row('plugin.generated-files-match', "a hand-edited or stale generated plugin file, or a hooks file the harness skips whole, so the plugin's guards never run", async () => {
    const generated = generatedPluginFiles(root);
    const faults: string[] = [];
    for (const [relative, expected] of Object.entries(generated)) {
      const text = read(root, relative);
      if (text === null) { faults.push(`${relative} is missing; regenerate with tools/PluginPackage.ps1 -Write`); continue; }
      let actual: unknown;
      try { actual = JSON.parse(text); } catch (error) { faults.push(`${relative} is not valid JSON: ${(error as Error).message}`); continue; }
      if (canonical(actual) !== canonical(expected)) faults.push(`${relative} does not match what the canonical package generates; it was hand-edited or the canonical file moved on`);
    }
    // A diff proves the pair agree; only the shape proves either is loadable.
    const { claudeHookShapeFaults } = await kernel<typeof import('../kernel/src/hookregistry.ts')>('hookregistry.ts');
    for (const [relative, label] of [['.codex-plugin/hooks.json', 'the canonical hooks file'], ['.claude-plugin/hooks/hooks.json', "Claude's generated hooks file"]] as const) {
      const text = read(root, relative);
      if (text === null) { faults.push(`${relative} is missing, so its shape could not be judged`); continue; }
      let document: unknown;
      try { document = JSON.parse(text); } catch { faults.push(`${relative} is not valid JSON, so its shape could not be judged`); continue; }
      faults.push(...claudeHookShapeFaults(document, label));
    }
    // What tools/PluginPackage.ps1 -SelfTest also asserted against this repository (s224-r3 row 1): a comparison alone passes
    // a guard renamed to a verb nothing answers, as long as the generated files were rewritten to match.
    const counted = await pluginRepositoryFaults(root, generated, faults);
    if (faults.length) throw new Fault(faults.join('; '));
    return `${Object.keys(generated).length} generated plugin file(s) match the canonical Codex layout, and both hooks files load; ${counted}`;
  });
}

/** The tool names a matcher of the Library's own shapes names, as `Get-MatcherToolNames` read them: one outer `^`, `$` and pair of
 * parentheses stripped, split on `|`, `.*` read as the sample tool `read_note`. Not a regex expander. */
export function matcherToolNames(matcher: string): string[] {
  let core = String(matcher ?? '').trim();
  if (core.startsWith('^')) core = core.slice(1);
  if (core.endsWith('$')) core = core.slice(0, -1);
  const group = /^\((.*)\)$/.exec(core);
  if (group) core = group[1]!;
  return core.split('|').map(name => name.split('.*').join('read_note')).filter(Boolean);
}

const CANONICAL_HOOK = /^"\$\{PLUGIN_ROOT\}\/bin\/library" hook (?<verb>[a-z-]+)(?<rest>( --[a-z-]+ [^ "]+)*)$/;
const GUARD_SOURCES: readonly { file: string; names: Readonly<Record<string, string>> }[] = [
  { file: '.claude/settings.json', names: {
    'Guard-BasicMemoryRead.ps1': 'basic-memory-read', 'Guard-ShelfBookRead.ps1': 'shelf-read', 'Guard-ShellShelfRead.ps1': 'shell-shelf-read',
    'hook basic-memory-read': 'basic-memory-read', 'hook shelf-read': 'shelf-read', 'hook shell-shelf-read': 'shell-shelf-read' } },
  { file: '.codex/hooks.template.json', names: {
    '__BASIC_MEMORY_GUARD_COMMAND__': 'basic-memory-read', '__PATCH_GUARD_COMMAND__': 'shelf-read', '__SHELL_GUARD_COMMAND__': 'shell-shelf-read' } },
];

/** Pushes one fault per broken repository assertion and returns what was checked, for the pass line. */
async function pluginRepositoryFaults(root: string, generated: Record<string, JsonValue>, faults: string[]): Promise<string> {
  const { VERBS } = await kernel<typeof import('../kernel/src/verbs.ts')>('verbs.ts');
  const { hookEntryText, asList, isObject } = await kernel<typeof import('../kernel/src/hookregistry.ts')>('hookregistry.ts');
  const json = (relative: string): Record<string, unknown> | null => {
    const text = read(root, relative);
    if (text === null) { faults.push(`${relative} is missing`); return null; }
    try { const value = JSON.parse(text); return isObject(value) ? value : (faults.push(`${relative} is not a JSON object`), null); }
    catch { faults.push(`${relative} is not valid JSON`); return null; }
  };
  /** Every hook entry of a hooks document, with its event and its block's matcher. */
  const entries = (document: unknown) => {
    const found: { event: string; matcher: string; entry: unknown }[] = [];
    const events = isObject(document) && isObject(document['hooks']) ? Object.entries(document['hooks']) : [];
    for (const [event, blocks] of events)
      for (const block of asList(blocks))
        if (isObject(block)) for (const entry of asList(block['hooks'])) found.push({ event, matcher: typeof block['matcher'] === 'string' ? block['matcher'] : '', entry });
    return found;
  };
  const manifest = json('.codex-plugin/plugin.json'), reader = json('.codex-plugin/reader.json');
  const pluginId = String(manifest?.['name'] ?? '');
  const serverId = reader && isObject(reader['mcpServers']) ? Object.keys(reader['mcpServers'])[0] ?? '' : '';
  const codexPrefix = `mcp__${serverId.replace(/-/g, '_')}__`, pluginPrefix = `mcp__plugin_${pluginId}_${serverId}__`;

  // (a) Claude's manifest declares its three components, and each path is there.
  const claudeManifest = generated['.claude-plugin/plugin.json'] as Record<string, JsonValue>;
  for (const field of ['skills', 'mcpServers', 'hooks']) {
    const declared = claudeManifest[field];
    if (typeof declared !== 'string' || !declared.trim()) { faults.push(`.claude-plugin/plugin.json declares no '${field}', so Claude's plugin carries none`); continue; }
    if (!fs.existsSync(path.join(root, declared.replace(/^\.\//, '')))) faults.push(`.claude-plugin/plugin.json names '${field}' as ${declared}, which is not there`);
  }

  // (b) Every canonical hook is bin/library hook <verb>, with a verb the kernel declares; (c) the four registrations.
  const declared = VERBS['hook']?.actions ?? [];
  const canonical = json('.codex-plugin/hooks.json');
  const byVerb = new Map<string, { event: string; matcher: string; command: string }>();
  let hookCount = 0;
  for (const { event, matcher, entry } of entries(canonical)) {
    hookCount++;
    const command = isObject(entry) && typeof entry['command'] === 'string' ? entry['command'] : '';
    const verb = CANONICAL_HOOK.exec(command)?.groups?.['verb'];
    if (!verb) { faults.push(`.codex-plugin/hooks.json has a ${event} hook that is not "\${PLUGIN_ROOT}/bin/library" hook <verb>: ${command || '(no command)'}`); continue; }
    if (!declared.includes(verb)) faults.push(`.codex-plugin/hooks.json names 'hook ${verb}' under ${event}, a verb the kernel does not declare (kernel/src/verbs.ts), so the hook exits non-zero and the guard is never there`);
    byVerb.set(verb, { event, matcher, command });
  }
  const required = [['basic-memory-read', 'PreToolUse'], ['shell-shelf-read', 'PreToolUse'], ['shelf-read', 'PreToolUse'], ['desk-context', 'UserPromptSubmit']] as const;
  for (const [verb, event] of required)
    if (byVerb.get(verb)?.event !== event) faults.push(`.codex-plugin/hooks.json does not register hook ${verb} under ${event}`);

  // (d) The plugin guards every tool a direct install guards.
  let pairs = 0;
  for (const source of GUARD_SOURCES) {
    const document = json(source.file);
    for (const { event, matcher, entry } of entries(document)) {
      if (event !== 'PreToolUse') continue;
      const text = hookEntryText(entry);
      for (const [name, verb] of Object.entries(source.names)) {
        if (!text.includes(name)) continue;
        for (const tool of matcherToolNames(matcher)) {
          pairs++;
          const plugin = byVerb.get(verb);
          let fires = false;
          try { fires = plugin !== undefined && new RegExp(plugin.matcher).test(tool); } catch { /* an unreadable matcher fires on nothing */ }
          if (!fires) faults.push(`${source.file} guards '${tool}' with ${verb}, and the plugin's hook ${verb} does not fire on it${plugin ? ` (matcher ${plugin.matcher})` : ' (not registered)'}`);
        }
      }
    }
  }
  if (pairs < 9) faults.push(`.claude/settings.json and .codex/hooks.template.json name ${pairs} guarded tool(s), fewer than the 9 a direct install guards`);

  // (e) Every hook that names the reader is handed its prefix, in each harness's form.
  for (const verb of ['desk-context', 'shelf-read', 'shell-shelf-read', 'search-hit'])
    if (!byVerb.get(verb)?.command.endsWith(` --reader-tool-prefix ${codexPrefix}`)) faults.push(`.codex-plugin/hooks.json: hook ${verb} is not handed Codex's name for the reader (--reader-tool-prefix ${codexPrefix})`);
  if (byVerb.get('basic-memory-read')?.command.includes('--reader-tool-prefix')) faults.push('.codex-plugin/hooks.json: hook basic-memory-read, which names no reader, is handed a --reader-tool-prefix');
  const claudeHooks = generated['.claude-plugin/hooks/hooks.json'];
  const claudeCommands = entries(claudeHooks).map(({ entry }) => (isObject(entry) && typeof entry['command'] === 'string' ? entry['command'] : ''));
  const desk = `"\${CLAUDE_PLUGIN_ROOT}/bin/library" hook desk-context --reader-tool-prefix ${pluginPrefix}`;
  if (!claudeCommands.some(command => / hook desk-context(?: |$)/.test(command) && command === desk)) faults.push(`.claude-plugin/hooks/hooks.json: the Desk hook is not exactly ${desk}`);
  if (JSON.stringify(claudeHooks).includes(codexPrefix)) faults.push(`.claude-plugin/hooks/hooks.json carries Codex's name for the reader (${codexPrefix})`);
  const handed = claudeCommands.filter(command => command.endsWith(` --reader-tool-prefix ${pluginPrefix}`)).length;
  if (handed !== 4) faults.push(`.claude-plugin/hooks/hooks.json hands the plugin's name for the reader to ${handed} hook(s), not the four that name the reader`);

  // (f) The reader: Claude's plugin serves it, Codex's declares no server and says so.
  if (manifest && manifest['mcpServers'] !== './.codex-plugin/mcp.json') faults.push(`.codex-plugin/plugin.json names mcpServers ${JSON.stringify(manifest['mcpServers'] ?? null)}, not ./.codex-plugin/mcp.json, so Codex falls back to the program's own .mcp.json`);
  const codexMcp = json('.codex-plugin/mcp.json');
  const codexServers = codexMcp && isObject(codexMcp['mcpServers']) ? Object.keys(codexMcp['mcpServers']) : [];
  if (codexServers.length) faults.push(`.codex-plugin/mcp.json declares ${codexServers.join(', ')}; the Codex plugin must declare no MCP server, since a Codex plugin server cannot learn its workspace`);
  const claudeMcp = generated['.claude-plugin/.mcp.json'] as Record<string, JsonValue>;
  const server = isObject(claudeMcp['mcpServers']) ? claudeMcp['mcpServers'][serverId] : undefined;
  const serverCommand = isObject(server) ? server['command'] : undefined, serverArgs = isObject(server) ? asList(server['args']).join(' ') : '';
  if (serverCommand !== '${CLAUDE_PLUGIN_ROOT}/bin/library' || serverArgs !== 'mcp serve') faults.push(`.claude-plugin/.mcp.json does not serve the reader as \${CLAUDE_PLUGIN_ROOT}/bin/library mcp serve (got ${String(serverCommand ?? '(none)')} ${serverArgs})`);

  return `3 manifest paths, ${hookCount} canonical hooks against ${declared.length} declared verbs, ${required.length} registrations, ${pairs} guarded tool pairs, the reader prefixes and both MCP declarations checked`;
}

/** workspace-init.selftest: the templates init, seat creation and the Shelf render read from the program are there and usable. */
export function workspaceInitTemplates(root: string): Promise<CheckOutcome> {
  return row('workspace-init.selftest', 'a template init and upgrade ship that is missing or malformed, so every init or seat creation from this program fails', async () => {
    const { managedSectionPlan } = await kernel<typeof import('../kernel/src/init.ts')>('init.ts');
    const { seatTemplateNames, loadSeatTemplate } = await kernel<typeof import('../kernel/src/seattemplates.ts')>('seattemplates.ts');
    const body = read(root, 'templates/workspace-instructions.md');
    if (body === null || !body.trim()) throw new Fault('templates/workspace-instructions.md is missing or empty; init writes it into every workspace\'s CLAUDE.md and AGENTS.md.');
    // A body carrying a managed-section marker writes a section the next init or upgrade refuses to touch.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-init-template-'));
    try {
      const target = path.join(scratch, 'CLAUDE.md');
      const first = managedSectionPlan(target, body);
      if (first.action !== 'create' || first.content === null) throw new Fault(`init could not plan templates/workspace-instructions.md into a new CLAUDE.md: ${first.reason ?? first.action}`);
      fs.writeFileSync(target, first.content);
      const again = managedSectionPlan(target, body);
      if (again.action === 'refuse') throw new Fault(`templates/workspace-instructions.md writes a managed section the next init refuses: ${again.reason}`);
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
    const names = seatTemplateNames(root);
    if (!names.length) throw new Fault('templates/seats/ holds no seat template; seat creation from a template would refuse every name.');
    for (const name of names) {
      try { loadSeatTemplate(root, name); } catch (error) { throw new Fault((error as Error).message); }
    }
    const header = read(root, 'docs/templates/shelf-catalog-header.md');
    if (header === null || !header.trim()) throw new Fault('docs/templates/shelf-catalog-header.md is missing or empty; the Shelf catalog render needs it.');
    return `the workspace instructions template plans cleanly, ${names.length} seat template(s) load, and the Shelf catalog header is there`;
  });
}

/** Every check `tools/check-map.json` may name, by name. Section 1961 holds the map to this list: the only names it may use
 * without an entry here are c174's `acceptance.*`, which leave the map with the matrix. */
export const PORTED_CHECKS: Readonly<Record<string, (root: string) => Promise<CheckOutcome>>> = {
  'settings.parse': settingsParse,
  'settings.hooks-registered': settingsHooksRegistered,
  'codex.project-access-config': codexProjectAccessConfig,
  'seats.session-start-section-resolves': seatsSessionStartSectionResolves,
  'skill.library-help-pointers-resolve': skillLibraryHelpPointersResolve,
  'context.always-on-budget': contextAlwaysOnBudget,
  'plugin.generated-files-match': pluginGeneratedFilesMatch,
  'workspace-init.selftest': workspaceInitTemplates,
};
