/**
 * WHAT A LANE FILE'S SECTIONS GET FROM THE SUITE (PLAN-lane-test-files.md, Design 2; kickoffs/s210 row 1). Each lane's new
 * self-test sections live in `kernel/test/lanes/<lane>.ts`; `kernel/test/selftest.ts` builds one `Harness` from its own
 * helpers and state, after all of its initialization, and awaits each lane's `runLane(harness)` after its last own
 * section and before its one verdict. A check made through `check`, `equal` or `same` counts in the suite's own tally,
 * and a line pushed to `failures` is one of the suite's failures, exactly as in `selftest.ts`. Types only: this module
 * runs nothing.
 */
export interface Harness {
  /** The section runs in this selection (LIBRARY_SELFTEST_SECTIONS; every section when it is empty). */
  selected(section: number): boolean;
  /** A declared skip: false (and one `SKIP section N:` line) when the condition does not hold. */
  prerequisite(section: number, condition: () => unknown, reason: string): boolean;
  check(condition: boolean, label: string): void;
  equal(actual: unknown, expected: unknown, label: string): void;
  /** `equal` over JSON text. */
  same(actual: unknown, expected: unknown, label: string): void;
  /** The suite's own failure list: a section that stops early pushes its reason here. */
  failures: string[];
  /** The kernel under test as a child process, as `selftest.ts` runs it. */
  runCli(args: string[], options?: { cwd?: string; env?: Record<string, string>; input?: string }): { exit: number; stdout: string; stderr: string };
  runCliAsync(args: string[], options?: { cwd?: string; env?: Record<string, string> }): Promise<{ exit: number; stdout: string; stderr: string }>;
  /** `kernel/test`, the folder `selftest.ts` runs from. */
  HERE: string;
  /** The source tree sections read (LIBRARY_SELFTEST_PROGRAM_ROOT for a compiled suite). */
  PROGRAM_ROOT: string;
  /** LIBRARY_SELFTEST_KERNEL split into its words; empty for this checkout's own CLI. */
  KERNEL_COMMAND: readonly string[];
  /** This suite is a compiled binary (a section that needs the source tree declares `!isCompiled()`). */
  isCompiled(): boolean;
}
