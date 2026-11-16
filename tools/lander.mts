#!/usr/bin/env node
/**
 * The queued lander (PLAN-build-regroup.md point 7; kickoffs/s205 row 1). It runs on NAS-LAB, is woken only by
 * Forgejo's webhooks, and checks and merges one pull request to master at a time. It keeps no state of its own:
 * every pass reads the open pull requests, their labels and its own comments, so a restart or a lost event heals
 * on the next event. No timer, no retry loop, no sleep: a failed step leaves the labels as they are.
 */
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CHECKING_LABEL, SHA, forgejoClient, repositoryApi, type Label, type Pull, type Reply } from './land.mts';

export const LANDER_VERSION = '1.1.0';
/** The one status context the master rule requires. */
export const CONTEXT = 'ci / linux (pull_request)';
export const LABELS = { queued: 'lander: queued', checking: CHECKING_LABEL, red: 'lander: red', held: 'lander: held' } as const;
const COLORS: Record<string, string> = { [LABELS.queued]: '#8caaee', [LABELS.checking]: '#e5c890', [LABELS.red]: '#e78284', [LABELS.held]: '#ca9ee6' };
const BODY_LIMIT = 5 * 1024 * 1024;
const USAGE = 'usage: node tools/lander.mts serve | reset <pull request number> | nudge';

/** `source`, when set, names where the secrets came from for the one start line; it never holds a value. */
export type Secrets = { token: string; webhook: string; source?: string };
type Comment = { id: number; body: string; user?: { login?: string } };
type Run = { id: number; index_in_repo: number; workflow_id: string; event: string; commit_sha: string;
  status: string; event_payload: string | { label?: { name?: string }; pull_request?: { number?: number } } };

