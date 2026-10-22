import { AstDecodeError } from "./ast-bytes.js";
import {
  AstKind,
  AstModifierFlags,
  AstNodeFlags,
  KIND_NODE_LIST,
  astChildOrder,
} from "./ast-schema.generated.js";
import { astLineOfPosition, astLineStarts, astSkipTrivia } from "./ast-text.js";
import {
  AstWireFile,
  PREORDER_LIST,
  parseAstNodeHandle,
  type AstFileReference,
  type AstNodeHandle,
} from "./ast-wire.js";
import type { SourceFile } from "./ast-types.js";
import { SyntaxKind, NodeFlags } from "./enums.js";

/** A list of child nodes with the list's own position, the shape of tsc-ts's
 * NodeList. The file keeps the nodes array, not this object: each read of a
 * list field returns a new AstNodeList over the same array, so `nodes` keeps
 * its identity and a decoded file holds no list objects. The position is
 * decoded from the wire when it is read; most readers only use `nodes`. */
export class AstNodeList<T extends AstNode = AstNode> {
  constructor(
    private readonly wire: AstWireFile,
    private readonly index: number,
    readonly nodes: readonly T[],
  ) {}

  get pos(): number {
    return this.wire.pos(this.index) >>> 0;
  }

  get end(): number {
    return this.wire.end(this.index) >>> 0;
  }

  /** Whether a comma follows the last node before the list's end. */
  hasTrailingComma(): boolean {
    const last = this.nodes[this.nodes.length - 1];
    if (last === undefined) return false;
    const text = last.getSourceFile().text;
    const next = astSkipTrivia(text, last.end, false, false);
    return next < this.end && text.charCodeAt(next) === 44;
  }
}

/** A declaration's modifiers, with the flags of all of them: tsc-ts's
 * ModifierList. */
export class AstModifierList<T extends AstNode = AstNode> extends AstNodeList<T> {
  get modifierFlags(): number {
    let result = 0;
    for (const modifier of this.nodes) result |= astModifierFlag(modifier.kind);
    return result;
  }
}

/** One immutable AST response owns one object per node and one array per
 * list.
 * Parent access is lazy, so resolving a checker handle near the bottom
 * of a deep tree never recursively constructs its ancestors. */
export interface AstFileOptions {
  /** Answer the reference an assignment, a `++`/`--` update or a for-in/of
   * head writes without the parentheses and non-null assertions around it.
   * TypeScript accepts both around a target (`(x) = 1`, `a[i]! += 1`) and
   * both are erased at run time. With this option the writer's `left`,
   * `operand` or `initializer` is the reference itself and the reference's
   * `parent` is the writer, so every reader of a write target sees one
   * shape. Positions stay the source's: the reference keeps its own span.
   * Files read for other purposes keep TypeScript's exact tree. */
  writeTargets?: boolean;
}

export class AstFile {
  readonly wire: AstWireFile;
  readonly root: AstNode;
  // Wire ids are bounded dense indices. Holes mark unresolved slots; present
  // entries hold concrete nodes/lists without an optional payload wrapper.
  private readonly nodes: AstNode[];
  private readonly lists: AstNode[][];
  private readonly references = new Map<number, AstFileReference[]>();
  private readonly structuredNodes = new Map<number, AstNode[]>();
  private readonly strings = new Map<number, string[]>();
  private lines: number[] | undefined;
  private childIndices: Uint32Array | undefined;

  /** Whether nodes answer write targets without their wrappers (see
   * AstFileOptions.writeTargets). */
  readonly writeTargets: boolean;

  constructor(
    bytes: Uint8Array,
    private readonly materialized?: () => void,
    options: AstFileOptions = {},
  ) {
    this.writeTargets = options.writeTargets === true;
    this.wire = new AstWireFile(bytes);
    this.nodes = new Array<AstNode>(this.wire.nodeCount);
    this.lists = new Array<AstNode[]>(this.wire.nodeCount);
    this.root = new AstNode(this, 1);
    this.nodes[1] = this.root;
  }

  /** Checker factories also return AST fragments. Only source-file
   * consumers require this kind check; a type or signature root is valid
   * for typeToTypeNode/signatureToSignatureDeclaration. */
  get sourceFile(): SourceFile {
    if (this.root.kind !== SyntaxKind.SourceFile)
      throw new AstDecodeError("expected a source file root");
    return this.root as SourceFile;
  }

