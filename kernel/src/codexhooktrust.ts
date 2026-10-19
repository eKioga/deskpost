/** Offline command-hook identity for Codex rust-v0.163.0.
 * Sources: hooks/src/engine/discovery.rs:478-581, 747-795 and
 * config/src/fingerprint.rs:54-66 in openai/codex's codex-rs/.
 * Unknown events, fields or shapes return null: an upgrade must not invent stale reviews.
 */
import { createHash } from 'node:crypto';

const events = new Set(['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact', 'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt']);
const contextEvents = new Set(['PreToolUse', 'PostToolUse', 'SessionStart', 'UserPromptSubmit', 'SubagentStart']);
const fields = new Set(['type', 'command', 'commandWindows', 'command_windows', 'timeout', 'async', 'statusMessage', 'additionalContextLimit']);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Null means reviewed but not checked, never evidence of a changed hook. */
export function codexHookHash(event: string, group: unknown, hook: unknown, windows = process.platform === 'win32'): string | null {
  if (!events.has(event) || !object(group) || !object(hook) || hook['type'] !== 'command') return null;
  if (Object.keys(group).some((key) => key !== 'matcher' && key !== 'hooks') || Object.keys(hook).some((key) => !fields.has(key))) return null;
  if (group['matcher'] != null && typeof group['matcher'] !== 'string') return null;
  if (typeof hook['command'] !== 'string' || !hook['command'].trim()) return null;
  for (const name of ['commandWindows', 'command_windows', 'statusMessage']) {
    if (hook[name] != null && typeof hook[name] !== 'string') return null;
  }
  if (hook['commandWindows'] != null && hook['command_windows'] != null) return null;
  if (hook['async'] != null && typeof hook['async'] !== 'boolean') return null;
  for (const name of ['timeout', 'additionalContextLimit']) {
    if (hook[name] != null && (!Number.isSafeInteger(hook[name]) || (hook[name] as number) < 0)) return null;
  }
  const command = windows ? hook['commandWindows'] ?? hook['command_windows'] ?? hook['command'] : hook['command'];
  if (typeof command !== 'string' || !command.trim()) return null;
  const short = event === 'SessionEnd' || event === 'Interrupt';
  const timeout = Math.max(1, (hook['timeout'] as number | undefined) ?? (short ? 1 : 600));
  const handler: Record<string, unknown> = { type: 'command', command, timeout: short ? Math.min(3, timeout) : timeout, async: hook['async'] ?? false };
  if (hook['statusMessage'] != null) handler['statusMessage'] = hook['statusMessage'];
  if (contextEvents.has(event) && hook['additionalContextLimit'] != null && hook['additionalContextLimit'] !== 2500) handler['additionalContextLimit'] = hook['additionalContextLimit'];
  const identity: Record<string, unknown> = { event_name: event.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase(), hooks: [handler] };
  if (!['UserPromptSubmit', 'Stop', 'Interrupt'].includes(event) && group['matcher'] != null) identity['matcher'] = group['matcher'];
  // The TOML round trip omits absent options. Rust's canonical JSON sorts every object.
  const sortedHandler = Object.fromEntries(Object.keys(handler).sort().map((key) => [key, handler[key]]));
  identity['hooks'] = [sortedHandler];
  const sortedIdentity = Object.fromEntries(Object.keys(identity).sort().map((key) => [key, identity[key]]));
  return `sha256:${createHash('sha256').update(JSON.stringify(sortedIdentity), 'utf8').digest('hex')}`;
}
