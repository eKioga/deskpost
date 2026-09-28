/**
 * A stand-in Basic Memory server for the kernel self-test (PLAN-basic-memory.md steps 2, 3 and 5).
 *
 * A CHILD PROCESS, NEVER IN THE SUITE'S OWN: every behavioural case runs the CLI through `spawnSync`, which blocks
 * the suite's event loop, so a server listening in-process could never answer the call being judged.
 *
 * IT SERVES A FOLDER ON DISK AS ONE COLLECTION -- the same folder a connection names as its storage folder -- over
 * the streamable-HTTP MCP the kernel speaks: `initialize` with a session header, `notifications/initialized`,
 * and three tools: `list_memory_projects`, `read_note` (an absent note is `isError: false` with a null path and
 * content, as the real server answers it, measured S33), and `list_directory`. Nothing is ever written.
 *
 *   node fake-basic-memory.ts <folder> <port-file> [--project <name>] [--id <uuid>] [--hang]
 *
 * `--hang` accepts every connection and answers none, which is what a black-holed host looks like to a client.
 * The port it listens on is written to <port-file> once it is listening.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

const [folder, portFile, ...rest] = process.argv.slice(2);
const option = (name: string, fallback: string): string => {
  const at = rest.indexOf(`--${name}`);
  return at >= 0 && rest[at + 1] !== undefined ? rest[at + 1]! : fallback;
};
const hang = rest.includes('--hang');
const projectName = option('project', 'stand-in-collection');
const projectId = option('id', 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa');

function text(result: unknown): unknown {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { result }, isError: false };
}

function readNote(identifier: string, includeFrontmatter: boolean): unknown {
  const file = path.join(folder!, ...`${identifier}.md`.split('/'));
  if (!file.startsWith(path.resolve(folder!)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return { file_path: null, title: null, content: null };
  }
  let content = fs.readFileSync(file, 'utf8');
  if (!includeFrontmatter) content = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  return { file_path: `${identifier}.md`, title: path.basename(identifier), content };
}

function call(name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case 'list_memory_projects':
      return text({ projects: [{ name: projectName, external_id: projectId, path: `/${projectName}` }, { name: 'main', external_id: 'bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb', path: '/main' }], default_project: 'main' });
    case 'read_note': {
      if (String(args['project_id'] ?? '') !== projectId) return { content: [{ type: 'text', text: `Project '${String(args['project_id'])}' not found.` }], isError: true };
      return text(readNote(String(args['identifier'] ?? ''), args['include_frontmatter'] !== false));
    }
    default:
      return { content: [{ type: 'text', text: `The stand-in has no tool '${name}'.` }], isError: true };
  }
}

const server = http.createServer((request, response) => {
  if (hang) return; // never answered; the client's timeout is the only way out
  let body = '';
  request.on('data', (chunk) => (body += chunk));
  request.on('end', () => {
    let message: Record<string, unknown> = {};
    try {
      message = JSON.parse(body) as Record<string, unknown>;
    } catch {
      response.writeHead(400).end('not JSON');
      return;
    }
    const id = message['id'];
    const method = String(message['method'] ?? '');
    if (id === undefined) {
      response.writeHead(202).end();
      return;
    }
    let result: unknown;
    if (method === 'initialize') {
      result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fake-basic-memory', version: '0' } };
      response.setHeader('Mcp-Session-Id', 'fake-session');
    } else if (method === 'tools/call') {
      const params = (message['params'] ?? {}) as Record<string, unknown>;
      result = call(String(params['name'] ?? ''), (params['arguments'] ?? {}) as Record<string, unknown>);
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  });
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  fs.writeFileSync(portFile!, String(typeof address === 'object' && address !== null ? address.port : 0));
});
