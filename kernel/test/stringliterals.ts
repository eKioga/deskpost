import ts from 'typescript';

/** Whole strings and templates, including strings inside interpolations; never comments or regular expressions. */
export function stringLiterals(source: string): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTemplateExpression(node)) {
      found.push(node.head.text + node.templateSpans.map(span => '\uFFFC' + span.literal.text).join(''));
      for (const span of node.templateSpans) visit(span.expression);
      return;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) found.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
  return found;
}
