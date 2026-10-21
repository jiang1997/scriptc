/** The syntax answers minified-entry verification asks of a parsed
 * JavaScript file (npm-static-minified.ts keeps no AST dependency, so the
 * package.json transform stays parser-free). */
import * as ts from "./ts7/syntax.js";
import { moduleSpecifiersOfFile } from "./module-syntax.js";
import { cjsLexedExportsOfFile } from "./cjs-syntax.js";
import type { ModuleEdge, ModuleExportNames } from "./npm-static-minified.js";

/** Every specifier the file loads at run time, by edge kind. */
export function moduleEdgesOfFile(sf: ts.SourceFile): ModuleEdge[] {
  return moduleSpecifiersOfFile(sf).uses.map((use) => ({
    specifier: use.specifier,
    imported: use.static || use.dynamicImport,
    required: use.require,
  }));
}

/** ES module export declarations, or the Node-visible CommonJS names when
 * the file has no module syntax. */
export function moduleExportsOfFile(sf: ts.SourceFile): ModuleExportNames | null {
  if (!hasModuleSyntax(sf)) {
    const lexed = cjsLexedExportsOfFile(sf);
    return { esm: false, names: [...lexed.exports], reexports: lexed.reexports };
  }
  const names: string[] = [];
  const reexports: string[] = [];
  for (const stmt of sf.statements.nodes) {
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.isTypeOnly) continue;
      const clause = stmt.exportClause;
      if (clause === undefined) {
        const spec = stmt.moduleSpecifier;
        if (spec === undefined || !ts.isStringLiteral(spec)) return null;
        reexports.push(spec.text);
      } else if (ts.isNamedExports(clause)) {
        for (const element of clause.elements.nodes) {
          if (!element.isTypeOnly) names.push(element.name.text);
        }
      } else {
        names.push(clause.name.text);
      }
    } else if (ts.isExportAssignment(stmt)) {
      names.push("default");
    } else if (
      (ts.isFunctionDeclaration(stmt) ||
        ts.isClassDeclaration(stmt) ||
        ts.isVariableStatement(stmt)) &&
      stmt.modifiers?.nodes.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      if (stmt.modifiers.nodes.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) {
        names.push("default");
      } else if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations.nodes) {
          if (!ts.isIdentifier(decl.name)) return null;
          names.push(decl.name.text);
        }
      } else if (stmt.name !== undefined) {
        names.push(stmt.name.text);
      }
    }
  }
  return { esm: true, names, reexports };
}

function hasModuleSyntax(sf: ts.SourceFile): boolean {
  return sf.statements.nodes.some(
    (stmt) =>
      ts.isImportDeclaration(stmt) ||
      ts.isExportDeclaration(stmt) ||
      ts.isExportAssignment(stmt) ||
      ((ts.isFunctionDeclaration(stmt) ||
        ts.isClassDeclaration(stmt) ||
        ts.isVariableStatement(stmt)) &&
        stmt.modifiers?.nodes.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true),
  );
}