  node(index: number): AstNode {
    if (Object.hasOwn(this.nodes, index)) return this.nodes[index]!;
    if (index === 0 || this.wire.kind(index) === KIND_NODE_LIST)
      throw new AstDecodeError("expected a node index");
    const node = new AstNode(this, index);
    this.nodes[index] = node;
    this.materialized?.();
    return node;
  }

  list(index: number): AstNodeList {
    return new AstNodeList(this.wire, index, this.listNodes(index));
  }
  modifierList(index: number): AstModifierList {
    return new AstModifierList(this.wire, index, this.listNodes(index));
  }
  private listNodes(index: number): AstNode[] {
    let nodes = this.lists[index];
    if (nodes === undefined) {
      nodes = [];
      for (const child of this.wire.list(index)) nodes.push(this.node(child));
      this.lists[index] = nodes;
      this.materialized?.();
    }
    return nodes;
  }

  namedChild(node: AstNode, name: string): number {
    if (node.file !== this) throw new AstDecodeError("named child belongs to another source file");
    const order = astChildOrder(node.kind, name);
    if (order < 0) return 0;
    const mask = node.data >>> 30 === 0 ? node.data & 0xff : 0xff;
    if ((mask & (1 << order)) === 0) return 0;
    const slot = node.index * 8 + order;
    const indices = this.childIndices;
    if (indices !== undefined) {
      const cached = indices[slot]!;
      if (cached !== 0) return cached;
    }
    const index = this.wire.childAtOrder(node.index, order);
    // The pinned wire has at most eight named children per node. One packed
    // table avoids per-node arrays; allocate it only after successful access
    // so malformed siblings still fail lazily in the checked wire decoder.
    if (this.childIndices === undefined)
      this.childIndices = new Uint32Array(this.wire.nodeCount * 8);
    this.childIndices[slot] = index;
    return index;
  }

  resolve(handle: string): AstNode {
    return this.resolveHandle(parseAstNodeHandle(handle));
  }

  resolveHandle(parsed: AstNodeHandle): AstNode {
    if (parsed.path !== this.root.path)
      throw new AstDecodeError("node handle belongs to another source file");
    const node = this.node(parsed.index);
    if (node.kind !== parsed.kind)
      throw new AstDecodeError("node handle kind does not match the response");
    return node;
  }

  fileReferences(offset: number): AstFileReference[] {
    let result = this.references.get(offset);
    if (result === undefined) {
      result = this.wire.fileReferences(offset);
      this.references.set(offset, result);
    }
    return result;
  }

  nodeReferences(offset: number): AstNode[] {
    let result = this.structuredNodes.get(offset);
    if (result === undefined) {
      result = [];
      for (const index of this.wire.nodeIndices(offset)) result.push(this.node(index));
      this.structuredNodes.set(offset, result);
    }
    return result;
  }

  stringReferences(offset: number): string[] {
    let result = this.strings.get(offset);
    if (result === undefined) {
      result = this.wire.stringArray(offset);
      this.strings.set(offset, result);
    }
    return result;
  }

  lineStarts(): number[] {
    if (this.lines === undefined) this.lines = astLineStarts(this.root.text ?? "");
    return this.lines;
  }
}

/** Concrete native layout shared by every syntax kind. Kind-specific
 * properties are views over the wire; they never copy identity-bearing
 * nodes into structural records. */
/* Write targets without their wrappers (AstFileOptions.writeTargets). */

function isTargetWrapper(node: AstNode): boolean {
  return node.kind === AstKind.ParenthesizedExpression || node.kind === AstKind.NonNullExpression;
}

function unwrapTarget(node: AstNode): AstNode {
  let target = node;
  while (isTargetWrapper(target)) {
    const inner = target.childNode("expression");
    if (inner === undefined) break;
    target = inner;
  }
  return target;
}

/** Whether `field` of `node` is a write target: an assignment's left side,
 * a `++`/`--` operand, or a for-in/of head that declares nothing. */
