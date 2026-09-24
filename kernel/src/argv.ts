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
}

export function parseArguments(argv: string[], valued: string[]): ParsedArguments {
  const positional: string[] = [];
  const options = new Map<string, string>();
  const flags = new Set<string>();
  const wantsValue = new Set(valued);
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (item.startsWith('--')) {
      const name = item.substring(2);
      if (wantsValue.has(name)) {
        if (index + 1 >= argv.length) throw new Error(`${item} needs a value after it.`);
        options.set(name, argv[index + 1]!);
        index += 1;
      } else {
        flags.add(name);
      }
      continue;
    }
    positional.push(item);
  }
  return { positional, options, flags };
}
