/**
 * The `library basic-memory` actions beyond set-up and disconnect, each in the file that owns its subject
 * (PLAN-basic-memory.md steps 3 to 5). Named here, once, so the dispatch and `verbs.ts`'s action list are
 * checked against the same set by kernel self-test section 42.
 */

import type { PsJsonValue } from './psjson.ts';
import { basicMemoryStatus } from './bmstatus.ts';
import { basicMemoryImport } from './bmimport.ts';
import { basicMemoryOpen, basicMemoryRollbackCheck } from './bmopen.ts';

export const BASIC_MEMORY_ACTIONS: Record<string, (argv: string[], workspace: string) => Promise<Record<string, PsJsonValue>>> = {
  import: basicMemoryImport,
  open: basicMemoryOpen,
  'rollback-check': basicMemoryRollbackCheck,
  status: basicMemoryStatus,
};