function writesTarget(node: AstNode, field: "left" | "operand" | "initializer"): boolean {
  switch (node.kind) {
    case AstKind.BinaryExpression: {
      if (field !== "left") return false;
      const operator = node.childNode("operatorToken")?.kind;
      return (
        operator !== undefined &&
        operator >= AstKind.FirstAssignment &&
        operator <= AstKind.LastAssignment
      );
    }
    case AstKind.PrefixUnaryExpression:
    case AstKind.PostfixUnaryExpression:
      return (
        field === "operand" &&
        (node.operator === AstKind.PlusPlusToken || node.operator === AstKind.MinusMinusToken)
      );
    case AstKind.ForInStatement:
    case AstKind.ForOfStatement:
      return (
        field === "initializer" &&
        node.childNode("initializer")?.kind !== AstKind.VariableDeclarationList
      );
    default:
      return false;
  }
}

/** The parent of `node`, whose syntactic parent `wrapper` is a parenthesis
 * or a non-null assertion: the writer when the wrappers around `node` are
 * the whole target of an assignment, update or for-in/of head, and
 * `wrapper` otherwise. */
function writerOf(node: AstNode, wrapper: AstNode): AstNode {
  let outer = wrapper;
  for (;;) {
    const up = outer.parent;
    if (up === undefined) return wrapper;
    if (isTargetWrapper(up)) {
      outer = up;
      continue;
    }
    for (const field of ["left", "operand", "initializer"] as const) {
      if (writesTarget(up, field) && up.childNode(field) === outer && unwrapTarget(outer) === node)
        return up;
    }
    return wrapper;
  }
}

export class AstNode {
  readonly kind: SyntaxKind;
  readonly pos: number;
  readonly end: number;
  readonly flags: NodeFlags;
  readonly data: number;
  private parentResolved = false;
  private parentCache: AstNode | undefined;

  constructor(
    readonly file: AstFile,
    readonly index: number,
  ) {
    // Materialize immutable scalar metadata once. Lowering repeatedly reads
    // it while refining the same node, without needing another wire decode.
    const wire = file.wire;
    this.kind = wire.kind(index);
    this.pos = wire.pos(index);
    this.end = wire.end(index);
    this.flags = wire.flags(index);
    this.data = wire.data(index);
  }

  get id(): string {
    return `${this.index}.${this.kind}.${this.file.root.path}`;
  }
  get parent(): AstNode | undefined {
    if (!this.parentResolved) {
      const index = this.file.wire.semanticParent(this.index);
      const parent = index === 0 || index === this.index ? undefined : this.file.node(index);
      this.parentCache =
        parent !== undefined && this.file.writeTargets && isTargetWrapper(parent)
          ? writerOf(this, parent)
          : parent;
      this.parentResolved = true;
    }
    return this.parentCache;
  }
  get text(): string | undefined {
    return this.file.wire.text(this.index);
  }
  get rawText(): string | undefined {
    return this.file.wire.rawText(this.index);
  }

  childNode(name: string): AstNode | undefined {
    const index = this.file.namedChild(this, name);
    return index === 0 ? undefined : this.file.node(index);
  }
  childList(name: string): AstNodeList | undefined {
    const index = this.file.namedChild(this, name);
    return index === 0 ? undefined : this.file.list(index);
  }
  child(name: string): AstNode | AstNodeList | undefined {
    const index = this.file.namedChild(this, name);
    if (index === 0) return undefined;
    return this.file.wire.kind(index) === KIND_NODE_LIST
      ? this.file.list(index)
      : this.file.node(index);
  }

  /** Append semantic child handles without giving a traversal worklist an
   * owning reference to every pending node. Lists still pass through the
   * checked, identity-preserving cache used by forEachChild. */
  appendChildIndices(indices: number[]): void {
    const file = this.file;
    const wire = file.wire;
    for (let index = wire.firstChild(this.index); index !== 0; index = wire.next(index)) {
      if (wire.parent(index) !== this.index)
        throw new AstDecodeError("sibling belongs to another parent");
      const kind = wire.kind(index);
      if (kind === KIND_NODE_LIST) {
        for (const node of file.list(index).nodes) indices.push(node.index);
      } else if (kind !== AstKind.JSDoc) {
        indices.push(index);
      }
    }
  }