/** The webhook signature: HMAC-SHA256 of the raw body, hex, compared in constant time. */
export function signatureValid(secret: string, body: Buffer, signature: string | undefined): boolean {
  if (!secret || !signature || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = crypto.createHmac('sha256', secret).update(body).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

/** The lander's folder in its Infisical project: CREDENTIAL is the Forgejo token, PASSWORD the webhook secret. */
const INFISICAL_ENVIRONMENT = 'prod';
const INFISICAL_FOLDER = '/forgejo-lander';

/**
 * The two secrets from Infisical, read at start and again after a Forgejo 401: a machine-identity sign-in
 * (universal auth) with the Client ID and Client Secret from the file LANDER_INFISICAL_IDENTITY_FILE names, then
 * one read of the folder. The address and the project are settings, never constants here. A refusal names the step
 * and the HTTP status only; no reply body, header, Client Secret, access token or value is ever printed.
 */
export async function readInfisicalSecrets(env: NodeJS.ProcessEnv = process.env): Promise<Secrets> {
  const address = env['LANDER_INFISICAL_URL'] ?? '';
  let base: URL | undefined;
  try { base = new URL(address); } catch { /* refused below */ }
  if (!base || !(base.protocol === 'https:' || (base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname))))
    throw Error('Set LANDER_INFISICAL_URL to the Infisical address: https://, or http:// only for 127.0.0.1 or localhost');
  const project = env['LANDER_INFISICAL_PROJECT'] ?? '';
  if (!project || /\s/.test(project)) throw Error('Set LANDER_INFISICAL_PROJECT to the Infisical project ID');
  const file = env['LANDER_INFISICAL_IDENTITY_FILE'] ?? '';
  if (!file) throw Error('Set LANDER_INFISICAL_IDENTITY_FILE to the file holding the Infisical Client ID and Client Secret');
  let identity: string[];
  try { identity = fs.readFileSync(file, 'utf8').split('\n'); } catch { throw Error(`The identity file ${file} could not be read`); }
  if (identity.length !== 2 || identity.some(line => !line || /\s/.test(line)))
    throw Error(`The identity file ${file} must hold exactly two lines, Client ID then Client Secret, with no whitespace and no trailing newline`);
  let [clientId, clientSecret] = identity as [string, string];
  identity = [];
  let accessToken = '';
  const call = async (step: string, route: string, init: RequestInit) => {
    let response: Response;
    try { response = await fetch(new URL(route, base!.origin), { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000) }); }
    catch { throw Error(`Infisical ${step} got no answer (a network failure, a time-out or a redirect)`); }
    if (!response.ok) { await response.body?.cancel(); throw Error(`Infisical ${step} refused (HTTP ${response.status})`); }
    try { return { status: response.status, data: await response.json() as any }; }
    catch { throw Error(`Infisical ${step} answer is not JSON (HTTP ${response.status})`); }
  };
  try {
    const signIn = await call('sign-in', '/api/v1/auth/universal-auth/login', { method: 'POST',
      body: new URLSearchParams({ clientId, clientSecret }) });
    clientSecret = '';
    accessToken = typeof signIn.data?.accessToken === 'string' ? signIn.data.accessToken : '';
    if (!accessToken) throw Error(`Infisical sign-in answer holds no access token (HTTP ${signIn.status})`);
    const query = new URLSearchParams({ workspaceId: project, environment: INFISICAL_ENVIRONMENT, secretPath: INFISICAL_FOLDER });
    const read = await call('read', `/api/v3/secrets/raw?${query}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const list: unknown = read.data?.secrets;
    if (!Array.isArray(list)) throw Error(`Infisical read answer holds no secrets list (HTTP ${read.status})`);
    const pick = (key: string): string => {
      const found = list.filter(s => s?.secretKey === key);
      if (found.length !== 1) throw Error(`Infisical read: secret ${key} is ${found.length ? 'there more than once' : 'missing'} (HTTP ${read.status})`);
      if (found[0].secretValueHidden === true) throw Error(`Infisical read: secret ${key} is hidden from this identity (HTTP ${read.status})`);
      const value = found[0].secretValue;
      if (typeof value !== 'string' || !value || /\s/.test(value)) throw Error(`Infisical read: secret ${key} is empty or holds whitespace (HTTP ${read.status})`);
      return value;
    };
    return { token: pick('CREDENTIAL'), webhook: pick('PASSWORD'),
      source: `Infisical (identity file ${file}; sign-in HTTP ${signIn.status}; read HTTP ${read.status})` };
  } finally { clientId = ''; clientSecret = ''; accessToken = ''; }
}

export interface LanderOptions {
  repoUrl: string;
  login: string;
  readSecrets: () => Promise<Secrets>;
  say?: (line: string) => void;
}

export function createLander(options: LanderOptions) {
  const { api } = repositoryApi(options.repoUrl);
  let secrets: Secrets | undefined;
  let stale = false;
  let accountMismatch = false;
  const scrub = (text: string) => {
    let out = text.replace(/[\r\n]+/g, ' ');
    for (const value of [secrets?.token, secrets?.webhook]) if (value) out = out.split(value).join('[redacted]');
    return out;
  };
  const say = (line: string) => (options.say ?? console.log)(scrub(`lander: ${line}`));
  const repo = forgejoClient(api, () => secrets?.token ?? '');
  // A 401 marks the secrets stale; the next pass signs in to Infisical and reads them again.
  const request = async (route: string, method = 'GET', body?: object, text = false): Promise<Reply> => {
    if (accountMismatch) throw Error('LANDER_LOGIN mismatch; no further writes until restarted');
    let reply: Reply;
    if (text) {
      const response = await fetch(api + route, { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `token ${secrets?.token ?? ''}` } });
      reply = { code: response.status, ok: response.ok, data: null, text: await response.text() };
    } else reply = await repo.request(route, method, body);
    if (reply.code === 401) { stale = true; throw Error(`Forgejo refused the token (HTTP 401) on ${method} ${route}; secrets read again on the next event`); }
    return reply;
  };
  const get = async (route: string) => {
    const reply = await request(route);
    if (!reply.ok) throw Error(`Forgejo read refused (HTTP ${reply.code}) on ${route}`);
    return reply.data;
  };
  const must = async (what: string, route: string, method: string, body?: object) => {
    const reply = await request(route, method, body);
    if (!reply.ok) throw Error(`${what} refused (HTTP ${reply.code})`);
    return reply;
  };
  const me = options.login;
  let labelIds = new Map<string, number>();

  async function ensureSecrets(): Promise<void> {
    if (secrets && !stale) return;
    secrets = await options.readSecrets();
    stale = false;
  }
  async function ensureLabels(): Promise<void> {
    if (Object.values(LABELS).every(name => labelIds.has(name))) return;
    const found = new Map<string, number>();
    for (let page = 1; ; page++) {
      const list = await get(`/labels?limit=50&page=${page}`) as Label[];
      if (!Array.isArray(list)) throw Error('Forgejo label list is invalid');
      for (const label of list) found.set(label.name, label.id);
      if (list.length < 50) break;
    }
    for (const name of Object.values(LABELS)) if (!found.has(name)) {
      const made = await must(`Creating label '${name}'`, '/labels', 'POST', { name, color: COLORS[name], description: 'Set by the queued lander' });
      found.set(name, (made.data as Label).id);
      say(`created label '${name}'`);
    }
    labelIds = found;
  }
  const addLabel = (n: number, name: string) => must(`Adding '${name}' to ${n}`, `/issues/${n}/labels`, 'POST', { labels: [labelIds.get(name)] });
  const removeLabel = (n: number, name: string) => must(`Removing '${name}' from ${n}`, `/issues/${n}/labels/${labelIds.get(name)}`, 'DELETE');
  const comment = async (n: number, body: string) => {
    const reply = await must(`Commenting on ${n}`, `/issues/${n}/comments`, 'POST', { body });
    const login = reply.data?.user?.login;
    if (login !== me) {
      accountMismatch = true;
      say(`LANDER_LOGIN ${me} is not this token's account (${login ?? 'unnamed'}); no further writes until restarted`);
      throw Error('LANDER_LOGIN mismatch; no further writes until restarted');
    }
    say(`#${n} ${body}`);
  };
  const has = (pull: Pull, name: string) => !!pull.labels?.some(l => l.name === name);
  async function myCommentRows(n: number): Promise<Comment[]> {
    const bodies: Comment[] = [];
    for (let page = 1; ; page++) {
      const list = await get(`/issues/${n}/comments?limit=50&page=${page}`) as Comment[];
      if (!Array.isArray(list)) throw Error('Forgejo comment list is invalid');
      for (const c of list) if (c.user?.login === me && typeof c.body === 'string') bodies.push(c);
      if (list.length < 50) break;
    }
    return bodies;
  }
  const myComments = async (n: number) => (await myCommentRows(n)).map(c => c.body);
  const lastMatch = (bodies: string[], pattern: RegExp) => {
    for (let i = bodies.length - 1; i >= 0; i--) { const m = pattern.exec(bodies[i]!); if (m) return { index: i, match: m }; }
    return undefined;
  };
  async function openPulls(): Promise<Pull[]> {
    const all: Pull[] = [];
    for (let page = 1; ; page++) {
      const list = await get(`/pulls?state=open&base=master&limit=50&page=${page}`) as Pull[];
      if (!Array.isArray(list)) throw Error('Forgejo pull request list is invalid');
      all.push(...list.filter(p => p.base?.ref === 'master' && Number.isInteger(p.number) && SHA.test(p.head?.sha ?? '')));
      if (list.length < 50) break;
    }
    return all.sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) || a.number - b.number);
  }
  async function masterAhead(head: string): Promise<boolean> {
    const compare = await get(`/compare/${head}...master`) as { total_commits: number };
    if (!Number.isInteger(compare?.total_commits) || compare.total_commits < 0) throw Error('Forgejo comparison is invalid');
    return compare.total_commits > 0;
  }
  async function stop(pull: Pull, kind: 'held' | 'red', why: string): Promise<void> {
    await comment(pull.number, `lander: ${kind} ${pull.head.sha}: ${why}`);
    if (!has(pull, LABELS[kind])) await addLabel(pull.number, LABELS[kind]);
    if (has(pull, LABELS.checking)) await removeLabel(pull.number, LABELS.checking);
  }
  const hold = (pull: Pull, why: string) => stop(pull, 'held', why);
  async function allRuns(): Promise<Run[]> {
    const runs: Run[] = [];
    for (let page = 1; ; page++) {
      const reply = await get(`/actions/runs?limit=50&page=${page}`) as { workflow_runs?: Run[] };
      if (!Array.isArray(reply?.workflow_runs)) throw Error('Forgejo run list is invalid');
      runs.push(...reply.workflow_runs);
      if (reply.workflow_runs.length < 50) break;
    }
    return runs;
  }
  const highest = (runs: Run[]) => Math.max(0, ...runs.map(r => r.index_in_repo));
  /** Judge logs by the chosen run's id. Unreadable logs fail closed as a test result. */
  async function leftResult(run: Run): Promise<boolean> {
    if (run.status === 'cancelled') return false;
    try {
      const jobs = await get(`/actions/runs/${run.id}/jobs`) as { id: number }[];
      if (!Array.isArray(jobs) || !jobs.length) return true;
      for (const job of jobs) {
        if (!Number.isSafeInteger(job.id) || job.id <= 0) return true;
        const log = await request(`/actions/jobs/${job.id}/logs`, 'GET', undefined, true);
        if (!log.ok || /--- result\.json\r?\n(?:\d{4}-\d\d-\d\dT[\d:.]+Z )?\{/.test(log.text)) return true;
      }
      return false;
    } catch (error) { if (stale) throw error; return true; }
  }

  /** One pass: read every open pull request to master and act on the head of the queue. */
  async function pass(): Promise<boolean> {
    if (accountMismatch) return false;
    await ensureSecrets();
    await ensureLabels();
    const pulls = await openPulls();
    // A new head on a red pull request clears red; it rejoins the queue by age.
    for (const pull of pulls.filter(p => has(p, LABELS.red))) {
      const red = lastMatch(await myComments(pull.number), /^lander: red ([a-f0-9]{40})/);
      if (red && red.match[1] !== pull.head.sha) {
        await removeLabel(pull.number, LABELS.red);
        pull.labels = pull.labels!.filter(l => l.name !== LABELS.red);
        await comment(pull.number, `lander: rejoined at ${pull.head.sha} (red was ${red.match[1]})`);
      }
    }
    for (const pull of pulls.filter(p => has(p, LABELS.held))) {
      const held = lastMatch(await myComments(pull.number), /^lander: held ([a-f0-9]{40}): (.*)/);
      if (held && held.match[1] !== pull.head.sha && /^(retry limit|run budget)/.test(held.match[2]!)) {
        await removeLabel(pull.number, LABELS.held);
        pull.labels = pull.labels!.filter(l => l.name !== LABELS.held);
        await comment(pull.number, `lander: rejoined at ${pull.head.sha} (retry limit was ${held.match[1]})`);
      }
    }
    const queue = pulls.filter(p => !has(p, LABELS.red) && !has(p, LABELS.held));
    const checkingPulls = [];
    for (const pull of queue.filter(p => has(p, LABELS.checking))) {
      const requests = (await myCommentRows(pull.number)).filter(c => /^lander: run-request [a-f0-9]{40} #\d+ after run \d+$/.test(c.body));
      checkingPulls.push({ pull, requested: requests.at(-1)?.id ?? Infinity });
    }
    checkingPulls.sort((a, b) => a.requested - b.requested);
    const head = checkingPulls[0]?.pull ?? queue[0];
    for (const pull of queue.filter(p => p !== head)) {
      const demoted = has(pull, LABELS.checking);
      if (demoted) await removeLabel(pull.number, LABELS.checking);
      if (!has(pull, LABELS.queued)) await addLabel(pull.number, LABELS.queued);
      if (demoted || !has(pull, LABELS.queued)) await comment(pull.number, `lander: queued behind #${head!.number}`);
    }
    if (!head) return false;
    const n = head.number, H = head.head.sha;
    const mine = await myComments(n);
    const resetAt = lastMatch(mine, new RegExp(`^lander: reset ${H} after run (\\d+)$`));
    const R0 = Number(resetAt?.match[1] ?? 0);
    const requests = mine.slice((resetAt?.index ?? -1) + 1).flatMap(body => {
      const match = new RegExp(`^lander: run-request ${H} #(\\d+) after run (\\d+)$`).exec(body);
      return match ? [{ k: Number(match[1]), R: Number(match[2]) }] : [];
    });
    const runs = await allRuns();
    const own = runs.filter(run => {
      let payload: Exclude<Run['event_payload'], string>;
      try { payload = typeof run.event_payload === 'string' ? JSON.parse(run.event_payload) : run.event_payload; }
      catch { return false; }
      return run.workflow_id === 'ci.yml' && run.event === 'pull_request' && run.commit_sha === H
        && run.index_in_repo > R0 && payload?.label?.name === LABELS.checking && payload?.pull_request?.number === n;
    });
    const latest = requests.at(-1);
    const candidates = latest ? own.filter(run => run.index_in_repo > latest.R) : own;
    if (candidates.length > 1) {
      await hold(head, `attribution: runs ${candidates.map(r => r.index_in_repo).sort((a, b) => a - b).join(', ')} after request #${latest?.k ?? 0}`);
      return true;
    }
    const row = candidates[0];
    const checking = has(head, LABELS.checking);
    const result = row?.status ?? '';
    let start = !checking || (!latest && !row);
    const returnedHead = latest && mine.slice(mine.lastIndexOf(`lander: run-request ${H} #${latest.k} after run ${latest.R}`) + 1).some(body => {
      const match = /^lander: run-request ([a-f0-9]{40}) #\d+ after run \d+$/.exec(body);
      return match && match[1] !== H;
    });
    if (checking && latest && !row && returnedHead) {
      await hold(head, 'head returned to an earlier commit; reset to check it again');
      return true;
    }
    if (!start && (!row || !['success', 'failure', 'cancelled'].includes(result))) return false;
    if (!start && (result === 'failure' || result === 'cancelled')) {
      if (await leftResult(row!)) {
        await stop(head, 'red', `run ${row!.index_in_repo} failed`);
        return true;
      }
      start = true;
    }
    if (start) {
      if (await masterAhead(H)) {
        const updated = await request(`/pulls/${n}/update?style=rebase`, 'POST');
        if (!updated.ok) { await hold(head, `update refused (HTTP ${updated.code})`); return true; }
        await comment(n, `lander: updated ${H} onto master by rebase`);
        return false;
      }
      if (checking) {
        await removeLabel(n, LABELS.checking);
        head.labels = head.labels?.filter(l => l.name !== LABELS.checking);
      }
      if (has(head, LABELS.queued)) await removeLabel(n, LABELS.queued);
      if (Math.max(requests.length, own.length) >= 2) {
        await hold(head, 'run budget: two requests or runs already used');
        return true;
      }
      await comment(n, `lander: run-request ${H} #${requests.length + 1} after run ${highest(runs)}`);
      await addLabel(n, LABELS.checking);
      return false;
    }
    if (result === 'success') {
      const branch = await get('/branches/master') as { protected?: boolean; enable_status_check?: boolean; status_check_contexts?: string[] };
      const contexts = Array.isArray(branch?.status_check_contexts) ? branch.status_check_contexts : [];
      if (branch?.protected !== true || branch?.enable_status_check !== true || contexts.length !== 1 || contexts[0] !== CONTEXT) {
        await hold(head, `branch read drifted (protected ${branch?.protected}, enable_status_check ${branch?.enable_status_check}, status_check_contexts ${JSON.stringify(contexts)}); run ${row!.index_in_repo}`);
        return true;
      }
      if (await masterAhead(H)) { await hold(head, `master moved ahead of the checked head; run ${row!.index_in_repo}`); return true; }
      const merged = await request(`/pulls/${n}/merge`, 'POST', { Do: 'merge', head_commit_id: H });
      if (!merged.ok) { await hold(head, `merge refused (HTTP ${merged.code}); run ${row!.index_in_repo}`); return true; }
      await removeLabel(n, LABELS.checking);
      await comment(n, `lander: merged ${H}; run ${row!.index_in_repo}`);
      return true; // the next pull request is now the head of the queue
    }
    return false;
  }

  let running: Promise<void> | undefined;
  let again = false;
  const resets: { n: number; resolve: () => void; reject: (error: unknown) => void }[] = [];
  /** One pass at a time: a wake during a pass marks one more pass, never a second concurrent one. */
  function wake(reason: string): Promise<void> {
    if (running) { again = true; return running; }
    running = (async () => {
      try {
        do {
          again = false;
          for (const job of resets.splice(0)) {
            try { await resetNow(job.n); job.resolve(); } catch (error) { job.reject(error); }
          }
          say(`pass (${reason})`);
          try { if (await pass()) again = true; }
          catch (error) { say(`pass stopped: ${(error as Error).message}; labels left as they are until the next event`); }
          reason = 'again';
        } while (again);
      } finally { running = undefined; }
    })();
    return running;
  }
  const idle = () => running ?? Promise.resolve();

  async function resetNow(n: number): Promise<void> {
    await ensureSecrets();
    await ensureLabels();
    const pull = await get(`/pulls/${n}`) as Pull;
    await comment(n, `lander: reset ${pull.head.sha} after run ${highest(await allRuns())}`);
    for (const name of [LABELS.held, LABELS.red]) if (has(pull, name)) await removeLabel(n, name);
  }

  function reset(n: number): Promise<void> {
    const done = new Promise<void>((resolve, reject) => resets.push({ n, resolve, reject }));
    void wake(`reset ${n}`);
    return done;
  }

  /** The HTTP listener: Forgejo deliveries on any path, and nudge and reset from this host only. */
  const server = http.createServer(async (req, res) => {
    const reply = (code: number, text: string) => { res.writeHead(code, { 'Content-Type': 'text/plain' }); res.end(text); };
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');
    const control = /^\/control\/(nudge|reset\/(\d+))$/.exec(req.url ?? '');
    if (control && req.method === 'POST') {
      if (!local) return reply(403, 'control only from this host\n');
      if (!control[2] && accountMismatch) return reply(503, `stopped: LANDER_LOGIN ${me} is not this token's account; fix it and restart\n`);
      if (control[2]) {
        try { await reset(Number(control[2])); }
        catch (error) { say(`reset stopped: ${(error as Error).message}`); return reply(502, `reset failed: ${scrub((error as Error).message)}\n`); }
      }
      await wake(control[2] ? `reset ${control[2]}` : 'nudge');
      return reply(200, 'done\n');
    }
    if (req.method !== 'POST') return reply(405, 'POST only\n');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) { size += (chunk as Buffer).length; if (size > BODY_LIMIT) return reply(413, 'too large\n'); chunks.push(chunk as Buffer); }
    const body = Buffer.concat(chunks);
    if (!secrets || !signatureValid(secrets.webhook, body, req.headers['x-forgejo-signature'] as string | undefined)) {
      say('refused a delivery: bad signature');
      return reply(401, 'bad signature\n');
    }
    const event = String(req.headers['x-forgejo-event'] ?? req.headers['x-gitea-event'] ?? 'unknown');
    let ref = '';
    try { ref = String(JSON.parse(body.toString('utf8'))?.ref ?? ''); } catch { /* the event alone wakes a pass */ }
    reply(200, 'ok\n'); // Forgejo waits five seconds and never retries: answer first, then work.
    if (event === 'push' && ref !== 'refs/heads/master') return;
    void wake(event);
  });

  async function serve(port: number, host?: string): Promise<number> {
    await ensureSecrets();
    if (secrets?.source) say(`secrets read from ${secrets.source}`);
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve()); });
    const address = server.address();
    const bound = typeof address === 'object' && address ? address.port : port;
    say(`version ${LANDER_VERSION} listening on port ${bound}`);
    void wake('start');
    return bound;
  }
  const close = () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  return { serve, close, wake, idle, pass, reset, server };
}

