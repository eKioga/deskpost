/**
 * `library raw owners` -- which Project owns each source batch under `raw/`.
 *
 * OWNERSHIP IS DECLARED, NEVER INFERRED. `raw/` does not follow the documented
 * `raw/<project-slug>/<source-batch>/` shape -- whole repository checkouts sit at the top level and
 * none of their names is a Project slug -- so a NAME IS NOT EVIDENCE of ownership. A batch nobody
 * has declared is reported as unmapped, and this report says which.
 *
 * LIVENESS IS NEVER STORED. A record holds a Project slug and nothing else, so archiving a Project
 * cannot leave a stale copy of its state behind: every read joins the slug against the active and
 * archived Project Catalogs. That join is the only part that reaches the shared collection, and
 * `--offline` skips it, reporting every liveness as `undetermined` rather than as anything more
 * confident. Tier 0 has no endpoint to reach, so `--offline` is also what this kernel answers with
 * when none is configured -- the same honest answer an unreachable NAS produces, never a quieter
 * one.
 *
 * TWO FIELDS, NOT ONE, FOR THE PARTIAL ANSWER. `catalogs_read` is a property of the network call;
 * `eviction_determined` is a property of the MAPPINGS, and is vacuously true when there are none,
 * because a list of nothing really is complete. One flag doing both jobs reported one of them
 * wrongly whichever it picked -- measured on the PowerShell side's first live run.
 *
 * EVICTION IS OFFERED AND NEVER PERFORMED. Nothing here deletes, moves or modifies anything under
 * `raw/`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PsJsonValue } from './psjson.ts';
import { parseArguments } from './argv.ts';
import { getRawBatchRoster, getRawProvenance, resolveRawBatch } from './rawsearch.ts';

const OWNER_SCHEMA = 1;
const OWNER_RECORD_RELATIVE = 'internal/raw-batch-owners.json';

const LIVENESS_ACTIVE = 'active';
const LIVENESS_ARCHIVED = 'archived';
const LIVENESS_UNLISTED = 'unlisted';
const LIVENESS_UNDETERMINED = 'undetermined';

const READ_OK = 'ok';
const READ_FAILED = 'failed';

const EVICTION_RULE =
  'An eviction candidate is an OFFER, not an action: nothing here deletes, moves, or modifies anything under raw/, ' +
  'and no record is a licence to. Ownership is what the reader declared, never what a directory name suggests.';

interface OwnerRecord {
  batch: string;
  project: string;
  date: string;
  note: string;
}

interface CatalogSet {
  activeRead: string;
  activeSlugs: string[];
  activeReason: string;
  archiveRead: string;
  archiveSlugs: string[];
  archiveReason: string;
}

function convertToBatchKey(batch: string): string {
  return String(batch).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function readOwnerFile(workspace: string): OwnerRecord[] {
  const file = path.join(workspace, ...OWNER_RECORD_RELATIVE.split('/'));
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  if (!raw.trim()) return [];
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${OWNER_RECORD_RELATIVE} is not valid JSON: ${(error as Error).message}`);
  }
  if (!('schema' in parsed)) throw new Error(`${OWNER_RECORD_RELATIVE} has no schema field.`);
  if (Number(parsed['schema']) !== OWNER_SCHEMA) {
    throw new Error(`${OWNER_RECORD_RELATIVE} is schema ${String(parsed['schema'])}; this helper writes schema ${OWNER_SCHEMA}.`);
  }
  const records = Array.isArray(parsed['records']) ? (parsed['records'] as Record<string, unknown>[]) : [];
  return records.map((record) => ({
    batch: String(record['batch'] ?? ''),
    project: String(record['project'] ?? ''),
    date: 'date' in record ? String(record['date'] ?? '') : '',
    note: 'note' in record ? String(record['note'] ?? '') : '',
  }));
}

/**
 * The record that owns one batch path, or null. LONGEST DECLARED PREFIX WINS, so a reader who owns
 * a checkout by one Project and a directory inside it by another gets the specific answer rather
 * than the general one.
 */
