/**
 * THE `library-help` SKILL IN THE LIBRARY, OWNED FILE BY FILE (PLAN-assistant-onboarding.md step 7).
 *
 * Measured in S57: every Library's instructions end by pointing the Librarian at the `library-help` Skill, and only
 * the opt-in plugin carried it, so a Library made by the installer sent its Librarian to a Skill it did not have. init
 * copies released skills into `.claude/skills/` and `.agents/skills/` with identical ownership rules.
 *
 * A COPY IN SOMEONE'S FOLDER IS OWNED ONLY AS FAR AS IT CAN BE PROVEN (Codex #10). The folder carries
 * `.deskpost-managed.json`: each file, with the SHA-256 of every version Deskpost has written there. A file is
 * Deskpost's only while it is listed AND still holds one of those hashes, so:
 *   - an absent file is created;
 *   - a file holding a hash Deskpost wrote is replaced with this program's version;
 *   - a file changed since, or one the manifest does not list, is left as it is and named;
 *   - a `library-help` folder with no manifest is one the reader made: it is left whole and named, and the Skill is not
 *     installed there (flaw F: it never refuses the rest of the setup);
 *   - a folder that is a reparse point would carry writes somewhere the plan did not preview, so it refuses.
 * Uninstall leaves the Skill and its manifest (ADR-0058: inside a Library, entries are removed, never files).
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const SKILL_RELATIVE = '.claude/skills/library-help';
export const SKILL_MANIFEST = '.deskpost-managed.json';
/** Released workspace skills only; prototypes enter this inventory when their command ships. */
export const SHIPPED_SKILLS = ['library-help'] as const;
export const SKILL_LOCATIONS = ['.claude/skills', '.agents/skills'] as const;

export interface SkillFilePlan {
  path: string;
  name: string;
  action: 'created' | 'updated' | 'unchanged' | 'left';
  content: string | null;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Whether this folder itself is a link. Judged against its parent's physical path, not its own textual one, so a Library
 * that sits below a junction or a mapped drive is not mistaken for a link at every level.
 */
function isReparsePoint(target: string): boolean {
  try {
    // lstat FIRST: a dangling link does not exist to existsSync, and must still refuse here rather than fail mid-apply.
    if (fs.lstatSync(target).isSymbolicLink()) return true;
    if (!fs.existsSync(target)) return false;
    const expected = path.join(fs.realpathSync.native(path.dirname(target)), path.basename(target));
    return fs.realpathSync.native(target).toLowerCase() !== expected.toLowerCase();
  } catch {
    return false;
  }
}

/** Every file of the program's copy of the Skill, relative and forward-slashed, sorted. */
function programSkillFiles(programRoot: string, skill: string): string[] {
  const root = path.join(programRoot, '.claude', 'skills', skill);
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (folder: string) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name !== SKILL_MANIFEST) out.push(path.relative(root, full).replace(/\\/g, '/'));
    }
  };
  walk(root);
  return out.sort();
}

interface Manifest {
  schema: 1;
  files: Record<string, string[]>;
}

function readManifest(file: string): Manifest | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as Partial<Manifest>;
    if (parsed.schema !== 1 || parsed.files === null || typeof parsed.files !== 'object' || Array.isArray(parsed.files)) return null;
    for (const [name, hashes] of Object.entries(parsed.files)) {
      if (!name || name.includes('\\') || name.split('/').some((part) => !part || part === '.' || part === '..') || path.isAbsolute(name) ||
          !Array.isArray(hashes) || !hashes.every((hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))) return null;
    }
    return { schema: 1, files: parsed.files as Record<string, string[]> };
  } catch {
    return null;
  }
}

/**
 * One destination's planned writes. Missing shipped content and unsafe destinations refuse before init writes.
 */
