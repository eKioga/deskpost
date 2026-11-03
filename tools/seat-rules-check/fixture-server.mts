/**
 * The seat-rules-check fixture server (PLAN-start-and-prove.md, Approach 2, "No real shell"; review SP-01, SP-03, SP-07).
 * A stdio JSON-RPC MCP server, Node built-ins only, and a session's only tool source:
 *
 *   node fixture-server.mts --root <case folder> --log <file> [--results <search-results.json>]
 *
 * list_files, read_file and write_file act inside --root only: a path is resolved through the real path of its
 * nearest existing parent, so `..`, an absolute path elsewhere and a link that leaves the root are all refused.
 * run_command and screen_action do nothing and answer "not available in this session"; search_public answers from
 * the case's offline results file. Every call is one JSON line in --log: { tool, arguments, outcome, at }, with
 * outcome ok, refused or stub. The first line records which Library or Deskpost variables reached this process.
 */
import fs from 'node:fs';
import path from 'node:path';

const STUB = 'not available in this session';
const OUTSIDE = 'refused: the path is outside the case folder';

function option(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}
const rootOption = option('--root'), logFile = option('--log'), resultsFile = option('--results');
if (!rootOption || !logFile) {
  process.stderr.write('usage: node fixture-server.mts --root <case folder> --log <file> [--results <search-results.json>]\n');
  process.exit(2);
}
const root = fs.realpathSync(rootOption);

function log(entry: Record<string, unknown>): void {
  fs.appendFileSync(logFile!, JSON.stringify({ ...entry, at: new Date().toISOString() }) + '\n');
}
log({ event: 'start', identity_variables: Object.keys(process.env).filter((name) => /^(LIBRARY_|DESKPOST_)/i.test(name)).sort() });

/** The path inside the root, or null when it would leave it. */
function inside(requested: unknown): string | null {
  if (typeof requested !== 'string' || requested === '') return null;
  const target = path.resolve(root, requested);
  let existing = target;
  const rest: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return null;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  const real = path.join(fs.realpathSync(existing), ...rest);
  const relative = path.relative(root, real);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return real;
}

function listFiles(folder: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(path.join(folder, entry.name), relative));
    else if (entry.isFile()) out.push(relative);
  }
  return out;
}

type Result = { text: string; outcome: 'ok' | 'refused' | 'stub'; isError?: boolean };

function search(query: string): string {
  if (!resultsFile || !fs.existsSync(resultsFile)) return '[]';
  const entries = JSON.parse(fs.readFileSync(resultsFile, 'utf8')) as { keywords?: string[]; title?: string; url?: string; snippet?: string }[];
  const lower = query.toLowerCase();
  const hits = entries.filter((entry) => (entry.keywords ?? []).some((word) => lower.includes(word.toLowerCase())));
  return JSON.stringify(hits.map(({ title, url, snippet }) => ({ title, url, snippet })), null, 2);
}

function callTool(name: string, args: Record<string, unknown>): Result {
  switch (name) {
    case 'list_files': {
      const folder = args['path'] === undefined ? root : inside(args['path']);
      if (folder === null) return { text: OUTSIDE, outcome: 'refused', isError: true };
      if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) return { text: 'no such folder', outcome: 'ok', isError: true };
      const prefix = path.relative(root, folder).split(path.sep).join('/');
      return { text: listFiles(folder, prefix).join('\n'), outcome: 'ok' };
    }
    case 'read_file': {
      const file = inside(args['path']);
      if (file === null) return { text: OUTSIDE, outcome: 'refused', isError: true };
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return { text: 'no such file', outcome: 'ok', isError: true };
      return { text: fs.readFileSync(file, 'utf8'), outcome: 'ok' };
    }
    case 'write_file': {
      const file = inside(args['path']);
      if (file === null) return { text: OUTSIDE, outcome: 'refused', isError: true };
      if (typeof args['content'] !== 'string') return { text: 'content must be text', outcome: 'ok', isError: true };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, args['content']);
      return { text: 'written', outcome: 'ok' };
    }
    case 'run_command':
    case 'screen_action':
      return { text: STUB, outcome: 'stub' };
    case 'search_public':
      return { text: search(String(args['query'] ?? '')), outcome: 'stub' };
    default:
      return { text: 'unknown tool: ' + name, outcome: 'refused', isError: true };
  }
}

const TOOLS = [
  { name: 'list_files', description: 'List the files in the work folder, or in one folder inside it.', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'A folder inside the work folder (optional).' } } } },
  { name: 'read_file', description: 'Read one text file inside the work folder.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'write_file', description: 'Create or replace one text file inside the work folder.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'run_command', description: 'Run a command line.', inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'screen_action', description: 'Act on an application window on the screen.', inputSchema: { type: 'object', properties: { app: { type: 'string' }, action: { type: 'string' } }, required: ['action'] } },
  { name: 'search_public', description: 'Search the public web.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
];

function answer(message: Record<string, unknown>): Record<string, unknown> | null {
  const id = message['id'];
  if (id === undefined || id === null) return null; // a notification, notifications/initialized among them
  const method = String(message['method'] ?? '');
  const params = (message['params'] ?? {}) as Record<string, unknown>;
  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: { protocolVersion: typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } };
  }
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'tools/call') {
    const name = String(params['name'] ?? '');
    const args = (params['arguments'] ?? {}) as Record<string, unknown>;
    let result: Result;
    try { result = callTool(name, args); } catch (error) { result = { text: 'failed: ' + (error as Error).message, outcome: 'ok', isError: true }; }
    log({ tool: name, arguments: args, outcome: result.outcome });
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: result.text }], ...(result.isError ? { isError: true } : {}) } };
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } };
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  let at: number;
  while ((at = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (line === '') continue;
    let reply: Record<string, unknown> | null;
    try { reply = answer(JSON.parse(line) as Record<string, unknown>); }
    catch { reply = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }; }
    if (reply) process.stdout.write(JSON.stringify(reply) + '\n');
  }
});
process.stdin.on('end', () => process.exit(0));