function ownerRecordFor(records: OwnerRecord[], batch: string): OwnerRecord | null {
  const normalised = convertToBatchKey(batch);
  if (!normalised.trim()) return null;
  let best: OwnerRecord | null = null;
  let bestLength = -1;
  for (const record of records) {
    const key = convertToBatchKey(record.batch);
    if (!key.trim()) continue;
    const lower = normalised.toLowerCase();
    const keyLower = key.toLowerCase();
    const covers = lower === keyLower || lower.startsWith(keyLower + '/');
    if (covers && key.length > bestLength) {
      best = record;
      bestLength = key.length;
    }
  }
  return best;
}

/**
 * One slug's liveness, derived from a catalog set. Never guesses and never defaults to live.
 * Decomposed so an unreadable ARCHIVE catalog only degrades the answer for slugs that need it.
 */
function resolveLiveness(catalogs: CatalogSet | null, slug: string): string {
  if (catalogs === null) return LIVENESS_UNDETERMINED;
  if (catalogs.activeRead !== READ_OK) return LIVENESS_UNDETERMINED;
  if (catalogs.activeSlugs.includes(slug)) return LIVENESS_ACTIVE;
  if (catalogs.archiveRead === READ_OK) {
    return catalogs.archiveSlugs.includes(slug) ? LIVENESS_ARCHIVED : LIVENESS_UNLISTED;
  }
  if (catalogs.archiveRead === 'absent') return LIVENESS_UNLISTED;
  return LIVENESS_UNDETERMINED;
}

/** Both non-external classes may never be cited as current, and the test is written once. */
function testProvenanceSuperseded(provenance: string): boolean {
  return provenance === 'historical' || provenance === 'unclassified';
}

interface RootRow {
  batch: string;
  provenance: string;
  children: number;
  project: string;
  mapped: boolean;
  sub_mapped: number;
  liveness: string;
}

interface MappingRow {
  batch: string;
  project: string;
  date: string;
  note: string;
  on_disk: boolean;
  miss_reason: string;
  provenance: string;
  liveness: string;
}

export interface OwnershipReport {
  schema: number;
  operation: string;
  status: string;
  raw_present: boolean;
  record_path: string;
  roots_total: number;
  roots_unmapped: number;
  records_total: number;
  catalog_active: string;
  catalog_archive: string;
  catalogs_read: boolean;
  liveness_reason: string;
  roots: RootRow[];
  mappings: MappingRow[];
  unmapped: string[];
  stale_mappings: MappingRow[];
  dangling_mappings: MappingRow[];
  eviction_candidates: MappingRow[];
  archived_absent: MappingRow[];
  eviction_determined: boolean;
}

/**
 * REPORTED AT THE TOP LEVEL, BECAUSE A MAPPING COVERS ITS SUBTREE. A depth-1 root is the unit an
 * ownership decision is actually made about; anything under it inherits, and a reader who wants a
 * finer grain declares a deeper mapping, which is then listed on its own.
 */