  forEachChild<T>(
    visitNode: (node: AstNode) => T,
    visitList?: (nodes: AstNodeList) => T,
  ): T | undefined {
    const wire = this.file.wire;
    const tree = wire.preorder();
    if (tree === null) return this.forEachLinkedChild(visitNode, visitList);
    // In the checked preorder tree, the first child follows its parent and
    // each later child starts where the previous child's subtree ends.
    const kinds = tree.kinds;
    const ends = tree.ends;
    const stop = ends[this.index]!;
    for (let index = this.index + 1; index < stop; index = ends[index]!) {
      const kind = kinds[index]!;
      if (kind === PREORDER_LIST) {
        const result = this.visitChildList(index, visitNode, visitList);
        if (result) return result;
      } else if (kind !== AstKind.JSDoc) {
        const result = visitNode(this.file.node(index));
        if (result) return result;
      }
    }
    return undefined;
  }

  /** forEachChild through the sibling and parent links. */
  private forEachLinkedChild<T>(
    visitNode: (node: AstNode) => T,
    visitList?: (nodes: AstNodeList) => T,
  ): T | undefined {
    const wire = this.file.wire;
    // Walk the immutable sibling links directly. Repeated semantic scans
    // should not allocate and free a temporary child-index array per node.
    for (let index = wire.firstChild(this.index); index !== 0; index = wire.next(index)) {
      if (wire.parent(index) !== this.index)
        throw new AstDecodeError("sibling belongs to another parent");
      const kind = wire.kind(index);
      if (kind === KIND_NODE_LIST) {
        const result = this.visitChildList(index, visitNode, visitList);
        if (result) return result;
      } else if (kind !== AstKind.JSDoc) {
        const result = visitNode(this.file.node(index));
        if (result) return result;
      }
    }
    return undefined;
  }

  private visitChildList<T>(
    index: number,
    visitNode: (node: AstNode) => T,
    visitList?: (nodes: AstNodeList) => T,
  ): T | undefined {
    const list = this.file.list(index);
    if (visitList !== undefined) return visitList(list);
    for (const node of list.nodes) {
      const result = visitNode(node);
      if (result) return result;
    }
    return undefined;
  }

  get jsDoc(): AstNode[] | undefined {
    const docs: AstNode[] = [];
    for (const index of this.file.wire.children(this.index)) {
      if (this.file.wire.kind(index) === AstKind.JSDoc) docs.push(this.file.node(index));
    }
    return docs.length === 0 ? undefined : docs;
  }

  getSourceFile(): SourceFile {
    return this.file.sourceFile;
  }
  getStart(sourceFile?: AstNode, includeJsDocComment?: boolean): number {
    if (this.pos === this.end && this.pos >= 0 && this.kind !== AstKind.EndOfFile) return this.pos;
    const source = sourceFile ?? this.file.root;
    const text = source.text ?? "";
    if (
      (this.kind >= AstKind.FirstJSDocNode && this.kind <= AstKind.LastJSDocNode) ||
      this.kind === AstKind.JsxText
    ) {
      return astSkipTrivia(text, this.pos, true, false);
    }
    if (includeJsDocComment) {
      const docs = this.jsDoc;
      if (docs !== undefined && docs.length > 0) return docs[0]!.getStart(source, false);
    }
    return astSkipTrivia(text, this.pos, false, (this.flags & AstNodeFlags.JSDoc) !== 0);
  }
  getFullStart(): number {
    return this.pos;
  }
  getEnd(): number {
    return this.end;
  }
  getWidth(sourceFile?: AstNode): number {
    return this.end - this.getStart(sourceFile);
  }
  getFullWidth(): number {
    return this.end - this.pos;
  }
  getLeadingTriviaWidth(sourceFile?: AstNode): number {
    return this.getStart(sourceFile) - this.pos;
  }
  getFullText(sourceFile?: AstNode): string {
    return ((sourceFile ?? this.file.root).text ?? "").substring(this.pos, this.end);
  }
  getText(sourceFile?: AstNode): string {
    const source = sourceFile ?? this.file.root;
    return (source.text ?? "").substring(this.getStart(source), this.end);
  }

