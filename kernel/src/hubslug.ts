/**
 * A Project slug as a reader writes one (PLAN-one-step-upgrade.md small fix 2). The Desk and a Hub's own links say
 * `projects/<slug>`, which the reader has taken since S85; every Hub writer refused it as malformed, naming a
 * PowerShell parameter (`ProjectSlug`) the reader never typed. A leaf module, so the writers reach it without
 * importing the reader (which imports `collection.ts` back).
 */

const PROJECT_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The `projects/` prefix dropped; anything else is returned as given, for the caller's own check. */
export function projectSlugArgument(slug: string): string {
  return slug.startsWith('projects/') ? slug.substring('projects/'.length) : slug;
}

/** The bare slug, or the refusal a Hub writer gives for it in its own refusal type. */
export function hubSlug(raw: string): { slug: string; problem: string | null } {
  const slug = projectSlugArgument(raw.trim());
  if (!slug) return { slug, problem: "<slug> is required: the Project Hub's slug, such as work or projects/work." };
  if (!PROJECT_SLUG.test(slug)) {
    return { slug, problem: `<slug> '${raw}' is not a Project slug: lowercase letters, digits and single hyphens, alone or as projects/<slug>.` };
  }
  return { slug, problem: null };
}
