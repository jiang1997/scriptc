import { primitiveConstructorOr } from "./lower-exprs.js";
import { dynUndefinedExpr, helperLoc, nodeThrowExpr, varRef } from "../../ir/build.js";
import { constructedValue } from "./constructor-returns.js";
import { eventTargetApiMembers, eventTargetInheritedMember } from "./lower-event-target.js";
import {
  BOOL,
  DYN,
  F64,
  DYN_CLASS_PROPERTIES as PROPERTY_BAG,
  STRING,
  VOID,
  canConvertToDyn,
  canDynCheckTo,
  isClassOwnEnumerableFieldName,
  isDynTypedRefType,
  isUnitType,
  typeEquals,
  typeKey,
  type IrExpr,
  type IrFunction,
  type IrParam,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import { streamTypedRefEligible } from "../../ir/analysis.js";
import { everyStmtList, transformExpr, transformStmtList } from "../../ir/traverse.js";
import { PoisonError, type Lowerer } from "./lowerer.js";
import { erasedGenericInstance, implicitDefaultInstance } from "./generic-functions.js";
import { type ParamShape } from "./call-signatures.js";
import {
  accessorCall,
  classValueRef,
  findGenericMethodOn,
  findGenericStaticOn,
  findMethodOn,
  findStaticOn,
  genericOverrideBelow,
  upcastTo,
  type ClassInfo,
} from "./lower-classes.js";
import {
  classPrototypeData,
  hasClassPrototypeData,
  observedPrototypeMethod,
  reflectClassPrototype,
} from "./class-prototypes.js";
import { perEvaluationPrivateNames } from "./private-brands.js";
import {
  errorPropertyRead,
  errorPropertyWrite,
  errorToStringCall,
  errorToStringMethod,
  refreshErrorPropertyDispatch,
  refreshErrorMethodDispatch,
} from "./error-methods.js";
import { GeneratorDynamicDispatch } from "./generator-dynamic-dispatch.js";
import {
  classMethodValue,
  reflectedClassStaticMethodValue,
  refreshClassMethodValueSelections,
} from "./class-method-values.js";
import { classStaticData } from "./class-static-data.js";
import { isJsSourceFile } from "../program.js";
import * as ts from "../ts7/adapter.js";
import { SYMBOL_T, type IrLibFn } from "../../ir/ir.js";
import { isClassCallback } from "./class-callbacks.js";
import { CaughtValueDispatch } from "./caught-value-dispatch.js";
import { refreshDescriptorGuards } from "./class-descriptors.js";
import { ClassConstructionDispatch } from "./class-construction.js";
import { emitterRooted } from "./lower-event-emitter.js";
import { protocolArm, protocolFieldArm } from "./class-protocol-dispatch.js";
import { STREAM_OPERATORS } from "./lower-stream.js";
import { deletedPropertyNames, fixedFieldFamily } from "./js-class-fields.js";

const STREAM_METHODS = new Set([
  "on",
  "addListener",
  "once",
  "prependListener",
  "prependOnceListener",
  "off",
  "removeListener",
  "read",
  "pause",
  "resume",
  "isPaused",
  "destroy",
]);
const EMITTER_METHODS = new Set([
  "emit",
  "on",
  "addListener",
  "once",
  "prependListener",
  "prependOnceListener",
  "off",
  "removeListener",
]);
const STREAM_BOOL_PROPERTIES = new Set([
  "readable",
  "readableEnded",
  "writable",
  "writableEnded",
  "writableFinished",
  "writableNeedDrain",
  "destroyed",
  "closed",
  "readableObjectMode",
  "writableObjectMode",
  "allowHalfOpen",
]);
const STREAM_NUM_PROPERTIES = new Set([
  "readableLength",
  "readableHighWaterMark",
  "writableLength",
  "writableHighWaterMark",
  "writableCorked",
]);
const streamProperty = (name: string): boolean =>
  STREAM_BOOL_PROPERTIES.has(name) || STREAM_NUM_PROPERTIES.has(name);

function symbolMemberKey(
  lowerer: Lowerer,
  info: ClassInfo,
  name: string,
  loc: SrcLoc,
): IrExpr | null {
  if (name.startsWith("sym:"))
    return lowerer.coerceToExpected(
      {
        kind: "libCall",
        fn: "sym.wellKnown",
        args: [{ kind: "strLit", value: name.slice(4), type: STRING, loc }],
        type: SYMBOL_T,
        loc,
      },
      DYN,
    );
  if (info.symbolFields !== undefined) {
    for (const [symbol, member] of info.symbolFields) {
      if (member !== name) continue;
      const global = lowerer.globalsBySymbol.get(symbol);
      if (global) return lowerer.coerceToExpected(varRef(global.id, global.type, loc), DYN);
    }
  }
  if (info.symbolMethods !== undefined) {
    for (const [symbol, member] of info.symbolMethods) {
      if (member !== name) continue;
      const global = lowerer.globalsBySymbol.get(symbol);
      if (global) return lowerer.coerceToExpected(varRef(global.id, global.type, loc), DYN);
    }
  }
  return null;
}

type Invoke = Extract<IrExpr, { kind: "dynInvoke" }>;
interface Dispatch {
  source: Invoke;
  fn: IrFunction;
  callback: IrFunction;
  classes: Set<string>;
}

type ToPrimitiveHint = "default" | "number" | "string";
type ConversionMethod = "valueOf" | "toString" | "sym:toPrimitive";
const CONVERSION_CALL_PREFIX = "%conversionCall.";
type Hoisted = { stmts: IrStmt[]; value: IrExpr };
const TO_PRIMITIVE_PREFIX = "%dyn.class.toPrimitive.";

/** Operations that convert their dynamic operands with ToPrimitive: `+`
 * and `==` take the default hint, the arithmetic, bitwise, relational and
 * numeric conversions the number hint, and the string conversions the
 * string hint. */
const DEFAULT_HINT_CALLS = new Set<string>(["dyn.abstractEq", "dyn.add"]);
const NUMBER_HINT_CALLS = new Set<string>([
  "dyn.arithmetic",
  "dyn.bigintConstructor",
  "dyn.bitwise",
  "dyn.compare",
  "dyn.numberConstructor",
  "dyn.toNumberCoerce",
  "dyn.toNumeric",
]);
const STRING_HINT_CALLS = new Set<string>(["dyn.stringConstructor", "dyn.toStringCoerce"]);
/** Operations whose second operand is a property key, converted with the
 * string hint when the receiver admits a key: `in` needs an object,
 * propertyIsEnumerable converts before checking its receiver, and the
 * others need a receiver other than null and undefined. */
const KEY_CALLS = new Map<string, "object" | "any" | "value">([
  ["dyn.hasKeyComputed", "object"],
  ["dyn.propertyIsEnumerableComputed", "any"],
  ["dyn.hasOwnComputed", "value"],
  ["dyn.keyDeleteComputed", "value"],
  ["dyn.keySetComputed", "value"],
]);

function toPrimitiveHint(expr: IrExpr): ToPrimitiveHint | null {
  if (expr.kind === "toString") return expr.operand.type.kind === "dyn" ? "string" : null;
  if (expr.kind === "dynKeyGet") return expr.key.type.kind === "dyn" ? "string" : null;
  if (expr.kind !== "libCall") return null;
  if (DEFAULT_HINT_CALLS.has(expr.fn)) return "default";
  if (NUMBER_HINT_CALLS.has(expr.fn)) return "number";
  if (STRING_HINT_CALLS.has(expr.fn) || KEY_CALLS.has(expr.fn)) return "string";
  return null;
}

/** An operand that needs no conversion: already passed through a
 * conversion helper (loose equality converts conditionally), or boxed from
 * a statically primitive value. */
function isConversion(expr: IrExpr): boolean {
  if (expr.kind === "ternary") return isConversion(expr.then);
  if (expr.kind === "dynFrom") return PRIMITIVE_KINDS.has(expr.value.type.kind);
  return expr.kind === "call" && expr.callee.startsWith(TO_PRIMITIVE_PREFIX);
}

const PRIMITIVE_KINDS = new Set<string>([
  "f64",
  "string",
  "bool",
  "bigint",
  "symbol",
  "undefinedT",
  "nullT",
]);

/** A declared conversion method, own or inherited. */
function conversionMethod(lowerer: Lowerer, info: ClassInfo, method: ConversionMethod): boolean {
  if (info.fields.has(method)) return false;
  const found = findMethodOn(lowerer, info, method);
  return !!found && !found.declarer.builtinError;
}

function isPrimitive(value: IrExpr, loc: SrcLoc): IrExpr {
  return (["number", "string", "boolean", "undefined", "null", "bigint", "symbol"] as const)
    .map((test): IrExpr => ({ kind: "dynTest", test, value, type: BOOL, loc }))
    .reduce((a, b) => ({ kind: "logical", op: "||", left: a, right: b, type: BOOL, loc }));
}

interface PropertyReceiver {
  info: ClassInfo;
  capsule: ClassInfo;
  key: string;
}

interface PropertyDispatch {
  name: string;
  write: boolean;
  fn: IrFunction;
  classes: Set<string>;
  reflect?: boolean;
}

export function classInstanceOf(
  lowerer: Lowerer,
  value: IrExpr,
  info: ClassInfo,
  loc: SrcLoc,
  classValue?: IrExpr,
): IrExpr {
  const name = `%dyn.class.${classValue ? "valueInstanceof" : "instanceof"}:${info.def.name}`;
  const params = [
    { localId: "value", name: "value", type: DYN },
    ...(classValue ? [{ localId: "class", name: "class", type: classValue.type }] : []),
  ];
  if (!lowerer.liftedFns.some((fn) => fn.name === name)) {
    const candidate = varRef("candidate", DYN, loc);
    const prototype = classPrototypeData(
      lowerer,
      info,
      loc,
      classValue ? varRef("class", classValue.type, loc) : undefined,
    );
    const body: IrStmt[] = prototype
      ? [
          { kind: "varDecl", localId: "candidate", init: varRef("value", DYN, loc), loc },
          {
            kind: "while",
            cond: {
              kind: "ternary",
              cond: { kind: "dynTest", test: "nullish", value: candidate, type: BOOL, loc },
              then: { kind: "boolLit", value: false, type: BOOL, loc },
              else_: { kind: "dynTest", test: "object", value: candidate, type: BOOL, loc },
              type: BOOL,
              loc,
            },
            body: [
              {
                kind: "assign",
                localId: "candidate",
                value: {
                  kind: "libCall",
                  fn: "dyn.getPrototype",
                  args: [candidate],
                  type: DYN,
                  loc,
                  prototypeIdentityOnly: true,
                },
                loc,
              },
              {
                kind: "if",
                cond: { kind: "dynScalarEq", left: candidate, right: prototype, type: BOOL, loc },
                then: [
                  { kind: "return", value: { kind: "boolLit", value: true, type: BOOL, loc }, loc },
                ],
                else_: null,
                loc,
              },
            ],
            loc,
          },
        ]
      : [];
    body.push({ kind: "return", value: { kind: "boolLit", value: false, type: BOOL, loc }, loc });
    lowerer.liftedFns.push({
      name,
      params,
      returnType: BOOL,
      locals: [
        ...params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })),
        ...(prototype ? [{ id: "candidate", name: "candidate", type: DYN, mutable: true }] : []),
      ],
      body,
      loc,
    });
  }
  return {
    kind: "call",
    callee: name,
    args: [value, ...(classValue ? [classValue] : [])],
    type: BOOL,
    loc,
  };
}

const READ_PROPERTIES = "%dyn.class.readProperties";
const READ_PROPERTIES_OR_EMPTY = "%dyn.class.readPropertiesOrEmpty";

function isEmptyBag(value: IrExpr): boolean {
  return value.kind === "dynObjLit" && value.fields?.length === 0;
}

/** The property-bag dispatch's class branches without their lazy stores:
 * `if (bag === undefined) bag = init` becomes `return init` (not stored), or
 * nothing for an empty bag unless `orEmpty` asks for a fresh empty object. */
function readOnlyBagBody(body: IrStmt[], orEmpty = false): IrStmt[] {
  for (const branch of body) {
    if (branch.kind !== "if") continue;
    const absent = branch.then[0];
    const store = absent?.kind === "if" ? absent.then[0] : undefined;
    if (
      absent?.kind !== "if" ||
      absent.cond.kind !== "dynTest" ||
      absent.cond.test !== "undefined" ||
      absent.then.length !== 1 ||
      store?.kind !== "fieldSet" ||
      store.field !== PROPERTY_BAG
    )
      continue;
    if (isEmptyBag(store.value) && !orEmpty) branch.then.shift();
    else absent.then = [{ kind: "return", value: store.value, loc: store.loc }];
  }
  return body;
}

export function classPropertiesHelper(lowerer: Lowerer, loc: SrcLoc, readOnly = false): IrFunction {
  const name = readOnly ? READ_PROPERTIES : "%dyn.class.properties";
  const existing = lowerer.liftedFns.find((fn) => fn.name === name);
  if (existing) return existing;
  const helper: IrFunction = {
    name,
    params: [{ localId: "p.0", name: "value", type: DYN }],
    returnType: DYN,
    locals: [{ id: "p.0", name: "value", type: DYN, mutable: false }],
    body: [
      {
        kind: "return",
        value: readOnly
          ? {
              kind: "call",
              callee: classPropertiesHelper(lowerer, loc).name,
              args: [varRef("p.0", DYN, loc)],
              type: DYN,
              loc,
            }
          : varRef("p.0", DYN, loc),
        loc,
      },
    ],
    loc,
  };
  lowerer.liftedFns.push(helper);
  return helper;
}

/** A for-in presence recheck asks the live property table first, avoiding
 * value conversion or a dispatch branch for every possible member name.
 * Declared fields of a compiled class live in its native layout rather
 * than that table, so a miss rechecks the instance itself. */
