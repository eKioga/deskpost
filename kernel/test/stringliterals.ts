import ts from 'typescript';

/** Real string and template parts, including strings inside interpolations; never comments or regular expressions. */
export function stringLiterals(source: string): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ||
        node.kind === ts.SyntaxKind.TemplateHead || node.kind === ts.SyntaxKind.TemplateMiddle || node.kind === ts.SyntaxKind.TemplateTail) {
      found.push((node as ts.StringLiteralLike).text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
  return found;
}
