/* Empty array literals that are about to receive elements.
 *
 * These construct through scr_arr_new_small / scr_arr_new_ops_small, which
 * keep the first slots in the array's own block. Reserving slots for every
 * empty literal would grow the arrays that stay empty (`cond ? xs : []`,
 * `?? []`, an empty flatMap result), so reserve only where the literal
 * initializes storage that the module appends to: a local or global binding that is a push/unshift/splice
 * receiver or an indexed-write target, or a class or record field that is
 * one directly or through a binding read from it. The choice never changes
 * behavior. */

import type { IrExpr, IrModule, IrStmt } from "../../ir/ir.js";
import { everyStmtList } from "../../ir/traverse.js";

const APPENDING_METHODS: ReadonlySet<string> = new Set([
  "push",
  "pushSpread",
  "unshift",
  "unshiftSpread",
  "splice",
  "spliceInsert",
]);

function isEmptyLiteral(e: IrExpr): boolean {
  return (
    e.kind === "arrayLit" &&
    e.elems.length === 0 &&
    e.capacity === undefined &&
    e.type.kind === "array"
  );
}

export function findAppendedArrayLiterals(module: IrModule): ReadonlySet<IrExpr> {
  // Bindings are function-scoped by id; module globals are shared.
  const localsOf = new Map<string, ReadonlySet<string>>();
  for (const fn of module.functions) {
    localsOf.set(
      fn.name,
      new Set([...fn.locals.map((local) => local.id), ...fn.params.map((p) => p.localId)]),
    );
  }
  const bindingKey = (fn: string, localId: string): string =>
    localsOf.get(fn)?.has(localId) ? `${fn}\0${localId}` : localId;
  const fieldKey = (owner: string, field: string): string => `${owner}.${field}`;

  const fieldOf = (e: IrExpr | null): string | null =>
    e?.kind === "fieldGet"
      ? fieldKey(e.className, e.field)
      : e?.kind === "recordGet"
        ? fieldKey(e.shapeId, e.field)
        : null;
  const appendedBindings = new Set<string>();
  const appendedFields = new Set<string>();
  // Bindings that hold a field's array (`const d = this.d; d.push(x)`, and
  // the receiver temporaries the frontend introduces) append to the field.
  const fieldAliases = new Map<string, string[]>();
  const noteAlias = (fn: string, localId: string, value: IrExpr | null): void => {
    const field = fieldOf(value);
    if (field === null) return;
    const key = bindingKey(fn, localId);
    fieldAliases.set(key, [...(fieldAliases.get(key) ?? []), field]);
  };
  const noteTarget = (fn: string, target: IrExpr): void => {
    if (target.kind === "varRef") appendedBindings.add(bindingKey(fn, target.localId));
    const field = fieldOf(target);
    if (field !== null) appendedFields.add(field);
  };
  for (const fn of module.functions) {
    everyStmtList(fn.body, {
      expr: (e) => {
        if (e.kind === "arrIntrinsic" && APPENDING_METHODS.has(e.method))
          noteTarget(fn.name, e.receiver);
        else if (e.kind === "assignExpr") noteAlias(fn.name, e.localId, e.value);
        return true;
      },
      stmt: (s) => {
        if (s.kind === "arraySet") noteTarget(fn.name, s.arr);
        else if (s.kind === "varDecl") noteAlias(fn.name, s.localId, s.init);
        else if (s.kind === "assign") noteAlias(fn.name, s.localId, s.value);
        return true;
      },
    });
  }
  for (const binding of appendedBindings)
    for (const field of fieldAliases.get(binding) ?? []) appendedFields.add(field);

  const result = new Set<IrExpr>();
  if (appendedBindings.size === 0 && appendedFields.size === 0) return result;
  const consider = (value: IrExpr | null, appended: boolean): void => {
    if (value && appended && isEmptyLiteral(value)) result.add(value);
  };
  for (const fn of module.functions) {
    const binding = (localId: string): boolean =>
      appendedBindings.has(bindingKey(fn.name, localId));
    everyStmtList(fn.body, {
      expr: (e) => {
        if (e.kind === "assignExpr") consider(e.value, binding(e.localId));
        return true;
      },
      stmt: (s: IrStmt) => {
        if (s.kind === "varDecl") consider(s.init, binding(s.localId));
        else if (s.kind === "assign") consider(s.value, binding(s.localId));
        else if (s.kind === "fieldSet")
          consider(s.value, appendedFields.has(fieldKey(s.className, s.field)));
        else if (s.kind === "recordSet")
          consider(s.value, appendedFields.has(fieldKey(s.shapeId, s.field)));
        return true;
      },
    });
  }
  return result;
}