export function classForInHasKey(
  lowerer: Lowerer,
  value: IrExpr,
  key: IrExpr,
  loc: SrcLoc,
): IrExpr {
  const name = "%dyn.class.forInHasKey";
  if (!lowerer.liftedFns.some((fn) => fn.name === name)) {
    // The read-only table: a recheck never creates an instance's table, which
    // is undefined while the instance has no own dynamic properties.
    const bagHas = "%dyn.class.forInBagHas";
    const bag = varRef("bag", DYN, loc);
    lowerer.liftedFns.push({
      name: bagHas,
      params: [
        { localId: "bag", name: "bag", type: DYN },
        { localId: "key", name: "key", type: STRING },
      ],
      returnType: BOOL,
      locals: [
        { id: "bag", name: "bag", type: DYN, mutable: false },
        { id: "key", name: "key", type: STRING, mutable: false },
      ],
      body: [
        {
          kind: "if",
          cond: { kind: "dynTest", test: "undefined", value: bag, type: BOOL, loc },
          then: [
            { kind: "return", value: { kind: "boolLit", value: false, type: BOOL, loc }, loc },
          ],
          else_: null,
          loc,
        },
        {
          kind: "return",
          value: {
            kind: "libCall",
            fn: "dyn.hasKey",
            args: [bag, varRef("key", STRING, loc)],
            type: BOOL,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
    lowerer.liftedFns.push({
      name,
      params: [
        { localId: "value", name: "value", type: DYN },
        { localId: "key", name: "key", type: STRING },
      ],
      returnType: BOOL,
      locals: [
        { id: "value", name: "value", type: DYN, mutable: false },
        { id: "key", name: "key", type: STRING, mutable: false },
      ],
      body: [
        {
          kind: "return",
          value: {
            kind: "logical",
            op: "||",
            left: {
              kind: "call",
              callee: bagHas,
              args: [
                {
                  kind: "call",
                  callee: classPropertiesHelper(lowerer, loc, true).name,
                  args: [varRef("value", DYN, loc)],
                  type: DYN,
                  loc,
                },
                varRef("key", STRING, loc),
              ],
              type: BOOL,
              loc,
            },
            right: {
              kind: "libCall",
              fn: "dyn.hasKey",
              args: [varRef("value", DYN, loc), varRef("key", STRING, loc)],
              type: BOOL,
              loc,
            },
            type: BOOL,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
  }
  return { kind: "call", callee: name, args: [value, key], type: BOOL, loc };
}

/** Record field creation after the dispatch worklist closes, including writes
 * in generated member tables. Native values stay in their slots; the bag
 * owns only their property presence, attributes, and insertion position. */
export function trackClassFieldCreation(lowerer: Lowerer, functions: IrFunction[]): void {
  if (![...lowerer.classes.values()].some((info) => info.def.tracksOwnFields)) return;
  const loc = functions[0]!.loc;
  const name = "%dyn.class.fieldCreated";
  const value = varRef("value", DYN, loc),
    key = varRef("key", DYN, loc);
  const bag = varRef("bag", DYN, loc);
  const created = (receiver: IrExpr, className: string, field: string, loc: SrcLoc): IrStmt => ({
    kind: "exprStmt",
    expr: {
      kind: "call",
      callee: name,
      args: [
        lowerer.coerceToExpected(receiver, DYN),
        symbolMemberKey(lowerer, lowerer.classes.get(className)!, field, loc) ??
          lowerer.coerceToExpected({ kind: "strLit", value: field, type: STRING, loc }, DYN),
      ],
      type: VOID,
      loc,
    },
    loc,
  });
  const tracked = (className: string, field: string): boolean =>
    !!lowerer.classes.get(className)?.def.tracksOwnFields &&
    (isClassOwnEnumerableFieldName(field) ||
      symbolMemberKey(lowerer, lowerer.classes.get(className)!, field, loc) !== null);
  for (const fn of functions) {
    // The transform revisits the replacement it returns. An instrumented
    // write is recognized by its receiver, a temporary created here.
    const receivers = new Set<string>();
    const instrumented = (obj: IrExpr): boolean =>
      obj.kind === "varRef" && receivers.has(obj.localId);
    const local = (type: IrType, loc: SrcLoc): Extract<IrExpr, { kind: "varRef" }> => {
      const id = `%fieldCreated.${fn.locals.length}`;
      fn.locals.push({ id, name: id, type, mutable: false });
      return { kind: "varRef", localId: id, type, loc };
    };
    fn.body = transformStmtList(fn.body, {
      stmt: (statement) => {
        if (
          statement.kind !== "fieldSet" ||
          instrumented(statement.obj) ||
          !tracked(statement.className, statement.field)
        )
          return statement;
        const receiver = local(statement.obj.type, statement.loc);
        receivers.add(receiver.localId);
        const store: Extract<IrStmt, { kind: "fieldSet" }> = { ...statement, obj: receiver };
        return {
          kind: "block",
          body: [
            { kind: "varDecl", localId: receiver.localId, init: statement.obj, loc: statement.loc },
            store,
            created(receiver, statement.className, statement.field, statement.loc),
          ],
          loc: statement.loc,
        };
      },
      expr: (expression) => {
        if (
          expression.kind !== "fieldIncDec" ||
          instrumented(expression.obj) ||
          !tracked(expression.className, expression.field)
        )
          return expression;
        const receiver = local(expression.obj.type, expression.loc),
          result = local(expression.type, expression.loc);
        receivers.add(receiver.localId);
        const update: Extract<IrExpr, { kind: "fieldIncDec" }> = { ...expression, obj: receiver };
        return {
          kind: "seqExpr",
          stmts: [
            {
              kind: "varDecl",
              localId: receiver.localId,
              init: expression.obj,
              loc: expression.loc,
            },
            { kind: "varDecl", localId: result.localId, init: update, loc: expression.loc },
            created(receiver, expression.className, expression.field, expression.loc),
          ],
          result,
          type: expression.type,
          loc: expression.loc,
        };
      },
    });
  }
  functions.push({
    name,
    params: [
      { localId: "value", name: "value", type: DYN },
      { localId: "key", name: "key", type: DYN },
    ],
    returnType: VOID,
    locals: [
      { id: "value", name: "value", type: DYN, mutable: false },
      { id: "key", name: "key", type: DYN, mutable: false },
      { id: "bag", name: "bag", type: DYN, mutable: false },
    ],
    body: [
      {
        kind: "varDecl",
        localId: "bag",
        init: {
          kind: "call",
          callee: classPropertiesHelper(lowerer, loc).name,
          args: [value],
          type: DYN,
          loc,
        },
        loc,
      },
      {
        kind: "if",
        cond: {
          kind: "unary",
          op: "!",
          operand: { kind: "libCall", fn: "dyn.hasOwnComputed", args: [bag, key], type: BOOL, loc },
          type: BOOL,
          loc,
        },
        then: [
          {
            kind: "exprStmt",
            expr: {
              kind: "libCall",
              fn: "dyn.defineProperty",
              args: [
                bag,
                lowerer.coerceToExpected(key, DYN),
                {
                  kind: "dynObjLit",
                  fields: [
                    {
                      key: { kind: "strLit", value: "value", type: STRING, loc },
                      value: dynUndefinedExpr(loc),
                    },
                    ...["writable", "enumerable", "configurable"].map((key) => ({
                      key: { kind: "strLit" as const, value: key, type: STRING, loc },
                      value: lowerer.coerceToExpected(
                        { kind: "boolLit", value: true, type: BOOL, loc },
                        DYN,
                      ),
                    })),
                  ],
                  type: DYN,
                  loc,
                },
              ],
              type: DYN,
              loc,
            },
            loc,
          },
        ],
        else_: null,
        loc,
      },
    ],
    loc,
  });
}

/** Calls on native class capsules keep the instance's compiled methods. The
 * reachable-body fixed point discovers both the boxed classes and method
 * names before generating checked native dispatch; ordinary dyn receivers
 * continue through their existing runtime implementation. */
export class ClassDynamicDispatch {
  constructor(private readonly asyncFree = false) {}

  private readonly generatorDispatch = new GeneratorDynamicDispatch();
  private readonly caughtDispatch = new CaughtValueDispatch();
  private readonly constructionDispatch = new ClassConstructionDispatch();
  /** Property names a delete can remove (null: any name), for the field
   * creation tracking decision. */
  private deletedNames: Set<string> | null | undefined;
  private readonly boxed = new Set<string>();
  private readonly boxedConstructors = new Set<string>();
  private readonly dispatches = new Map<string, Dispatch>();
  private readonly properties = new Map<string, PropertyDispatch>();
  private readonly computed = new Map<
    string,
    Omit<PropertyDispatch, "name"> & {
      keyLocal: string;
      branchIndex: number;
      dynamicKey: boolean;
      numericKey: boolean;
      probe: "in" | "own" | "enumerable" | undefined;
    }
  >();
  private readonly computedClassHelpers = new Map<string, IrFunction>();
  private normalization: IrFunction | null = null;
  private normalizationKey = "";
  private staticPropertyBag: IrFunction | null = null;
  private readonly staticBagClasses = new Set<string>();
  private propertyBag: IrFunction | null = null;
  private readonly errorStrings = new Map<string, IrFunction>();
  private readonly bagClasses = new Set<string>();
  private readonly bagInitializers = new Map<string, Extract<IrStmt, { kind: "fieldSet" }>[]>();
  private readonly typedPropertyBags = new Map<string, IrFunction>();
  /** Per-class prototype selection for new property bags (bagPrototypeHelper). */
  private readonly bagPrototypeHelpers = new Map<string, IrFunction>();
  private readonly readPropertyBags: {
    helper: IrFunction;
    initialize: Extract<IrStmt, { kind: "fieldSet" }>;
  }[] = [];
  private readonly generated = new Set<IrFunction>();
  /** Protocol dispatch helpers and callee reads whose receivers normalize. */
  private readonly protocols: IrFunction[] = [];
  private constructDispatch: IrFunction | null = null;
  private readonly constructors = new Map<string, ClassInfo>();
  private readonly constructed = new Set<string>();
  private readonly instanceTests = new Map<string, Set<string>>();
  private readonly jsonPrototypes = new Set<string>();
  private serializesClasses = false;
  private descriptorHelper: IrFunction | null = null;
  private prototypeHelper: IrFunction | null = null;
  private readonly prototypeClasses = new Set<string>();
  private prototypeIdentityHelper: IrFunction | null = null;
  private readonly prototypeIdentityClasses = new Set<string>();
  private readonly instancePrototypes = new Map<string, { fn: IrFunction; classes: Set<string> }>();
  private readonly checkedCasts = new Map<string, { fn: IrFunction; classes: Set<string> }>();
  /** The for-in key helpers, by libCall (dyn and native string[] keys). */
  private readonly enumerations = new Map<"dyn.forInKeys" | "dyn.forInKeyStrings", IrFunction>();
  private readonly enumerationClasses = new Set<string>();
  /** OrdinaryToPrimitive over boxed class instances, by hint, and the
   * per-class method calls its arms make. */
  private readonly toPrimitives = new Map<
    ToPrimitiveHint,
    { fn: IrFunction; classes: Set<string> }
  >();
  private readonly toPrimitiveCalls = new Map<string, IrFunction>();
  /** `value.valueOf()` and `value.toString()` on a dynamic receiver: a test
   * for boxed instances of classes declaring the method, and the call. */
  private readonly conversionCalls = new Map<
    "valueOf" | "toString",
    { test: IrFunction; call: IrFunction; classes: Set<string> }
  >();

  process(lowerer: Lowerer, functions: readonly IrFunction[]): boolean {
    // Dispatch tables grow between worklist waves. Keep their normalization
    // entry ahead of every newly inserted branch after rebuilding the tables.
    for (const fn of this.normalizedDispatches()) {
      const first = fn.body[0];
      if (
        first?.kind === "assign" &&
        first.value.kind === "call" &&
        first.value.callee === this.normalization?.name
      )
        fn.body.shift();
    }
    let changed = this.caughtDispatch.process(lowerer, functions);
    changed = refreshErrorMethodDispatch(lowerer, functions) || changed;
    changed = refreshClassMethodValueSelections(lowerer) || changed;
    changed = refreshErrorPropertyDispatch(lowerer, functions) || changed;
    changed = this.generatorDispatch.process(lowerer, functions, this.generated) || changed;
    changed = this.constructionDispatch.process(lowerer, functions) || changed;
    const seenTypes = new Set<string>();
    const rewrite = new Set<IrFunction>();
    const toPrimitiveSites = new Set<IrFunction>();
    const hasKeySites = new Set<IrFunction>();
    const discover = (type: IrType): void => {
      const key = typeKey(type);
      if (seenTypes.has(key)) return;
      seenTypes.add(key);
      if (type.kind === "object") {
        if (isDynTypedRefType(type)) this.boxed.add(type.className);
      } else if (type.kind === "classval") this.boxedConstructors.add(type.className);
      else if (type.kind === "array") discover(type.elem);
      else if (type.kind === "record") {
        const shape = lowerer.shapes.get(type.shapeId);
        shape?.fields.forEach((field) => discover(field.type));
        if (shape?.indexValue) discover(shape.indexValue);
      } else if (type.kind === "union") lowerer.unions.get(type.unionId)?.arms.forEach(discover);
      else if (type.kind === "func") discover(type.ret);
      else if (type.kind === "promise") discover(type.inner);
    };
    for (const fn of functions)
      everyStmtList(fn.body, {
        stmt: (statement) => {
          // Field-creation instrumentation can box a base-constructor receiver
          // even when only its derived instances otherwise cross the boundary.
          if (
            statement.kind === "fieldSet" &&
            lowerer.classes.get(statement.className)?.def.tracksOwnFields &&
            isClassOwnEnumerableFieldName(statement.field)
          )
            discover(statement.obj.type);
          return true;
        },
        expr: (expr) => {
          if (
            expr.kind === "jsonStringify" ||
            (expr.kind === "libCall" &&
              (expr.fn === "json.stringifyValue" || expr.fn === "json.stringifyReplacer"))
          ) {
            this.serializesClasses = true;
          }
          if (
            toPrimitiveHint(expr) !== null ||
            (expr.kind === "libCall" && (expr.fn === "dyn.valueOf" || expr.fn === "dyn.toString"))
          )
            toPrimitiveSites.add(fn);
          switch (expr.kind) {
            case "dynFrom":
              discover(expr.value.type);
              break;
            case "fieldIncDec":
              if (
                lowerer.classes.get(expr.className)?.def.tracksOwnFields &&
                isClassOwnEnumerableFieldName(expr.field)
              )
                discover(expr.obj.type);
              break;
            case "call":
              if (
                (expr.callee === "%dyn.class.properties" ||
                  expr.callee === "%dyn.class.readProperties") &&
                expr.args[0]?.kind === "dynFrom" &&
                isDynTypedRefType(expr.args[0].value.type)
              )
                rewrite.add(fn);
              break;
            case "dynHasKey":
              hasKeySites.add(fn);
              break;
            case "dynKeyGet":
            case "dynInvoke":
              rewrite.add(fn);
              break;
            case "dynCheck":
              if (isDynTypedRefType(expr.type)) rewrite.add(fn);
              // A dynamic function checked into a native function type
              // receives its arguments as dynamic values: class instances
              // passed to it cross the boundary when it is called (a JS
              // `list.map((rec) => rec.match(x))` callback with an untyped
              // parameter).
              if (expr.type.kind === "func") expr.type.params.forEach(discover);
              break;
            case "libCall":
              if (
                expr.fn === "bytes.construct" ||
                expr.fn === "dyn.keySet" ||
                expr.fn === "dyn.keySetComputed" ||
                expr.fn === "dyn.iterator" ||
                expr.fn === "dyn.arrayFromIterator" ||
                expr.fn === "dyn.toString" ||
                expr.fn === "dyn.stringConstructor" ||
                expr.fn === "dyn.forInKeys" ||
                expr.fn === "dyn.forInKeyStrings" ||
                expr.fn === "dyn.hasKeyComputed" ||
                expr.fn === "dyn.hasOwnComputed" ||
                expr.fn === "dyn.propertyIsEnumerableComputed" ||
                expr.fn === "dyn.defineProperty" ||
                expr.fn === "dyn.getPrototype" ||
                expr.fn === "dyn.reflectGet" ||
                expr.fn === "dyn.reflectSet"
              )
                rewrite.add(fn);
              break;
          }
          return true;
        },
      });
    if (this.boxed.size === 0 && rewrite.size === 0) return changed;
    const converting = this.convertingHints(lowerer);
    const calling = this.calledConversions(lowerer);
    if (converting.size || calling.size) for (const fn of toPrimitiveSites) rewrite.add(fn);
    const prototypeMembers = this.prototypeMemberNames(lowerer);
    if (prototypeMembers.size) for (const fn of hasKeySites) rewrite.add(fn);
    for (const fn of functions) {
      if (
        !fn.name.startsWith("%dyn.class.instanceof:") &&
        !fn.name.startsWith("%dyn.class.valueInstanceof:")
      )
        continue;
      const target = fn.name.slice(fn.name.indexOf(":") + 1);
      let checked = this.instanceTests.get(fn.name);
      if (!checked) {
        checked = new Set();
        this.instanceTests.set(fn.name, checked);
      }
      for (const className of this.boxed) {
        if (checked.has(className)) continue;
        checked.add(className);
        const subtype = className === target || lowerer.isSubclassOf(className, target);
        if (!subtype && !lowerer.isSubclassOf(target, className)) continue;
        const loc = fn.loc;
        const value = varRef("value", DYN, loc);
        const type: IrType = { kind: "object", className };
        const result: IrExpr =
          subtype && fn.params[1] && lowerer.classes.get(target)?.localClass
            ? {
                kind: "instanceOfValue",
                value: { kind: "dynCheck", value, type, loc },
                classValue: varRef("class", fn.params[1].type, loc),
                type: BOOL,
                loc,
              }
            : subtype
              ? { kind: "boolLit", value: true, type: BOOL, loc }
              : {
                  kind: "instanceOf",
                  value: { kind: "dynCheck", value, type, loc },
                  className: target,
                  type: BOOL,
                  loc,
                };
        fn.body.unshift({
          kind: "if",
          cond: {
            kind: "libCall",
            fn: "dyn.typedRefIs",
            args: [value, { kind: "strLit", value: typeKey(type), type: STRING, loc }],
            type: BOOL,
            loc,
          },
          then: [{ kind: "return", value: result, loc }],
          else_: null,
          loc,
        });
        changed = true;
      }
    }
    if (!this.propertyBag) {
      this.propertyBag = classPropertiesHelper(lowerer, functions[0]!.loc);
      this.generated.add(this.propertyBag);
      changed = true;
    }
    for (const className of this.boxed) {
      const info = lowerer.classes.get(className);
      if (!info || info.builtinEmitter || info.builtinStream || info.builtinError) continue;
      if (info.symbolFields && info.def.symbolFields === undefined) {
        info.def.symbolFields = [...info.symbolFields].flatMap(([symbol, field]) => {
          const global = lowerer.globalsBySymbol.get(symbol);
          return global?.type.kind === "symbol" ? [{ field, globalId: global.id }] : [];
        });
      }
      if (this.prototypeHelper && !this.prototypeClasses.has(className)) {
        this.prototypeClasses.add(className);
        const loc = this.prototypeHelper.loc;
        const type: IrType = { kind: "object", className };
        const value = varRef("value", DYN, loc);
        const prototype = reflectClassPrototype(lowerer, info, loc, {
          kind: "dynCheck",
          value,
          type,
          loc,
        });
        if (prototype)
          this.prototypeHelper.body.unshift({
            kind: "if",
            cond: {
              kind: "libCall",
              fn: "dyn.typedRefIs",
              args: [value, { kind: "strLit", value: typeKey(type), type: STRING, loc }],
              type: BOOL,
              loc,
            },
            then: [{ kind: "return", value: prototype, loc }],
            else_: null,
            loc,
          });
        changed = true;
      }
      if (this.prototypeIdentityHelper && !this.prototypeIdentityClasses.has(className)) {
        this.prototypeIdentityClasses.add(className);
        const loc = this.prototypeIdentityHelper.loc;
        const type: IrType = { kind: "object", className };
        const value = varRef("value", DYN, loc);
        const prototype = classPrototypeData(lowerer, info, loc, {
          kind: "dynCheck",
          value,
          type,
          loc,
        });
        if (prototype)
          this.prototypeIdentityHelper.body.unshift({
            kind: "if",
            cond: {
              kind: "libCall",
              fn: "dyn.typedRefIs",
              args: [value, { kind: "strLit", value: typeKey(type), type: STRING, loc }],
              type: BOOL,
              loc,
            },
            then: [{ kind: "return", value: prototype, loc }],
            else_: null,
            loc,
          });
        changed = true;
      }
      if (
        this.serializesClasses &&
        !this.jsonPrototypes.has(className) &&
        info.decl &&
        findMethodOn(lowerer, info, "toJSON")
      ) {
        this.jsonPrototypes.add(className);
        const loc = this.propertyBag.loc;
        const method = classMethodValue(lowerer, info.decl, info, "toJSON", loc);
        const prototype = method ? classPrototypeData(lowerer, info, loc) : null;
        const helper = lowerer.liftedFns.find((fn) => fn.name === info.def.prototypeDataHelper);
        const init = helper?.body[0];
        if (
          !info.prototypeReflectionReady &&
          method &&
          prototype &&
          init?.kind === "if" &&
          canConvertToDyn(
            method.type,
            (id) => lowerer.shapes.get(id),
            (id) => lowerer.unions.get(id),
          )
        ) {
          const descriptor: IrStmt = {
            kind: "exprStmt",
            expr: {
              kind: "libCall",
              fn: "dyn.defineProperty",
              args: [
                prototype,
                {
                  kind: "dynFrom",
                  value: { kind: "strLit", value: "toJSON", type: STRING, loc },
                  type: DYN,
                  loc,
                },
                {
                  kind: "dynObjLit",
                  fields: [
                    {
                      key: { kind: "strLit", value: "value", type: STRING, loc },
                      value: { kind: "dynFrom", value: method, type: DYN, loc },
                    },
                    ...["writable", "configurable"].map((key): { key: IrExpr; value: IrExpr } => ({
                      key: { kind: "strLit", value: key, type: STRING, loc },
                      value: {
                        kind: "dynFrom",
                        value: { kind: "boolLit", value: true, type: BOOL, loc },
                        type: DYN,
                        loc,
                      },
                    })),
                  ],
                  type: DYN,
                  loc,
                },
              ],
              type: DYN,
              loc,
            },
            loc,
          };
          init.then.push(descriptor);
          changed = true;
        }
      }
    }
    for (const plan of this.propertyReceivers(lowerer, false, false)) {
      const info = plan.info;
      const className = info.def.name;
      let instancePrototype = this.instancePrototypes.get(plan.capsule.def.name);
      if (!instancePrototype && hasClassPrototypeData(info)) {
        const name = `%class.instancePrototype:${plan.capsule.def.name}`;
        const type: IrType = { kind: "object", className: plan.capsule.def.name };
        const loc = this.propertyBag.loc;
        const fn: IrFunction = {
          name,
          params: [{ localId: "this", name: "this", type }],
          locals: [{ id: "this", name: "this", type, mutable: false }],
          returnType: DYN,
          body: [
            {
              kind: "return",
              value: {
                kind: "libCall",
                fn: "dyn.getPrototype",
                args: [{ kind: "dynObjLit", fields: [], type: DYN, loc }],
                type: DYN,
                loc,
              },
              loc,
            },
          ],
          loc,
        };
        plan.capsule.def.instancePrototypeHelper = name;
        instancePrototype = { fn, classes: new Set() };
        this.instancePrototypes.set(plan.capsule.def.name, instancePrototype);
        this.generated.add(fn);
        lowerer.liftedFns.push(fn);
      }
      if (
        instancePrototype &&
        hasClassPrototypeData(info) &&
        !instancePrototype.classes.has(className)
      ) {
        instancePrototype.classes.add(className);
        const loc = instancePrototype.fn.loc;
        const receiver = varRef("this", instancePrototype.fn.params[0]!.type, loc);
        const prototype = classPrototypeData(
          lowerer,
          info,
          loc,
          info === plan.capsule
            ? receiver
            : { kind: "downcast", value: receiver, type: { kind: "object", className }, loc },
        );
        const returned: IrStmt = {
          kind: "return",
          value: prototype ?? {
            kind: "libCall",
            fn: "dyn.getPrototype",
            args: [{ kind: "dynObjLit", fields: [], type: DYN, loc }],
            type: DYN,
            loc,
          },
          loc,
        };
        if (info === plan.capsule)
          instancePrototype.fn.body[instancePrototype.fn.body.length - 1] = returned;
        else
          instancePrototype.fn.body.unshift({
            kind: "if",
            cond: { kind: "instanceOf", value: receiver, className, type: BOOL, loc },
            then: [returned],
            else_: null,
            loc,
          });
        changed = true;
      }
      const needsPrototype = (current: ClassInfo): boolean =>
        hasClassPrototypeData(current) ||
        current.subclasses.some(
          (child) => lowerer.classCanBeConstructed(child) && needsPrototype(child),
        );
      const prototypeFor = (current: ClassInfo, receiver: IrExpr, loc: SrcLoc): IrExpr | null =>
        this.bagPrototype(lowerer, current, receiver, loc);
      for (const existingInit of this.bagInitializers.get(className) ?? []) {
        if (existingInit.value.kind === "dynObjLit" && needsPrototype(info)) {
          const prototype = prototypeFor(info, existingInit.obj, existingInit.loc);
          if (prototype) {
            existingInit.value = {
              kind: "libCall",
              fn: "dyn.objCreate",
              args: [prototype],
              type: DYN,
              loc: existingInit.loc,
            };
            changed = true;
          }
        }
      }
      if (this.bagClasses.has(plan.key)) continue;
      this.bagClasses.add(plan.key);
      this.ensurePropertyBag(info);
      if (info.decl && isJsSourceFile(ts.getSourceFileOfNode(info.decl))) {
        let root = info;
        while (root.base && !root.base.def.runtime) root = root.base;
        const track = (current: ClassInfo): void => {
          current.def.tracksOwnFields = true;
          current.subclasses.forEach(track);
        };
        // Runtime-owned roots keep their dedicated property contracts. A
        // family whose fields all exist from construction and are never
        // deleted keeps a fixed layout, as TypeScript classes do.
        // null is a result too; undefined means not computed yet.
        if (this.deletedNames === undefined)
          this.deletedNames = deletedPropertyNames(lowerer.moduleOrder);
        if (!root.base?.def.runtime && !fixedFieldFamily(root, this.deletedNames)) track(root);
      }
      const loc = this.propertyBag.loc;
      const { receiver, condition } = this.propertyReceiver(plan, loc);
      const bag: IrExpr = {
        kind: "fieldGet",
        obj: receiver,
        className,
        field: PROPERTY_BAG,
        type: DYN,
        loc,
      };
      const prototype = needsPrototype(info) ? prototypeFor(info, receiver, loc) : null;
      const initialize: Extract<IrStmt, { kind: "fieldSet" }> = {
        kind: "fieldSet",
        obj: receiver,
        className,
        field: PROPERTY_BAG,
        value: prototype
          ? { kind: "libCall", fn: "dyn.objCreate", args: [prototype], type: DYN, loc }
          : { kind: "dynObjLit", fields: [], type: DYN, loc },
        loc,
      };
      const initializers = this.bagInitializers.get(className) ?? [];
      initializers.push(initialize);
      this.bagInitializers.set(className, initializers);
      this.propertyBag.body.unshift({
        kind: "if",
        cond: condition,
        then: [
          {
            kind: "if",
            cond: { kind: "dynTest", test: "undefined", value: bag, type: BOOL, loc },
            then: [initialize],
            else_: null,
            loc,
          },
          { kind: "return", value: bag, loc },
        ],
        else_: null,
        loc,
      });
      changed = true;
    }
    refreshDescriptorGuards(lowerer);
    const byMethod = new Map<string, ClassInfo[]>();
    const candidates = (method: string): ClassInfo[] => {
      const found = byMethod.get(method);
      if (found) return found;
      const matching = this.propertyReceivers(lowerer, true).flatMap(({ info }) => {
        if (!info || info.fields.has(method) || info.builtinError) return [];
        if (emitterRooted(lowerer, info) && EMITTER_METHODS.has(method)) return [info];
        if (info.builtinStream) {
          return STREAM_METHODS.has(method) ||
            (STREAM_OPERATORS.has(method) && info.builtinStream !== "w")
            ? [info]
            : [];
        }
        return findMethodOn(lowerer, info, method) || findGenericMethodOn(lowerer, info, method)
          ? [info]
          : [];
      });
      byMethod.set(method, matching);
      return matching;
    };
    for (const fn of functions) {
      // Discovery already visits every expression. Preserve bodies without
      // dispatch sites instead of rebuilding their entire typed IR tree on
      // every reachability pass. Recompute this set as new bodies appear.
      if (this.generated.has(fn) || !rewrite.has(fn)) continue;
      const keyInitializers = new Map<string, IrExpr>();
      const written = new Set<string>();
      everyStmtList(fn.body, {
        expr: (expression) => {
          if (expression.kind === "incDec" || expression.kind === "assignExpr")
            written.add(expression.localId);
          return true;
        },
        stmt: (statement) => {
          if (statement.kind === "varDecl" && statement.init)
            keyInitializers.set(statement.localId, statement.init);
          if (statement.kind === "assign") written.add(statement.localId);
          return true;
        },
      });
      const keyValue = (value: IrExpr): IrExpr => {
        const visited = new Set<string>();
        while (true) {
          if (value.kind === "dynFrom") {
            value = value.value;
            continue;
          }
          if (value.kind === "libCall" && value.fn === "dyn.propertyKey") {
            value = value.args[0]!;
            continue;
          }
          if (
            value.kind === "varRef" &&
            !written.has(value.localId) &&
            !visited.has(value.localId) &&
            keyInitializers.has(value.localId)
          ) {
            visited.add(value.localId);
            value = keyInitializers.get(value.localId)!;
            continue;
          }
          return value;
        }
      };
      fn.body = transformStmtList(fn.body, {
        stmt: (stmt) => stmt,
        expr: (expr) => {
          if (expr.kind === "dynHasKey" && prototypeMembers.has(expr.key)) {
            // A class instance's snapshot can carry its class's prototype
            // data, which holds only the methods the program reads through
            // the prototype. The computed-key form answers methods and
            // accessors from the class itself.
            const loc = expr.loc;
            const test: IrExpr = {
              kind: "libCall",
              fn: "dyn.hasKeyComputed",
              args: [
                expr.value,
                {
                  kind: "dynFrom",
                  value: { kind: "strLit", value: expr.key, type: STRING, loc },
                  type: DYN,
                  loc,
                },
              ],
              type: BOOL,
              loc,
            };
            changed = true;
            return {
              kind: "seqExpr",
              stmts: [],
              result: expr.negated
                ? { kind: "unary", op: "!", operand: test, type: BOOL, loc }
                : test,
              type: BOOL,
              loc,
            };
          }
          const called = calling.size ? this.convertMethodCall(lowerer, fn, expr, calling) : null;
          if (called) {
            changed = true;
            return called;
          }
          const converted = converting.size
            ? this.convertOperands(lowerer, fn, expr, converting)
            : null;
          if (converted) {
            changed = true;
            // A hoisting sequence revisits the operation as its child; a
            // wrapped operation continues through the rewrites below.
            if (converted.kind === "seqExpr") return converted;
            expr = converted;
          }
          if (expr.kind === "dynCheck" && isDynTypedRefType(expr.type)) {
            const type = expr.type;
            let cast = this.checkedCasts.get(type.className);
            if (!cast) {
              const loc = expr.loc;
              const fn: IrFunction = {
                name: `%dyn.class.cast:${type.className}`,
                params: [{ localId: "value", name: "value", type: DYN }],
                locals: [{ id: "value", name: "value", type: DYN, mutable: false }],
                returnType: type,
                body: [
                  { kind: "return", value: { ...expr, value: varRef("value", DYN, loc) }, loc },
                ],
                loc,
              };
              cast = { fn, classes: new Set() };
              this.checkedCasts.set(type.className, cast);
              this.generated.add(fn);
              lowerer.liftedFns.push(fn);
              changed = true;
            }
            return { kind: "call", callee: cast.fn.name, args: [expr.value], type, loc: expr.loc };
          }
          if (
            expr.kind === "libCall" &&
            expr.fn === "dyn.getPrototype" &&
            expr.args[0]?.kind !== "dynObjLit"
          ) {
            if (expr.prototypeIdentityOnly) {
              if (!this.prototypeIdentityHelper) {
                const loc = expr.loc;
                this.prototypeIdentityHelper = {
                  name: "%dyn.class.prototypeIdentity",
                  params: [{ localId: "value", name: "value", type: DYN }],
                  locals: [{ id: "value", name: "value", type: DYN, mutable: false }],
                  returnType: DYN,
                  loc,
                  body: [
                    { kind: "return", value: { ...expr, args: [varRef("value", DYN, loc)] }, loc },
                  ],
                };
                lowerer.liftedFns.push(this.prototypeIdentityHelper);
                this.generated.add(this.prototypeIdentityHelper);
                changed = true;
              }
              return {
                kind: "call",
                callee: this.prototypeIdentityHelper.name,
                args: expr.args,
                type: DYN,
                loc: expr.loc,
              };
            }
            if (!this.prototypeHelper) {
              const loc = expr.loc;
              this.prototypeHelper = {
                name: "%dyn.class.getPrototype",
                params: [{ localId: "value", name: "value", type: DYN }],
                locals: [{ id: "value", name: "value", type: DYN, mutable: false }],
                returnType: DYN,
                loc,
                body: [
                  { kind: "return", value: { ...expr, args: [varRef("value", DYN, loc)] }, loc },
                ],
              };
              lowerer.liftedFns.push(this.prototypeHelper);
              this.generated.add(this.prototypeHelper);
              changed = true;
            }
            return {
              kind: "call",
              callee: this.prototypeHelper.name,
              args: expr.args,
              type: DYN,
              loc: expr.loc,
            };
          }
          if (
            expr.kind === "libCall" &&
            (expr.fn === "dyn.toString" || expr.fn === "dyn.stringConstructor") &&
            lowerer.classes.has("%Error")
          ) {
            const key = JSON.stringify([expr.fn, ...expr.args.map((arg) => typeKey(arg.type))]);
            let errorString = this.errorStrings.get(key);
            if (!errorString) {
              const loc = expr.loc;
              const params = expr.args.map((arg, i) => ({
                localId: `p.${i}`,
                name: `p${i}`,
                type: arg.type,
              }));
              const value = varRef("p.0", DYN, loc);
              errorString = {
                name: `%dyn.error.${expr.fn.slice(4)}.${this.errorStrings.size}`,
                params,
                returnType: STRING,
                locals: params.map((p) => ({
                  id: p.localId,
                  name: p.name,
                  type: p.type,
                  mutable: false,
                })),
                loc,
                body: [
                  {
                    kind: "if",
                    cond: { kind: "dynTest", test: "error", value, type: BOOL, loc },
                    then: [
                      {
                        kind: "return",
                        value: {
                          kind: "dynCheck",
                          type: STRING,
                          loc,
                          value: {
                            kind: "dynCall",
                            callee: errorToStringMethod(lowerer, {
                              kind: "dynCheck",
                              value,
                              type: { kind: "object", className: "%Error" },
                              loc,
                            }),
                            receiver: value,
                            calleeName: "value.toString",
                            args: params
                              .slice(1)
                              .map((p) =>
                                lowerer.coerceToExpected(varRef(p.localId, p.type, loc), DYN),
                              ),
                            type: DYN,
                            loc,
                          },
                        },
                        loc,
                      },
                    ],
                    else_: null,
                    loc,
                  },
                  {
                    kind: "return",
                    value: { ...expr, args: params.map((p) => varRef(p.localId, p.type, loc)) },
                    loc,
                  },
                ],
              };
              this.errorStrings.set(key, errorString);
              this.generated.add(errorString);
              lowerer.liftedFns.push(errorString);
              changed = true;
            }
            return {
              kind: "call",
              callee: errorString.name,
              args: expr.args,
              type: STRING,
              loc: expr.loc,
            };
          }
          if (
            expr.kind === "call" &&
            (expr.callee === this.propertyBag!.name || expr.callee === "%dyn.class.readProperties")
          ) {
            const boxed = expr.args[0];
            if (boxed?.kind === "dynFrom" && isDynTypedRefType(boxed.value.type)) {
              const helper = this.typedPropertyBag(
                lowerer,
                boxed.value.type,
                expr.loc,
                expr.callee === "%dyn.class.readProperties",
              );
              if (helper) {
                changed = true;
                return { ...expr, callee: helper.name, args: [boxed.value] };
              }
            }
          }
          if (expr.kind === "libCall" && expr.fn === "bytes.construct") {
            if (!this.constructDispatch) {
              const loc = expr.loc;
              const params = [DYN, DYN, STRING].map((type, i) => ({
                localId: `p.${i}`,
                name: `p${i}`,
                type,
              }));
              this.constructDispatch = {
                name: "%dyn.class.construct",
                params,
                returnType: DYN,
                locals: params.map((p) => ({
                  id: p.localId,
                  name: p.name,
                  type: p.type,
                  mutable: false,
                })),
                body: [
                  {
                    kind: "return",
                    value: { ...expr, args: params.map((p) => varRef(p.localId, p.type, loc)) },
                    loc,
                  },
                ],
                loc,
              };
              this.generated.add(this.constructDispatch);
              lowerer.liftedFns.push(this.constructDispatch);
              changed = true;
            }
            return {
              kind: "call",
              callee: this.constructDispatch.name,
              args: expr.args,
              type: DYN,
              loc: expr.loc,
            };
          }
          if (
            expr.kind === "libCall" &&
            (expr.fn === "dyn.forInKeys" || expr.fn === "dyn.forInKeyStrings")
          ) {
            let enumeration = this.enumerations.get(expr.fn);
            if (!enumeration) {
              const loc = expr.loc;
              const value = varRef("p.0", DYN, loc);
              enumeration = {
                name:
                  expr.fn === "dyn.forInKeys"
                    ? "%dyn.class.forInKeys"
                    : "%dyn.class.forInKeyStrings",
                params: [{ localId: "p.0", name: "value", type: DYN }],
                returnType: expr.type,
                locals: [{ id: "p.0", name: "value", type: DYN, mutable: false }],
                body: [{ kind: "return", value: { ...expr, args: [value] }, loc }],
                loc,
              };
              this.enumerations.set(expr.fn, enumeration);
              this.generated.add(enumeration);
              lowerer.liftedFns.push(enumeration);
              changed = true;
            }
            return {
              kind: "call",
              callee: enumeration.name,
              args: expr.args,
              type: expr.type,
              loc: expr.loc,
            };
          }
          if (expr.kind === "libCall" && expr.fn === "dyn.defineProperty") {
            const loc = expr.loc;
            if (!this.descriptorHelper) {
              const params = ["target", "key", "descriptor"].map((name) => ({
                localId: name,
                name,
                type: DYN,
              }));
              const target = varRef("target", DYN, loc);
              const key = varRef("key", DYN, loc);
              const descriptor = varRef("descriptor", DYN, loc);
              this.descriptorHelper = {
                name: "%dyn.class.defineProperty",
                params,
                returnType: DYN,
                locals: params.map((param) => ({
                  id: param.localId,
                  name: param.name,
                  type: DYN,
                  mutable: false,
                })),
                body: [
                  {
                    kind: "if",
                    cond: { kind: "dynTest", test: "symbol", value: key, type: BOOL, loc },
                    then: [
                      {
                        kind: "exprStmt",
                        expr: {
                          ...expr,
                          args: [
                            {
                              kind: "call",
                              callee: this.propertyBag!.name,
                              args: [target],
                              type: DYN,
                              loc,
                            },
                            key,
                            descriptor,
                          ],
                        },
                        loc,
                      },
                      { kind: "return", value: target, loc },
                    ],
                    else_: null,
                    loc,
                  },
                  { kind: "return", value: { ...expr, args: [target, key, descriptor] }, loc },
                ],
                loc,
              };
              this.generated.add(this.descriptorHelper);
              lowerer.liftedFns.push(this.descriptorHelper);
              changed = true;
            }
            return {
              kind: "call",
              callee: this.descriptorHelper.name,
              args: expr.args,
              type: DYN,
              loc,
            };
          }
          if (expr.kind === "dynKeyGet" && expr.value.kind === "dynObjLit") return expr;
          const reflectRead = expr.kind === "libCall" && expr.fn === "dyn.reflectGet" ? expr : null;
          const reflectWrite =
            expr.kind === "libCall" && expr.fn === "dyn.reflectSet" ? expr : null;
          const reflect = !!reflectRead || !!reflectWrite;
          const computedRead = reflectRead
            ? {
                kind: "dynKeyGet" as const,
                value: reflectRead.args[0]!,
                key: reflectRead.args[1]!,
                type: DYN,
                loc: expr.loc,
              }
            : expr.kind === "dynKeyGet" && expr.key.kind !== "strLit"
              ? expr
              : null;
          const computedWrite = reflectWrite
            ? {
                ...reflectWrite,
                fn: "dyn.keySetComputed" as const,
                args: reflectWrite.args.slice(0, 3),
                type: VOID,
              }
            : expr.kind === "libCall" &&
                (expr.fn === "dyn.keySetComputed" ||
                  (expr.fn === "dyn.keySet" && expr.args[1]?.kind !== "strLit"))
              ? expr
              : null;
          const computedProbe =
            expr.kind === "libCall" &&
            [
              "dyn.hasKeyComputed",
              "dyn.hasOwnComputed",
              "dyn.propertyIsEnumerableComputed",
            ].includes(expr.fn)
              ? expr
              : null;
          if (computedRead || computedWrite || computedProbe) {
            const probe = computedProbe
              ? computedProbe.fn === "dyn.hasKeyComputed"
                ? "in"
                : computedProbe.fn === "dyn.hasOwnComputed"
                  ? "own"
                  : "enumerable"
              : undefined;
            const dynamicKey =
              reflect ||
              !!computedProbe ||
              computedWrite?.fn === "dyn.keySetComputed" ||
              computedRead?.key.type.kind === "dyn";
            const sourceKey = keyValue(
              computedRead?.key ?? (computedWrite ?? computedProbe)!.args[1]!,
            );
            const numericKey =
              sourceKey.type.kind === "f64" ||
              (sourceKey.kind === "dynFrom" && sourceKey.value.type.kind === "f64") ||
              (sourceKey.kind === "toString" && sourceKey.operand.type.kind === "f64");
            // `value[i]` with a number `i`: the helper takes the number and
            // reads a dense checked array element directly, formatting the
            // property name only when that does not apply.
            const indexKey =
              computedRead &&
              !reflect &&
              !dynamicKey &&
              !computedRead.optional &&
              computedRead.key.kind === "toString" &&
              computedRead.key.operand.type.kind === "f64"
                ? computedRead.key
                : null;
            const key = JSON.stringify([
              !!computedWrite,
              computedRead?.optional ?? false,
              dynamicKey,
              probe,
              numericKey,
              reflect,
              !!indexKey,
            ]);
            let dispatch = this.computed.get(key);
            if (!dispatch) {
              const loc = expr.loc;
              const params = [
                { localId: "p.0", name: "value", type: DYN },
                indexKey
                  ? { localId: "p.index", name: "index", type: F64 }
                  : { localId: "p.key", name: "key", type: dynamicKey ? DYN : STRING },
                ...(computedWrite ? [{ localId: "p.1", name: "stored", type: DYN }] : []),
                ...(reflect ? [{ localId: "p.reflectReceiver", name: "receiver", type: DYN }] : []),
              ];
              const keyLocal = dynamicKey ? "key.string" : "p.key";
              const bag: IrExpr = computedWrite
                ? {
                    kind: "call",
                    callee: this.propertyBag!.name,
                    args: [varRef("p.0", DYN, loc)],
                    type: DYN,
                    loc,
                  }
                : this.readPropertyBagOrEmpty(lowerer, varRef("p.0", DYN, loc), loc);
              const reflectionFallback = (target: IrExpr, property: IrExpr): IrExpr => ({
                kind: "libCall",
                fn: computedWrite ? "dyn.reflectSet" : "dyn.reflectGet",
                args: [
                  target,
                  lowerer.coerceToExpected(property, DYN),
                  ...(computedWrite ? [varRef("p.1", DYN, loc)] : []),
                  varRef("p.reflectReceiver", DYN, loc),
                ],
                type: computedWrite ? BOOL : DYN,
                loc,
              });
              const fallback: IrExpr = reflect
                ? reflectionFallback(bag, varRef(keyLocal, STRING, loc))
                : computedProbe
                  ? {
                      ...computedProbe,
                      fn:
                        probe === "in"
                          ? "dyn.in"
                          : probe === "own"
                            ? "dyn.hasOwn"
                            : "dyn.propertyIsEnumerable",
                      args: [bag, varRef(keyLocal, STRING, loc)],
                    }
                  : computedRead
                    ? { ...computedRead, value: bag, key: varRef(keyLocal, STRING, loc) }
                    : {
                        ...computedWrite!,
                        fn: "dyn.keySet",
                        args: [bag, varRef(keyLocal, STRING, loc), varRef("p.1", DYN, loc)],
                      };
              const helper: IrFunction = {
                name: `%dyn.class.computed.${this.computed.size}`,
                params,
                returnType:
                  (reflect && computedWrite) || computedProbe ? BOOL : computedWrite ? VOID : DYN,
                locals: [
                  ...params.map((p) => ({
                    id: p.localId,
                    name: p.name,
                    type: p.type,
                    mutable: false,
                  })),
                  ...(dynamicKey || indexKey
                    ? [{ id: keyLocal, name: "key", type: STRING, mutable: false }]
                    : []),
                ],
                body: reflect
                  ? [{ kind: "return", value: fallback, loc }]
                  : computedWrite
                    ? [
                        { kind: "exprStmt", expr: fallback, loc },
                        { kind: "return", value: null, loc },
                      ]
                    : [{ kind: "return", value: fallback, loc }],
                loc,
                ...(numericKey && computedRead && !reflect && !dynamicKey
                  ? { fastRead: "index" as const }
                  : {}),
              };
              if (dynamicKey)
                helper.body.unshift(
                  {
                    kind: "if",
                    cond: {
                      kind: "dynTest",
                      test: "symbol",
                      value: varRef("p.key", DYN, loc),
                      type: BOOL,
                      loc,
                    },
                    then: reflect
                      ? [
                          {
                            kind: "return",
                            value: reflectionFallback(bag, varRef("p.key", DYN, loc)),
                            loc,
                          },
                        ]
                      : computedProbe
                        ? [
                            {
                              kind: "return",
                              value: { ...computedProbe, args: [bag, varRef("p.key", DYN, loc)] },
                              loc,
                            },
                          ]
                        : computedRead
                          ? [
                              {
                                kind: "return",
                                value: {
                                  ...computedRead,
                                  value: bag,
                                  key: varRef("p.key", DYN, loc),
                                },
                                loc,
                              },
                            ]
                          : [
                              {
                                kind: "exprStmt",
                                expr: {
                                  ...computedWrite!,
                                  args: [bag, varRef("p.key", DYN, loc), varRef("p.1", DYN, loc)],
                                },
                                loc,
                              },
                              { kind: "return", value: null, loc },
                            ],
                    else_: null,
                    loc,
                  },
                  {
                    kind: "if",
                    cond: {
                      kind: "dynTest",
                      test: "nullish",
                      value: varRef("p.0", DYN, loc),
                      type: BOOL,
                      loc,
                    },
                    then: [
                      ...(reflect
                        ? [
                            {
                              kind: "return",
                              value: reflectionFallback(
                                varRef("p.0", DYN, loc),
                                varRef("p.key", DYN, loc),
                              ),
                              loc,
                            } as IrStmt,
                          ]
                        : computedProbe
                          ? [
                              {
                                kind: "return",
                                value: {
                                  ...computedProbe,
                                  args: [varRef("p.0", DYN, loc), varRef("p.key", DYN, loc)],
                                },
                                loc,
                              } as IrStmt,
                            ]
                          : computedRead
                            ? [
                                {
                                  kind: "return",
                                  value: {
                                    ...computedRead,
                                    value: varRef("p.0", DYN, loc),
                                    key: varRef("p.key", DYN, loc),
                                  },
                                  loc,
                                } as IrStmt,
                              ]
                            : [
                                {
                                  kind: "exprStmt",
                                  expr: {
                                    ...computedWrite!,
                                    args: [
                                      varRef("p.0", DYN, loc),
                                      varRef("p.key", DYN, loc),
                                      varRef("p.1", DYN, loc),
                                    ],
                                  },
                                  loc,
                                } as IrStmt,
                                { kind: "return", value: null, loc } as IrStmt,
                              ]),
                    ],
                    else_: null,
                    loc,
                  },
                  {
                    kind: "varDecl",
                    localId: keyLocal,
                    init: {
                      kind: "libCall",
                      fn: "dyn.toStringCoerce",
                      args: [varRef("p.key", DYN, loc)],
                      type: STRING,
                      loc,
                    },
                    loc,
                  },
                );
              if (indexKey) {
                // An integer index below a checked array's length names an
                // element (-0 included: its property name is "0"); dyn.arrLen
                // answers 0 for every other kind. Holes keep dyn.arrAt's
                // ordinary named lookup.
                const index = varRef("p.index", F64, loc);
                const elementRead: IrStmt = {
                  kind: "if",
                  cond: { kind: "libCall", fn: "number.isInteger", args: [index], type: BOOL, loc },
                  then: [
                    {
                      kind: "if",
                      cond: {
                        kind: "bin",
                        op: ">=",
                        left: index,
                        right: { kind: "numLit", value: 0, type: F64, loc },
                        type: BOOL,
                        loc,
                      },
                      then: [
                        {
                          kind: "if",
                          cond: {
                            kind: "bin",
                            op: "<",
                            left: index,
                            right: {
                              kind: "libCall",
                              fn: "dyn.arrLen",
                              args: [varRef("p.0", DYN, loc)],
                              type: F64,
                              loc,
                            },
                            type: BOOL,
                            loc,
                          },
                          then: [
                            {
                              kind: "return",
                              value: {
                                kind: "libCall",
                                fn: "dyn.arrAt",
                                args: [varRef("p.0", DYN, loc), index],
                                type: DYN,
                                loc,
                              },
                              loc,
                            },
                          ],
                          else_: null,
                          loc,
                        },
                      ],
                      else_: null,
                      loc,
                    },
                  ],
                  else_: null,
                  loc,
                };
                helper.body.unshift(elementRead, {
                  kind: "varDecl",
                  localId: keyLocal,
                  init: { ...indexKey, operand: index },
                  loc,
                });
              }
              dispatch = {
                write: !!computedWrite,
                reflect,
                fn: helper,
                classes: new Set(),
                keyLocal,
                branchIndex: dynamicKey ? 3 : indexKey ? 2 : 0,
                dynamicKey,
                numericKey,
                probe,
              };
              this.computed.set(key, dispatch);
              this.generated.add(helper);
              lowerer.liftedFns.push(helper);
              changed = true;
            }
            return {
              kind: "call",
              callee: dispatch.fn.name,
              args: reflect
                ? (reflectRead ?? reflectWrite)!.args
                : computedRead
                  ? [computedRead.value, indexKey ? indexKey.operand : computedRead.key]
                  : (computedWrite ?? computedProbe)!.args,
              type: dispatch.fn.returnType,
              loc: expr.loc,
            };
          }
          const read = expr.kind === "dynKeyGet" && expr.key.kind === "strLit" ? expr : null;
          const write =
            expr.kind === "libCall" && expr.fn === "dyn.keySet" && expr.args[1]?.kind === "strLit"
              ? expr
              : null;
          const name =
            read?.key.kind === "strLit"
              ? read.key.value
              : write?.args[1]?.kind === "strLit"
                ? write.args[1].value
                : null;
          if (name !== null) {
            const key = JSON.stringify([name, !!write, read?.optional ?? false]);
            let dispatch = this.properties.get(key);
            if (!dispatch) {
              const loc = expr.loc;
              const params = (write ? [0, 1] : [0]).map((i) => ({
                localId: `p.${i}`,
                name: `p${i}`,
                type: DYN,
              }));
              const instanceBag: IrExpr = read
                ? this.readPropertyBagOrEmpty(lowerer, varRef("p.0", DYN, loc), loc)
                : {
                    kind: "call",
                    callee: this.propertyBag!.name,
                    args: [varRef("p.0", DYN, loc)],
                    type: DYN,
                    loc,
                  };
              const bag: IrExpr =
                read && !["name", "length", "apply"].includes(name)
                  ? {
                      kind: "call",
                      callee: this.constructorPropertyBag(lowerer, loc).name,
                      args: [instanceBag],
                      type: DYN,
                      loc,
                    }
                  : instanceBag;
              // A read compares the bag with the receiver and then reads it:
              // evaluate it once, so each read retains the receiver once.
              const bagRead = varRef("bag.0", DYN, loc);
              const bagGet: IrExpr | null = read
                ? {
                    kind: "libCall",
                    fn: "dyn.bagGet",
                    args: [bagRead, read.key, varRef("p.0", DYN, loc)],
                    type: DYN,
                    loc,
                  }
                : null;
              // A class instance whose class chain declares no member of an
              // Object.prototype method's name (classes that do answer in
              // their own branches) inherits it unless an own property
              // shadows it; a class constructor's static bag reads as before.
              const instanceRead: IrExpr | null =
                read && INHERITED_OBJECT_METHODS.has(name)
                  ? {
                      kind: "ternary",
                      cond: {
                        kind: "dynTest",
                        test: "function",
                        value: varRef("p.0", DYN, loc),
                        type: BOOL,
                        loc,
                      },
                      then: bagGet!,
                      else_: {
                        kind: "ternary",
                        cond: this.readBagHas(lowerer, "dyn.hasKey", bagRead, read.key, loc),
                        then: bagGet!,
                        else_: {
                          kind: "libCall",
                          fn: "dyn.builtinMethod",
                          args: [{ kind: "strLit", value: "Object", type: STRING, loc }, read.key],
                          type: DYN,
                          loc,
                        },
                        type: DYN,
                        loc,
                      },
                      type: DYN,
                      loc,
                    }
                  : bagGet;
              const fallback: IrExpr = read
                ? {
                    kind: "ternary",
                    cond: {
                      kind: "dynScalarEq",
                      left: bagRead,
                      right: varRef("p.0", DYN, loc),
                      type: BOOL,
                      loc,
                    },
                    then: { ...read, value: bagRead },
                    else_: instanceRead!,
                    type: DYN,
                    loc,
                  }
                : { ...write!, args: [bag, write!.args[1]!, varRef("p.1", DYN, loc)] };
              const helper: IrFunction = {
                name: `%dyn.class.property.${this.properties.size}`,
                params,
                returnType: write ? VOID : DYN,
                locals: [
                  ...params.map((p) => ({
                    id: p.localId,
                    name: p.name,
                    type: DYN,
                    mutable: false,
                  })),
                  ...(read ? [{ id: "bag.0", name: "bag", type: DYN, mutable: false }] : []),
                ],
                body: write
                  ? [
                      { kind: "exprStmt", expr: fallback, loc },
                      { kind: "return", value: null, loc },
                    ]
                  : [
                      { kind: "varDecl", localId: "bag.0", init: bag, loc },
                      {
                        kind: "return",
                        // Primitives answer their wrapper constructors.
                        value:
                          name === "constructor"
                            ? primitiveConstructorOr(
                                lowerer,
                                varRef("p.0", DYN, loc),
                                fallback,
                                loc,
                              )
                            : fallback,
                        loc,
                      },
                    ],
                loc,
              };
              if (!write && name === "toString" && lowerer.classes.has("%Error")) {
                const value = varRef("p.0", DYN, loc);
                helper.body.unshift({
                  kind: "if",
                  cond: { kind: "dynTest", test: "error", value, type: BOOL, loc },
                  then: [
                    {
                      kind: "return",
                      value: errorToStringMethod(lowerer, {
                        kind: "dynCheck",
                        value,
                        type: { kind: "object", className: "%Error" },
                        loc,
                      }),
                      loc,
                    },
                  ],
                  else_: null,
                  loc,
                });
              }
              dispatch = { name, write: !!write, fn: helper, classes: new Set() };
              this.properties.set(key, dispatch);
              this.generated.add(helper);
              lowerer.liftedFns.push(helper);
              changed = true;
            }
            return {
              kind: "call",
              callee: dispatch.fn.name,
              args: read ? [read.value] : [write!.args[0]!, write!.args[2]!],
              type: dispatch.fn.returnType,
              loc: expr.loc,
            };
          }
          const iterator =
            expr.kind === "libCall" &&
            (expr.fn === "dyn.iterator" || expr.fn === "dyn.arrayFromIterator")
              ? expr
              : null;
          const invoke: Invoke | null = iterator
            ? {
                kind: "dynInvoke",
                recv: iterator.args[0]!,
                method: "sym:iterator",
                calleeName: "value[Symbol.iterator]",
                args: [],
                type: DYN,
                loc: iterator.loc,
              }
            : expr.kind === "dynInvoke"
              ? expr
              : null;
          const staticCandidates =
            invoke &&
            [...this.boxedConstructors].some((name) => {
              const info = lowerer.classes.get(name);
              return info && findStaticOn(lowerer, info, invoke.method)?.method;
            });
          if (
            !invoke ||
            (candidates(invoke.method).length === 0 &&
              !staticCandidates &&
              !(invoke.method === "toString" && lowerer.classes.has("%Error")))
          )
            return expr;
          const key = JSON.stringify([
            invoke.method,
            invoke.args.length,
            iterator?.fn,
            iterator?.args[1],
          ]);
          let dispatch = this.dispatches.get(key);
          if (!dispatch) {
            const params: IrParam[] = [invoke.recv, ...invoke.args].map((_, i) => ({
              localId: `p.${i}`,
              name: `p${i}`,
              type: DYN,
            }));
            params.splice(1, 0, { localId: "p.callback", name: "callback", type: DYN });
            iterator?.args.slice(1).forEach((argument, i) =>
              params.push({
                localId: `p.iterator.${i}`,
                name: `iterator${i}`,
                type: argument.type,
              }),
            );
            params.push({ localId: "p.calleeName", name: "calleeName", type: STRING });
            const callback: IrFunction = {
              name: `%dyn.class.callback.${this.dispatches.size}`,
              params: [params[0]!],
              returnType: DYN,
              locals: [{ id: "p.0", name: "receiver", type: DYN, mutable: false }],
              body: [{ kind: "return", value: dynUndefinedExpr(expr.loc), loc: expr.loc }],
              loc: expr.loc,
            };
            const helper: IrFunction = {
              name: `%dyn.class.call.${this.dispatches.size}`,
              params,
              returnType: DYN,
              locals: params.map((p) => ({
                id: p.localId,
                name: p.name,
                type: p.type,
                mutable: false,
              })),
              body: [
                {
                  kind: "return",
                  value: iterator
                    ? {
                        ...iterator,
                        args: [
                          varRef("p.0", DYN, expr.loc),
                          ...iterator.args
                            .slice(1)
                            .map((argument, i) =>
                              varRef(`p.iterator.${i}`, argument.type, expr.loc),
                            ),
                        ],
                      }
                    : {
                        ...invoke,
                        calleeNameValue: varRef("p.calleeName", STRING, expr.loc),
                        recv: varRef("p.0", DYN, expr.loc),
                        args: invoke.args.map((_, i) => varRef(`p.${i + 1}`, DYN, expr.loc)),
                      },
                  loc: expr.loc,
                },
              ],
              loc: expr.loc,
            };
            if (invoke.method === "toString" && lowerer.classes.has("%Error")) {
              const loc = expr.loc;
              const value = varRef("p.0", DYN, loc);
              helper.body.unshift({
                kind: "if",
                cond: { kind: "dynTest", test: "error", value, type: BOOL, loc },
                then: [
                  {
                    kind: "return",
                    value: {
                      kind: "dynCall",
                      callee: errorToStringMethod(lowerer, {
                        kind: "dynCheck",
                        value,
                        type: { kind: "object", className: "%Error" },
                        loc,
                      }),
                      receiver: value,
                      calleeName: invoke.calleeName,
                      calleeNameValue: varRef("p.calleeName", STRING, loc),
                      args: invoke.args.map((_, i) => varRef(`p.${i + 1}`, DYN, loc)),
                      type: DYN,
                      loc,
                    },
                    loc,
                  },
                ],
                else_: null,
                loc,
              });
            }
            dispatch = { source: invoke, fn: helper, callback, classes: new Set() };
            this.dispatches.set(key, dispatch);
            this.generated.add(helper);
            this.generated.add(callback);
            lowerer.liftedFns.push(helper, callback);
            changed = true;
          }
          // Resolve an own callback before argument effects can replace it.
          const local = {
            id: `%dispatch.receiver.${fn.locals.length}`,
            name: "receiver",
            type: DYN,
            mutable: false,
          };
          fn.locals.push(local);
          const receiver = varRef(local.id, DYN, expr.loc);
          return {
            kind: "seqExpr",
            stmts: [{ kind: "varDecl", localId: local.id, init: invoke.recv, loc: expr.loc }],
            result: {
              kind: "call",
              callee: dispatch.fn.name,
              args: [
                receiver,
                {
                  kind: "call",
                  callee: dispatch.callback.name,
                  args: [receiver],
                  type: DYN,
                  loc: expr.loc,
                },
                ...invoke.args,
                ...(iterator?.args.slice(1) ?? []),
                invoke.calleeNameValue ?? {
                  kind: "strLit",
                  value: invoke.calleeName,
                  type: STRING,
                  loc: expr.loc,
                },
              ],
              type: DYN,
              loc: expr.loc,
            },
            type: DYN,
            loc: expr.loc,
          };
        },
      });
    }
    for (const [target, cast] of this.checkedCasts) {
      for (const source of this.boxed) {
        if (source === target || !lowerer.isSubclassOf(target, source) || cast.classes.has(source))
          continue;
        cast.classes.add(source);
        const loc = cast.fn.loc;
        const value = varRef("value", DYN, loc);
        const sourceType: IrType = { kind: "object", className: source };
        const object: IrExpr = { kind: "dynCheck", value, type: sourceType, loc };
        cast.fn.body.unshift({
          kind: "if",
          cond: {
            kind: "libCall",
            fn: "dyn.typedRefIs",
            args: [value, { kind: "strLit", value: typeKey(sourceType), type: STRING, loc }],
            type: BOOL,
            loc,
          },
          then: [
            {
              kind: "if",
              cond: { kind: "instanceOf", value: object, className: target, type: BOOL, loc },
              then: [
                {
                  kind: "return",
                  value: { kind: "downcast", value: object, type: cast.fn.returnType, loc },
                  loc,
                },
              ],
              else_: null,
              loc,
            },
          ],
          else_: null,
          loc,
        });
        changed = true;
      }
    }
    for (const dispatch of this.dispatches.values()) {
      for (const name of this.boxedConstructors) {
        const info = lowerer.classes.get(name);
        const found = info && findStaticOn(lowerer, info, dispatch.source.method);
        const key = `constructor:${name}`;
        if (!found?.method || dispatch.classes.has(key)) continue;
        const method = reflectedClassStaticMethodValue(
          lowerer,
          found.declarer,
          dispatch.source.method,
        );
        if (!method) continue;
        dispatch.classes.add(key);
        const loc = dispatch.source.loc;
        const receiver = varRef("p.0", DYN, loc);
        const condition: IrExpr = {
          kind: "libCall",
          fn: "dyn.classIs",
          args: [
            receiver,
            {
              kind: "strLit",
              value: typeKey({ kind: "classval", className: name }),
              type: STRING,
              loc,
            },
          ],
          type: BOOL,
          loc,
        };
        dispatch.callback.body.unshift({
          kind: "if",
          cond: condition,
          then: [
            {
              kind: "return",
              value: {
                kind: "dynObjLit",
                fields: [
                  {
                    key: { kind: "strLit", value: "value", type: STRING, loc },
                    value: lowerer.coerceToExpected(method, DYN),
                  },
                ],
                type: DYN,
                loc,
              },
              loc,
            },
          ],
          else_: null,
          loc,
        });
        dispatch.fn.body.unshift({
          kind: "if",
          cond: condition,
          then: [
            {
              kind: "return",
              value: {
                kind: "dynCall",
                callee: {
                  kind: "dynKeyGet",
                  value: varRef("p.callback", DYN, loc),
                  key: { kind: "strLit", value: "value", type: STRING, loc },
                  type: DYN,
                  loc,
                },
                receiver,
                calleeName: dispatch.source.calleeName,
                calleeNameValue: varRef("p.calleeName", STRING, loc),
                args: dispatch.source.args.map((_, i) => varRef(`p.${i + 1}`, DYN, loc)),
                type: DYN,
                loc,
              },
              loc,
            },
          ],
          else_: null,
          loc,
        });
        changed = true;
      }
      for (const plan of this.propertyReceivers(lowerer, true)) {
        const { info } = plan;
        if (!candidates(dispatch.source.method).includes(info) || dispatch.classes.has(plan.key))
          continue;
        dispatch.classes.add(plan.key);
        const loc = dispatch.source.loc;
        const value = varRef("p.0", DYN, loc);
        const { receiver, condition } = this.propertyReceiver(plan, loc);
        if (isClassCallback(lowerer, info, dispatch.source.method)) {
          const prototypeMethod = observedPrototypeMethod(
            lowerer,
            info,
            dispatch.source.method,
            loc,
            receiver,
          );
          const bag = this.readPropertyBagOrEmpty(lowerer, value, loc);
          dispatch.callback.body.unshift({
            kind: "if",
            cond: condition,
            then: [
              {
                kind: "return",
                value: {
                  kind: "ternary",
                  cond: prototypeMethod
                    ? { kind: "boolLit", value: true, type: BOOL, loc }
                    : {
                        kind: "libCall",
                        fn: "dyn.hasKey",
                        args: [
                          bag,
                          { kind: "strLit", value: dispatch.source.method, type: STRING, loc },
                        ],
                        type: BOOL,
                        loc,
                      },
                  then: {
                    kind: "dynObjLit",
                    fields: [
                      {
                        key: { kind: "strLit", value: "value", type: STRING, loc },
                        value: {
                          kind: "dynKeyGet",
                          value: bag,
                          key: { kind: "strLit", value: dispatch.source.method, type: STRING, loc },
                          type: DYN,
                          loc,
                        },
                      },
                    ],
                    type: DYN,
                    loc,
                  },
                  else_: dynUndefinedExpr(loc),
                  type: DYN,
                  loc,
                },
                loc,
              },
            ],
            else_: null,
            loc,
          });
        }
        const before = lowerer.diags.length;
        let branch: IrStmt[];
        try {
          branch = this.methodBody(lowerer, dispatch, info, receiver);
        } catch (error) {
          if (!(error instanceof PoisonError) || !info.decl) throw error;
          const fence = lowerer.deferToRuntimeFence(before, info.decl, { kind: "statement" });
          if (!fence) throw error;
          branch = [fence];
        }
        dispatch.fn.body.unshift({
          kind: "if",
          cond: condition,
          then: branch,
          else_: null,
          loc,
        });
        changed = true;
      }
    }
    for (const [method, conversion] of this.conversionCalls) {
      for (const plan of this.propertyReceivers(lowerer)) {
        if (conversion.classes.has(plan.key)) continue;
        conversion.classes.add(plan.key);
        if (!conversionMethod(lowerer, plan.info, method)) continue;
        const loc = conversion.call.loc;
        const { condition } = this.propertyReceiver(plan, loc);
        const value = varRef("p.0", DYN, loc);
        const result: IrExpr = {
          kind: "call",
          callee: this.toPrimitiveCall(lowerer, plan, method, method === "toString" ? 1 : 0, loc),
          args: method === "toString" ? [value, varRef("p.1", DYN, loc)] : [value],
          type: DYN,
          loc,
        };
        conversion.test.body.unshift({
          kind: "if",
          cond: condition,
          then: [{ kind: "return", value: { kind: "boolLit", value: true, type: BOOL, loc }, loc }],
          else_: null,
          loc,
        });
        conversion.call.body.unshift({
          kind: "if",
          cond: condition,
          then: [
            {
              kind: "return",
              value:
                method === "toString"
                  ? { kind: "dynCheck", value: result, type: STRING, loc }
                  : result,
              loc,
            },
          ],
          else_: null,
          loc,
        });
        changed = true;
      }
    }
    for (const [hint, conversion] of this.toPrimitives) {
      for (const plan of this.propertyReceivers(lowerer)) {
        if (conversion.classes.has(plan.key)) continue;
        conversion.classes.add(plan.key);
        const arm = this.toPrimitiveArm(lowerer, plan, hint, conversion.fn);
        if (!arm) continue;
        conversion.fn.body.unshift(arm);
        changed = true;
      }
    }
    for (const dispatch of lowerer.protocolDispatches.values()) {
      if (!this.generated.has(dispatch.fn)) {
        this.generated.add(dispatch.fn);
        this.protocols.push(dispatch.fn, ...(dispatch.probe ? [dispatch.probe] : []));
      }
      // Normalized receivers name their exact class, so one key pointer
      // test selects an arm; any other capsule takes the fallback.
      for (const plan of this.propertyReceivers(lowerer)) {
        if (
          plan.info !== plan.capsule ||
          dispatch.classes.has(plan.key) ||
          (!dispatch.field && !candidates(dispatch.method).includes(plan.info))
        )
          continue;
        dispatch.classes.add(plan.key);
        const loc = dispatch.fn.loc;
        const type: IrType = { kind: "object", className: plan.info.def.name };
        const receiver: IrExpr = {
          kind: "dynCheck",
          value: varRef("p.0", DYN, loc),
          exact: true,
          type,
          loc,
        };
        const arm = dispatch.field
          ? protocolFieldArm(lowerer, dispatch, plan.info, receiver)
          : protocolArm(lowerer, dispatch, plan.info, receiver, this.asyncFree);
        if (!arm) continue;
        const condition = (): IrExpr => ({
          kind: "libCall",
          fn: "dyn.typedRefKeyIs",
          args: [
            varRef("p.0", DYN, loc),
            { kind: "strLit", value: typeKey(type), type: STRING, loc },
          ],
          type: BOOL,
          loc,
        });
        dispatch.fn.body.unshift({ kind: "if", cond: condition(), then: arm, else_: null, loc });
        // The method of a native arm is never an own property, so reading
        // it ahead of the arguments observes nothing.
        dispatch.probe?.body.unshift({
          kind: "if",
          cond: condition(),
          then: [{ kind: "return", value: dynUndefinedExpr(loc), loc }],
          else_: null,
          loc,
        });
        changed = true;
      }
    }
    for (const dispatch of this.properties.values()) {
      if (!dispatch.write)
        for (const name of this.boxedConstructors) {
          const info = lowerer.classes.get(name);
          const found = info && findStaticOn(lowerer, info, dispatch.name);
          const field = found?.field;
          const key = `constructor:${name}`;
          if (
            !info ||
            dispatch.name.startsWith("#") ||
            dispatch.classes.has(key) ||
            (!found && dispatch.name !== "prototype")
          )
            continue;
          const method =
            found?.method &&
            reflectedClassStaticMethodValue(lowerer, found.declarer, dispatch.name);
          if (
            (found && !field && !method) ||
            (findGenericStaticOn(lowerer, info, dispatch.name) && !method)
          )
            continue;
          const loc = dispatch.fn.loc;
          const result = field
            ? varRef(field.globalId, field.type, loc)
            : (method ??
              (dispatch.name === "prototype" ? classPrototypeData(lowerer, info, loc) : null) ??
              dynUndefinedExpr(loc));
          if (dispatch.name === "name" || dispatch.name === "length" || dispatch.name === "apply")
            continue;
          dispatch.classes.add(key);
          const value = varRef("p.0", DYN, loc);
          const type: IrType = { kind: "classval", className: name };
          dispatch.fn.body.unshift({
            kind: "if",
            cond: {
              kind: "libCall",
              fn: "dyn.classIs",
              args: [value, { kind: "strLit", value: typeKey(type), type: STRING, loc }],
              type: BOOL,
              loc,
            },
            then: [{ kind: "return", value: lowerer.coerceToExpected(result, DYN), loc }],
            else_: null,
            loc,
          });
          changed = true;
        }
      for (const plan of this.propertyReceivers(lowerer, true)) {
        const { info } = plan;
        if (
          !isClassOwnEnumerableFieldName(dispatch.name) ||
          (!(info.builtinStream !== undefined && streamProperty(dispatch.name)) &&
            !eventTargetInheritedMember(info, dispatch.name) &&
            !findMethodOn(lowerer, info, dispatch.name) &&
            !findGenericMethodOn(lowerer, info, dispatch.name) &&
            dispatch.name !== "constructor" &&
            !info.fields.has(dispatch.name) &&
            !(dispatch.name === "stack" && lowerer.isSubclassOf(info.def.name, "%Error")) &&
            !findMethodOn(lowerer, info, `get:${dispatch.name}`) &&
            !findMethodOn(lowerer, info, `set:${dispatch.name}`))
        )
          continue;
        if (dispatch.classes.has(plan.key)) continue;
        dispatch.classes.add(plan.key);
        const loc = dispatch.fn.loc;
        const { receiver, condition } = this.propertyReceiver(plan, loc);
        const before = lowerer.diags.length;
        let branch: IrStmt[];
        try {
          branch = this.propertyBody(lowerer, dispatch, info, receiver);
        } catch (error) {
          if (!(error instanceof PoisonError) || !info.decl) throw error;
          const fence = lowerer.deferToRuntimeFence(before, info.decl, { kind: "statement" });
          if (!fence) throw error;
          branch = [fence];
        }
        dispatch.fn.body.unshift({
          kind: "if",
          cond: condition,
          then: branch,
          else_: null,
          loc,
        });
        changed = true;
      }
    }
    for (const dispatch of this.computed.values()) {
      for (const plan of this.propertyReceivers(lowerer, true)) {
        if (dispatch.classes.has(plan.key)) continue;
        const { info } = plan;
        dispatch.classes.add(plan.key);
        const loc = dispatch.fn.loc;
        const selected = this.propertyReceiver(plan, loc);
        const receiverType: IrType = { kind: "object", className: info.def.name };
        const receiver = varRef("p.receiver", receiverType, loc);
        const helperKey = JSON.stringify([dispatch.fn.name, info.def.name]);
        const existingHelper = this.computedClassHelpers.get(helperKey);
        const callHelper = (helper: IrFunction): IrStmt => {
          const call: IrExpr = {
            kind: "call",
            callee: helper.name,
            args: helper.params.map((param) =>
              param.localId === "p.receiver"
                ? selected.receiver
                : varRef(param.localId, param.type, loc),
            ),
            type: helper.returnType,
            loc,
          };
          return {
            kind: "if",
            cond: selected.condition,
            then:
              dispatch.write && !dispatch.reflect
                ? [
                    { kind: "exprStmt", expr: call, loc },
                    { kind: "return", value: null, loc },
                  ]
                : [{ kind: "return", value: call, loc }],
            else_: null,
            loc,
          };
        };
        if (existingHelper && !dispatch.dynamicKey) {
          dispatch.fn.body.splice(dispatch.branchIndex, 0, callHelper(existingHelper));
          changed = true;
          continue;
        }
        const memberBody = (name: string): IrStmt[] => {
          if (
            dispatch.probe &&
            (name === "message" || name === "name") &&
            lowerer.isSubclassOf(info.def.name, "%Error") &&
            dispatch.probe !== "in"
          )
            return [
              {
                kind: "return",
                value:
                  dispatch.probe === "own"
                    ? {
                        kind: "fieldGet",
                        obj: lowerer.upcastTo(receiver, "%Error"),
                        className: "%Error",
                        field: `%${name}Present`,
                        type: BOOL,
                        loc,
                      }
                    : {
                        kind: "fieldGet",
                        obj: lowerer.upcastTo(receiver, "%Error"),
                        className: "%Error",
                        field: `%${name}Enumerable`,
                        type: BOOL,
                        loc,
                      },
                loc,
              },
            ];
          if (
            ((info.builtinStream !== undefined && streamProperty(name)) ||
              eventTargetInheritedMember(info, name)) &&
            dispatch.probe
          )
            return [
              {
                kind: "return",
                value: { kind: "boolLit", value: dispatch.probe === "in", type: BOOL, loc },
                loc,
              },
            ];
          if (!dispatch.probe)
            return dispatch.reflect
              ? this.reflectPropertyBody(lowerer, { ...dispatch, name }, info, receiver)
              : this.propertyBody(lowerer, { ...dispatch, name }, info, receiver);
          const prototypeMethod =
            !info.fields.has(name) && observedPrototypeMethod(lowerer, info, name, loc, receiver);
          if (info.fields.has(name) || (dispatch.probe === "in" && !prototypeMethod)) {
            if (info.fields.has(name) && info.def.tracksOwnFields) {
              const bag = this.readPropertyBagOrEmpty(
                lowerer,
                lowerer.coerceToExpected(receiver, DYN),
                loc,
              );
              const symbol = symbolMemberKey(lowerer, info, name, loc);
              const fn =
                dispatch.probe === "in"
                  ? "dyn.hasKey"
                  : dispatch.probe === "own"
                    ? "dyn.hasOwn"
                    : "dyn.propertyIsEnumerable";
              return [
                {
                  kind: "return",
                  value: {
                    kind: "libCall",
                    fn: symbol ? `${fn}Computed` : fn,
                    args: [bag, symbol ?? { kind: "strLit", value: name, type: STRING, loc }],
                    type: BOOL,
                    loc,
                  },
                  loc,
                },
              ];
            }
            return [
              { kind: "return", value: { kind: "boolLit", value: true, type: BOOL, loc }, loc },
            ];
          }
          const bag = this.readPropertyBagOrEmpty(
            lowerer,
            lowerer.coerceToExpected(receiver, DYN),
            loc,
          );
          const symbol = name.startsWith("sym:") || name.startsWith("%symbol:");
          const fn =
            dispatch.probe === "in"
              ? "dyn.hasKey"
              : dispatch.probe === "own"
                ? "dyn.hasOwn"
                : "dyn.propertyIsEnumerable";
          return [
            {
              kind: "return",
              value: {
                kind: "libCall",
                fn: symbol ? `${fn}Computed` : fn,
                args: [
                  bag,
                  symbol
                    ? varRef("p.key", DYN, loc)
                    : { kind: "strLit", value: name, type: STRING, loc },
                ],
                type: BOOL,
                loc,
              },
              loc,
            },
          ];
        };
        if (dispatch.dynamicKey) {
          const symbols = new Map<string, IrExpr>();
          const symbolEntries: [ts.Symbol, string][] = [];
          if (info.symbolFields)
            for (const [symbol, name] of info.symbolFields) symbolEntries.push([symbol, name]);
          if (info.symbolMethods)
            for (const [symbol, name] of info.symbolMethods) symbolEntries.push([symbol, name]);
          for (const [symbol, name] of symbolEntries) {
            const declaration = symbol.valueDeclaration;
            // Module-scope consts and CommonJS key-table properties
            // (classSymbolKeyOfSymbol) both hold their key in a global.
            if (
              declaration &&
              ((ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) ||
                ts.isPropertyAssignment(declaration))
            ) {
              const global = lowerer.globalsBySymbol.get(symbol);
              if (global)
                symbols.set(
                  name,
                  lowerer.coerceToExpected(varRef(global.id, global.type, loc), DYN),
                );
            }
          }
          for (let owner: ClassInfo | null = info; owner; owner = owner.base) {
            for (const name of [...owner.methods.keys()])
              if (name.startsWith("sym:")) {
                symbols.set(name, {
                  kind: "dynFrom",
                  type: DYN,
                  loc,
                  value: {
                    kind: "libCall",
                    fn: "sym.wellKnown",
                    args: [{ kind: "strLit", value: name.slice(4), type: STRING, loc }],
                    type: SYMBOL_T,
                    loc,
                  },
                });
              }
          }
          const branches: IrStmt[] = [];
          if (!dispatch.write && !dispatch.reflect && !info.def.tracksOwnFields) {
            const value = varRef("p.0", DYN, loc);
            const key = varRef("p.key", DYN, loc);
            const bag = this.readPropertyBagOrEmpty(lowerer, value, loc);
            branches.push({
              kind: "if",
              cond: {
                kind: "libCall",
                fn: "dyn.hasOwnComputed",
                args: [bag, key],
                type: BOOL,
                loc,
              },
              then: [
                {
                  kind: "return",
                  value: dispatch.probe
                    ? {
                        kind: "libCall",
                        fn:
                          dispatch.probe === "enumerable"
                            ? "dyn.propertyIsEnumerableComputed"
                            : "dyn.hasOwnComputed",
                        args: [bag, key],
                        type: BOOL,
                        loc,
                      }
                    : { kind: "dynKeyGet", value: bag, key, type: DYN, loc },
                  loc,
                },
              ],
              else_: null,
              loc,
            });
          }
          for (const [name, symbol] of symbols) {
            const before = lowerer.diags.length;
            let then: IrStmt[];
            try {
              then = memberBody(name);
            } catch (error) {
              if (!(error instanceof PoisonError) || !info.decl) throw error;
              const fence = lowerer.deferToRuntimeFence(before, info.decl, { kind: "statement" });
              if (!fence) throw error;
              then = [fence];
            }
            branches.push({
              kind: "if",
              cond: {
                kind: "dynScalarEq",
                left: varRef("p.key", DYN, loc),
                right: symbol,
                type: BOOL,
                loc,
              },
              then,
              else_: null,
              loc,
            });
          }
          if (branches.length) {
            dispatch.fn.body.unshift({
              kind: "if",
              cond: selected.condition,
              then: [
                {
                  kind: "if",
                  cond: {
                    kind: "dynTest",
                    test: "symbol",
                    value: varRef("p.key", DYN, loc),
                    type: BOOL,
                    loc,
                  },
                  then: transformStmtList(branches, {
                    stmt: (statement) => statement,
                    expr: (expression) =>
                      expression.kind === "varRef" && expression.localId === "p.receiver"
                        ? selected.receiver
                        : expression,
                  }),
                  else_: null,
                  loc,
                },
              ],
              else_: null,
              loc,
            });
            dispatch.branchIndex++;
          }
        }
        if (existingHelper) {
          dispatch.fn.body.splice(dispatch.branchIndex, 0, callHelper(existingHelper));
          changed = true;
          continue;
        }
        const names = new Set([...info.fields.keys()].filter(isClassOwnEnumerableFieldName));
        if (info.builtinStream)
          for (const name of [...STREAM_BOOL_PROPERTIES, ...STREAM_NUM_PROPERTIES]) names.add(name);
        const inherited = eventTargetApiMembers(info);
        if (inherited) for (const name of inherited) names.add(name);

        for (let owner: ClassInfo | null = info; owner; owner = owner.base) {
          const methodNames = [...owner.methods.keys()];
          if (owner.genericMethods) methodNames.push(...[...owner.genericMethods.keys()]);
          for (const method of methodNames) {
            const name =
              method.startsWith("get:") || method.startsWith("set:") ? method.slice(4) : method;
            if (isClassOwnEnumerableFieldName(name) && !name.startsWith("sym:")) names.add(name);
          }
        }
        const branch: IrStmt[] = [];
        for (const name of names) {
          if (dispatch.numericKey && String(Number(name)) !== name) continue;
          const before = lowerer.diags.length;
          let body: IrStmt[];
          try {
            body = memberBody(name);
          } catch (error) {
            if (!(error instanceof PoisonError) || !info.decl) throw error;
            const fence = lowerer.deferToRuntimeFence(before, info.decl, { kind: "statement" });
            if (!fence) throw error;
            body = [fence];
          }
          branch.push({
            kind: "if",
            cond: {
              kind: "strEq",
              left: varRef(dispatch.keyLocal, STRING, loc),
              right: { kind: "strLit", value: name, type: STRING, loc },
              negated: false,
              type: BOOL,
              loc,
            },
            then: body,
            else_: null,
            loc,
          });
        }
        // Keep each class's key table in a separate function. A single
        // function containing every boxed class grows quadratically during
        // LLVM's control-flow optimization for large library workloads.
        const params = [
          ...dispatch.fn.params,
          { localId: "p.receiver", name: "receiver", type: receiverType },
        ];
        // A derived key (a dynamic key's string, or an index's name) is a
        // local of the dispatch helper; pass it along.
        if (!dispatch.fn.params.some((param) => param.localId === dispatch.keyLocal))
          params.push({ localId: dispatch.keyLocal, name: "key", type: STRING });
        const helper: IrFunction = {
          name: `%dyn.class.keys.${lowerer.liftedFns.length}`,
          params,
          returnType: dispatch.fn.returnType,
          locals: params.map((p) => ({
            id: p.localId,
            name: p.name,
            type: p.type,
            mutable: false,
          })),
          body: [
            ...branch,
            ...transformStmtList(dispatch.fn.body.slice(dispatch.write ? -2 : -1), {
              stmt: (statement) => statement,
              expr: (expression) =>
                expression.kind === "dynKeyGet" && expression.key.type.kind === "string"
                  ? {
                      kind: "libCall",
                      fn: "dyn.bagGet",
                      args: [
                        expression.value,
                        expression.key,
                        lowerer.coerceToExpected(receiver, DYN),
                      ],
                      type: DYN,
                      loc,
                    }
                  : expression.kind === "libCall" && expression.fn === "dyn.keySet"
                    ? {
                        ...expression,
                        fn: "dyn.bagSet",
                        args: [...expression.args, lowerer.coerceToExpected(receiver, DYN)],
                      }
                    : expression,
            }),
          ],
          loc,
        };
        this.generated.add(helper);
        lowerer.liftedFns.push(helper);
        this.computedClassHelpers.set(helperKey, helper);
        dispatch.fn.body.splice(dispatch.branchIndex, 0, callHelper(helper));
        changed = true;
      }
    }
    for (const [fn, enumeration] of this.enumerations)
      for (const plan of this.propertyReceivers(lowerer, false, false)) {
        const classKey = `${fn}:${plan.key}`;
        if (!plan.info.def.tracksOwnFields || this.enumerationClasses.has(classKey)) continue;
        this.enumerationClasses.add(classKey);
        const loc = enumeration.loc;
        const { condition } = this.propertyReceiver(plan, loc);
        const bag = this.readPropertyBagOrEmpty(lowerer, varRef("p.0", DYN, loc), loc);
        enumeration.body.unshift({
          kind: "if",
          cond: condition,
          then: [
            {
              kind: "return",
              value: { kind: "libCall", fn, args: [bag], type: enumeration.returnType, loc },
              loc,
            },
          ],
          else_: null,
          loc,
        });
        changed = true;
      }
    if (this.constructDispatch)
      for (const [name, info] of this.constructors) {
        if (this.constructed.has(name)) continue;
        this.constructed.add(name);
        const loc = this.constructDispatch.loc;
        const callee = varRef("p.0", DYN, loc),
          input = varRef("p.1", DYN, loc);
        const args: IrExpr[] = [];
        let supported = true;
        for (let i = 0; i < info.ctorParams.length; i++) {
          const param = info.ctorParams[i]!;
          if (param.mode !== "required" && param.mode !== "omittable") {
            supported = false;
            break;
          }
          const value: IrExpr = {
            kind: "dynKeyGet",
            value: input,
            key: { kind: "strLit", value: String(i), type: STRING, loc },
            type: DYN,
            loc,
          };
          const arg = lowerer.coerceToExpected(value, param.type);
          if (!typeEquals(arg.type, param.type)) {
            supported = false;
            break;
          }
          args.push(arg);
        }
        if (!supported || !info.decl) continue;
        const cls = classValueRef(lowerer, info, info.decl);
        const result = constructedValue(lowerer, info, {
          kind: "new",
          className: name,
          args,
          type: { kind: "object", className: name },
          loc,
        });
        this.constructDispatch.body.unshift({
          kind: "if",
          cond: {
            kind: "dynScalarEq",
            left: callee,
            right: lowerer.coerceToExpected(cls, DYN),
            type: BOOL,
            loc,
          },
          then: [{ kind: "return", value: lowerer.coerceToExpected(result, DYN), loc }],
          else_: null,
          loc,
        });
        changed = true;
      }
    if (this.staticPropertyBag)
      for (const name of this.boxedConstructors) {
        if (this.staticBagClasses.has(name)) continue;
        const info = lowerer.classes.get(name);
        if (!info?.decl || !isJsSourceFile(ts.getSourceFileOfNode(info.decl))) continue;
        const loc = this.staticPropertyBag.loc;
        const bag = classStaticData(lowerer, info, loc);
        if (!bag) continue;
        this.staticBagClasses.add(name);
        const value = varRef("value", DYN, loc);
        this.staticPropertyBag.body.unshift({
          kind: "if",
          cond: {
            kind: "libCall",
            fn: "dyn.classIs",
            args: [
              value,
              {
                kind: "strLit",
                value: typeKey({ kind: "classval", className: name }),
                type: STRING,
                loc,
              },
            ],
            type: BOOL,
            loc,
          },
          then: [{ kind: "return", value: bag, loc }],
          else_: null,
          loc,
        });
        changed = true;
      }
    changed = this.normalizeDispatches(lowerer) || changed;
    for (const fn of this.generated) fn.speculativeDispatch = true;
    return changed;
  }

  /** The receiver's own dynamic properties for a read: undefined while it has
   * none, and never stored, so reads stay valid on published objects. */
  private readPropertyBag(lowerer: Lowerer, receiver: IrExpr, loc: SrcLoc): IrExpr {
    const helper = classPropertiesHelper(lowerer, loc, true);
    this.generated.add(helper);
    return {
      kind: "call",
      callee: helper.name,
      args: [receiver.type.kind === "dyn" ? receiver : lowerer.coerceToExpected(receiver, DYN)],
      type: DYN,
      loc,
    };
  }

  /** The bag a read looks a key up in (`%dyn.class.readPropertiesOrEmpty`):
   * the receiver's own properties, or a fresh empty object (not stored) while
   * an instance has none, so inherited Object.prototype members still resolve
   * as on an empty bag. A non-instance is its own bag; an undefined receiver
   * stays undefined so the read throws Node's TypeError. */
  /** A key test on a read-only bag, which is undefined while the object has no
   * own dynamic properties. A shared helper evaluates the bag once and keeps
   * each class branch as small as the storing form. */
  private readBagHas(
    lowerer: Lowerer,
    fn: "dyn.hasKey" | "dyn.hasOwnComputed",
    bag: IrExpr,
    key: IrExpr,
    loc: SrcLoc,
  ): IrExpr {
    const name = fn === "dyn.hasKey" ? "%dyn.class.bagHas" : "%dyn.class.bagHasComputed";
    let helper = lowerer.liftedFns.find((item) => item.name === name);
    if (!helper) {
      const keyType = fn === "dyn.hasKey" ? STRING : DYN;
      const value = varRef("p.0", DYN, loc);
      helper = {
        name,
        params: [
          { localId: "p.0", name: "bag", type: DYN },
          { localId: "p.1", name: "key", type: keyType },
        ],
        returnType: BOOL,
        locals: [
          { id: "p.0", name: "bag", type: DYN, mutable: false },
          { id: "p.1", name: "key", type: keyType, mutable: false },
        ],
        body: [
          {
            kind: "if",
            cond: { kind: "dynTest", test: "undefined", value, type: BOOL, loc },
            then: [
              { kind: "return", value: { kind: "boolLit", value: false, type: BOOL, loc }, loc },
            ],
            else_: null,
            loc,
          },
          {
            kind: "return",
            value: {
              kind: "libCall",
              fn,
              args: [value, varRef("p.1", keyType, loc)],
              type: BOOL,
              loc,
            },
            loc,
          },
        ],
        loc,
      };
      lowerer.liftedFns.push(helper);
    }
    this.generated.add(helper);
    return { kind: "call", callee: name, args: [bag, key], type: BOOL, loc };
  }

  /** The hints for which some boxed class declares a conversion method. A
   * string conversion calls toString first, so without a declared toString
   * or Symbol.toPrimitive it answers Object.prototype.toString's
   * "[object Object]" as before. */
  private convertingHints(lowerer: Lowerer): Set<ToPrimitiveHint> {
    const hints = new Set<ToPrimitiveHint>();
    for (const { info } of this.propertyReceivers(lowerer)) {
      if (
        conversionMethod(lowerer, info, "sym:toPrimitive") ||
        conversionMethod(lowerer, info, "toString")
      ) {
        hints.add("string");
        hints.add("number");
        hints.add("default");
      } else if (conversionMethod(lowerer, info, "valueOf")) {
        hints.add("number");
        hints.add("default");
      }
    }
    return hints;
  }

  /** An operation that converts dynamic operands to primitives, with each
   * operand passed through the hint's conversion helper first. Operations
   * with two dynamic operands evaluate both before converting the left one,
   * as JavaScript does. Returns null when `expr` needs no conversion. */
  private convertOperands(
    lowerer: Lowerer,
    fn: IrFunction,
    expr: IrExpr,
    converting: Set<ToPrimitiveHint>,
  ): IrExpr | null {
    const hint = toPrimitiveHint(expr);
    if (hint === null || !converting.has(hint)) return null;
    const loc = expr.loc;
    const convert = (value: IrExpr): IrExpr => ({
      kind: "call",
      callee: this.toPrimitiveHelper(lowerer, hint, loc),
      args: [value],
      type: DYN,
      loc,
    });
    if (expr.kind === "toString") {
      if (isConversion(expr.operand)) return null;
      return { ...expr, operand: convert(expr.operand) };
    }
    if (expr.kind === "dynKeyGet") {
      // A computed read converts its key after evaluating the receiver,
      // unless the receiver is null or undefined.
      if (expr.key.type.kind !== "dyn" || isConversion(expr.key)) return null;
      const [receiver, key] = this.hoistOperands(fn, [expr.value, expr.key], loc) as [
        Hoisted,
        Hoisted,
      ];
      return {
        kind: "seqExpr",
        stmts: receiver.stmts.concat(key.stmts),
        result: {
          ...expr,
          value: receiver.value,
          key: {
            kind: "ternary",
            cond: {
              kind: "dynTest",
              test: "nullish",
              negated: true,
              value: receiver.value,
              type: BOOL,
              loc,
            },
            then: convert(key.value),
            else_: key.value,
            type: DYN,
            loc,
          },
        },
        type: expr.type,
        loc,
      };
    }
    if (expr.kind !== "libCall") return null;
    const receiverNeeds = KEY_CALLS.get(expr.fn);
    if (receiverNeeds) {
      if (expr.args[1]?.type.kind !== "dyn" || isConversion(expr.args[1])) return null;
      // Every operand is evaluated before the key converts, as in
      // `obj[key] = value`, where the value is evaluated first.
      const hoisted = this.hoistOperands(fn, expr.args, loc);
      const args = hoisted.map((operand) => operand.value);
      const receiver = args[0]!;
      const admits: IrExpr | null =
        receiverNeeds === "any"
          ? null
          : receiverNeeds === "object"
            ? { kind: "unary", op: "!", operand: isPrimitive(receiver, loc), type: BOOL, loc }
            : { kind: "dynTest", test: "nullish", negated: true, value: receiver, type: BOOL, loc };
      args[1] = admits
        ? {
            kind: "ternary",
            cond: admits,
            then: convert(args[1]!),
            else_: args[1]!,
            type: DYN,
            loc,
          }
        : convert(args[1]!);
      return {
        kind: "seqExpr",
        stmts: hoisted.flatMap((operand) => operand.stmts),
        result: { ...expr, args },
        type: expr.type,
        loc,
      };
    }
    const dynamic = expr.args.flatMap((arg, i) => (arg.type.kind === "dyn" ? [i] : []));
    if (dynamic.some((i) => isConversion(expr.args[i]!) && expr.args[i]!.kind !== "dynFrom"))
      return null;
    const operands = dynamic.filter((i) => !isConversion(expr.args[i]!));
    if (operands.length === 0) return null;
    if (expr.args.length === 1) return { ...expr, args: [convert(expr.args[0]!)] };
    // Every operand is evaluated before the first conversion.
    const hoisted = expr.args.map((arg): Hoisted =>
      arg.kind === "strLit" || arg.kind === "numLit" || arg.kind === "boolLit"
        ? { stmts: [], value: arg }
        : this.hoistOperands(fn, [arg], loc)[0]!,
    );
    const args = hoisted.map((operand) => operand.value);
    if (expr.fn === "dyn.abstractEq") {
      // Loose equality converts an object only when the other operand is a
      // primitive other than null and undefined.
      if (dynamic.length !== 2) return null;
      const primitive = (value: IrExpr): IrExpr =>
        (["number", "string", "boolean", "bigint", "symbol"] as const)
          .map((test): IrExpr => ({ kind: "dynTest", test, value, type: BOOL, loc }))
          .reduce((a, b) => ({ kind: "logical", op: "||", left: a, right: b, type: BOOL, loc }));
      const [left, right] = [args[0]!, args[1]!];
      for (const i of operands)
        args[i] = {
          kind: "ternary",
          cond: primitive(i === 0 ? right : left),
          then: convert(args[i]!),
          else_: args[i]!,
          type: DYN,
          loc,
        };
    } else for (const i of operands) args[i] = convert(args[i]!);
    return {
      kind: "seqExpr",
      stmts: hoisted.flatMap((operand) => operand.stmts),
      result: { ...expr, args },
      type: expr.type,
      loc,
    };
  }

  /** The method and accessor names of boxed classes whose instances can
   * carry their class's prototype data. */
  private prototypeMemberNames(lowerer: Lowerer): Set<string> {
    const names = new Set<string>();
    for (const { info } of this.propertyReceivers(lowerer)) {
      if (!hasClassPrototypeData(info)) continue;
      for (let c: ClassInfo | null = info; c; c = c.base)
        for (const name of c.methods.keys())
          names.add(name.startsWith("get:") || name.startsWith("set:") ? name.slice(4) : name);
    }
    return names;
  }

  /** The methods some boxed class declares among valueOf and toString. */
  private calledConversions(lowerer: Lowerer): Set<"valueOf" | "toString"> {
    const methods = new Set<"valueOf" | "toString">();
    for (const { info } of this.propertyReceivers(lowerer)) {
      if (conversionMethod(lowerer, info, "valueOf")) methods.add("valueOf");
      if (conversionMethod(lowerer, info, "toString")) methods.add("toString");
    }
    return methods;
  }

  /** `value.valueOf()` or `value.toString(argument)` on a dynamic receiver:
   * a boxed instance of a class declaring the method calls it, any other
   * value keeps the runtime method call. The toString result must be a
   * string, as for the runtime's own-member call. */
  private convertMethodCall(
    lowerer: Lowerer,
    fn: IrFunction,
    expr: IrExpr,
    calling: Set<"valueOf" | "toString">,
  ): IrExpr | null {
    if (expr.kind !== "libCall" || (expr.fn !== "dyn.valueOf" && expr.fn !== "dyn.toString"))
      return null;
    const method = expr.fn === "dyn.valueOf" ? "valueOf" : "toString";
    const receiver = expr.args[0]!;
    if (!calling.has(method)) return null;
    if (receiver.kind === "varRef" && receiver.localId.startsWith(CONVERSION_CALL_PREFIX))
      return null;
    const loc = expr.loc;
    const operands = this.hoistOperands(
      fn,
      method === "toString" ? [receiver, expr.args[1]!] : [receiver],
      loc,
      CONVERSION_CALL_PREFIX,
    );
    const values = operands.map((operand) => operand.value);
    const helpers = this.conversionCallHelpers(lowerer, method, loc);
    return {
      kind: "seqExpr",
      stmts: operands.flatMap((operand) => operand.stmts),
      result: {
        kind: "ternary",
        cond: { kind: "call", callee: helpers.test.name, args: [values[0]!], type: BOOL, loc },
        then: { kind: "call", callee: helpers.call.name, args: values, type: expr.type, loc },
        else_: { ...expr, args: [...values, ...expr.args.slice(values.length)] },
        type: expr.type,
        loc,
      },
      type: expr.type,
      loc,
    };
  }

  private conversionCallHelpers(
    lowerer: Lowerer,
    method: "valueOf" | "toString",
    loc: SrcLoc,
  ): { test: IrFunction; call: IrFunction } {
    let helpers = this.conversionCalls.get(method);
    if (!helpers) {
      const at = helperLoc(loc);
      const params: IrParam[] = [
        { localId: "p.0", name: "value", type: DYN },
        ...(method === "toString" ? [{ localId: "p.1", name: "argument", type: DYN }] : []),
      ];
      const locals = params.map((param) => ({
        id: param.localId,
        name: param.name,
        type: param.type,
        mutable: false,
      }));
      const name = { kind: "strLit" as const, value: method, type: STRING, loc: at };
      const test: IrFunction = {
        name: `${TO_PRIMITIVE_PREFIX}${method}.test`,
        params: params.slice(0, 1),
        locals: locals.slice(0, 1),
        returnType: BOOL,
        body: [
          {
            kind: "return",
            value: { kind: "boolLit", value: false, type: BOOL, loc: at },
            loc: at,
          },
        ],
        loc: at,
      };
      const call: IrFunction = {
        name: `${TO_PRIMITIVE_PREFIX}${method}.call`,
        params,
        locals,
        returnType: method === "toString" ? STRING : DYN,
        body: [
          {
            kind: "return",
            value:
              method === "toString"
                ? {
                    kind: "libCall",
                    fn: "dyn.toString",
                    args: [varRef("p.0", DYN, at), varRef("p.1", DYN, at), name],
                    type: STRING,
                    loc: at,
                  }
                : {
                    kind: "libCall",
                    fn: "dyn.valueOf",
                    args: [varRef("p.0", DYN, at), name],
                    type: DYN,
                    loc: at,
                  },
            loc: at,
          },
        ],
        loc: at,
      };
      helpers = { test, call, classes: new Set() };
      this.conversionCalls.set(method, helpers);
      this.generated.add(test);
      this.generated.add(call);
      lowerer.liftedFns.push(test, call);
    }
    return helpers;
  }

  /** Evaluates each operand into a fresh local, in order. */
  private hoistOperands(
    fn: IrFunction,
    operands: readonly IrExpr[],
    loc: SrcLoc,
    prefix = "%toPrimitive.operand.",
  ): Hoisted[] {
    return operands.map((operand) => {
      const id = `${prefix}${fn.locals.length}`;
      fn.locals.push({ id, name: "operand", type: operand.type, mutable: false });
      const stmts: IrStmt[] = [{ kind: "varDecl", localId: id, init: operand, loc }];
      return { stmts, value: varRef(id, operand.type, loc) };
    });
  }

  /** The conversion helper for `hint`: a boxed class instance answers its
   * OrdinaryToPrimitive result, any other value is returned unchanged for
   * the runtime operation to convert. Arms are added per boxed class. */
  private toPrimitiveHelper(lowerer: Lowerer, hint: ToPrimitiveHint, loc: SrcLoc): string {
    let conversion = this.toPrimitives.get(hint);
    if (!conversion) {
      const at = helperLoc(loc);
      const fn: IrFunction = {
        name: `${TO_PRIMITIVE_PREFIX}${hint}`,
        params: [{ localId: "p.0", name: "value", type: DYN }],
        locals: [{ id: "p.0", name: "value", type: DYN, mutable: false }],
        returnType: DYN,
        body: [{ kind: "return", value: varRef("p.0", DYN, at), loc: at }],
        loc: at,
      };
      conversion = { fn, classes: new Set() };
      this.toPrimitives.set(hint, conversion);
      this.generated.add(fn);
      lowerer.liftedFns.push(fn);
    }
    return conversion.fn.name;
  }

  /** OrdinaryToPrimitive for one boxed class: the declared conversion
   * methods in hint order, each result returned when it is a primitive.
   * Object.prototype.valueOf answers the object itself and its toString
   * answers "[object Object]". */
  private toPrimitiveArm(
    lowerer: Lowerer,
    plan: PropertyReceiver,
    hint: ToPrimitiveHint,
    helper: IrFunction,
  ): IrStmt | null {
    const { info } = plan;
    const loc = helper.loc;
    const { condition } = this.propertyReceiver(plan, loc);
    if (conversionMethod(lowerer, info, "sym:toPrimitive")) {
      // A Symbol.toPrimitive method decides alone: its result must be a
      // primitive.
      const result = `%toPrimitive.exotic.${helper.locals.length}`;
      helper.locals.push({ id: result, name: "exotic", type: DYN, mutable: false });
      const hintValue: IrExpr = {
        kind: "dynFrom",
        value: { kind: "strLit", value: hint, type: STRING, loc },
        type: DYN,
        loc,
      };
      const body: IrStmt[] = [
        {
          kind: "varDecl",
          localId: result,
          init: {
            kind: "call",
            callee: this.toPrimitiveCall(lowerer, plan, "sym:toPrimitive", 1, loc),
            args: [varRef("p.0", DYN, loc), hintValue],
            type: DYN,
            loc,
          },
          loc,
        },
        {
          kind: "if",
          cond: isPrimitive(varRef(result, DYN, loc), loc),
          then: [{ kind: "return", value: varRef(result, DYN, loc), loc }],
          else_: null,
          loc,
        },
        {
          kind: "return",
          value: nodeThrowExpr(1, "", "Cannot convert object to primitive value", DYN, loc),
          loc,
        },
      ];
      return { kind: "if", cond: condition, then: body, else_: null, loc };
    }
    const order: ("valueOf" | "toString")[] =
      hint === "string" ? ["toString", "valueOf"] : ["valueOf", "toString"];
    if (!order.some((method) => conversionMethod(lowerer, info, method))) return null;
    if (hint === "string" && !conversionMethod(lowerer, info, "toString")) return null;
    const body: IrStmt[] = [];
    let settled = false;
    for (const method of order) {
      if (!conversionMethod(lowerer, info, method)) {
        if (method === "toString") {
          body.push({
            kind: "return",
            value: {
              kind: "dynFrom",
              value: { kind: "strLit", value: "[object Object]", type: STRING, loc },
              type: DYN,
              loc,
            },
            loc,
          });
          settled = true;
          break;
        }
        continue;
      }
      const result = `%toPrimitive.${method}.${helper.locals.length}`;
      helper.locals.push({ id: result, name: method, type: DYN, mutable: false });
      body.push(
        {
          kind: "varDecl",
          localId: result,
          init: {
            kind: "call",
            callee: this.toPrimitiveCall(lowerer, plan, method, 0, loc),
            args: [varRef("p.0", DYN, loc)],
            type: DYN,
            loc,
          },
          loc,
        },
        {
          kind: "if",
          cond: isPrimitive(varRef(result, DYN, loc), loc),
          then: [{ kind: "return", value: varRef(result, DYN, loc), loc }],
          else_: null,
          loc,
        },
      );
    }
    if (!settled)
      body.push({
        kind: "return",
        value: nodeThrowExpr(1, "", "Cannot convert object to primitive value", DYN, loc),
        loc,
      });
    return { kind: "if", cond: condition, then: body, else_: null, loc };
  }

  /** A function calling `method` with `arity` arguments on a boxed instance
   * of `plan`'s class, as a dynamic method call would: an own replacement on
   * the instance answers first for methods the program can replace. */
  private toPrimitiveCall(
    lowerer: Lowerer,
    plan: PropertyReceiver,
    method: ConversionMethod,
    arity: number,
    loc: SrcLoc,
  ): string {
    const key = JSON.stringify([plan.key, method, arity]);
    const existing = this.toPrimitiveCalls.get(key);
    if (existing) return existing.name;
    const { info } = plan;
    const { receiver } = this.propertyReceiver(plan, loc);
    const args = Array.from({ length: arity }, (_, i) => varRef(`p.${i + 1}`, DYN, loc));
    const source: Invoke = {
      kind: "dynInvoke",
      recv: varRef("p.0", DYN, loc),
      method,
      calleeName: method === "sym:toPrimitive" ? "value[Symbol.toPrimitive]" : `value.${method}`,
      args,
      type: DYN,
      loc,
    };
    const value = varRef("p.0", DYN, loc);
    let callback: IrExpr = dynUndefinedExpr(loc);
    if (isClassCallback(lowerer, info, method)) {
      const prototypeMethod = lowerer.prototypeMethodAccesses.has(method);
      if (prototypeMethod) classPrototypeData(lowerer, info, loc);
      const bag = this.readPropertyBagOrEmpty(lowerer, value, loc);
      callback = {
        kind: "ternary",
        cond: prototypeMethod
          ? { kind: "boolLit", value: true, type: BOOL, loc }
          : {
              kind: "libCall",
              fn: "dyn.hasKey",
              args: [bag, { kind: "strLit", value: method, type: STRING, loc }],
              type: BOOL,
              loc,
            },
        then: {
          kind: "dynObjLit",
          fields: [
            {
              key: { kind: "strLit", value: "value", type: STRING, loc },
              value: {
                kind: "dynKeyGet",
                value: bag,
                key: { kind: "strLit", value: method, type: STRING, loc },
                type: DYN,
                loc,
              },
            },
          ],
          type: DYN,
          loc,
        },
        else_: dynUndefinedExpr(loc),
        type: DYN,
        loc,
      };
    }
    const params: IrParam[] = [
      { localId: "p.0", name: "value", type: DYN },
      ...args.map((_, i) => ({ localId: `p.${i + 1}`, name: `p${i + 1}`, type: DYN })),
    ];
    const fn: IrFunction = {
      name: `${TO_PRIMITIVE_PREFIX}call.${this.toPrimitiveCalls.size}`,
      params,
      locals: [
        ...params.map((param) => ({
          id: param.localId,
          name: param.name,
          type: param.type,
          mutable: false,
        })),
        { id: "p.callback", name: "callback", type: DYN, mutable: false },
        { id: "p.calleeName", name: "calleeName", type: STRING, mutable: false },
      ],
      returnType: DYN,
      body: [],
      loc,
    };
    const dispatch: Dispatch = { source, fn, callback: fn, classes: new Set() };
    const before = lowerer.diags.length;
    let body: IrStmt[];
    try {
      body = this.methodBody(lowerer, dispatch, info, receiver);
    } catch (error) {
      if (!(error instanceof PoisonError) || !info.decl) throw error;
      const fence = lowerer.deferToRuntimeFence(before, info.decl, { kind: "statement" });
      if (!fence) throw error;
      body = [fence];
    }
    fn.body = [
      { kind: "varDecl", localId: "p.callback", init: callback, loc },
      {
        kind: "varDecl",
        localId: "p.calleeName",
        init: { kind: "strLit", value: source.calleeName, type: STRING, loc },
        loc,
      },
      ...body,
    ];
    this.toPrimitiveCalls.set(key, fn);
    this.generated.add(fn);
    lowerer.liftedFns.push(fn);
    return fn.name;
  }

  private readPropertyBagOrEmpty(lowerer: Lowerer, receiver: IrExpr, loc: SrcLoc): IrExpr {
    // One call per read site: large JS programs have a branch per class and
    // property, so the absent-bag handling lives in the shared helper.
    let helper = lowerer.liftedFns.find((fn) => fn.name === READ_PROPERTIES_OR_EMPTY);
    if (!helper) {
      // Settled by finalize; until then, the read-only bag's own dispatch.
      helper = {
        ...classPropertiesHelper(lowerer, loc, true),
        name: READ_PROPERTIES_OR_EMPTY,
      };
      helper = structuredClone(helper);
      lowerer.liftedFns.push(helper);
    }
    this.generated.add(helper);
    return {
      kind: "call",
      callee: helper.name,
      args: [receiver.type.kind === "dyn" ? receiver : lowerer.coerceToExpected(receiver, DYN)],
      type: DYN,
      loc,
    };
  }

  /** A known native class can access its shared bag directly. Keep the
   * receiver as an owned parameter so calls and temporary instances retain
   * their ordinary evaluation and lifetime rules without a boxed capsule. */
  private typedPropertyBag(
    lowerer: Lowerer,
    type: Extract<IrType, { kind: "object" }>,
    loc: SrcLoc,
    readOnly: boolean,
  ): IrFunction | null {
    // A superclass constructor can be the first code to access this bag.
    // Its receiver still needs the actual subclass's prototype.
    if (lowerer.classes.get(type.className)?.subclasses.length) return null;
    const key = `${type.className}:${readOnly}`;
    const existing = this.typedPropertyBags.get(key);
    if (existing) return existing;
    const initializers = this.bagInitializers.get(type.className);
    if (!initializers) return null;
    const receiver = varRef("p.0", type, loc);
    const bag: IrExpr = {
      kind: "fieldGet",
      obj: receiver,
      className: type.className,
      field: PROPERTY_BAG,
      type: DYN,
      loc,
    };
    const initialize: Extract<IrStmt, { kind: "fieldSet" }> = {
      ...initializers[0]!,
      obj: receiver,
      value: transformExpr(initializers[0]!.value, {
        stmt: (stmt) => stmt,
        expr: (expr) => {
          const checked = (e: IrExpr): boolean =>
            e.kind === "dynCheck" && e.value.kind === "varRef" && e.value.localId === "p.0";
          // The checked receiver, possibly cast to this class (the prototype
          // helper's argument), is the typed parameter itself.
          if (
            expr.kind === "downcast" &&
            checked(expr.value) &&
            expr.type.kind === "object" &&
            expr.type.className === type.className
          )
            return receiver;
          return checked(expr) ? receiver : expr;
        },
      }),
      loc,
    };
    const helper: IrFunction = {
      name: `%class.${readOnly ? "readProperties" : "properties"}:${type.className}`,
      params: [{ localId: "p.0", name: "value", type }],
      returnType: DYN,
      locals: [{ id: "p.0", name: "value", type, mutable: false }],
      loc,
      body: [
        {
          kind: "if",
          cond: { kind: "dynTest", test: "undefined", value: bag, type: BOOL, loc },
          then: [initialize],
          else_: null,
          loc,
        },
        { kind: "return", value: bag, loc },
      ],
    };
    initializers.push(initialize);
    this.typedPropertyBags.set(key, helper);
    if (readOnly) this.readPropertyBags.push({ helper, initialize });
    this.generated.add(helper);
    lowerer.liftedFns.push(helper);
    return helper;
  }

  /** The prototype a new property bag of `current` (or of the subclass the
   * receiver is) starts from, or null when `current` has no prototype data.
   * A class with constructible subclasses that have prototype data selects
   * it through its `%class.bagPrototype` helper; any other class reads its
   * own prototype data. */
  private bagPrototype(
    lowerer: Lowerer,
    current: ClassInfo,
    receiver: IrExpr,
    loc: SrcLoc,
  ): IrExpr | null {
    const arg: IrExpr =
      receiver.type.kind === "object" && receiver.type.className !== current.def.name
        ? {
            kind: "downcast",
            value: receiver,
            type: { kind: "object", className: current.def.name },
            loc,
          }
        : receiver;
    const helper = this.bagPrototypeHelper(lowerer, current, loc);
    return helper
      ? { kind: "call", callee: helper.name, args: [arg], type: DYN, loc }
      : classPrototypeData(lowerer, current, loc, arg);
  }

  /** `%class.bagPrototype:<class>(this)`: the prototype data of the most
   * derived constructible class `this` is an instance of, tested from the
   * last subclass to the first and then the class itself. One helper per
   * class, calling its subclasses' helpers, keeps every property-bag branch
   * a single call: a whole hierarchy inlined into each branch grows with the
   * square of its depth. Null when the class has no prototype data, in which
   * case its subclasses are not tested either, or while no constructible
   * subclass has any. The body is rebuilt on each use, as classes become
   * constructible. */
  private bagPrototypeHelper(lowerer: Lowerer, current: ClassInfo, loc: SrcLoc): IrFunction | null {
    const type: IrType = { kind: "object", className: current.def.name };
    const self = varRef("this", type, loc);
    const own = classPrototypeData(lowerer, current, loc, self);
    if (!own) return null;
    const body: IrStmt[] = [];
    const children = current.subclasses.filter((child) => lowerer.classCanBeConstructed(child));
    for (const child of children.reverse()) {
      const selected = this.bagPrototype(lowerer, child, self, loc);
      if (!selected) continue;
      body.push({
        kind: "if",
        cond: { kind: "instanceOf", value: self, className: child.def.name, type: BOOL, loc },
        then: [{ kind: "return", value: selected, loc }],
        else_: null,
        loc,
      });
    }
    let helper = this.bagPrototypeHelpers.get(current.def.name);
    if (!helper && body.length === 0) return null;
    body.push({ kind: "return", value: own, loc });
    if (!helper) {
      helper = {
        name: `%class.bagPrototype:${current.def.name}`,
        params: [{ localId: "this", name: "this", type }],
        returnType: DYN,
        locals: [{ id: "this", name: "this", type, mutable: false }],
        body,
        loc,
      };
      this.bagPrototypeHelpers.set(current.def.name, helper);
      this.generated.add(helper);
      lowerer.liftedFns.push(helper);
    }
    helper.body = body;
    return helper;
  }

  /** Prototype state may appear in a later reachable body, so read-only bags
   * settle only after the dispatch worklist closes. A read never stores: an
   * absent empty bag stays undefined (callers test it), and an absent
   * prototype-backed bag is produced for this read only. A published object
   * cannot take the store, and Node's reads never write. */
  finalize(lowerer?: Lowerer): void {
    for (const { helper, initialize } of this.readPropertyBags) {
      const absent = helper.body[0];
      if (isEmptyBag(initialize.value)) helper.body.shift();
      else if (absent?.kind === "if")
        absent.then = [{ kind: "return", value: initialize.value, loc: initialize.loc }];
    }
    // The untyped read-only accessor selects the receiver's class as the
    // complete property-bag dispatch does, without its lazy stores.
    for (const fn of lowerer?.liftedFns ?? []) {
      if (
        !this.propertyBag ||
        (fn.name !== READ_PROPERTIES && fn.name !== READ_PROPERTIES_OR_EMPTY)
      )
        continue;
      fn.locals = structuredClone(this.propertyBag.locals);
      fn.body = readOnlyBagBody(
        structuredClone(this.propertyBag.body),
        fn.name === READ_PROPERTIES_OR_EMPTY,
      );
    }
  }

  private normalizedDispatches(): IrFunction[] {
    return [
      ...(this.propertyBag ? [this.propertyBag] : []),
      ...[...this.properties.values()].map((dispatch) => dispatch.fn),
      ...[...this.computed.values()].map((dispatch) => dispatch.fn),
      ...[...this.dispatches.values()].flatMap((dispatch) => [dispatch.fn, dispatch.callback]),
      ...this.protocols,
    ];
  }

  private constructorPropertyBag(lowerer: Lowerer, loc: SrcLoc): IrFunction {
    if (!this.staticPropertyBag) {
      this.staticPropertyBag = {
        name: "%dyn.class.staticProperties",
        params: [{ localId: "value", name: "value", type: DYN }],
        returnType: DYN,
        locals: [{ id: "value", name: "value", type: DYN, mutable: false }],
        body: [{ kind: "return", value: varRef("value", DYN, loc), loc }],
        loc,
      };
      lowerer.liftedFns.push(this.staticPropertyBag);
      this.generated.add(this.staticPropertyBag);
    }
    return this.staticPropertyBag;
  }

  /** A base capsule and a derived capsule refer to the same native object.
   * Select its actual layout once, so each member table needs one branch
   * per class rather than one per possible base/derived capsule pair. */
  private normalizeDispatches(lowerer: Lowerer): boolean {
    const entries: { capsule: ClassInfo; children: ClassInfo[] }[] = [];
    for (const name of this.boxed) {
      const capsule = lowerer.classes.get(name);
      if (!capsule || capsule.builtinEmitter || capsule.builtinStream || capsule.builtinError)
        continue;
      const children: ClassInfo[] = [];
      const visit = (info: ClassInfo): void => {
        for (const child of info.subclasses) {
          if (lowerer.classCanBeConstructed(child)) children.push(child);
          visit(child);
        }
      };
      visit(capsule);
      if (children.length) entries.push({ capsule, children: children.reverse() });
    }
    if (!entries.length && !this.normalization) return false;
    const key = JSON.stringify(
      entries.map(({ capsule, children }) => [
        capsule.def.name,
        children.map((child) => child.def.name),
      ]),
    );
    let changed = key !== this.normalizationKey;
    if (!this.normalization) {
      const loc = this.propertyBag!.loc;
      this.normalization = {
        name: "%dyn.class.normalize",
        params: [{ localId: "value", name: "value", type: DYN }],
        returnType: DYN,
        locals: [{ id: "value", name: "value", type: DYN, mutable: false }],
        body: [],
        loc,
      };
      lowerer.liftedFns.push(this.normalization);
      this.generated.add(this.normalization);
      changed = true;
    }
    if (changed) {
      this.normalizationKey = key;
      const loc = this.normalization.loc;
      const value = varRef("value", DYN, loc);
      this.normalization.body = entries.map(({ capsule, children }): IrStmt => {
        const type: IrType = { kind: "object", className: capsule.def.name };
        const receiver: IrExpr = { kind: "dynCheck", value, type, loc };
        return {
          kind: "if",
          cond: {
            kind: "libCall",
            fn: "dyn.typedRefIs",
            args: [value, { kind: "strLit", value: typeKey(type), type: STRING, loc }],
            type: BOOL,
            loc,
          },
          then: children.map((child): IrStmt => ({
            kind: "if",
            cond: {
              kind: "instanceOf",
              value: receiver,
              className: child.def.name,
              type: BOOL,
              loc,
            },
            then: [
              {
                kind: "return",
                value: {
                  kind: "dynFrom",
                  value: {
                    kind: "downcast",
                    value: receiver,
                    type: { kind: "object", className: child.def.name },
                    loc,
                  },
                  type: DYN,
                  loc,
                },
                loc,
              },
            ],
            else_: null,
            loc,
          })),
          else_: null,
          loc,
        };
      });
      this.normalization.body.push({ kind: "return", value, loc });
    }
    for (const fn of this.normalizedDispatches()) {
      fn.locals.find((local) => local.id === "p.0")!.mutable = true;
      fn.body.unshift({
        kind: "assign",
        localId: "p.0",
        value: {
          kind: "call",
          callee: this.normalization.name,
          args: [varRef("p.0", DYN, fn.loc)],
          type: DYN,
          loc: fn.loc,
        },
        loc: fn.loc,
      });
    }
    return changed;
  }

  /** The hidden bag is part of the native object layout, so every capsule
   * shares it and normal class tracing/disposal owns its values. Insert it
   * at the same prefix offset throughout a hierarchy, including classes
   * collected before this untyped crossing was discovered. */
  private ensurePropertyBag(info: ClassInfo): void {
    if (info.fields.has(PROPERTY_BAG)) return;
    let root = info;
    while (root.base && !root.base.def.runtime) root = root.base;
    const index = root.def.fields.length;
    const add = (current: ClassInfo): void => {
      if (!current.fields.has(PROPERTY_BAG)) {
        current.fields.set(PROPERTY_BAG, DYN);
        current.def.fields.splice(index, 0, { name: PROPERTY_BAG, type: DYN });
      }
      current.subclasses.forEach(add);
    };
    add(root);
  }

  /** A capsule retains its static type, while its object may be a subclass.
   * Preorder insertion lets later branches test the most derived layout first. */
  private propertyReceivers(
    lowerer: Lowerer,
    streams = false,
    normalize = true,
  ): PropertyReceiver[] {
    const plans: PropertyReceiver[] = [];
    const seen = new Set<string>();
    for (const name of this.boxed) {
      const capsule = lowerer.classes.get(name);
      if (
        !capsule ||
        ((capsule.builtinEmitter || capsule.builtinStream) && !streams) ||
        capsule.builtinError
      )
        continue;
      const canonical = normalize && !capsule.builtinStream && !capsule.builtinEmitter;
      const visit = (info: ClassInfo): void => {
        if (
          (!canonical || !seen.has(info.def.name)) &&
          (info === capsule || lowerer.classCanBeConstructed(info))
        ) {
          seen.add(info.def.name);
          plans.push({
            info,
            capsule: canonical ? info : capsule,
            key: canonical ? info.def.name : JSON.stringify([name, info.def.name]),
          });
        }
        for (const child of info.subclasses) visit(child);
      };
      visit(capsule);
    }
    return plans;
  }

  private propertyReceiver(
    plan: PropertyReceiver,
    loc: SrcLoc,
  ): { receiver: IrExpr; condition: IrExpr } {
    const value = varRef("p.0", DYN, loc);
    const type: IrType = { kind: "object", className: plan.capsule.def.name };
    const checked: IrExpr = { kind: "dynCheck", value, type, loc };
    const matches: IrExpr = {
      kind: "libCall",
      fn: "dyn.typedRefIs",
      args: [value, { kind: "strLit", value: typeKey(type), type: STRING, loc }],
      type: BOOL,
      loc,
    };
    if (plan.info === plan.capsule) return { receiver: checked, condition: matches };
    return {
      receiver: {
        kind: "downcast",
        value: checked,
        type: { kind: "object", className: plan.info.def.name },
        loc,
      },
      condition: {
        kind: "ternary",
        cond: matches,
        then: {
          kind: "instanceOf",
          value: checked,
          className: plan.info.def.name,
          type: BOOL,
          loc,
        },
        else_: { kind: "boolLit", value: false, type: BOOL, loc },
        type: BOOL,
        loc,
      },
    };
  }

  private reflectPropertyBody(
    lowerer: Lowerer,
    dispatch: PropertyDispatch,
    info: ClassInfo,
    receiver: IrExpr,
  ): IrStmt[] {
    const { name, write } = dispatch;
    const loc = dispatch.fn.loc;
    const actualReceiver = varRef("p.reflectReceiver", DYN, loc);
    const instance = lowerer.coerceToExpected(receiver, DYN);
    const key: IrExpr = { kind: "strLit", value: name, type: STRING, loc };
    const field = info.fields.get(name);
    const member = `${write ? "set" : "get"}:${name}`;
    const accessor = field ? null : findMethodOn(lowerer, info, member);
    const bag: IrExpr = {
      kind: "call",
      callee: this.propertyBag!.name,
      args: [instance],
      type: DYN,
      loc,
    };
    const fallback: IrExpr = {
      kind: "libCall",
      fn: write ? "dyn.reflectSet" : "dyn.reflectGet",
      args: [
        bag,
        lowerer.coerceToExpected(key, DYN),
        ...(write ? [varRef("p.1", DYN, loc)] : []),
        actualReceiver,
      ],
      type: write ? BOOL : DYN,
      loc,
    };
    if (accessor && info.decl) {
      // An accessor whose private names belong to one evaluation runs as
      // the instance's own evaluation's prototype accessor.
      const declarer = accessor.declarer;
      const prototype = perEvaluationPrivateNames(declarer)
        ? classPrototypeData(lowerer, declarer, loc, upcastTo(lowerer, receiver, declarer.def.name))
        : null;
      const method = prototype ? null : classMethodValue(lowerer, info.decl, info, member, loc);
      if (prototype || method) {
        const call: IrExpr = prototype
          ? {
              kind: "libCall",
              fn: write ? "dyn.reflectSet" : "dyn.reflectGet",
              args: [
                prototype,
                lowerer.coerceToExpected(key, DYN),
                ...(write ? [varRef("p.1", DYN, loc)] : []),
                actualReceiver,
              ],
              type: write ? BOOL : DYN,
              loc,
            }
          : {
              kind: "libCall",
              fn: "dyn.reflectApply",
              args: [
                lowerer.coerceToExpected(method!, DYN),
                actualReceiver,
                {
                  kind: "dynArrLit",
                  elems: write ? [varRef("p.1", DYN, loc)] : [],
                  type: DYN,
                  loc,
                },
              ],
              type: DYN,
              loc,
            };
        return [
          {
            kind: "if",
            cond: { kind: "libCall", fn: "dyn.hasOwn", args: [bag, key], type: BOOL, loc },
            then: [{ kind: "return", value: fallback, loc }],
            else_: null,
            loc,
          },
          ...(write
            ? ([
                { kind: "exprStmt", expr: call, loc },
                { kind: "return", value: { kind: "boolLit", value: true, type: BOOL, loc }, loc },
              ] as IrStmt[])
            : ([{ kind: "return", value: call, loc }] as IrStmt[])),
        ];
      }
    }
    if (write && !field) {
      if (findMethodOn(lowerer, info, `get:${name}`) && !accessor)
        return [{ kind: "return", value: { kind: "boolLit", value: false, type: BOOL, loc }, loc }];
      return [{ kind: "return", value: fallback, loc }];
    }
    const body = this.propertyBody(lowerer, dispatch, info, receiver);
    if (!write)
      return transformStmtList(body, {
        stmt: (statement) => statement,
        expr: (expression) =>
          expression.kind === "libCall" && expression.fn === "dyn.bagGet"
            ? {
                ...expression,
                fn: "dyn.reflectGet",
                args: [
                  expression.args[0]!,
                  lowerer.coerceToExpected(expression.args[1]!, DYN),
                  actualReceiver,
                ],
              }
            : expression,
      });
    return [
      {
        kind: "if",
        cond: {
          kind: "dynScalarEq",
          left: instance,
          right: actualReceiver,
          negated: true,
          type: BOOL,
          loc,
        },
        then: [
          {
            kind: "return",
            value: {
              kind: "libCall",
              fn: "dyn.reflectDefine",
              args: [actualReceiver, lowerer.coerceToExpected(key, DYN), varRef("p.1", DYN, loc)],
              type: BOOL,
              loc,
            },
            loc,
          },
        ],
        else_: null,
        loc,
      },
      ...transformStmtList(body, {
        stmt: (statement) =>
          statement.kind === "return" && !statement.value
            ? { ...statement, value: { kind: "boolLit", value: true, type: BOOL, loc } }
            : statement,
        expr: (expression) => expression,
      }),
    ];
  }

  private propertyBody(
    lowerer: Lowerer,
    dispatch: PropertyDispatch,
    info: ClassInfo,
    receiver: IrExpr,
  ): IrStmt[] {
    const { name, write } = dispatch;
    const loc = dispatch.fn.loc;
    // The inherited EventTarget/Event members of a subclass instance: the
    // runtime's capsule view answers the accessors and method values.
    if (eventTargetInheritedMember(info, name)) {
      const key: IrExpr = { kind: "strLit", value: name, type: STRING, loc };
      if (!write)
        return [
          {
            kind: "return",
            value: {
              kind: "dynKeyGet",
              value: lowerer.coerceToExpected(receiver, DYN),
              key,
              type: DYN,
              loc,
            },
            loc,
          },
        ];
      if (name !== "returnValue" && name !== "cancelBubble")
        return [
          {
            kind: "runtimeFence",
            code: "SC2020",
            message: `writing the inherited member '${name}' through an untyped value is not supported`,
            loc,
          },
        ];
      return [
        {
          kind: "exprStmt",
          expr: {
            kind: "libCall",
            fn: "event.set",
            args: [receiver, key, varRef("p.1", DYN, loc)],
            type: VOID,
            loc,
          },
          loc,
        },
        { kind: "return", value: null, loc },
      ];
    }
    // fs.ReadStream / fs.WriteStream's members (undefined on other
    // streams, as in Node).
    if (
      info.builtinStream !== undefined &&
      !write &&
      (name === "bytesRead" || name === "bytesWritten" || name === "pending" || name === "path")
    ) {
      return [
        {
          kind: "return",
          value: {
            kind: "libCall",
            fn: "fs.fsStreamPropDyn",
            args: [receiver, { kind: "strLit", value: name, type: STRING, loc }],
            type: DYN,
            loc,
          },
          loc,
        },
      ];
    }
    if (info.builtinStream !== undefined && streamProperty(name)) {
      if (write)
        return [
          {
            kind: "runtimeFence",
            code: "SC2020",
            message: `writing stream property '${name}' through an untyped value is not supported`,
            loc,
          },
        ];
      return [
        {
          kind: "return",
          value: lowerer.coerceToExpected(
            {
              kind: "libCall",
              fn: "stream.prop",
              args: [receiver, { kind: "strLit", value: name, type: STRING, loc }],
              type: STREAM_BOOL_PROPERTIES.has(name) ? BOOL : F64,
              loc,
            },
            DYN,
          ),
          loc,
        },
      ];
    }
    // An Error's own `stack`: a string is the native error's stack, which
    // typed reads share; any other value is kept with the instance's own
    // properties, which a read checks first. A class whose chain declares
    // a `stack` accessor answers through it (the accessor code below).
    if (
      name === "stack" &&
      !info.fields.has(name) &&
      lowerer.isSubclassOf(info.def.name, "%Error") &&
      !findMethodOn(lowerer, info, "get:stack") &&
      !findMethodOn(lowerer, info, "set:stack")
    ) {
      const key: IrExpr = { kind: "strLit", value: name, type: STRING, loc };
      const error = lowerer.upcastTo(receiver, "%Error");
      if (write) {
        const helper = classPropertiesHelper(lowerer, loc);
        this.generated.add(helper);
        const store: IrStmt = {
          kind: "exprStmt",
          expr: {
            kind: "libCall",
            fn: "dyn.keySet",
            args: [
              {
                kind: "call",
                callee: helper.name,
                args: [lowerer.coerceToExpected(receiver, DYN)],
                type: DYN,
                loc,
              },
              key,
              varRef("p.1", DYN, loc),
            ],
            type: VOID,
            loc,
          },
          loc,
        };
        return [
          {
            kind: "if",
            cond: {
              kind: "dynTest",
              test: "string",
              value: varRef("p.1", DYN, loc),
              type: BOOL,
              loc,
            },
            then: [
              {
                kind: "exprStmt",
                expr: {
                  kind: "libCall",
                  fn: "error.setStack",
                  args: [error, lowerer.coerceToExpected(varRef("p.1", DYN, loc), STRING)],
                  type: VOID,
                  loc,
                },
                loc,
              },
              {
                kind: "if",
                cond: this.readBagHas(
                  lowerer,
                  "dyn.hasKey",
                  this.readPropertyBag(lowerer, receiver, loc),
                  key,
                  loc,
                ),
                then: [store],
                else_: null,
                loc,
              },
            ],
            else_: [store],
            loc,
          },
          { kind: "return", value: null, loc },
        ];
      }
      const bag = this.readPropertyBag(lowerer, receiver, loc);
      return [
        {
          kind: "return",
          value: {
            kind: "ternary",
            cond: this.readBagHas(lowerer, "dyn.hasKey", bag, key, loc),
            then: {
              kind: "libCall",
              fn: "dyn.bagGet",
              args: [bag, key, lowerer.coerceToExpected(receiver, DYN)],
              type: DYN,
              loc,
            },
            else_: lowerer.coerceToExpected(
              { kind: "libCall", fn: "error.stack", args: [error], type: STRING, loc },
              DYN,
            ),
            type: DYN,
            loc,
          },
          loc,
        },
      ];
    }
    if ((name === "message" || name === "name") && lowerer.isSubclassOf(info.def.name, "%Error"))
      return write
        ? [
            errorPropertyWrite(
              lowerer,
              receiver,
              lowerer.coerceToExpected(varRef("p.1", DYN, loc), STRING),
              name,
            ),
            { kind: "return", value: null, loc },
          ]
        : [
            {
              kind: "return",
              value: lowerer.coerceToExpected(errorPropertyRead(lowerer, receiver, name), DYN),
              loc,
            },
          ];
    const field = info.fields.get(name);
    const member = `${write ? "set" : "get"}:${name}`;
    const accessor = field ? null : findMethodOn(lowerer, info, member);
    const fence = (): IrStmt[] => [
      {
        kind: "runtimeFence",
        code: "SC2020",
        message: `${write ? "writing" : "reading"} '${name}' on this native class through an untyped value is not supported yet`,
        loc,
      },
    ];
    const getRecord = (id: string) => lowerer.shapes.get(id);
    const getUnion = (id: string) => lowerer.unions.get(id);
    if (!write) {
      if (
        name === "constructor" &&
        !field &&
        !accessor &&
        info.decl &&
        !info.generic &&
        !info.localClass &&
        !info.classDecorators
      ) {
        this.constructors.set(info.def.name, info);
        const cls = lowerer.coerceToExpected(classValueRef(lowerer, info, info.decl), DYN);
        const bag = this.readPropertyBag(lowerer, receiver, loc);
        const key: IrExpr = { kind: "strLit", value: name, type: STRING, loc };
        return [
          {
            kind: "return",
            value: {
              kind: "ternary",
              cond: this.readBagHas(lowerer, "dyn.hasKey", bag, key, loc),
              then: {
                kind: "libCall",
                fn: "dyn.bagGet",
                args: [bag, key, lowerer.coerceToExpected(receiver, DYN)],
                type: DYN,
                loc,
              },
              else_: cls,
              type: DYN,
              loc,
            },
            loc,
          },
        ];
      }
      if (name === "toString" && findMethodOn(lowerer, info, name)?.declarer.builtinError) {
        return [{ kind: "return", value: errorToStringMethod(lowerer, receiver), loc }];
      }
      if (!field && !accessor && info.decl) {
        const declared = findMethodOn(lowerer, info, name);
        // Untyped dispatch considers native classes that may never reach
        // this lookup. Libraries cannot expose fibers or promises through
        // those speculative branches. Direct typed references still reach
        // the ordinary graph-wide async_free diagnostic.
        if (this.asyncFree && (declared?.sig.gen || declared?.sig.async)) {
          return [
            {
              kind: "runtimeFence",
              code: "SC4005",
              message: `reading async or generator method '${name}' through an untyped library lookup is not supported`,
              loc,
            },
          ];
        }
        const generic = findGenericMethodOn(lowerer, info, name);
        // A computed lookup has branches for every visible name. Generic
        // methods need a concrete specialization before they can escape;
        // refuse only if this runtime branch is selected.
        if (
          generic &&
          (!generic.info.implicitParams ||
            !generic.declarer.decl ||
            lowerer.overrideBelow(info, name) ||
            genericOverrideBelow(info, name))
        )
          return fence();
        const method = classMethodValue(lowerer, info.decl, info, name, loc);
        if (method && canConvertToDyn(method.type, getRecord, getUnion)) {
          // A capsule may have the base ABI even when its native object is
          // a subclass (for example an inherited iterator returning this).
          // Select the method declaration at extraction, before detaching it.
          const overrides = [...lowerer.classes.values()].filter(
            (candidate) =>
              candidate !== info &&
              lowerer.classCanBeConstructed(candidate) &&
              lowerer.isSubclassOf(candidate.def.name, info.def.name) &&
              (candidate.methods.has(name) || candidate.genericMethods?.has(name)),
          );
          overrides.sort((a, b) =>
            lowerer.isSubclassOf(a.def.name, b.def.name)
              ? -1
              : lowerer.isSubclassOf(b.def.name, a.def.name)
                ? 1
                : 0,
          );
          const body: IrStmt[] = [];
          const symbol = symbolMemberKey(lowerer, info, name, loc);
          if (symbol || (isClassOwnEnumerableFieldName(name) && !name.startsWith("sym:"))) {
            const prototypeMethod = observedPrototypeMethod(lowerer, info, name, loc, receiver);
            // Selecting the method must not give the object own storage.
            const bag = this.readPropertyBag(lowerer, receiver, loc);
            const key: IrExpr = symbol ?? { kind: "strLit", value: name, type: STRING, loc };
            body.push({
              kind: "if",
              cond: this.readBagHas(
                lowerer,
                symbol ? "dyn.hasOwnComputed" : "dyn.hasKey",
                bag,
                key,
                loc,
              ),
              then: [
                {
                  kind: "return",
                  value: {
                    kind: "libCall",
                    fn: symbol ? "dyn.reflectGet" : "dyn.bagGet",
                    args: [bag, key, lowerer.coerceToExpected(receiver, DYN)],
                    type: DYN,
                    loc,
                  },
                  loc,
                },
              ],
              else_: null,
              loc,
            });
            if (prototypeMethod) {
              body.push({ kind: "return", value: dynUndefinedExpr(loc), loc });
              return body;
            }
          }
          for (const candidate of overrides) {
            const selected = classMethodValue(lowerer, info.decl, candidate, name, loc);
            const branch: IrStmt[] =
              selected && canConvertToDyn(selected.type, getRecord, getUnion)
                ? [
                    {
                      kind: "return",
                      value: { kind: "dynFrom", value: selected, type: DYN, loc },
                      loc,
                    },
                  ]
                : fence();
            body.push({
              kind: "if",
              cond: {
                kind: "instanceOf",
                value: receiver,
                className: candidate.def.name,
                type: BOOL,
                loc,
              },
              then: branch,
              else_: null,
              loc,
            });
          }
          body.push({
            kind: "return",
            value: { kind: "dynFrom", value: method, type: DYN, loc },
            loc,
          });
          return body;
        }
      }
      if (!field && !accessor) {
        const instance = lowerer.coerceToExpected(receiver, DYN);
        const bag = this.readPropertyBagOrEmpty(lowerer, instance, loc);
        const key: IrExpr = { kind: "strLit", value: name, type: STRING, loc };
        const own: IrExpr = {
          kind: "libCall",
          fn: "dyn.bagGet",
          args: [bag, key, instance],
          type: DYN,
          loc,
        };
        // An Object.prototype method no class in the chain declares: an
        // own property shadows it, otherwise the read answers the same
        // interned value `Object.prototype.<name>` reads.
        if (INHERITED_OBJECT_METHODS.has(name) && !findMethodOn(lowerer, info, name)) {
          return [
            {
              kind: "return",
              value: {
                kind: "ternary",
                cond: this.readBagHas(lowerer, "dyn.hasKey", bag, key, loc),
                then: own,
                else_: {
                  kind: "libCall",
                  fn: "dyn.builtinMethod",
                  args: [{ kind: "strLit", value: "Object", type: STRING, loc }, key],
                  type: DYN,
                  loc,
                },
                type: DYN,
                loc,
              },
              loc,
            },
          ];
        }
        return [{ kind: "return", value: own, loc }];
      }
      const type = field ?? accessor!.sig.ret;
      if (!canConvertToDyn(type, getRecord, getUnion)) return fence();
      const value: IrExpr = field
        ? { kind: "fieldGet", obj: receiver, className: info.def.name, field: name, type, loc }
        : accessorCall(lowerer, info.def.name, member, receiver, [], type, loc);
      const boxed = lowerer.coerceToExpected(value, DYN);
      const mutable = (t: IrType): boolean =>
        streamTypedRefEligible(t) ||
        (t.kind === "union" && (getUnion(t.unionId)?.arms.some(mutable) ?? false));
      if (boxed.kind === "dynFrom" && mutable(boxed.value.type)) boxed.liveRef = true;
      if (accessor) {
        const bag = this.readPropertyBagOrEmpty(
          lowerer,
          lowerer.coerceToExpected(receiver, DYN),
          loc,
        );
        const key: IrExpr = { kind: "strLit", value: name, type: STRING, loc };
        return [
          {
            kind: "if",
            cond: { kind: "libCall", fn: "dyn.hasOwn", args: [bag, key], type: BOOL, loc },
            then: [
              {
                kind: "return",
                value: {
                  kind: "libCall",
                  fn: "dyn.bagGet",
                  args: [bag, key, lowerer.coerceToExpected(receiver, DYN)],
                  type: DYN,
                  loc,
                },
                loc,
              },
            ],
            else_: null,
            loc,
          },
          { kind: "return", value: boxed, loc },
        ];
      }
      if (field && info.def.tracksOwnFields) {
        const instance = lowerer.coerceToExpected(receiver, DYN);
        const bag = this.readPropertyBagOrEmpty(lowerer, instance, loc);
        const symbol = symbolMemberKey(lowerer, info, name, loc);
        const key: IrExpr = symbol ?? { kind: "strLit", value: name, type: STRING, loc };
        return [
          {
            kind: "return",
            value: {
              kind: "ternary",
              cond: {
                kind: "libCall",
                fn: symbol ? "dyn.hasOwnComputed" : "dyn.hasOwn",
                args: [bag, key],
                type: BOOL,
                loc,
              },
              then: boxed,
              else_: {
                kind: "libCall",
                fn: symbol ? "dyn.reflectGet" : "dyn.bagGet",
                args: [bag, key, instance],
                type: DYN,
                loc,
              },
              type: DYN,
              loc,
            },
            loc,
          },
        ];
      }
      return [{ kind: "return", value: boxed, loc }];
    }
    if (
      !field &&
      !accessor &&
      isClassOwnEnumerableFieldName(name) &&
      !name.startsWith("sym:") &&
      !findMethodOn(lowerer, info, `get:${name}`)
    ) {
      const bag: IrExpr = {
        kind: "call",
        callee: this.propertyBag!.name,
        args: [lowerer.coerceToExpected(receiver, DYN)],
        type: DYN,
        loc,
      };
      return [
        {
          kind: "exprStmt",
          expr: {
            kind: "libCall",
            fn: "dyn.bagSet",
            args: [
              bag,
              { kind: "strLit", value: name, type: STRING, loc },
              varRef("p.1", DYN, loc),
              lowerer.coerceToExpected(receiver, DYN),
            ],
            type: VOID,
            loc,
          },
          loc,
        },
        { kind: "return", value: null, loc },
      ];
    }
    if (!field && !accessor)
      return [
        {
          kind: "throw",
          value: {
            kind: "libCall",
            fn: "error.new",
            args: [
              {
                kind: "strLit",
                value: `Cannot set property ${name} of #<${info.def.jsName ?? info.def.name}> which has only a getter`,
                type: STRING,
                loc,
              },
            ],
            type: { kind: "object", className: "%TypeError" },
            loc,
          },
          loc,
        },
      ];
    const type = field ?? accessor!.sig.params[0]!.type;
    const checkable = (t: IrType): boolean =>
      isDynTypedRefType(t) ||
      isUnitType(t) ||
      (t.kind === "union"
        ? (getUnion(t.unionId)?.arms.every(checkable) ?? false)
        : canDynCheckTo(t, getRecord, getUnion));
    if (!checkable(type)) return fence();
    const value = lowerer.coerceToExpected(varRef("p.1", DYN, loc), type);
    if (!typeEquals(value.type, type)) return fence();
    const store: IrStmt = field
      ? { kind: "fieldSet", obj: receiver, className: info.def.name, field: name, value, loc }
      : {
          kind: "exprStmt",
          expr: accessorCall(lowerer, info.def.name, member, receiver, [value], VOID, loc),
          loc,
        };
    return [store, { kind: "return", value: null, loc }];
  }

  private methodBody(
    lowerer: Lowerer,
    dispatch: Dispatch,
    info: ClassInfo,
    receiver: IrExpr,
  ): IrStmt[] {
    const { method, loc } = dispatch.source;
    const fence = (): IrStmt[] => [
      {
        kind: "runtimeFence",
        code: "SC2020",
        message: `calling '${method}' on this native class through an untyped value is not supported yet`,
        loc,
      },
    ];
    if (
      info.builtinStream ||
      (emitterRooted(lowerer, info) &&
        EMITTER_METHODS.has(method) &&
        !findMethodOn(lowerer, info, method))
    ) {
      const incoming = dispatch.source.args.map((_, i) => varRef(`p.${i + 1}`, DYN, loc));
      const registering = [
        "on",
        "addListener",
        "once",
        "prependListener",
        "prependOnceListener",
      ].includes(method);
      const removing = method === "off" || method === "removeListener";
      const ret = (value: IrExpr): IrStmt[] => [
        { kind: "return", value: lowerer.coerceToExpected(value, DYN), loc },
      ];
      if (method === "emit") {
        if (!incoming.length) return fence();
        return ret({
          kind: "libCall",
          fn: "emitter.emitFlex",
          args: [receiver, lowerer.coerceToExpected(incoming[0]!, STRING), ...incoming.slice(1)],
          type: BOOL,
          loc,
        });
      }
      if (registering || removing) {
        if (incoming.length < 2) return fence();
        const event = lowerer.coerceToExpected(incoming[0]!, STRING);
        const cb = incoming[1]!;
        return [
          {
            kind: "exprStmt",
            expr: { kind: "libCall", fn: "emitter.checkListener", args: [cb], type: VOID, loc },
            loc,
          },
          ...ret({
            kind: "libCall",
            fn: registering
              ? info.builtinStream
                ? "stream.onDyn"
                : "emitter.onFlex"
              : "emitter.offDyn",
            args: [
              receiver,
              event,
              cb,
              ...(registering
                ? [
                    {
                      kind: "boolLit" as const,
                      value: method === "once" || method === "prependOnceListener",
                      type: BOOL,
                      loc,
                    },
                    {
                      kind: "boolLit" as const,
                      value: method.startsWith("prepend"),
                      type: BOOL,
                      loc,
                    },
                  ]
                : []),
            ],
            type: receiver.type,
            loc,
          }),
        ];
      }
      if (method === "read")
        return ret({
          kind: "libCall",
          fn: "readable.readDyn",
          args: [receiver, incoming[0] ?? dynUndefinedExpr(loc)],
          type: DYN,
          loc,
        });
      if (method === "pause" || method === "resume" || method === "isPaused")
        return ret({
          kind: "libCall",
          fn:
            method === "pause"
              ? "readable.pause"
              : method === "resume"
                ? "readable.resume"
                : "readable.isPaused",
          args: [receiver],
          type: method === "isPaused" ? BOOL : receiver.type,
          loc,
        });
      if (STREAM_OPERATORS.has(method) && info.builtinStream && info.builtinStream !== "w") {
        // The Readable operators over a checked-dynamic receiver: every
        // argument is already a checked value.
        const arg = (i: number): IrExpr => incoming[i] ?? dynUndefinedExpr(loc);
        const readableT: IrType = { kind: "object", className: "%Readable" };
        const op = (fn: string, args: IrExpr[], type: IrType): IrStmt[] =>
          ret({ kind: "libCall", fn: fn as IrLibFn, args: [receiver, ...args], type, loc });
        switch (method) {
          case "map":
            return op("readable.opMap", [arg(0), arg(1)], readableT);
          case "filter":
            return op("readable.opFilter", [arg(0), arg(1)], readableT);
          case "flatMap":
            return op("readable.opFlatMap", [arg(0), arg(1)], readableT);
          case "drop":
            return op("readable.opDrop", [arg(0), arg(1)], readableT);
          case "take":
            return op("readable.opTake", [arg(0), arg(1)], readableT);
          case "toArray":
            return op("readable.opToArray", [arg(0)], { kind: "promise", inner: DYN });
          case "forEach":
            return op("readable.opForEach", [arg(0), arg(1)], { kind: "promise", inner: VOID });
          case "some":
            return op("readable.opSome", [arg(0), arg(1)], { kind: "promise", inner: BOOL });
          case "every":
            return op("readable.opEvery", [arg(0), arg(1)], { kind: "promise", inner: BOOL });
          case "find":
            return op("readable.opFind", [arg(0), arg(1)], { kind: "promise", inner: DYN });
          case "reduce":
            return op(
              "readable.opReduce",
              [
                arg(0),
                arg(1),
                { kind: "boolLit", value: dispatch.source.args.length >= 2, type: BOOL, loc },
                arg(2),
                { kind: "numLit", value: 0, type: F64, loc },
              ],
              { kind: "promise", inner: DYN },
            );
        }
      }
      if (method === "destroy" && (!incoming.length || incoming[0]?.kind === "unitLit"))
        return ret({
          kind: "libCall",
          fn: "stream.destroy",
          args: [receiver],
          type: receiver.type,
          loc,
        });
      return fence();
    }
    const methodInfo = findMethodOn(lowerer, info, method);
    if (this.asyncFree && (methodInfo?.sig.gen || methodInfo?.sig.async)) {
      return [
        {
          kind: "runtimeFence",
          code: "SC4005",
          message: `calling async or generator method '${method}' through an untyped library value is not supported`,
          loc,
        },
      ];
    }
    if (methodInfo?.declarer.builtinError && method === "toString") {
      return [
        {
          kind: "return",
          value: { kind: "dynFrom", value: errorToStringCall(lowerer, receiver), type: DYN, loc },
          loc,
        },
      ];
    }
    const generic = methodInfo ? null : findGenericMethodOn(lowerer, info, method);
    let params: ParamShape[];
    let result: IrType;
    let callee: string;
    let virtual = false;
    let owner: ClassInfo;
    /** Erased instances of subclasses that redeclare a generic method. */
    const overrides: { cls: ClassInfo; callee: string }[] = [];
    if (methodInfo) {
      owner = methodInfo.declarer;
      params = methodInfo.sig.params;
      // An untyped async method's `dyn` result is its promise's payload; the
      // call answers the promise. An async generator method answers its
      // generator object, which its signature already returns.
      result =
        methodInfo.sig.async === true &&
        !methodInfo.sig.gen &&
        methodInfo.sig.ret.kind !== "promise"
          ? { kind: "promise", inner: methodInfo.sig.ret }
          : methodInfo.sig.ret;
      callee = `%${owner.def.name}.${method}`;
      virtual = lowerer.overrideBelow(owner, method) || methodInfo.sig.abstract === true;
    } else if (
      generic?.info.implicitParams &&
      generic.declarer.decl &&
      !lowerer.overrideBelow(info, method) &&
      !genericOverrideBelow(info, method)
    ) {
      owner = generic.declarer;
      // A failed eager specialization leaves a signature in the instance
      // cache, but no body. Later dispatch arities must retain the fence
      // instead of turning that cached signature into an unresolved call.
      const instance = implicitDefaultInstance(lowerer, generic.declarer.decl, generic.info);
      if (!lowerer.implicitFns.some((fn) => fn.name === instance.name)) return fence();
      params = instance.params;
      result = instance.returnType;
      callee = instance.name;
    } else if (
      generic &&
      !generic.info.implicitParams &&
      generic.info.typeParams.length > 0 &&
      generic.declarer.decl &&
      !lowerer.overrideBelow(info, method)
    ) {
      // A generic method called by name runs its erased instance; a
      // subclass that redeclares it runs its own, selected by the
      // receiver's runtime class (most derived first).
      owner = generic.declarer;
      const instance = erasedGenericInstance(lowerer, generic.declarer.decl, generic.info);
      params = instance.params;
      result = instance.returnType;
      callee = instance.name;
      if (genericOverrideBelow(info, method)) {
        const subclasses: ClassInfo[] = [];
        const collect = (c: ClassInfo): void => {
          for (const sub of c.subclasses) {
            collect(sub);
            if (sub.genericMethods?.has(method) && lowerer.classCanBeConstructed(sub))
              subclasses.push(sub);
          }
        };
        collect(info);
        for (const sub of subclasses) {
          const own = sub.genericMethods!.get(method)!;
          if (!sub.decl || own.implicitParams || own.typeParams.length === 0) return fence();
          const subInstance = erasedGenericInstance(lowerer, sub.decl, own);
          if (
            subInstance.params.length !== params.length ||
            subInstance.params.some((p, i) => !typeEquals(p.type, params[i]!.type)) ||
            !typeEquals(subInstance.returnType, result)
          )
            return fence();
          overrides.push({ cls: sub, callee: subInstance.name });
        }
      }
    } else return fence();
    const incoming = dispatch.source.args.map((_, i) => varRef(`p.${i + 1}`, DYN, loc));
    const args: IrExpr[] = [];
    let index = 0;
    for (const param of params) {
      if ((param.mode === "dynRest" || param.mode === "arguments") && param.type.kind === "dyn") {
        args.push({
          kind: "dynArrLit",
          elems: param.mode === "arguments" ? incoming : incoming.slice(index),
          type: DYN,
          loc,
        });
        index = incoming.length;
        continue;
      }
      if (param.mode === "rest" && param.type.kind === "array") {
        const element = param.type.elem;
        const elems = incoming
          .slice(index)
          .map((value) => lowerer.coerceToExpected(value, element));
        if (elems.some((value) => !typeEquals(value.type, element))) return fence();
        args.push({ kind: "arrayLit", elems, type: param.type, loc });
        index = incoming.length;
        continue;
      }
      if (param.mode !== "required" && param.mode !== "omittable") return fence();
      const value = incoming[index++] ?? param.callDefault ?? dynUndefinedExpr(loc);
      const converted = lowerer.coerceToExpected(value, param.type);
      if (!typeEquals(converted.type, param.type)) return fence();
      args.push(converted);
    }
    let call: IrExpr = virtual
      ? {
          kind: "virtualCall",
          className: owner.def.name,
          method,
          args: [upcastTo(lowerer, receiver, owner.def.name), ...args],
          type: result,
          loc,
        }
      : {
          kind: "call",
          callee,
          args: [upcastTo(lowerer, receiver, owner.def.name), ...args],
          type: result,
          loc,
        };
    for (const override of overrides.toReversed()) {
      const subType: IrType = { kind: "object", className: override.cls.def.name };
      call = {
        kind: "ternary",
        cond: {
          kind: "instanceOf",
          value: receiver,
          className: override.cls.def.name,
          type: BOOL,
          loc,
        },
        then: {
          kind: "call",
          callee: override.callee,
          args: [{ kind: "downcast", value: receiver, type: subType, loc }, ...args],
          type: result,
          loc,
        },
        else_: call,
        type: result,
        loc,
      };
    }
    let body: IrStmt[];
    if (result.kind === "void")
      body = [
        { kind: "exprStmt", expr: call, loc },
        { kind: "return", value: dynUndefinedExpr(loc), loc },
      ];
    else {
      const boxed = lowerer.coerceToExpected(call, DYN);
      if (boxed.type.kind !== "dyn") return fence();
      body = [{ kind: "return", value: boxed, loc }];
    }
    if (methodInfo) {
      if (virtual) lowerer.noteVirtualEdge(owner, method);
      else lowerer.noteEdge(callee);
    }
    if (isClassCallback(lowerer, info, method)) {
      const descriptor = varRef("p.callback", DYN, loc);
      body.unshift({
        kind: "if",
        cond: {
          kind: "dynTest",
          test: "undefined",
          negated: true,
          value: descriptor,
          type: BOOL,
          loc,
        },
        then: [
          {
            kind: "return",
            value: {
              kind: "dynCall",
              callee: {
                kind: "dynKeyGet",
                value: descriptor,
                key: { kind: "strLit", value: "value", type: STRING, loc },
                type: DYN,
                loc,
              },
              receiver: varRef("p.0", DYN, loc),
              args: incoming,
              calleeName: dispatch.source.calleeName,
              calleeNameValue: varRef("p.calleeName", STRING, loc),
              type: DYN,
              loc,
            },
            loc,
          },
        ],
        else_: null,
        loc,
      });
    }
    return body;
  }
}

/** Object.prototype methods every class instance inherits unless its class
 * chain declares them. */
const INHERITED_OBJECT_METHODS: ReadonlySet<string> = new Set([
  "valueOf",
  "toString",
  "hasOwnProperty",
  "propertyIsEnumerable",
]);
