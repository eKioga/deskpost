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
 */

export interface ParsedArguments {
  positional: string[];
  options: Map<string, string>;
  flags: Set<string>;
  /** Every value of each REPEATABLE option, in order (`options` still holds its last). Empty for the rest. */
  lists: Map<string, string[]>;
}

/**
 * A REPEATED OPTION KEEPS ITS LAST VALUE, unless the verb DECLARES it repeatable (S97 row 1: `seat start --open-book`
 * takes one Book per use). The declaration is per call, so no other verb's option changes meaning.
 */
export function parseArguments(argv: string[], valued: string[], repeatable: string[] = []): ParsedArguments {
  const positional: string[] = [];
  const options = new Map<string, string>();
  const flags = new Set<string>();
  const lists = new Map<string, string[]>();
  const wantsValue = new Set([...valued, ...repeatable]);
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