  get containsOnlyTriviaWhiteSpaces(): boolean {
    return (this.data & (1 << 24)) !== 0;
  }
  get isArrayType(): boolean {
    return (this.data & (1 << 24)) !== 0;
  }
  get isBracketed(): boolean {
    return (this.data & (1 << 24)) !== 0;
  }
  get isExportEquals(): boolean {
    return (this.data & (1 << 24)) !== 0;
  }
  get isNameFirst(): boolean {
    return (this.data & (1 << 25)) !== 0;
  }
  get isTypeOf(): boolean {
    return (this.data & (1 << 24)) !== 0;
  }
  get isTypeOnly(): boolean {
    return (this.data & (1 << 24)) !== 0;
  }
  get multiLine(): boolean {
    return (this.data & (1 << 24)) !== 0;
  }
  get keyword(): number | undefined {
    return this.kind === AstKind.ModuleDeclaration
      ? (this.data >>> 24) & 1
        ? AstKind.NamespaceKeyword
        : AstKind.ModuleKeyword
      : undefined;
  }
  get keywordToken(): number | undefined {
    return this.kind === AstKind.MetaProperty
      ? (this.data >>> 24) & 1
        ? AstKind.NewKeyword
        : AstKind.ImportKeyword
      : undefined;
  }
  get operator(): number | undefined {
    const value = (this.data >>> 24) & 7;
    if (this.kind === AstKind.PrefixUnaryExpression) {
      switch (value) {
        case 1:
          return AstKind.MinusToken;
        case 2:
          return AstKind.TildeToken;
        case 3:
          return AstKind.ExclamationToken;
        case 4:
          return AstKind.PlusPlusToken;
        case 5:
          return AstKind.MinusMinusToken;
        default:
          return AstKind.PlusToken;
      }
    }
    if (this.kind === AstKind.PostfixUnaryExpression)
      return value & 1 ? AstKind.MinusMinusToken : AstKind.PlusPlusToken;
    if (this.kind === AstKind.TypeOperator)
      return (value & 3) === 1
        ? AstKind.ReadonlyKeyword
        : (value & 3) === 2
          ? AstKind.UniqueKeyword
          : AstKind.KeyOfKeyword;
    return undefined;
  }
  get phaseModifier(): number | undefined {
    if (this.kind !== AstKind.ImportClause) return undefined;
    const value = (this.data >>> 24) & 3;
    return value === 1 ? AstKind.TypeKeyword : value === 2 ? AstKind.DeferKeyword : undefined;
  }
  get token(): number | undefined {
    if (this.kind === AstKind.HeritageClause)
      return (this.data >>> 24) & 1 ? AstKind.ImplementsKeyword : AstKind.ExtendsKeyword;
    if (this.kind === AstKind.ImportAttributes)
      return (this.data >>> 25) & 1 ? AstKind.AssertKeyword : AstKind.WithKeyword;
    return undefined;
  }
  get templateFlags(): number | undefined {
    return this.kind === AstKind.TemplateHead ||
      this.kind === AstKind.TemplateMiddle ||
      this.kind === AstKind.TemplateTail
      ? this.file.wire.extendedWord(this.index, 8)
      : undefined;
  }
  get tokenFlags(): number {
    return this.kind === AstKind.StringLiteral ||
      this.kind === AstKind.NumericLiteral ||
      this.kind === AstKind.BigIntLiteral ||
      this.kind === AstKind.RegularExpressionLiteral
      ? this.file.wire.extendedWord(this.index, 4)
      : 0;
  }
  get modifierFlags(): number {
    let result = 0;
    for (const modifier of this.childList("modifiers")?.nodes ?? [])
      result |= astModifierFlag(modifier.kind);
    return result;
  }

  get modifiers(): AstModifierList | undefined {
    const index = this.file.namedChild(this, "modifiers");
    return index === 0 ? undefined : this.file.modifierList(index);
  }

  get body(): AstNode | undefined {
    const body = this.childNode("body");
    // TS7 can serialize a reparsed @type callable before a method's
    // body without setting the type presence bit. The linked Block is
    // still the real body; keep the JSDoc node out of this view.
    if (
      body !== undefined &&
      (body.flags & AstNodeFlags.JSDoc) !== 0 &&
      (body.flags & AstNodeFlags.Reparsed) !== 0
    ) {
      const next = this.file.wire.next(body.index);
      if (
        next !== 0 &&
        this.file.wire.parent(next) === this.index &&
        this.file.wire.kind(next) === AstKind.Block
      ) {
        return this.file.node(next);
      }
    }
    return body;
  }

  get questionToken(): AstNode | undefined {
    const direct = this.childNode("questionToken");
    if (direct !== undefined) return direct;
    // TypeScript 7 shares one postfix slot for optional and definite-
    // assignment declarations. The familiar helper surface keeps them apart.
    const token = this.childNode("postfixToken");
    return token?.kind === SyntaxKind.QuestionToken ? token : undefined;
  }

