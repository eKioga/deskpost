/**
 * AN INLINE VALUE THE WINDOWS SHIM MAY HAVE CUT SHORT (S66 for `capture`, S70 row 2 for every other long-text
 * option). `deskpost.cmd` runs through cmd.exe, which ends the whole command line at the first line break: a
 * 33-line value arrives as its first line, anything after it on the line is never passed, and the writer says
 * `written: true`. S68 lost two handback sections to `hub edit --content` this way.
 *
 * Nothing on this side of the shim can see what was dropped, so this cannot refuse. What it can see is the only
 * shape a cut leaves: an inline value that is the LAST argument and holds no line break. A value followed by
 * anything else, or holding a newline, was not cut, and says nothing; a file option never goes through the
 * command line at all. The warning goes in the verb's result, and names the verb's file route.
 */
export function inlineCutWarning(
  argv: string[],
  option: string,
  value: string | undefined,
  remedy: string,
  platform: string = process.platform,
): string | null {
  if (platform !== 'win32' || value === undefined || value === '' || /[\r\n]/.test(value)) return null;
  if (argv.length < 2 || argv[argv.length - 2] !== `--${option}` || argv[argv.length - 1] !== value) return null;
  return (
    `On Windows the deskpost shim ends the command line at the first line break, so an inline --${option} keeps only ` +
    `its first line and nothing after it arrives. If this value had more lines, they were not saved: ${remedy}`
  );
}

/** A verb's result with `inline_warning` added when its last argument is an inline `--<option>` the shim may have cut. */
export function withInlineCutWarning<T extends Record<string, unknown>>(result: T, argv: string[], option: string, remedy: string): T {
  const warning = inlineCutWarning(argv, option, argv[argv.length - 1], remedy);
  return warning === null ? result : { ...result, inline_warning: warning };
}
