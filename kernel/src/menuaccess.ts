/** Plain access names, shared by the interactive menu, plain menu and launch flag validator. */
import type { Assistant } from './conversation.ts';
export const LAUNCH_ACCESS_VALUES: Record<Assistant, Record<string, readonly string[]>> = {
  codex: { '--ask-for-approval': ['on-request', 'never'], '--sandbox': ['read-only', 'workspace-write', 'danger-full-access'] },
  claude: { '--permission-mode': ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'] },
};
export interface MenuAccess { id: string; name: string; args: readonly string[]; detail: readonly string[]; full?: boolean; usual?: boolean }
export const MENU_ACCESS: Record<Assistant, readonly MenuAccess[]> = {
  codex: [
    { id: 'look', name: 'Look only', args: ['--sandbox', 'read-only'], detail: ['Reads files, without changing them.', 'Codex: --sandbox read-only'] },
    { id: 'work', name: 'Work in its own folders', usual: true, args: ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'],
      detail: ["Edits files and runs commands in this seat's", 'folders. To go outside them it has to ask you.', 'Codex: --sandbox workspace-write', '       --ask-for-approval on-request'] },
    { id: 'full', name: 'Full access', full: true, args: ['--sandbox', 'danger-full-access', '--ask-for-approval', 'never'],
      detail: ['Can change or delete any file on this computer', 'and run any command, and never stops to ask you.', 'Codex: --sandbox danger-full-access', '       --ask-for-approval never'] },
  ],
  claude: [
    { id: 'look', name: 'Look only', args: ['--permission-mode', 'plan'], detail: ['Plans and reads, without changing files.', 'Claude Code: --permission-mode plan'] },
    { id: 'ask', name: 'Ask me first', args: ['--permission-mode', 'manual'], detail: ['Asks you before using tools.', 'Claude Code: --permission-mode manual'] },
    { id: 'edit', name: 'Edit freely', args: ['--permission-mode', 'acceptEdits'], detail: ['Edits files freely; asks before other commands.', 'Claude Code: --permission-mode acceptEdits'] },
    { id: 'auto', name: 'Auto mode', usual: true, args: ['--permission-mode', 'auto'], detail: ['Decides for itself what to do, and asks you', 'before anything risky.', 'Claude Code: --permission-mode auto'] },
    { id: 'full', name: 'Full access', full: true, args: ['--permission-mode', 'bypassPermissions'], detail: ['Can change files and run commands without asking.', 'Claude Code: --permission-mode bypassPermissions'] },
  ],
};
export function accessOptionValue(args: readonly string[], name: string, short?: string): string | undefined {
  let value: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === name || arg === short) value = args[++i];
    else if (arg.startsWith(name + '=')) value = arg.slice(name.length + 1);
    else if (short && arg.startsWith(short) && arg !== short) value = arg.slice(short.length).replace(/^=/, '');
  }
  return value;
}
export function fullAccessSettings(assistant: Assistant, args: readonly string[]): boolean {
  return assistant === 'codex' ? accessOptionValue(args, '--sandbox', '-s') === 'danger-full-access' ||
    args.some(arg => /^(?:-c|--config=)?sandbox_mode=['\"]?danger-full-access['\"]?$/.test(arg)) ||
    args.includes('--dangerously-bypass-approvals-and-sandbox') :
    accessOptionValue(args, '--permission-mode') === 'bypassPermissions' || args.includes('--dangerously-skip-permissions');
}
export function accessName(assistant: Assistant, args: readonly string[]): string {
  if (fullAccessSettings(assistant, args)) return 'Full access';
  const named = MENU_ACCESS[assistant].find(access => access.args.every((arg, index) =>
    index % 2 === 0 || accessOptionValue(args, access.args[index - 1]!, assistant === 'codex' ? access.args[index - 1] === '--sandbox' ? '-s' : '-a' : undefined) === arg));
  return named?.name ?? (args.length ? 'My own settings' : "Assistant's default");
}