  // A write target keeps its parentheses and non-null assertions in the
  // tree; with AstFileOptions.writeTargets these views return the target
  // without them.
  get initializer(): AstNode | undefined {
    const initializer = this.childNode("initializer");
    return initializer !== undefined && this.file.writeTargets && writesTarget(this, "initializer")
      ? unwrapTarget(initializer)
      : initializer;
  }

  get left(): AstNode | undefined {
    const left = this.childNode("left");
    return left !== undefined && this.file.writeTargets && writesTarget(this, "left")
      ? unwrapTarget(left)
      : left;
  }

  get operand(): AstNode | undefined {
    const operand = this.childNode("operand");
    return operand !== undefined && this.file.writeTargets && writesTarget(this, "operand")
      ? unwrapTarget(operand)
      : operand;
  }

  // BEGIN GENERATED CHILD GETTERS
  // Generated from typescript@7.0.2; run scripts/generate-ts7-ast-schema.mjs.
  get argument(): AstNode | undefined {
    return this.childNode("argument");
  }
  get argumentExpression(): AstNode | undefined {
    return this.childNode("argumentExpression");
  }
  get arguments(): AstNodeList | undefined {
    return this.childList("arguments");
  }
  get assertsModifier(): AstNode | undefined {
    return this.childNode("assertsModifier");
  }
  get asteriskToken(): AstNode | undefined {
    return this.childNode("asteriskToken");
  }
  get attributes(): AstNode | AstNodeList | undefined {
    return this.child("attributes");
  }
  get awaitModifier(): AstNode | undefined {
    return this.childNode("awaitModifier");
  }
  get block(): AstNode | undefined {
    return this.childNode("block");
  }
  get caseBlock(): AstNode | undefined {
    return this.childNode("caseBlock");
  }
  get catchClause(): AstNode | undefined {
    return this.childNode("catchClause");
  }
  get checkType(): AstNode | undefined {
    return this.childNode("checkType");
  }
  get children(): AstNode | AstNodeList | undefined {
    return this.child("children");
  }
  get className(): AstNode | undefined {
    return this.childNode("className");
  }
  get clauses(): AstNodeList | undefined {
    return this.childList("clauses");
  }
  get closingElement(): AstNode | undefined {
    return this.childNode("closingElement");
  }
  get closingFragment(): AstNode | undefined {
    return this.childNode("closingFragment");
  }
  get colonToken(): AstNode | undefined {
    return this.childNode("colonToken");
  }
  get comment(): AstNodeList | undefined {
    return this.childList("comment");
  }
  get condition(): AstNode | undefined {
    return this.childNode("condition");
  }
  get constraint(): AstNode | undefined {
    return this.childNode("constraint");
  }
  get declarationList(): AstNode | undefined {
    return this.childNode("declarationList");
  }
  get declarations(): AstNodeList | undefined {
    return this.childList("declarations");
  }
  get defaultType(): AstNode | undefined {
    return this.childNode("defaultType");
  }
  get dotDotDotToken(): AstNode | undefined {
    return this.childNode("dotDotDotToken");
  }
  get elementType(): AstNode | undefined {
    return this.childNode("elementType");
  }
  get elements(): AstNodeList | undefined {
    return this.childList("elements");
  }
  get elseStatement(): AstNode | undefined {
    return this.childNode("elseStatement");
  }
  get endOfFileToken(): AstNode | undefined {
    return this.childNode("endOfFileToken");
  }
  get equalsGreaterThanToken(): AstNode | undefined {
    return this.childNode("equalsGreaterThanToken");
  }
  get equalsToken(): AstNode | undefined {
    return this.childNode("equalsToken");
  }
  get exclamationToken(): AstNode | undefined {
    return this.childNode("exclamationToken");
  }
  get exportClause(): AstNode | undefined {
    return this.childNode("exportClause");
  }
  get exprName(): AstNode | undefined {
    return this.childNode("exprName");
  }
  get expression(): AstNode | undefined {
    return this.childNode("expression");
  }
  get extendsType(): AstNode | undefined {
    return this.childNode("extendsType");
  }
  get falseType(): AstNode | undefined {
    return this.childNode("falseType");
  }
  get finallyBlock(): AstNode | undefined {
    return this.childNode("finallyBlock");
  }
  get head(): AstNode | undefined {
    return this.childNode("head");
  }
  get heritageClauses(): AstNodeList | undefined {
    return this.childList("heritageClauses");
  }
  get importClause(): AstNode | undefined {
    return this.childNode("importClause");
  }
  get incrementor(): AstNode | undefined {
    return this.childNode("incrementor");
  }
  get indexType(): AstNode | undefined {
    return this.childNode("indexType");
  }
  get jsdocPropertyTags(): AstNode | undefined {
    return this.childNode("jsdocPropertyTags");
  }
  get label(): AstNode | undefined {
    return this.childNode("label");
  }
  get literal(): AstNode | undefined {
    return this.childNode("literal");
  }
  get members(): AstNodeList | undefined {
    return this.childList("members");
  }
  get moduleReference(): AstNode | undefined {
    return this.childNode("moduleReference");
  }
  get moduleSpecifier(): AstNode | undefined {
    return this.childNode("moduleSpecifier");
  }
  get name(): AstNode | undefined {
    return this.childNode("name");
  }
  get nameExpression(): AstNode | undefined {
    return this.childNode("nameExpression");
  }
  get nameType(): AstNode | undefined {
    return this.childNode("nameType");
  }
  get namedBindings(): AstNode | undefined {
    return this.childNode("namedBindings");
  }
  get namespace(): AstNode | undefined {
    return this.childNode("namespace");
  }
  get objectAssignmentInitializer(): AstNode | undefined {
    return this.childNode("objectAssignmentInitializer");
  }
  get objectType(): AstNode | undefined {
    return this.childNode("objectType");
  }
  get openingElement(): AstNode | undefined {
    return this.childNode("openingElement");
  }
  get openingFragment(): AstNode | undefined {
    return this.childNode("openingFragment");
  }
  get operatorToken(): AstNode | undefined {
    return this.childNode("operatorToken");
  }
  get parameterName(): AstNode | undefined {
    return this.childNode("parameterName");
  }
  get parameters(): AstNodeList | undefined {
    return this.childList("parameters");
  }
  get postfixToken(): AstNode | undefined {
    return this.childNode("postfixToken");
  }
  get properties(): AstNodeList | undefined {
    return this.childList("properties");
  }
  get propertyName(): AstNode | undefined {
    return this.childNode("propertyName");
  }
  get qualifier(): AstNode | undefined {
    return this.childNode("qualifier");
  }
  get questionDotToken(): AstNode | undefined {
    return this.childNode("questionDotToken");
  }
  get readonlyToken(): AstNode | undefined {
    return this.childNode("readonlyToken");
  }
  get right(): AstNode | undefined {
    return this.childNode("right");
  }
  get statement(): AstNode | undefined {
    return this.childNode("statement");
  }
  get statements(): AstNodeList | undefined {
    return this.childList("statements");
  }
  get tag(): AstNode | undefined {
    return this.childNode("tag");
  }
  get tagName(): AstNode | undefined {
    return this.childNode("tagName");
  }
  get tags(): AstNodeList | undefined {
    return this.childList("tags");
  }
  get template(): AstNode | undefined {
    return this.childNode("template");
  }
  get templateSpans(): AstNodeList | undefined {
    return this.childList("templateSpans");
  }
  get thenStatement(): AstNode | undefined {
    return this.childNode("thenStatement");
  }
  get thisArg(): AstNode | undefined {
    return this.childNode("thisArg");
  }
  get trueType(): AstNode | undefined {
    return this.childNode("trueType");
  }
  get tryBlock(): AstNode | undefined {
    return this.childNode("tryBlock");
  }
  get tupleNameSource(): AstNode | undefined {
    return this.childNode("tupleNameSource");
  }
  get type(): AstNode | undefined {
    return this.childNode("type");
  }
  get typeArguments(): AstNodeList | undefined {
    return this.childList("typeArguments");
  }
  get typeExpression(): AstNode | undefined {
    return this.childNode("typeExpression");
  }
  get typeName(): AstNode | undefined {
    return this.childNode("typeName");
  }
  get typeParameter(): AstNode | undefined {
    return this.childNode("typeParameter");
  }
  get typeParameters(): AstNodeList | undefined {
    return this.childList("typeParameters");
  }
  get types(): AstNodeList | undefined {
    return this.childList("types");
  }
  get value(): AstNode | undefined {
    return this.childNode("value");
  }
  get variableDeclaration(): AstNode | undefined {
    return this.childNode("variableDeclaration");
  }
  get whenFalse(): AstNode | undefined {
    return this.childNode("whenFalse");
  }
  get whenTrue(): AstNode | undefined {
    return this.childNode("whenTrue");
  }
  // END GENERATED CHILD GETTERS

