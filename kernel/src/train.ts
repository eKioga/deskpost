/** The planner's ordered train record (c69-r3). Only explicit mutations write it; page is derived text. */
import fs from 'node:fs';
import path from 'node:path';
import { ensureDirectory, writeAtomicText } from './fsx.ts';
import { readerText } from './remedy.ts';
import { enterBookLock, exitBookLock } from './locks.ts';
import { fencedLineMask, headings, itemBlocks, toLines } from './hubedit.ts';
import { deskEntriesForSeat, resolveSeatName } from './seatdesk.ts';

type Item = { id: string; title: string; place: string; first_asked: string; source: string; status: 'open' | 'done' | 'dropped'; note: string; lane?: string; group?: string };
/** A car's opening and arrival (kickoffs/s184): local dates; the front car is the one opened and not arrived. */
export type Car = { place: string; opened: string; arrived: string | null; finish_line?: string; plan?: string };
export type TrainRecord = { schema: 1; changed_at: string; changed_by: string; items: Item[]; cars?: Car[] };
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PLACE = /^(?:foundation|running|bucket:[12]|(?:car|lane):[a-z0-9][a-z0-9.-]*)$/;
const line = (value: unknown): value is string => typeof value === 'string' && !/[\r\n\x00-\x1f\x7f]/.test(value);
const date = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const recordFile = (workspace: string): string => path.join(workspace, 'internal', 'train', 'register.json');
const CAR = /^car:[a-z0-9][a-z0-9.-]*$/;
/** Today's local date, YYYY-MM-DD: a car opens and arrives on the day Eric sees, not the UTC day. */
export const localDate = (at: Date = new Date()): string =>
  `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
/** Whole days from one YYYY-MM-DD to another (negative when `to` is earlier). */
export const daysBetween = (from: string, to: string): number => Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
/** The car opened and not arrived, or null. */
export const frontCar = (record: TrainRecord): Car | null => record.cars?.find(car => car.arrived === null) ?? null;

/** Missing is distinct from malformed: a damaged register must never be silently replaced. */
export function readTrain(workspace: string): TrainRecord | null {
  let text: string;
  try { text = fs.readFileSync(recordFile(workspace), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const r = JSON.parse(text) as TrainRecord;
  const ids = new Set<string>();
  if (!r || r.schema !== 1 || !line(r.changed_by) || !r.changed_by.trim() || !line(r.changed_at) || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(r.changed_at) || !Number.isFinite(Date.parse(r.changed_at)) || !Array.isArray(r.items)) throw new Error('The train register is not a valid schema-1 record.');
  for (const i of r.items) {
    if (!i || !line(i.id) || !SLUG.test(i.id) || ids.has(i.id) || !line(i.title) || !i.title.trim() || !line(i.place) || !PLACE.test(i.place) || !line(i.first_asked) || !date(i.first_asked) || !line(i.source) || !['open', 'done', 'dropped'].includes(i.status) || !line(i.note) || (i.lane !== undefined && (!line(i.lane) || !SLUG.test(i.lane))) || (i.group !== undefined && (!line(i.group) || !SLUG.test(i.group)))) throw new Error('The train register contains an invalid or duplicate item.');
    ids.add(i.id);
  }
  if (r.cars !== undefined) {
    if (!Array.isArray(r.cars)) throw new Error('The train register\'s cars is not a list.');
    const places = new Set<string>();
    for (const c of r.cars) {
      if (!c || !line(c.place) || !CAR.test(c.place) || places.has(c.place) || !line(c.opened) || !date(c.opened)
        || (c.finish_line !== undefined && (!line(c.finish_line) || !c.finish_line.trim()))
        || (c.plan !== undefined && (!line(c.plan) || !c.plan.trim()))
        || (c.arrived !== null && (!line(c.arrived) || !date(c.arrived) || c.arrived < c.opened))) throw new Error('The train register contains an invalid or duplicate car.');
      places.add(c.place);
    }
    if (r.cars.filter(c => c.arrived === null).length > 1) throw new Error('The train register has more than one open car.');
  }
  return r;
}

/** Open items retain array order, grouped by the first occurrence of their place. */
export function trainText(record: TrainRecord | null, markdown = false, by?: string): string {
  if (by !== undefined && by !== 'lane') throw new Error('Train page --by takes lane.');
  if (record === null) return 'No train register yet.';
  if (by === 'lane') return trainLanePage(record).map(p => `${markdown ? '## ' : ''}${p.place}\n` + p.lanes.map(l =>
    `${markdown ? '### ' : '  '}${l.lane} (${l.count} open)\n` + l.groups.map(g =>
      `${markdown ? '#### ' : '    '}${g.group} (${g.count} open)\n` + g.items.map(i =>
        `${markdown ? '- ' : '      '}${i.id}: ${readerText(i.title)}${i.note ? `; ${readerText(i.note)}` : ''} (${i.first_asked})`).join('\n')).join('\n')).join('\n'))
    .concat(`Changed ${record.changed_at} by ${record.changed_by}`).join('\n\n');
  const groups = new Map<string, Item[]>();
  for (const item of record.items.filter(i => i.status === 'open')) {
    if (!groups.has(item.place)) groups.set(item.place, []);
    groups.get(item.place)!.push(item);
  }
  return [...groups].map(([place, items]) => `${markdown ? '## ' : ''}${place}\n${items.map(i => `${markdown ? '- ' : '  '}${i.id}: ${readerText(i.title)}${i.note ? `; ${readerText(i.note)}` : ''} (${i.first_asked})`).join('\n')}`).concat(`Changed ${record.changed_at} by ${record.changed_by}`).join('\n\n');
}

/** The optional lane page preserves first-seen place, lane and group order. */
export function trainLanePage(record: TrainRecord | null) {
  const grouped = (items: Item[], key: (item: Item) => string): [string, Item[]][] => {
    const groups = new Map<string, Item[]>();
    for (const item of items) { const name = key(item); if (!groups.has(name)) groups.set(name, []); groups.get(name)!.push(item); }
    return [...groups];
  };
  return grouped(record?.items.filter(i => i.status === 'open') ?? [], i => i.place).map(([place, items]) => ({ place, count: items.length,
    lanes: grouped(items, i => i.lane ?? 'no lane').map(([lane, items]) => ({ lane, count: items.length,
      groups: grouped(items, i => i.group ?? 'no group').map(([group, items]) => ({ group, count: items.length, items })) })) }));
}

/** Shared by the check and add refusal: a title or an exact file:line token. */
function duplicateTitle(a: string, b: string): string | null {
  if (a.trim().toLowerCase() === b.trim().toLowerCase()) return 'same title';
  const locations = (title: string): string[] => title.match(/(?:[A-Za-z]:[\\/])?[\w./\\-]+\.[\w-]+:[1-9]\d*\b/g) ?? [];
  const other = new Set(locations(b));
  return locations(a).find(token => other.has(token)) ?? null;
}

/** Read-only shape advice. A malformed history refuses rather than inventing an item's age. */
export function checkTrain(workspace: string, now: Date = new Date()) {
  const record = readTrain(workspace), items = record?.items.filter(i => i.status === 'open') ?? [];
  const touched = new Map<string, string>();
  let history = '';
  try { history = fs.readFileSync(path.join(path.dirname(recordFile(workspace)), 'history.jsonl'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const line of history.split(/\r?\n/).filter(s => s.trim())) {
    const row = JSON.parse(line);
    if (!row || typeof row.id !== 'string' || typeof row.at !== 'string' || !Number.isFinite(Date.parse(row.at))) throw new Error('The train history contains an invalid id or date.');
    touched.set(row.id, row.at);
  }
  const findings: { kind: string; ids: string[]; message: string; age?: number }[] = [];
  for (const item of items) {
    if (!item.lane) findings.push({ kind: 'no-lane', ids: [item.id], message: `${item.id}: no lane; deskpost train set ${item.id} --lane <lane>` });
    const age = Math.floor((now.getTime() - Date.parse(touched.get(item.id) ?? item.first_asked)) / 86400000);
    if (age >= 30) findings.push({ kind: 'stale', ids: [item.id], age, message: `${item.id}: untouched for ${age} days (30+); deskpost train set ${item.id} --note <update>, or deskpost train close ${item.id} --dropped --note <reason>` });
  }
  for (const lane of new Set(items.flatMap(i => i.lane ? [i.lane] : []))) {
    const ids = items.filter(i => i.lane === lane).map(i => i.id);
    if (ids.length > 40) findings.push({ kind: 'lane-size', ids, message: `${lane}: ${ids.length} open items (${ids.join(', ')}); deskpost train close <id> --dropped --note <reason>` });
  }
  for (const [index, item] of items.entries()) for (const other of items.slice(index + 1)) {
    const duplicate = duplicateTitle(item.title, other.title);
    if (duplicate) findings.push({ kind: 'duplicate', ids: [item.id, other.id], message: `${item.id}, ${other.id}: ${duplicate}; merge with deskpost train close ${other.id} --dropped --note "merged into ${item.id}"` });
  }
  return { findings, count: findings.length };
}

/** A date that has happened: never later than today's local date (kickoffs/s185 row 2). */
function notFuture(flag: string, value: string, today: string): void {
  if (value > today) throw new Error(`${flag} ${value} is later than today, ${today}; it must be a day that has come.`);
}

export function commandLiteral(value: string, platform: NodeJS.Platform = process.platform): string {
  // PowerShell's about_Quoting_Rules treats typographic single quotes as delimiters too.
  const escaped = platform === 'win32'
    ? value.replace(/['\u2018-\u201b]/g, '$&$&')
    : value.replaceAll("'", "'\\''");
  return "'" + escaped + "'";
}

function hubItemsNamingTrainId(workspace: string, seat: string, id: string): string[] {
  const reference = '`' + id + '`';
  const notes: string[] = [];
  for (const hub of deskEntriesForSeat(path.join(workspace, '.claude'), seat, 'projects')) {
    if (!/^projects\/[a-z0-9-]+$/.test(hub)) continue;
    const file = path.join(workspace, 'collection', ...hub.split('/'), '_project.md');
    let lines: string[];
    try { lines = toLines(fs.readFileSync(file, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    const fenced = fencedLineMask(lines);
    const sections = headings(lines);
    const slug = hub.slice('projects/'.length);
    for (const [index, heading] of sections.entries()) {
      if (heading.level !== 2) continue;
      const end = sections[index + 1]?.index ?? lines.length;
      for (const block of itemBlocks(lines, heading.index + 1, end)) {
        const first = lines[block.start]!;
        if (!/^(?:[-*+]|[0-9]+\.)[ \t]+\[ \][ \t]+/.test(first) || fenced[block.start]) continue;
        if (!lines.slice(block.start, block.end + 1).some((line, offset) => !fenced[block.start + offset] && line.includes(reference))) continue;
        notes.push(`${hub} / ${heading.text}: ${first.trim()}`,
          `deskpost hub edit ${slug} --mode check-item --section ${commandLiteral(heading.text)} --match-text ${commandLiteral(first.trim())}`);
      }
    }
  }
  return notes;
}

/** Every argument and the prior record are checked before either file changes. `now` is the clock, for tests. */
export function changeTrain(workspace: string, action: string, id: string, options: Map<string, string>, flags: Set<string>, now: Date = new Date(), onChange?: (summary: string) => void): TrainRecord {
  // The seat as every other seat-needing verb names it (kickoffs/s185 row 1): the binding first, then LIBRARY_SEAT.
  const seat = resolveSeatName({ stateDirectory: path.join(workspace, '.claude') });
  if (seat.status === 'malformed') throw new Error(seat.message);
  const by = seat.status === 'named' ? seat.seat! : '';
  if (!line(by) || !by.trim()) throw new Error('A named seat is required to change the train.');
  // File text is decoded strictly and validated before taking the register lock or writing.
  if (['add', 'retitle', 'set', 'close'].includes(action)) {
    options = new Map(options);
    for (const key of ['title', 'note']) {
      const file = options.get(key + '-path');
      if (file === undefined) continue;
      if (options.has(key)) throw new Error(`Use only one of --${key} or --${key}-path.`);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)).replace(/\r?\n$/, '');
      if (!line(text) || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(text) || !text.trim()) throw new Error(`--${key}-path must hold one non-empty line of UTF-8 text.`);
      options.set(key, text);
    }
  }
  if (action === 'car') return changeCar(workspace, by, id, options, flags, now);
  if (!SLUG.test(id)) throw new Error('The train id must be a short lowercase slug.');
  const lock = enterBookLock(workspace, 'train/register');
  try {
    const at = now.toISOString();
    const prior = readTrain(workspace);
    const record: TrainRecord = prior ?? { schema: 1, changed_at: at, changed_by: by, items: [] };
    let item = record.items.find(i => i.id === id);
    const from = item?.place ?? null;
    const oldStatus = item?.status ?? 'absent';
    if (action === 'add' && item) throw new Error(`The train already has id '${id}'.`);
    if (action !== 'add' && !item) throw new Error(`The train has no id '${id}'.`);
    const fields: Partial<Pick<Item, 'lane' | 'group' | 'note'>> = {};
    if (action === 'add' || action === 'set') {
      for (const key of ['lane', 'group', 'note'] as const) {
        const value = options.get(key);
        if (value === undefined) continue;
        if (!line(value) || !value.trim() || (key !== 'note' && !SLUG.test(value))) throw new Error('--' + key + ' must be ' + (key === 'note' ? 'one non-empty line.' : 'a lowercase slug.'));
        fields[key] = value;
      }
    }
    if (action === 'set') {
      if (!Object.keys(fields).length) throw new Error('Train set needs at least one of --lane, --group or --note.');
      const before = Object.fromEntries(Object.keys(fields).map(key => [key, item![key as keyof typeof fields] ?? null]));
      Object.assign(item!, fields);
      const committed = commit(workspace, record, at, by, action, id, before, fields);
      onChange?.('Set ' + id + ': ' + Object.entries(fields).map(([key, value]) => key + ': ' + readerText(JSON.stringify(before[key])) + ' -> ' + readerText(JSON.stringify(value))).join('; '));
      return committed;
    }
    if (action === 'add' || action === 'move') {
      const place = options.get('place') ?? '';
      if (!PLACE.test(place)) throw new Error(`Unknown train place '${place}'.`);
      const after = options.get('after');
      const before = options.get('before'), first = flags.has('first');
      if (Number(first) + Number(before !== undefined) + Number(after !== undefined) > 1) throw new Error('Use only one of --first, --before or --after.');
      const anchor = before ?? after;
      const target = anchor === undefined ? undefined : record.items.find(i => i.id === anchor);
      if (anchor !== undefined) {
        if (anchor === id || !target) throw new Error(`--${before !== undefined ? 'before' : 'after'} names no other train item: '${anchor}'.`);
        if (target.place !== place && (action === 'add' || target.status !== 'open')) throw new Error(`${anchor} is in ${target.place}, not ${place}`);
      }
      if (action === 'add') {
        const title = options.get('title') ?? '';
        const first = options.get('first-asked') ?? localDate(now);
        const source = options.get('source') ?? '';
        if (!line(title) || !title.trim() || !line(source) || !date(first)) throw new Error('Train add needs a one-line title, source and a valid YYYY-MM-DD first-asked date.');
        notFuture('--first-asked', first, localDate(now));
        const duplicate = record.items.find(i => i.status === 'open' && duplicateTitle(i.title, title));
        if (duplicate && !flags.has('not-duplicate')) throw new Error(`Likely duplicate of ${duplicate.id}; use --not-duplicate to add anyway, or deskpost train set ${duplicate.id} --note <update>.`);
        item = { id, title, place, first_asked: first, source, status: 'open', note: '', ...fields };
      }
      item!.place = place;
      if (target && target.place !== place) {
        const group = record.items.filter(i => i.place === place);
        record.items = record.items.filter(i => i.place !== place);
        const index = record.items.findIndex(i => i.place === target.place && i.status === 'open');
        record.items.splice(index + Number(after !== undefined), 0, ...group);
      } else if (action === 'add' || first || anchor !== undefined) {
        record.items = record.items.filter(i => i.id !== id);
        const index = first ? record.items.findIndex(i => i.place === place)
          : anchor !== undefined ? record.items.findIndex(i => i.id === anchor) + Number(after !== undefined) : -1;
        record.items.splice(index < 0 ? record.items.length : index, 0, item!);
      }
    } else if (action === 'close') {
      const note = options.get('note') ?? '';
      if (flags.has('done') === flags.has('dropped') || !line(note) || !note.trim()) throw new Error('Train close needs exactly one of --done or --dropped and a one-line --note.');
      item!.status = flags.has('done') ? 'done' : 'dropped';
      item!.note = note;
    } else if (action === 'reopen') {
      const note = options.get('note') ?? '';
      if (item!.status === 'open') throw new Error(`Train item ${id} is already open.`);
      if (!line(note) || !note.trim()) throw new Error('Train reopen needs a one-line, non-empty --note.');
      const before = { status: item!.status, note: item!.note };
      item!.status = 'open'; item!.note = note;
      const committed = commit(workspace, record, at, by, action, id, before, 'open');
      onChange?.(`Reopened ${id}: ${before.status} -> open; ${readerText(note)}`);
      return committed;
    } else if (action === 'retitle') {
      // s201 row 2: a title that has gone stale is corrected in place; nothing else about the item changes.
      const title = options.get('title') ?? '';
      if (!line(title) || !title.trim()) throw new Error('Train retitle needs a one-line, non-empty --title.');
      const old = item!.title;
      item!.title = title;
      const committed = commit(workspace, record, at, by, action, id, old, title);
      onChange?.(`Retitled ${id}: ${readerText(JSON.stringify(old.slice(0, 100)))} -> ${readerText(JSON.stringify(title.slice(0, 100)))}`);
      return committed;
    } else throw new Error(`Unknown train action '${action}'.`);
    const hubItems = action === 'close' ? hubItemsNamingTrainId(workspace, by, id) : [];
    const committed = commit(workspace, record, at, by, action, id, from, action === 'close' ? item!.status : item!.place);
    const transition = action === 'close' ? oldStatus + ' -> ' + item!.status : (from ?? 'absent') + ' -> ' + item!.place;
    const summary = (action === 'add' ? 'Added' : action === 'move' ? 'Moved' : 'Closed') + ' ' + id + ': ' +
      readerText(JSON.stringify(item!.title.slice(0, 100))) + ' (' + transition + ')' + (item!.note ? ' note: ' + readerText(item!.note) : '') + (action === 'add' && !item!.lane ? '; no lane: set one with deskpost train set ' + id + ' --lane <lane>' : '');
    const car = action === 'close' && oldStatus === 'open' && !record.items.some(open => open.place === item!.place && open.status === 'open')
      ? record.cars?.find(car => car.place === item!.place) : undefined;
    const finish = car?.finish_line ? [`Finish line for ${car.place}: ${car.finish_line}. Give the evidence that it was met.`] : [];
    onChange?.([summary, ...finish, ...hubItems].join('\n'));
    return committed;
  } finally {
    exitBookLock(lock);
  }
}

/** Writes the record and appends its history line together; either failing restores both. */
function commit(workspace: string, record: TrainRecord, at: string, by: string, action: string, id: string, from: unknown, to: unknown): TrainRecord {
  record.changed_at = at;
  record.changed_by = by;
  const file = recordFile(workspace), history = path.join(path.dirname(file), 'history.jsonl');
  ensureDirectory(path.dirname(file));
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const historySize = fs.existsSync(history) ? fs.statSync(history).size : null;
  try {
    writeAtomicText(file, JSON.stringify(record, null, 2) + '\n');
    fs.appendFileSync(history, JSON.stringify({ at, by, action, id, from, to }) + '\n');
  } catch (error) {
    if (before === null) fs.rmSync(file, { force: true }); else writeAtomicText(file, before);
    if (historySize === null) fs.rmSync(history, { force: true }); else fs.truncateSync(history, historySize);
    throw error;
  }
  return record;
}

/** `train car <place> --opened|--arrived [--on <date>]` (kickoffs/s184 row 1): one car open at a time. */
function changeCar(workspace: string, by: string, place: string, options: Map<string, string>, flags: Set<string>, now: Date): TrainRecord {
  if (!CAR.test(place)) throw new Error(`A car's place is car:<name>, not '${place}'.`);
  const finish = options.get('finish-line');
  const plan = options.get('plan');
  if (finish === undefined && plan !== undefined) throw new Error('--plan requires --finish-line.');
  if (finish === undefined && flags.has('opened') === flags.has('arrived')) {
    throw new Error('Train car needs exactly one of --opened, --arrived or --finish-line.');
  }
  if (finish !== undefined && (!line(finish) || !finish.trim() || (plan !== undefined && (!line(plan) || !plan.trim()))
    || flags.has('opened') || flags.has('arrived') || options.has('on'))) {
    throw new Error('Set a one-line --finish-line and optional --plan separately from opening or arrival.');
  }
  const on = options.get('on') ?? localDate(now);
  if (!line(on) || !date(on)) throw new Error(`--on needs a real YYYY-MM-DD date, not '${on}'.`);
  notFuture('--on', on, localDate(now));
  const lock = enterBookLock(workspace, 'train/register');
  try {
    const at = now.toISOString();
    const record: TrainRecord = readTrain(workspace) ?? { schema: 1, changed_at: at, changed_by: by, items: [] };
    const cars = record.cars ?? [];
    const car = cars.find(c => c.place === place);
    if (finish !== undefined) {
      if (!car) throw new Error(`${place} was never opened; open it with --opened first.`);
      const prior = { finish_line: car.finish_line ?? null, plan: car.plan ?? null };
      car.finish_line = finish;
      if (plan !== undefined) car.plan = plan;
      return commit(workspace, record, at, by, 'car', place, prior,
        { finish_line: car.finish_line, plan: car.plan ?? null });
    }
    if (flags.has('opened')) {
      if (car) throw new Error(`${place} was already opened on ${car.opened}.`);
      const open = cars.find(c => c.arrived === null);
      if (open) throw new Error(`${open.place} is still open (opened ${open.opened}); mark it --arrived before opening ${place}.`);
      cars.push({ place, opened: on, arrived: null });
      record.cars = cars;
      return commit(workspace, record, at, by, 'car', place, null, `opened ${on}`);
    }
    if (!car) throw new Error(`${place} was never opened; open it with --opened first.`);
    if (car.arrived !== null) throw new Error(`${place} already arrived on ${car.arrived}.`);
    if (on < car.opened) throw new Error(`${place} opened on ${car.opened}; it cannot arrive on ${on}.`);
    car.arrived = on;
    return commit(workspace, record, at, by, 'car', place, `opened ${car.opened}`, `arrived ${on}`);
  } finally {
    exitBookLock(lock);
  }
}
