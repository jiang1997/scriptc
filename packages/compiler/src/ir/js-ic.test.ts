import { expect, test } from "vitest";
import { BOOL, DYN, STRING, VOID, type IrExpr, type IrFunction, type IrStmt } from "./ir.js";
import { JsIcSites, hasJsIcSite } from "./js-ic.js";

const loc = { file: "js-ic.ts", start: 0, end: 0 };
const ref = (id: string, type = DYN): IrExpr => ({ kind: "varRef", localId: id, type, loc });
const str = (value: string): IrExpr => ({ kind: "strLit", value, type: STRING, loc });
const call = (callee: string, ...args: IrExpr[]): IrExpr => ({
  kind: "call",
  callee,
  args,
  type: DYN,
  loc,
});
const ret = (value: IrExpr | null): IrStmt => ({ kind: "return", value, loc });

function helper(name: string, params: string[], body: IrStmt[], locals: string[] = []): IrFunction {
  return {
    name,
    params: params.map((id) => ({ localId: id, name: id, type: DYN })),
    returnType: DYN,
    locals: [...params, ...locals].map((id) => ({ id, name: id, type: DYN, mutable: false })),
    body,
    loc,
  };
}

/** `if (dyn.typedRefIs(p, "C")) return undefined` — a capsule branch. */
function capsuleBranch(param: string, fn = "dyn.typedRefIs"): IrStmt {
  return {
    kind: "if",
    cond: {
      kind: "libCall",
      fn: fn as "dyn.typedRefIs",
      args: [ref(param), str("C")],
      type: BOOL,
      loc,
    },
    then: [ret(ref(param))],
    else_: null,
    loc,
  };
}

const identityBag = helper(
  "%dyn.class.readPropertiesOrEmpty",
  ["v"],
  [capsuleBranch("v"), ret(ref("v"))],
);

function getHelper(name: string, key: string, prefix: IrStmt[] = [], bag?: IrExpr): IrFunction {
  const bagRef = ref("bag.0");
  return helper(
    name,
    ["p.0"],
    [
      ...prefix,
      { kind: "varDecl", localId: "bag.0", init: bag ?? call(identityBag.name, ref("p.0")), loc },
      ret({
        kind: "libCall",
        fn: "js.fromDyn",
        args: [
          {
            kind: "ternary",
            cond: { kind: "dynScalarEq", left: bagRef, right: ref("p.0"), type: BOOL, loc },
            then: { kind: "dynKeyGet", key: str(key), value: bagRef, type: DYN, loc },
            else_: {
              kind: "libCall",
              fn: "dyn.bagGet",
              args: [bagRef, str(key), ref("p.0")],
              type: DYN,
              loc,
            },
            type: DYN,
            loc,
          },
        ],
        type: { kind: "jsval" },
        loc,
      }),
    ],
    ["bag.0"],
  );
}

function setHelper(name: string, key: string, prefix: IrStmt[] = []): IrFunction {
  return {
    ...helper(
      name,
      ["p.0", "p.1"],
      [
        ...prefix,
        {
          kind: "exprStmt",
          expr: {
            kind: "libCall",
            fn: "dyn.keySet",
            args: [call("%dyn.class.properties", ref("p.0")), str(key), ref("p.1")],
            type: VOID,
            loc,
          },
          loc,
        },
        ret(null),
      ],
    ),
    returnType: VOID,
  };
}

const properties = helper("%dyn.class.properties", ["v"], [capsuleBranch("v"), ret(ref("v"))]);

function sitesOf(...functions: IrFunction[]): JsIcSites {
  return new JsIcSites({ functions: [identityBag, properties, ...functions] });
}

test("property helpers whose class branches only test capsules are cache sites", () => {
  const sites = sitesOf(
    getHelper("%dyn.class.property.0", "x", [
      capsuleBranch("p.0"),
      capsuleBranch("p.0", "dyn.classIs"),
    ]),
    setHelper("%dyn.class.property.1", "y", [capsuleBranch("p.0", "dyn.typedRefKeyIs")]),
  );
  expect(sites.site("%dyn.class.property.0")).toEqual({ kind: "get", key: "x" });
  expect(sites.site("%dyn.class.property.1")).toEqual({ kind: "set", key: "y" });
});

test("any other prefix or tail keeps the helper call", () => {
  const errorBranch: IrStmt = {
    kind: "if",
    cond: { kind: "dynTest", test: "error", value: ref("p.0"), type: BOOL, loc },
    then: [ret(ref("p.0"))],
    else_: null,
    loc,
  };
  // A branch an ordinary object can take (toString of an error object).
  const withError = getHelper("%dyn.class.property.0", "toString", [errorBranch]);
  // A bag that is not the receiver for ordinary objects.
  const otherBag = helper("%dyn.class.other", ["v"], [ret({ kind: "dynObjLit", type: DYN, loc })]);
  const foreignBag = getHelper("%dyn.class.property.1", "x", [], call(otherBag.name, ref("p.0")));
  // A function outside the generated helper family.
  const userFn = { ...getHelper("%dyn.class.property.2", "x"), name: "user" };
  const sites = sitesOf(withError, otherBag, foreignBag, userFn);
  expect(sites.site("%dyn.class.property.0")).toBeNull();
  expect(sites.site("%dyn.class.property.1")).toBeNull();
  expect(sites.site("user")).toBeNull();
  expect(sites.site("%dyn.class.missing")).toBeNull();
});

test("a function holds a site when it calls a classified helper or dispatches a method", () => {
  const getter = getHelper("%dyn.class.property.0", "x");
  const sites = sitesOf(getter);
  const caller = helper("f", ["o"], [ret(call(getter.name, ref("o")))]);
  const invoker = helper(
    "g",
    ["o"],
    [
      ret({
        kind: "dynInvoke",
        recv: ref("o"),
        method: "m",
        calleeName: "o.m",
        args: [],
        type: DYN,
        loc,
      }),
    ],
  );
  const plain = helper("h", ["o"], [ret(ref("o"))]);
  expect(hasJsIcSite(caller, sites)).toBe(true);
  expect(hasJsIcSite(invoker, sites)).toBe(true);
  expect(hasJsIcSite(plain, sites)).toBe(false);
  // Module initializers keep plain method dispatch (top-level handle
  // wiring), while their property sites still cache.
  expect(hasJsIcSite({ ...invoker, name: "%init.0" }, sites)).toBe(false);
  expect(hasJsIcSite({ ...caller, name: "%init.0" }, sites)).toBe(true);
});