  // Source-file fields stay on the same nominal class, matching the wire's
  // single node representation. Their extended-data accesses are checked.
  get fileName(): string {
    return this.file.wire.string(this.file.wire.extendedWord(this.index, 4));
  }
  get path(): string {
    return this.file.wire.string(this.file.wire.extendedWord(this.index, 8));
  }
  get languageVariant(): number {
    return this.file.wire.extendedWord(this.index, 12);
  }
  get scriptKind(): number {
    return this.file.wire.extendedWord(this.index, 16);
  }
  get isDeclarationFile(): boolean {
    return (this.flags & AstNodeFlags.Ambient) !== 0;
  }
  get referencedFiles(): AstFileReference[] {
    return this.file.fileReferences(this.file.wire.extendedWord(this.index, 20));
  }
  get typeReferenceDirectives(): AstFileReference[] {
    return this.file.fileReferences(this.file.wire.extendedWord(this.index, 24));
  }
  get libReferenceDirectives(): AstFileReference[] {
    return this.file.fileReferences(this.file.wire.extendedWord(this.index, 28));
  }
  get imports(): AstNode[] {
    return this.file.nodeReferences(this.file.wire.extendedWord(this.index, 32));
  }
  get moduleAugmentations(): AstNode[] {
    return this.file.nodeReferences(this.file.wire.extendedWord(this.index, 36));
  }
  get ambientModuleNames(): string[] {
    return this.file.stringReferences(this.file.wire.extendedWord(this.index, 40));
  }
  get externalModuleIndicator(): AstNode | true | undefined {
    const index = this.file.wire.extendedWord(this.index, 44);
    return index === 0 ? undefined : index === this.index ? true : this.file.node(index);
  }
  getLineStarts(): number[] {
    return this.file.lineStarts();
  }
  getLineAndCharacterOfPosition(position: number): { line: number; character: number } {
    const starts = this.getLineStarts();
    const line = astLineOfPosition(starts, position);
    return { line, character: position - starts[line]! };
  }
  getPositionOfLineAndCharacter(line: number, character: number): number {
    const starts = this.getLineStarts();
    if (line < 0 || line >= starts.length)
      throw new Error(`Bad line number. Line: ${line}, lineStarts.length: ${starts.length}`);
    return starts[line]! + character;
  }
  getOrCreateNodeAtIndex(index: number): AstNode {
    return this.file.node(index);
  }
}