export function getRawBatchOwnershipReport(workspace: string, catalogs: CatalogSet | null): OwnershipReport {
  const rawRoot = path.join(workspace, 'raw');
  const rawPresent = fs.existsSync(rawRoot) && fs.statSync(rawRoot).isDirectory();

  const records = readOwnerFile(workspace);
  const roster = getRawBatchRoster(workspace);

  const roots: RootRow[] = [];
  for (const entry of roster.filter((item) => item.depth === 1)) {
    const batch = entry.batch;
    // A root can only ever be owned DIRECTLY -- nothing sits above it to inherit from. What it can
    // have is mappings BENEATH it, and a bare "UNMAPPED" would hide a finer-grained decision the
    // reader has already made.
    const owner = ownerRecordFor(records, batch);
    const slug = owner === null ? '' : owner.project;
    const prefix = (convertToBatchKey(batch) + '/').toLowerCase();
    const beneath = records.filter((record) => convertToBatchKey(record.batch).toLowerCase().startsWith(prefix));
    roots.push({
      batch,
      provenance: entry.provenance,
      children: entry.children,
      project: slug,
      mapped: owner !== null,
      sub_mapped: beneath.length,
      liveness: owner === null ? '' : resolveLiveness(catalogs, slug),
    });
  }

  const mappings: MappingRow[] = records.map((record) => {
    const batch = convertToBatchKey(record.batch);
    const resolved = resolveRawBatch(workspace, batch);
    return {
      batch,
      project: record.project,
      date: record.date,
      note: record.note,
      on_disk: resolved.recognised,
      miss_reason: resolved.recognised ? '' : resolved.reason,
      provenance: resolved.recognised ? resolved.provenance : getRawProvenance(batch),
      liveness: resolveLiveness(catalogs, record.project),
    };
  });

  const unmapped = roots.filter((root) => !root.mapped).map((root) => root.batch);
  const stale = mappings.filter((mapping) => !mapping.on_disk);
  const evictable = mappings.filter((mapping) => mapping.on_disk && mapping.liveness === LIVENESS_ARCHIVED);
  // AN EMPTY CANDIDATE LIST HAS TWO CAUSES, AND ONLY ONE IS "nothing is archived". An archived
  // owner whose directory is already gone never reaches `evictable`, and answering that with "no
  // batch is owned by an archived Project" denies a mapping the same render prints as [archived].
  const archivedAbsent = mappings.filter((mapping) => !mapping.on_disk && mapping.liveness === LIVENESS_ARCHIVED);
  const dangling = mappings.filter((mapping) => mapping.liveness === LIVENESS_UNLISTED);
  const undetermined = mappings.filter((mapping) => mapping.liveness === LIVENESS_UNDETERMINED);

  let livenessReason = '';
  if (catalogs === null) livenessReason = 'the Project Catalogs were not read, so no mapping has a derived liveness';
  else if (catalogs.activeRead !== READ_OK) {
    livenessReason = `the active Project Catalog could not be read${catalogs.activeReason ? ': ' + catalogs.activeReason : ''}`;
  } else if (catalogs.archiveRead === READ_FAILED) {
    livenessReason = `the archived Project Catalog could not be read${catalogs.archiveReason ? ': ' + catalogs.archiveReason : ''}`;
  }

  return {
    schema: OWNER_SCHEMA,
    operation: 'RawBatchOwnershipReport',
    status: 'ok',
    raw_present: rawPresent,
    record_path: OWNER_RECORD_RELATIVE,
    roots_total: roots.length,
    roots_unmapped: unmapped.length,
    records_total: mappings.length,
    catalog_active: catalogs === null ? READ_FAILED : catalogs.activeRead,
    catalog_archive: catalogs === null ? READ_FAILED : catalogs.archiveRead,
    catalogs_read: livenessReason === '',
    liveness_reason: livenessReason,
    roots,
    mappings,
    unmapped,
    stale_mappings: stale,
    dangling_mappings: dangling,
    eviction_candidates: evictable,
    archived_absent: archivedAbsent,
    eviction_determined: undetermined.length === 0,
  };
}

