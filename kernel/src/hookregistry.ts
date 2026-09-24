/**
 * Which hooks the Library requires, and whether a settings tree registers them where a harness will
 * load them: `tools/HookRegistry.ps1`. Two callers, as in the oracle -- `library doctor`'s
 * `workspace.guards-registered` and `workspace.codex-guards-registered` (S26, moved here from
 * `doctor.ts` in S36), and `library hook settings-integrity` (S36).
 *
 * THE TREE IS JSON, AND THE ORACLE'S IS A `ConvertFrom-Json` OBJECT. So the rules below are the ones
 * the oracle applies to PowerShell's adapter, reproduced where they decide something:
 *
 *   A name is an OWN key compared case-sensitively -- the oracle's rule since S36, when a `Hooks` block
 *   was found reading as registered and a `{}` settings file found making the walk throw, each a silent
 *   allow through a guard that fails open.
 *
 *   A type in a fault is .NET's name for what `ConvertFrom-Json` made of the value (`psTypeName`).
 *   CONCEDED, because a parsed JavaScript number has lost its spelling: `1.0` is a Decimal to the oracle
 *   and an integer here, and `1e5` a Double there and an Int32 here. And an event named like an array
 *   index (`"1"`) enumerates first in a JavaScript object, where the oracle keeps the file's order. No
 *   settings file the Library writes carries either.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export type Json = Record<string, unknown>;

export const REQUIRED_HOOKS = [
  { file: 'Guard-BasicMemoryRead.ps1', events: ['PreToolUse'], optional: false, purpose: 'the shared-collection Desk boundary' },
  { file: 'Guard-ShelfBookRead.ps1', events: ['PreToolUse'], optional: false, purpose: 'a closed Shelf Book is unreadable by Read, Grep, Glob, Write and Edit' },
  { file: 'Guard-ShellShelfRead.ps1', events: ['PreToolUse'], optional: false, purpose: 'a closed Shelf Book is unreadable by shell command' },
  { file: 'Get-VirtualDeskContext.ps1', events: ['UserPromptSubmit'], optional: false, purpose: 'what is open, on every prompt' },
  { file: 'Get-PlaybookContext.ps1', events: ['PreToolUse'], optional: true, purpose: 'the playbook section for the helper about to run' },
  { file: 'Restore-CompactedGuidance.ps1', events: ['PostCompact', 'SessionStart'], optional: true, purpose: 'the path-scoped rule a compaction unloads, and the serve-ledger clear' },
  { file: 'Get-SeatStartContext.ps1', events: ['SessionStart'], optional: true, purpose: 'the seat roster and the ask, and the re-bind of a resumed conversation' },
  { file: 'Guard-SettingsIntegrity.ps1', events: ['ConfigChange'], optional: true, purpose: 'a settings edit cannot disable the guards' },
  { file: 'Add-SearchHitReminder.ps1', events: ['PostToolUse'], optional: true, purpose: 'a hit is a location, not a reading' },
];

/**
 * `$script:CodexRequiredHooks`. `matcher` is a pattern the registered matcher's TEXT must match; `sample`
 * (S38) is a TOOL NAME the registered matcher must match as a harness tests it. The Basic Memory guard had
 * neither, so `^mcp__basic-memory__.*$` -- which every Codex binding carried until S38, while Codex names
 * the tool `mcp__basic_memory__<tool>` -- read as registered.
 */
export const CODEX_REQUIRED_HOOKS: { file: string; event: string; matcher: RegExp | null; sample?: string; matcherDetail?: string; detail: string }[] = [
  {
    file: 'Guard-BasicMemoryRead.ps1', event: 'PreToolUse', matcher: null, sample: 'mcp__basic_memory__list_directory',
    matcherDetail: "the Codex Basic Memory guard's matcher does not match mcp__basic_memory__list_directory -- Codex spells a server's hyphens as underscores -- so it can never fire",
    detail: 'Codex Basic Memory calls are not registered with the Desk guard',
  },
  {
    file: 'Guard-ShellShelfRead.ps1', event: 'PreToolUse', matcher: /(^|\||\()Bash($|\||\))/,
    matcherDetail: "the Codex shell guard's matcher does not name the Bash tool, so it can never fire",
    detail: 'Codex shell commands can read a closed Shelf Book',
  },
  {
    file: 'Guard-ShelfBookRead.ps1', event: 'PreToolUse', matcher: /apply_patch/,
    matcherDetail: "the Codex patch guard's matcher does not name apply_patch, so it can never fire",
    detail: 'Codex apply_patch can write into a closed Shelf Book',
  },
  { file: 'Get-VirtualDeskContext.ps1', event: 'UserPromptSubmit', matcher: null, detail: 'Codex does not load Virtual Desk context at prompt submission' },
];

