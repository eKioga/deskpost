/**
 * One pass over a verb's arguments.
 *
 * IN ITS OWN FILE SO THE VERBS DO NOT IMPORT THE DISPATCHER. It began in `cli.ts`, and the first
 * verb that needed it imported `cli.ts` back -- a cycle whose symptom is a module half-initialised
 * at the moment the other half reads it, which is a much harder thing to diagnose than a missing
 * import.
 *
 * A `--name value` pair whose name is in `valued` takes the next argument; anything else beginning
 * with `--` is a flag; the rest is positional. WHICH NAMES TAKE A VALUE IS DECLARED RATHER THAN
 * GUESSED FROM WHETHER THE NEXT WORD STARTS WITH A DASH: a row passes `--plan-id
 * not-a-real-plan-id`, and a parser deciding by shape would be deciding a gate's argument by
 * whether somebody's plan id happened to look like a switch.
 *
 * WHAT A VERB TAKES IS DECLARED ONCE, as an `ArgumentTable` beside its usage in `verbs.ts` (PLAN-correct-and-find.md D7,
 * kickoffs/s106 row 1). The parser reads its value names from that table, and the front door checks a command line
 * against the same table before the verb runs (`checkArguments`): until 1.4.0 a flag a verb did not know was ignored,
 * so a typo ran the verb without it and said nothing.
 */

export interface ParsedArguments {
  positional: string[];
  options: Map<string, string>;
  flags: Set<string>;
  /** Every value of each REPEATABLE option, in order (`options` still holds its last). Empty for the rest. */
  lists: Map<string, string[]>;
}

/**
 * WHAT ONE VERB, OR ONE ACTION OF IT, TAKES. Names are written without their dashes.
 */
export interface ArgumentTable {
  /** Options that take the next word as their value. */
  valued?: string[];
  /** Options that take a value once per use, every use kept (`seat start --open-book`). */
  repeatable?: string[];
  /** Flags that take no value. */
  boolean?: string[];
  /**
   * Names the verb reads that its usage does not teach: plumbing between the program's own processes and the
   * self-test's hooks. Accepted like the rest, and never listed in a refusal.
   */
  internal?: string[];
  /** The most positional words the verb reads after its name and its action. */
  positionals: number;
  /** True when everything after a bare `--` belongs to another program (`seat start`'s agent arguments). */
  passthrough?: boolean;
  /**
   * True when the verb refuses an unknown flag and an extra word itself, in its own sentences, which the front door's
   * would only restate (`init`, `install`, `upgrade`). The front door then checks only the `--name=value` form.
   */
  ownRefusals?: boolean;
  /**
   * True when the verb refuses an extra word itself, in its own sentence (`hub edit` since S97, `book reader-map`,
   * `book sources`, `browse`): the front door then leaves the word count to it, and still checks every flag.
   */
  ownWords?: boolean;
  /** True for a retired action, which refuses by name before any table is consulted (`notebook own`). */
  retired?: boolean;
}

/**
 * A REPEATED OPTION KEEPS ITS LAST VALUE, unless the verb DECLARES it repeatable (S97 row 1: `seat start --open-book`
 * takes one Book per use). The declaration is the verb's table, so no other verb's option changes meaning.
 */
export function parseArguments(argv: string[], table: ArgumentTable): ParsedArguments {
  const positional: string[] = [];
  const options = new Map<string, string>();
  const flags = new Set<string>();
  const lists = new Map<string, string[]>();
  const repeatable = table.repeatable ?? [];
  const wantsValue = new Set([...(table.valued ?? []), ...repeatable]);
  const many = new Set(repeatable);
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (item.startsWith('--')) {
      const name = item.substring(2);
      if (wantsValue.has(name)) {
        if (index + 1 >= argv.length) throw new Error(`${item} needs a value after it.`);
        options.set(name, argv[index + 1]!);
        if (many.has(name)) lists.set(name, [...(lists.get(name) ?? []), argv[index + 1]!]);
        index += 1;
      } else {
        flags.add(name);
      }
      continue;
    }
    positional.push(item);
  }
  return { positional, options, flags, lists };
}