function astModifierFlag(kind: number): number {
  switch (kind) {
    case AstKind.StaticKeyword:
      return AstModifierFlags.Static;
    case AstKind.PublicKeyword:
      return AstModifierFlags.Public;
    case AstKind.ProtectedKeyword:
      return AstModifierFlags.Protected;
    case AstKind.PrivateKeyword:
      return AstModifierFlags.Private;
    case AstKind.AbstractKeyword:
      return AstModifierFlags.Abstract;
    case AstKind.AccessorKeyword:
      return AstModifierFlags.Accessor;
    case AstKind.ExportKeyword:
      return AstModifierFlags.Export;
    case AstKind.DeclareKeyword:
      return AstModifierFlags.Ambient;
    case AstKind.ConstKeyword:
      return AstModifierFlags.Const;
    case AstKind.DefaultKeyword:
      return AstModifierFlags.Default;
    case AstKind.AsyncKeyword:
      return AstModifierFlags.Async;
    case AstKind.ReadonlyKeyword:
      return AstModifierFlags.Readonly;
    case AstKind.OverrideKeyword:
      return AstModifierFlags.Override;
    case AstKind.InKeyword:
      return AstModifierFlags.In;
    case AstKind.OutKeyword:
      return AstModifierFlags.Out;
    case AstKind.Decorator:
      return AstModifierFlags.Decorator;
    default:
      return AstModifierFlags.None;
  }
}