function oneSkillPlans(workspace: string, programRoot: string, skill: string, location: string): { plans: SkillFilePlan[]; left: string[]; refusal: string | null } {
  const relativeRoot = `${location}/${skill}`;
  const files = programSkillFiles(programRoot, skill);
  if (!files.includes('SKILL.md')) return { plans: [], left: [], refusal: `shipped Skill ${skill} has no SKILL.md in ${programRoot}; nothing has been written.` };
  const target = path.join(workspace, ...relativeRoot.split('/'));
  // EVERY FOLDER A WRITE PASSES THROUGH (S58 post-build inspection #5): a link below library-help, such as a
  // `references` junction, carries writes out of the Library as surely as a link at the top, so each is checked.
  const folders = new Set<string>();
  for (const relative of files) {
    const parts = [...relativeRoot.split('/'), ...relative.split('/').slice(0, -1)];
    // Check the harness root too: .agents could redirect every Codex skill write.
    for (let depth = 1; depth <= parts.length; depth++) folders.add(path.join(workspace, ...parts.slice(0, depth)));
  }
  const fileSlots = [...files, SKILL_MANIFEST].map((relative) => path.join(target, ...relative.split('/')));
  // Links in file slots (including the manifest) must not be read or written through either.
  const destinations = [...folders, ...fileSlots];
  for (const folder of destinations.sort()) {
    if (isReparsePoint(folder)) {
      return { plans: [], left: [], refusal: `${folder} is a link to another folder or file, so the ${skill} Skill would be written somewhere this plan does not show. Replace it with a real folder or file, or remove it; nothing has been written.` };
    }
    if (fs.existsSync(folder) && (folders.has(folder) ? !fs.statSync(folder).isDirectory() : !fs.statSync(folder).isFile())) {
      return { plans: [], left: [], refusal: `${folder} is not a ${folders.has(folder) ? 'directory' : 'regular file'} where the ${skill} Skill needs one; nothing has been written.` };
    }
  }
  const manifestPath = path.join(target, SKILL_MANIFEST);
  const manifest = fs.existsSync(manifestPath) ? readManifest(manifestPath) : null;
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0 && manifest === null) {
    return { plans: [], left: [`${relativeRoot}/ (a ${skill} Skill Deskpost did not write; left as it is, and Deskpost's is not installed there)`], refusal: null };
  }
  const known: Record<string, string[]> = manifest?.files ?? {};
  const plans: SkillFilePlan[] = [];
  const left: string[] = [];
  const next: Record<string, string[]> = {};
  for (const relative of files) {
    const content = fs.readFileSync(path.join(programRoot, '.claude', 'skills', skill, ...relative.split('/')), 'utf8');
    const newSha = sha256(content);
    const shipped = new Set([...(known[relative] ?? []), newSha]);
    next[relative] = [...shipped].sort();
    const file = path.join(target, ...relative.split('/'));
    const name = `${relativeRoot}/${relative}`;
    if (!fs.existsSync(file)) {
      plans.push({ path: file, name, action: 'created', content });
      continue;
    }
    const current = sha256(fs.readFileSync(file, 'utf8'));
    if (current === newSha) plans.push({ path: file, name, action: 'unchanged', content: null });
    else if ((known[relative] ?? []).includes(current)) plans.push({ path: file, name, action: 'updated', content });
    else {
      left.push(`${name} (changed since Deskpost wrote it, or not Deskpost's; left as it is)`);
      // A FILE LEFT AS IT IS KEEPS ITS OWN HASH OUT OF THE MANIFEST: it is not Deskpost's to replace next time either.
      next[relative] = [...(known[relative] ?? [])].sort();
    }
  }
  for (const relative of Object.keys(known)) if (!(relative in next)) {
    next[relative] = [...known[relative]!].sort();
    left.push(`${relativeRoot}/${relative} (retired file; retained with its ownership record)`);
  }
  const manifestText = JSON.stringify({ schema: 1, files: next }, null, 2) + '\n';
  const oldManifest = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, 'utf8') : null;
  plans.push({ path: manifestPath, name: `${relativeRoot}/${SKILL_MANIFEST}`, action: oldManifest === null ? 'created' : oldManifest === manifestText ? 'unchanged' : 'updated', content: manifestText });
  return { plans, left, refusal: null };
}

/** Same canonical content and ownership rules in both harnesses; plan all copies before any write. */
export function skillPlans(workspace: string, programRoot: string): { plans: SkillFilePlan[]; left: string[]; refusal: string | null } {
  const plans: SkillFilePlan[] = [];
  const left: string[] = [];
  for (const location of SKILL_LOCATIONS) {
    for (const skill of SHIPPED_SKILLS) {
      const result = oneSkillPlans(workspace, programRoot, skill, location);
      if (result.refusal) return { plans: [], left: [], refusal: result.refusal };
      plans.push(...result.plans);
      left.push(...result.left);
    }
    left.push(...retiredSkills(workspace, location));
  }
  return { plans, left, refusal: null };
}

function retiredSkills(workspace: string, location: string): string[] {
  const root = path.join(workspace, ...location.split('/'));
  if (!fs.existsSync(root) || isReparsePoint(root) || isReparsePoint(path.dirname(root))) return [];
  const retired: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || SHIPPED_SKILLS.some((skill) => skill === entry.name)) continue;
    const folder = path.join(root, entry.name);
    const manifest = path.join(folder, SKILL_MANIFEST);
    if (!isReparsePoint(folder) && !isReparsePoint(manifest) && readManifest(manifest)) {
      retired.push(`${location}/${entry.name}/ (retired Skill; retained with its ownership record)`);
    }
  }
  return retired;
}

/** Structural installation check only: no claim about live harness discovery. */
export function skillInstallationStatus(workspace: string, programRoot: string, location: string): string {
  const problems: string[] = [];
  let safeToEnumerate = true;
  for (const skill of SHIPPED_SKILLS) {
    const result = oneSkillPlans(workspace, programRoot, skill, location);
    if (result.refusal) {
      problems.push(result.refusal);
      safeToEnumerate = false;
    }
    else {
      problems.push(...result.left);
      problems.push(...result.plans.filter((plan) => plan.action !== 'unchanged').map((plan) => `${plan.name} needs ${plan.action === 'created' ? 'installation' : 'refresh'}`));
    }
  }
  if (safeToEnumerate) problems.push(...retiredSkills(workspace, location));
  return problems.length ? `WARN: ${problems.join('; ').replace(/[.]+$/, '')}. Run deskpost init after resolving links or user collisions; reader edits are preserved.` : `${SHIPPED_SKILLS.join(', ')} installed in ${location}; structural check only, live discovery not tested`;
}