/**
 * THE BINARY'S SPELLING OF A HOOK (S42, the reader's ruling). On macOS and Linux there is no PowerShell, so
 * `library init` registers each ported hook as `"<program>/bin/library" hook <verb>`, and a registration is
 * recognised by its verb as well as by its script -- on every platform, as the oracle's
 * `Test-HookEntryNamesHook` since S42, because the Claude Code plugin spells its hooks this way on Windows
 * too. The hooks with no kernel port have no verb, are optional, and a POSIX workspace goes without them.
 */
export const HOOK_VERB_FOR_SCRIPT: Readonly<Record<string, string>> = {
  'Guard-BasicMemoryRead.ps1': 'basic-memory-read',
  'Guard-ShelfBookRead.ps1': 'shelf-read',
  'Guard-ShellShelfRead.ps1': 'shell-shelf-read',
  'Get-VirtualDeskContext.ps1': 'desk-context',
  'Guard-SettingsIntegrity.ps1': 'settings-integrity',
};

export const RECOGNISES_HOOK_VERBS = true;

/** `Test-HookEntryNamesHook`: whether a registration's text names this hook, by its script or by the binary's verb. */
export function namesHook(text: string, file: string): boolean {
  const lowered = text.toLowerCase();
  if (lowered.includes(file.toLowerCase())) return true;
  const verb = HOOK_VERB_FOR_SCRIPT[file];
  return verb !== undefined && new RegExp(`(^|\\s)hook\\s+${verb}(\\s|$)`).test(lowered);
}

export interface EnabledPlugin {
  key: string;
  installPath: string;
  tree: unknown;
  declaresReader: boolean;
}

/**
 * `Get-EnabledClaudePluginHooks`: the enabled Deskpost plugin's registrations as one more settings tree, or
 * null (S42). What it reads was MEASURED with claude 2.1.281 and a scratch CLAUDE_CONFIG_DIR -- see the
 * oracle, which says what is conceded. `${CLAUDE_PLUGIN_ROOT}` is replaced by the install path.
 */
export function enabledClaudePluginHooks(workspace: string, home: string): EnabledPlugin | null {
  const configured = process.env['CLAUDE_CONFIG_DIR'];
  const config = configured && configured.trim() ? configured : path.join(home, '.claude');
  const readJson = (file: string): unknown => {
    try {
      return fs.existsSync(file) && fs.statSync(file).isFile() ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) : null;
    } catch {
      return null;
    }
  };
  let key: string | null = null;
  let enabled = false;
  for (const file of [path.join(config, 'settings.json'), path.join(workspace, '.claude', 'settings.json'), path.join(workspace, '.claude', 'settings.local.json')]) {
    const settings = readJson(file);
    if (!isObject(settings) || !isObject(settings['enabledPlugins'])) continue;
    for (const [name, value] of Object.entries(settings['enabledPlugins'] as Json)) {
      if (/^deskpost@/.test(name)) {
        key = name;
        enabled = value === true;
      }
    }
  }
  if (!enabled || key === null) return null;
  const installed = readJson(path.join(config, 'plugins', 'installed_plugins.json'));
  if (!isObject(installed) || !isObject(installed['plugins']) || !hasOwn(installed['plugins'], key)) return null;
  let install = '';
  const trimmed = (value: string) => value.replace(/[\\/]+$/, '').toLowerCase();
  for (const entry of asList((installed['plugins'] as Json)[key])) {
    if (!isObject(entry) || typeof entry['installPath'] !== 'string') continue;
    const scope = typeof entry['scope'] === 'string' ? entry['scope'] : 'user';
    const project = typeof entry['projectPath'] === 'string' ? entry['projectPath'] : '';
    if (scope === 'user' || (project && trimmed(project) === trimmed(workspace))) {
      install = entry['installPath'];
      break;
    }
  }
  if (!install.trim()) return null;
  const manifest = readJson(path.join(install, '.claude-plugin', 'plugin.json'));
  const hooksRelative = isObject(manifest) && typeof manifest['hooks'] === 'string' ? manifest['hooks'] : 'hooks/hooks.json';
  const serversRelative = isObject(manifest) && typeof manifest['mcpServers'] === 'string' ? manifest['mcpServers'] : '.mcp.json';
  const root = install.replace(/\\/g, '/').replace(/\/+$/, '');
  let tree: unknown = null;
  const hooksPath = path.join(install, hooksRelative);
  try {
    if (fs.existsSync(hooksPath) && fs.statSync(hooksPath).isFile()) {
      tree = JSON.parse(fs.readFileSync(hooksPath, 'utf8').replace(/^﻿/, '').split('${CLAUDE_PLUGIN_ROOT}').join(root));
    }
  } catch {
    tree = null;
  }
  const servers = readJson(path.join(install, serversRelative));
  const declaresReader = isObject(servers) && isObject(servers['mcpServers']) && hasOwn(servers['mcpServers'], 'validated-book-reader');
  return { key, installPath: install, tree, declaresReader };
}