/** The flags a refusal names: the table's own, each valued one with its placeholder, internal names left out. */
export function takenFlags(table: ArgumentTable): string {
  const hidden = new Set(table.internal ?? []);
  const named = [
    ...(table.valued ?? []).filter((name) => !hidden.has(name)).map((name) => `--${name} <value>`),
    ...(table.repeatable ?? []).filter((name) => !hidden.has(name)).map((name) => `--${name} <value>...`),
    ...(table.boolean ?? []).filter((name) => !hidden.has(name)).map((name) => `--${name}`),
  ];
  return named.join(', ');
}

/**
 * THE FRONT DOOR'S CHECK, before the verb runs and before it writes anything: an unknown `--x`, the `--name=value`
 * form, and a positional word beyond the verb's arity are refused, naming the command and what it takes. `command` is
 * what a reader typed (`deskpost hub edit`); `argv` is what follows the action word.
 */
export function checkArguments(command: string, argv: string[], table: ArgumentTable): string | null {
  if (table.retired) return null;
  const wantsValue = new Set([...(table.valued ?? []), ...(table.repeatable ?? [])]);
  const known = new Set([...wantsValue, ...(table.boolean ?? [])]);
  let positionals = 0;
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (item === '--' && table.passthrough) break;
    if (item.startsWith('--') && item.length > 2) {
      const name = item.substring(2);
      const equals = name.indexOf('=');
      if (equals > 0) {
        // `--name=value` WAS A FLAG NAMED `name=value`, so the value never reached the verb (backlog D7).
        const bare = name.substring(0, equals);
        const value = name.substring(equals + 1);
        return `${command} takes \`--${bare} ${value}\`, not \`--${bare}=${value}\`: write \`--${bare} <value>\` as two words. Nothing was run.`;
      }
      if (table.ownRefusals) {
        if (wantsValue.has(name)) index += 1;
        continue;
      }
      if (!known.has(name)) return `${command} has no --${name}. It takes: ${takenFlags(table) || 'no flags'}. Nothing was run.`;
      if (wantsValue.has(name)) index += 1;
      continue;
    }
    positionals += 1;
  }
  if (!table.ownRefusals && !table.ownWords && positionals > table.positionals) {
    const words = positionals - table.positionals;
    return (
      `${command} takes ${table.positionals === 0 ? 'no words' : table.positionals === 1 ? 'one word' : `${table.positionals} words`} ` +
      `after its name, and was given ${words} more: ${extraWords(argv, table).join(' ')}. Quote a value that holds spaces. Nothing was run.`
    );
  }
  return null;
}

/** The positional words beyond the table's arity, in order, for the refusal. */
function extraWords(argv: string[], table: ArgumentTable): string[] {
  const wantsValue = new Set([...(table.valued ?? []), ...(table.repeatable ?? [])]);
  const words: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (item === '--' && table.passthrough) break;
    if (item.startsWith('--') && item.length > 2) {
      if (wantsValue.has(item.substring(2))) index += 1;
      continue;
    }
    words.push(item);
  }
  return words.slice(table.positionals);
}

/**
 * AN UNMATCHED QUOTE IN A TITLE, A SUMMARY OR A PURPOSE WARNS (backlog D7): Windows PowerShell 5.1 strips or splits
 * quotes on the way to a native program, so an odd `"` inside the value is the trace of a line that did not arrive as
 * typed. A warning, never a refusal: the value may be meant.
 */
export const QUOTE_CHECKED = ['title', 'summary', 'purpose'];

export function quoteWarnings(command: string, argv: string[], table: ArgumentTable): string[] {
  const valued = new Set([...(table.valued ?? []), ...(table.repeatable ?? [])]);
  const warnings: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (item === '--' && table.passthrough) break;
    if (!item.startsWith('--') || !valued.has(item.substring(2))) continue;
    const name = item.substring(2);
    const value = argv[index + 1] ?? '';
    index += 1;
    if (QUOTE_CHECKED.includes(name) && (value.match(/"/g) ?? []).length % 2 === 1) {
      warnings.push(`${command}: --${name} holds an unmatched quote (${JSON.stringify(value)}); check that the value arrived as you typed it.`);
    }
  }
  return warnings;
}