export function formatRawBatchOwnershipReport(report: OwnershipReport): string {
  const lines: string[] = [];

  if (!report.raw_present) {
    lines.push('This workspace has no raw/ directory, so there are no source batches to own.');
    if (report.records_total > 0) {
      lines.push(
        `${report.records_total} ownership record(s) are still declared; every one of them is stale until raw/ exists again.`,
      );
    }
    lines.push('');
    lines.push(EVICTION_RULE);
    return lines.join('\n');
  }

  lines.push(
    `Source batch ownership: ${report.roots_total} top-level batch(es) under raw/, ${report.records_total} declared mapping(s).`,
  );
  lines.push('A mapping covers its whole subtree, so a directory inside a mapped batch inherits that owner.');

  // The liveness sentence comes BEFORE any liveness value, so a reader meets the caveat before the
  // material it qualifies. Gated on whether the CATALOGS were read, not on whether the eviction
  // list came out complete.
  if (!report.catalogs_read) {
    lines.push(
      `LIVENESS WAS NOT DETERMINED: ${report.liveness_reason}. Every value below reading 'undetermined' is a question ` +
        'that was not answered, not a Project that is missing.',
    );
  }

  lines.push('');
  lines.push('Top-level batches:');
  for (const root of report.roots) {
    const mark = testProvenanceSuperseded(root.provenance) ? ` [${root.provenance}]` : '';
    const beneath = root.sub_mapped > 0 ? ` (${root.sub_mapped} sub-batch mapping(s) declared)` : '';
    if (root.mapped) lines.push(`  ${root.batch}${mark} -- ${root.project} [${root.liveness}]${beneath}`);
    else lines.push(`  ${root.batch}${mark} -- UNMAPPED${beneath}`);
  }

  if (report.roots_unmapped > 0) {
    lines.push('');
    lines.push(
      `${report.roots_unmapped} of ${report.roots_total} top-level batch(es) have no declared owner. That is reported, ` +
        'not guessed: raw/ does not follow the documented raw/<project-slug>/<source-batch>/ shape, so a name is not ' +
        'evidence of ownership. Declare one with -Action Set.',
    );
  }

  if (report.records_total > 0) {
    lines.push('');
    lines.push('Declared mappings:');
    for (const mapping of report.mappings) {
      const mark = testProvenanceSuperseded(mapping.provenance) ? ` [${mapping.provenance}]` : '';
      const gone = mapping.on_disk ? '' : ` -- NO DIRECTORY: ${mapping.miss_reason}`;
      lines.push(`  raw/${mapping.batch}${mark} -- ${mapping.project} [${mapping.liveness}]${gone}`);
    }
  }

  if (report.dangling_mappings.length > 0) {
    lines.push('');
    lines.push(
      `${report.dangling_mappings.length} mapping(s) name a Project that is in neither the active nor the archived ` +
        'Project Catalog. That is a record to correct or withdraw, not an eviction offer: an unlisted Project is one ' +
        'nothing knows about, where an archived one is a decision that was made.',
    );
  }

  lines.push('');
  if (report.records_total === 0) {
    lines.push(
      'No batch has a declared owner yet, so no eviction offer can be made. That is the absence of a mapping, not ' +
        'evidence that everything under raw/ is still wanted.',
    );
  } else if (!report.eviction_determined) {
    lines.push(
      'Eviction candidates could NOT be determined, because at least one mapped Project has an undetermined liveness. ' +
        'This is not a finding that there are none.',
    );
  } else if (report.eviction_candidates.length === 0 && report.archived_absent.length > 0) {
    lines.push(
      `Nothing is offered for eviction: ${report.archived_absent.length} mapping(s) name an archived Project, but no ` +
        'directory remains under raw/ to offer.',
    );
    for (const mapping of report.archived_absent) {
      lines.push(`  raw/${mapping.batch} -- ${mapping.project} is archived, and no directory raw/${mapping.batch} exists`);
    }
  } else if (report.eviction_candidates.length === 0) {
    lines.push('No batch is owned by an archived Project, so nothing is offered for eviction.');
  } else {
    lines.push(
      `Offered for eviction -- ${report.eviction_candidates.length} batch(es) whose owning Project is archived:`,
    );
    for (const candidate of report.eviction_candidates) {
      lines.push(`  raw/${candidate.batch} -- ${candidate.project} is archived`);
    }
  }

  lines.push('');
  lines.push(EVICTION_RULE);
  return lines.join('\n');
}

export interface RawOwnersResult {
  refusal: string | null;
  value: PsJsonValue | null;
}

export function runRawOwners(argv: string[], workspace: string): RawOwnersResult {
  parseArguments(argv, ['workspace', 'mcp-url', 'collection-id']);
  try {
    // Tier 0 has no backend, so the catalog set is null rather than empty: the join reports
    // `undetermined` for a missing set, and inventing an empty one would answer `unlisted` for
    // every slug -- a finding about the Projects, from a read that never happened.
    const catalogs: CatalogSet | null = null;
    const report = getRawBatchOwnershipReport(workspace, catalogs);
    const rendered = formatRawBatchOwnershipReport(report);
    return { refusal: null, value: { ...report, rendered } as unknown as PsJsonValue };
  } catch (error) {
    return { refusal: (error as Error).message, value: null };
  }
}