export function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value: unknown, name: string): boolean {
  return isObject(value) && Object.prototype.hasOwnProperty.call(value, name);
}

/** `@($value)`: an array as itself, null as nothing, anything else as one element. */
export function asList(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** `[string]$value` for what `ConvertFrom-Json` produces: an array joins with a space, a boolean is `True`. */
function psString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (Array.isArray(value)) return value.map(psString).join(' ');
  if (isObject(value)) return '@{' + Object.entries(value).map(([key, item]) => `${key}=${psString(item)}`).join('; ') + '}';
  return String(value);
}

/**
 * The .NET type `ConvertFrom-Json` gives a value, as a fault names it (measured on 5.1, S36): an integer
 * that fits is Int32, then Int64, then Decimal; a fraction is Decimal. See the concession above.
 */
export function psTypeName(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return 'String';
  if (typeof value === 'boolean') return 'Boolean';
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) return 'Decimal';
    if (value >= -2147483648 && value <= 2147483647) return 'Int32';
    if (Math.abs(value) < 9223372036854775808) return 'Int64';
    return value < 1e28 ? 'Decimal' : 'Double';
  }
  if (Array.isArray(value)) return 'Object[]';
  return 'PSCustomObject';
}

/** `Get-HookEntryText`: the command and its args, whichever shape a harness file spells them in. */
export function hookEntryText(entry: unknown): string {
  if (!isObject(entry)) return '';
  const parts: string[] = [];
  if (hasOwn(entry, 'command') && entry['command'] !== null) parts.push(psString(entry['command']));
  if (hasOwn(entry, 'args') && entry['args'] !== null) for (const arg of asList(entry['args'])) parts.push(psString(arg));
  return parts.join(' ');
}

