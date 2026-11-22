/** Prepare a read-only side-work request from the same facts both harnesses display. */
import path from 'node:path';
import { dashboardReport } from './dashboard.ts';
import { readSeatRegistry } from './desk.ts';
import { sectionSpan, sectionText, toLines } from './hubedit.ts';
import { sectionStarts } from './kickoffcheck.ts';
import type { PsJsonValue } from './psjson.ts';
import { deskEntriesForSeat } from './seatdesk.ts';
import { readUtf8 } from './shelfbook.ts';
import { isThisLibrary } from './shelfnote.ts';
import { readMarker } from './workspace.ts';
import { triageInventory } from './triageinventory.ts';

function records(value: PsJsonValue | undefined): Record<string, PsJsonValue>[] {
  return Array.isArray(value) ? value.filter((row): row is Record<string, PsJsonValue> =>
    row !== null && typeof row === 'object' && !Array.isArray(row)) : [];
}

const plain = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
const shown = (count: number | null) => count ?? 'not read';

export function meanwhilePrepare(workspace: string, seat: string, now = Date.now()) {
  const report = dashboardReport(workspace, { seat, now });
  const problems = [...report.problems];
  const problem = (source: string, message: string) => problems.push({ source, problem: plain(message) });
  const read = <T>(source: string, get: () => T): T | null => {
    try { return get(); }
    catch (error) { problem(source, (error as Error).message); return null; }
  };
  const stateDirectory = path.join(workspace, '.claude');
  const hub = read('seat registry', () => readSeatRegistry(stateDirectory).find(row => row.seat === seat)?.project ?? null);
  const open = read('open Projects', () => deskEntriesForSeat(stateDirectory, seat, 'projects')) ?? [];
  const bodies = new Map<string, string | null>();
  const hubPage = (slug: string, page: string, optional = false) => {
    const source = `projects/${slug}/${page}`;
    return read(source, () => {
      if (!open.includes(`projects/${slug}`)) throw new Error('closed on this Desk');
      try { return readUtf8(path.join(workspace, 'collection', source + '.md')); }
      catch (error) {
        if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    });
  };
  const root = (slug: string) => {
    if (!bodies.has(slug)) bodies.set(slug, hubPage(slug, '_project') ?? null);
    return bodies.get(slug) ?? null;
  };

  const localId = String(readMarker(workspace)?.['id'] ?? '').toLowerCase();
  const inventory = report.builders?.some(row => row.state === 'handed back' || row.state === 'reviewed')
    ? read('late Reports', () => {
      const inventory = triageInventory(workspace);
      const books = records(report.desk?.capture_books);
      if (!books.some(book => book['slug'] === 'letters') || !books.some(book => book['slug'] === 'reports')) {
        throw new Error('the letters and Reports capture Books are needed');
      }
      return records(inventory['holding_notes']);
    }) : null;
  const runs = report.builders?.map(row => {
    const kickoff = row.current ? `projects/${row.hub}/kickoffs/${row.current}` : null;
    const page = row.current ? hubPage(row.hub, `kickoffs/${row.current}`) : null;
    const title = page ? /^# [ \t]*(.+)$/m.exec(page)?.[1]?.trim() ?? null : null;
    if (page != null && title === null && kickoff) problem(kickoff, 'the page has no title');
    const headings = page == null ? null : sectionStarts(page).map(heading => heading.name);
    const body = row.state === undefined ? null : root(row.hub);
    const lines = body === null ? [] : toLines(body);
    const tree = body === null ? null : read(`projects/${row.hub}/_project ## Repo`, () =>
      /Working tree:\**\s*`([^`]+)`/.exec(sectionText(lines, sectionSpan(lines, 'Repo')))?.[1] ?? null);
    if (body !== null && tree === null) problem(`projects/${row.hub}/_project`, '## Repo names no working tree');
    if (row.problem) problem(row.source, row.problem);
    let late_reports: { page: PsJsonValue; title: PsJsonValue; captured: PsJsonValue }[] | null = null;
    if (row.state === 'handed back' || row.state === 'reviewed') {
      const fromBuilder = inventory?.filter(note => note['from_seat'] === row.seat && isThisLibrary(String(note['from_library_id'] ?? '').toLowerCase(), localId));
      const handback = fromBuilder?.filter(note => note['book'] === 'letters' &&
        String(note['title']).startsWith(`${row.current} handback: `))
        .map(note => Date.parse(String(note['captured']))).filter(Number.isFinite).sort((a, b) => b - a)[0];
      if (handback === undefined) problem(row.source, `${row.current} handback letter time was not read`);
      else late_reports = fromBuilder!.filter(note => note['book'] === 'reports' && Date.parse(String(note['captured'])) > handback)
        .map(note => ({ page: note['page']!, title: note['title']!, captured: note['captured']! }));
    }
    return { ...row, kickoff, title, headings, tree, branch: row.current ? `int/${row.current}` : null,
      waiting: row.queue?.filter(id => id !== row.current) ?? null, late_reports };
  }) ?? null;
  const active = runs?.filter(run => run.current && run.state !== 'reviewed') ?? null;
  const others = runs?.filter(run => run.seat !== seat).map(run => ({
    seat: run.seat, state: run.state === null ? 'idle' : run.state ?? null, current: run.current ?? null, problem: run.problem ?? null,
  })) ?? null;
  const captureBooks = records(report.desk?.capture_books);
  const letters = report.desk?.letters_for_this_seat;
  const reportsPending = captureBooks.find(book => book['slug'] === 'reports')?.['pending_count'];
  const lettersPending = letters && !Array.isArray(letters) && typeof letters === 'object' ? letters['count'] : null;
  const counts = {
    reports: typeof reportsPending === 'number' ? reportsPending : null,
    letters: typeof lettersPending === 'number' ? lettersPending : null,
    needs_you: report.needs_you?.count ?? null,
    hub_over_limit: report.hub_over_limit?.pages.length ?? null,
    closeout: report.closeout,
  };
  if (counts.reports === null) problem('Reports pending', 'the Desk has no Reports count');
  if (counts.letters === null) problem('letters pending', 'the Desk has no letter count');
  if (hub === null) problem('seat registry', `${seat} has no registered Hub`);
  const ownRoot = hub === null ? null : root(hub);
  const backlog = hub === null ? null : hubPage(hub, 'backlog', true);
  problem('time rule', 'the Kickoff mapping does not supply the wording of the original rule');

  const head = active?.map(run => run.state === 'handed back' ? `${run.seat} has handed back` : `side work while ${run.seat} ${run.state === 'running' ? 'runs' : 'has a Kickoff posted'}`).join(' / ');
  const request = [head || (active === null ? 'Builder runs were not read.' : 'Side work while builders are idle.'), ''];
  for (const run of runs ?? []) {
    request.push(`${run.seat}: ${run.state === null ? 'idle' : run.state ?? 'not read'}${run.problem ? ` (${plain(run.problem)})` : ''}`);
    if (run.kickoff) {
      request.push(`Kickoff: ${plain(run.title ?? 'not read')} [[${run.kickoff}]]`);
      if (run.attempt_page) request.push(`Attempt: [[projects/${run.hub}/${run.attempt_page}]]${run.outcome ? ' with a ## Handback' : ''}`);
      if (run.state === 'running') request.push(`Minutes running: ${shown(run.minutes_running ?? null)}`);
      request.push(`The branch is ${run.branch}; never move it while the run lasts.`);
    }
    request.push(`Working tree: ${plain(run.tree ?? 'not read')}`, `Written and not started: ${run.waiting?.join(', ') || (run.waiting ? 'none' : 'not read')}`);
    if (run.outcome) request.push(`Reports filed after the handback letter: ${run.late_reports?.map(note => `${plain(String(note.title))} (reports/${note.page})`).join(', ') || (run.late_reports ? 'none' : 'not read')}`);
  }
  request.push('', 'Any desk/* commit follows this seat’s Hub Now, which may forbid commits while the run lasts.',
    'Never touch a builder’s working tree or master.',
    'Write a builder Hub only to add a Kickoff page and its one pointer.',
    'Ask Eric only for decisions, approvals, or credentials.');
  request.push('', '1. Builder work');
  for (const run of active ?? []) {
    if (run.state === 'handed back') request.push(
      `Review ${run.seat}’s handback. Record the review on a page named notes/<date>-${run.current}-review-....`,
      'Draft the next Kickoff in the Notebook and write it to the Hub only on Eric’s word.');
    if (run.state === 'running') {
      request.push('Keep review notes in the Notebook. Sketch the next Kickoff from the backlog’s candidates.');
      request.push(run.headings === null ? 'Kickoff headings were not read.' : `Read these Kickoff headings: ${run.headings.join(', ') || 'none'}.`);
    }
    if (/\brelease\b/i.test(run.title ?? '')) request.push('Prepare the post-publish steps for the release.');
  }
  request.push('', `2. Gather asks for Eric from this seat’s Hub${ownRoot === null ? ' (not read)' : ''} and the Needs you report (${shown(counts.needs_you)}).`);
  for (const section of report.needs_you?.sections ?? []) {
    for (const item of section.items) request.push(`- ${item.seat ? item.seat + ': ' : ''}${item.text}`);
  }
  request.push('', `3. Check pending Reports (${shown(counts.reports)}), letters (${shown(counts.letters)}), and Hub pages over their limit (${shown(counts.hub_over_limit)}).`,
    `Check closeout gaps and waits. Closeout: ${counts.closeout ? counts.closeout.state ?? 'no recorded closeout' : 'not read'}.`);
  for (const page of report.hub_over_limit?.pages ?? []) request.push(`- ${plain(String(page['hub']))}/${plain(String(page['page']))}`);
  if (ownRoot === null) request.push('This seat’s Hub was not read.');
  if (/\brelease notice\b/i.test(ownRoot ?? '')) request.push('Check release notices owed.');
  if (backlog !== undefined) request.push('', `4. Read the backlog’s design queue${backlog === null ? ' (not read)' : ''}.`);
  request.push('', 'Answer in at most 7 items. Give each a size and make one recommendation. Start nothing until Eric picks.');
  return { schema: 1, operation: 'Prepare the meanwhile request', seat, hub, read_at: report.read_at,
    active, runs, others, counts, request: request.join('\n') + '\n', problems };
}
