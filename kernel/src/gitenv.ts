/**
 * A GIT CHILD SEES ONLY THE REPOSITORY IT IS POINTED AT (2026-09-30, the Report "Self-test section 89 writes into the
 * real repository when the gate runs in a worktree").
 *
 * Git exports GIT_DIR, GIT_INDEX_FILE and their kin to every hook. In a linked worktree GIT_DIR is ABSOLUTE
 * (`<repo>/.git/worktrees/<name>`), and `git -C <dir>` does not override it: `-C` changes the directory, while GIT_DIR
 * still names the repository. So a pre-commit gate that ran section 89's fixture `git init`, `add` and `commit` from
 * B's worktree re-initialised the REAL repository (writing `core.bare = true` into its shared config), filled its
 * index, and committed onto the checked-out branch. In the main checkout GIT_DIR is the relative `.git`, which `-C`
 * resolves inside the fixture, which is why seat A's commits never showed it.
 *
 * The cure is the one git's own documentation gives hooks: drop the repository-local variables before running git
 * against another repository. The list is `git rev-parse --local-env-vars` (git 2.54), plus the numbered pairs that
 * GIT_CONFIG_COUNT introduces. Everything else passes through, so a reader's GIT_SSH, GIT_ASKPASS or global config
 * still applies.
 */
const LOCAL_GIT_VARIABLES: readonly string[] = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
];

const NUMBERED_CONFIG = /^GIT_CONFIG_(KEY|VALUE)_\d+$/i;

/** True for a variable that would point a git child at a repository other than the one it was given. */
export function isRepositoryLocalGitVariable(name: string): boolean {
  const upper = name.toUpperCase();
  return LOCAL_GIT_VARIABLES.includes(upper) || NUMBERED_CONFIG.test(upper);
}

/**
 * The environment for a git child process: `base` (the current process's by default) without any repository-local
 * variable. Names are compared without case, because Windows environment names have none.
 */
export function repositoryNeutralEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && !isRepositoryLocalGitVariable(name)) env[name] = value;
  }
  return env;
}