/** `Get-RegisteredHookEvents`: which required files are registered, and under which events. The FILE match is case-insensitive (`-match`). */
export function registeredHookEvents(settings: unknown, required: { file: string }[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  if (!hasOwn(settings, 'hooks') || !isObject((settings as Json)['hooks'])) return found;
  for (const [eventName, blocks] of Object.entries((settings as Json)['hooks'] as Json)) {
    for (const block of asList(blocks)) {
      if (!hasOwn(block, 'hooks')) continue;
      for (const entry of asList((block as Json)['hooks'])) {
        if (entry === null) continue;
        const text = hookEntryText(entry);
        for (const hook of required) {
          if (!namesHook(text, hook.file)) continue;
          const events = found.get(hook.file) ?? [];
          if (!events.includes(eventName)) events.push(eventName);
          found.set(hook.file, events);
        }
      }
    }
  }
  return found;
}

/** `Get-HookRegistrationProblems`: one record per required hook missing or registered under the wrong event, over every tree in play. */
export function hookRegistrationProblems(trees: unknown[]): { file: string; optional: boolean; detail: string }[] {
  const registered = new Map<string, string[]>();
  for (const tree of trees) {
    for (const [file, events] of registeredHookEvents(tree, REQUIRED_HOOKS)) {
      registered.set(file, [...new Set([...(registered.get(file) ?? []), ...events])]);
    }
  }
  const problems: { file: string; optional: boolean; detail: string }[] = [];
  for (const hook of REQUIRED_HOOKS) {
    const actual = registered.get(hook.file);
    if (!actual) {
      problems.push({ file: hook.file, optional: hook.optional, detail: `${hook.file} is not registered (${hook.purpose})` });
      continue;
    }
    const missing = hook.events.filter((event) => !actual.includes(event));
    if (missing.length) {
      problems.push({ file: hook.file, optional: hook.optional, detail: `${hook.file} is registered under ${actual.join(', ')} but not ${missing.join(', ')}` });
    }
  }
  return problems;
}

/** `Test-ClaudeHookShape`: arrays at BOTH levels on every event, objects inside them, a `type` and a `command` on every hook. */
export function claudeHookShapeFaults(document: unknown, label: string): string[] {
  const faults: string[] = [];
  if (!hasOwn(document, 'hooks')) return [`${label} has no top-level 'hooks' key`];
  const events = (document as Json)['hooks'];
  if (!isObject(events)) return [`${label} has 'hooks' as a ${psTypeName(events)}, not an object of events`];
  const eventNames = Object.keys(events);
  if (!eventNames.length) faults.push(`${label} registers no events at all`);
  for (const eventName of eventNames) {
    const entries = events[eventName];
    if (!Array.isArray(entries)) {
      faults.push(`${label} event '${eventName}' is a ${psTypeName(entries)}, not an array; a one-element list that unrolled reads exactly like this`);
      continue;
    }
    entries.forEach((entry, i) => {
      if (entry === null) {
        faults.push(`${label} event '${eventName}' entry ${i} is null`);
        return;
      }
      if (!hasOwn(entry, 'hooks')) {
        faults.push(`${label} event '${eventName}' entry ${i} declares no 'hooks'`);
        return;
      }
      const commands = (entry as Json)['hooks'];
      if (!Array.isArray(commands)) {
        faults.push(`${label} event '${eventName}' entry ${i} has 'hooks' as a ${psTypeName(commands)}, not an array`);
        return;
      }
      commands.forEach((command, j) => {
        if (command === null) {
          faults.push(`${label} event '${eventName}' entry ${i} hook ${j} is null`);
          return;
        }
        for (const required of ['type', 'command']) {
          if (!hasOwn(command, required)) faults.push(`${label} event '${eventName}' entry ${i} hook ${j} has no '${required}'`);
        }
      });
    });
  }
  return faults;
}

/** `Test-CodexHookShape`: only `description` and `hooks` at the root, then Claude Code's nested shape. */
export function codexHookShapeFaults(document: unknown, label: string): string[] {
  const faults: string[] = [];
  const stray = isObject(document) ? Object.keys(document).filter((name) => name !== 'description' && name !== 'hooks') : [];
  if (stray.length) {
    faults.push(`${label} puts ${stray.join(', ')} at the root; Codex accepts only 'description' and 'hooks' there and rejects the whole file`);
  }
  return [...faults, ...claudeHookShapeFaults(document, label)];
}

/** `Get-CodexRegistrationProblems`: each Codex hook absent, under the wrong event, or bound to a matcher it can never fire on. */
export function codexRegistrationProblems(document: unknown): string[] {
  const problems: string[] = [];
  const registered = registeredHookEvents(document, CODEX_REQUIRED_HOOKS);
  for (const hook of CODEX_REQUIRED_HOOKS) {
    const events = registered.get(hook.file);
    if (!events) {
      problems.push(`${hook.detail}: ${hook.file} is absent.`);
      continue;
    }
    if (!events.includes(hook.event)) {
      problems.push(`${hook.detail}: ${hook.file} is registered under ${events.join(', ')} rather than ${hook.event}.`);
      continue;
    }
    if (hook.matcher === null && hook.sample === undefined) continue;
    const blocks = asList((isObject(document) && isObject(document['hooks']) ? (document['hooks'] as Json) : {})[hook.event]).filter(
      (block) => isObject(block) && asList(block['hooks']).some((entry) => namesHook(hookEntryText(entry), hook.file)),
    ) as Json[];
    const matcherText = (block: Json): string => (block['matcher'] === null || block['matcher'] === undefined ? '' : String(block['matcher']));
    const fires = (block: Json): boolean => {
      if (hook.sample === undefined) return hook.matcher!.test(matcherText(block));
      // A matcher that is not a regex fires on nothing, so it is a matcher that cannot fire.
      try {
        return new RegExp(matcherText(block)).test(hook.sample);
      } catch {
        return false;
      }
    };
    if (!blocks.some(fires)) {
      problems.push(String(hook.matcherDetail) + '.');
    }
  }
  return problems;
}