/** nudge and reset reach the running lander over this host's loopback; they never read a secret themselves. */
export async function control(command: string, port: number): Promise<number> {
  const route = command === 'nudge' ? '/control/nudge' : `/control/reset/${command}`;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', signal: AbortSignal.timeout(120_000) });
    const text = (await response.text()).trim();
    console.log(`lander: ${command === 'nudge' ? 'nudge' : 'reset ' + command}: ${text} (HTTP ${response.status})`);
    return response.ok ? 0 : 1;
  } catch {
    console.log(`lander: no running lander answered on port ${port}; start it with node tools/lander.mts serve`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, value, ...rest] = process.argv.slice(2);
  const port = Number(process.env['LANDER_PORT'] ?? 8080);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) { console.error('LANDER_PORT must be a port number'); process.exitCode = 1; }
  else if (command === 'serve' && value === undefined) {
    try {
      const repoUrl = process.env['LANDER_REPO_URL'];
      if (!repoUrl) throw Error('Set LANDER_REPO_URL to the repository URL, such as http://forgejo:3000/Kioga/deskpost-private.git');
      const login = process.env['LANDER_LOGIN'];
      if (!login) throw Error('Set LANDER_LOGIN to the lander account name');
      await createLander({ repoUrl, login, readSecrets: () => readInfisicalSecrets(process.env) }).serve(port);
    } catch (error) {
      console.error(`lander: start failed: ${(error as Error).message}`); // exits; never loops on a failed secret read
      process.exit(1);
    }
  } else if (command === 'nudge' && value === undefined) process.exitCode = await control('nudge', port);
  else if (command === 'reset' && /^[1-9]\d*$/.test(value ?? '') && rest.length === 0) process.exitCode = await control(value!, port);
  else { console.error(USAGE); process.exitCode = 1; }
}
