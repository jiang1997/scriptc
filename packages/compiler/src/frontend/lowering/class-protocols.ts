import * as ts from "../ts7/adapter.js";

/** Index only program classes. Ambient declarations describe APIs, not
 * compiled implementations, and must not change a protocol's storage. */
export class ClassProtocols {
  private implemented: Set<ts.Symbol> | null = null;
  private readonly methods = new Map<string, ts.ClassLikeDeclaration[]>();
  private readonly answers = new Map<ts.Type, boolean>();
  /** The program classes each Pick or Omit view accepts (classesAcceptedBy). */
  private readonly accepted = new Map<ts.Type, ts.Symbol[]>();
  /** What markIdentityFlows learned about the program, while it runs. */
  private facts: FlowFacts | null = null;

  constructor(
    private readonly checker: ts.TypeChecker,
    private readonly sources: readonly ts.SourceFile[],
  ) {}

  private index(): Set<ts.Symbol> {
    if (this.implemented !== null) return this.implemented;
    const protocols = new Set<ts.Symbol>();
    this.implemented = protocols;
    const add = (type: ts.Type): void => {
      const symbol = type.getSymbol();
      if (!symbol || protocols.has(symbol)) return;
      protocols.add(symbol);
      const target = type.isTypeReference() ? type.getTarget() : type;
      if (target?.isClassOrInterface()) this.checker.getBaseTypes(target).forEach(add);
    };
    const usesReceiver = (node: ts.Node): boolean =>
      node.kind === ts.SyntaxKind.ThisKeyword || ts.forEachChild(node, usesReceiver) === true;
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        for (const clause of node.heritageClauses?.nodes ?? [])
          if (clause.token === ts.SyntaxKind.ImplementsKeyword)
            for (const protocol of clause.types.nodes)
              add(this.checker.getTypeAtLocation(protocol));
        const symbol = node.name ? this.checker.getSymbolAtLocation(node.name) : undefined;
        const instance = symbol ? this.checker.getDeclaredTypeOfSymbol(symbol) : undefined;
        for (const property of instance ? this.checker.getPropertiesOfType(instance) : []) {
          if (
            !property.declarations.some(
              (member) =>
                ts.isMethodDeclaration(member) &&
                !member.modifiers?.nodes.some(
                  (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword,
                ),
            )
          )
            continue;
          const entries = this.methods.get(ts.symbolName(property)) ?? [];
          entries.push(node);
          this.methods.set(ts.symbolName(property), entries);
        }
      }
      if (
        ts.isObjectLiteralExpression(node) &&
        node.properties.nodes.some(
          (property) =>
            (ts.isMethodDeclaration(property) ||
              ts.isGetAccessorDeclaration(property) ||
              ts.isSetAccessorDeclaration(property)) &&
            property.body !== undefined &&
            usesReceiver(property.body),
        )
      ) {
        // Receiver-dependent methods and accessors need a live object even
        // without a class implementation. Receiver-free methods keep their
        // native callable fields, including async callbacks.
        add(this.checker.getTypeAtLocation(node));
        const contextual = this.checker.getContextualType(node);
        if (contextual) add(contextual);
      }
      ts.forEachChild(node, visit);
    };
    for (const source of this.sources) if (!source.isDeclarationFile) visit(source);
    this.markIdentityFlows(protocols);
    return protocols;
  }

  /** Structural types that receive a value with identity: a program class
   * instance, or a value of a type already marked here. Natively such a
   * type would be a record, and the conversion into it a field copy, so a
   * write or identity check through the record would miss the original
   * (`function bump(o: { n: number }) { o.n++ }` called with a class
   * instance). Marking keeps every value of the type a live, checked view.
   * Flows are scanned syntactically, and only sites whose source carries
   * identity query their target type.
   *
   * A copy differs from the original only when something observes the
   * difference, so a type is marked only when the program can: values of
   * the type are written through, compared by identity (`===`, `switch`,
   * assert), used as Set/Map keys or array search needles, given to
   * whole-object observers (console, JSON, Object, util, structuredClone,
   * spreads, for-in, templates, `unknown` parameters) or tested with
   * instanceof; or a field the type
   * exposes is written on the source class after construction, so a copy
   * could read a stale value. A view of readonly data that nothing
   * observes stays a native record. */
  private markIdentityFlows(protocols: Set<ts.Symbol>): void {
    const sites: { source: ts.Expression; target: () => ts.Type | undefined }[] = [];
    /** Expressions whose values are observed as whole objects. */
    const observed: ts.Expression[] = [];
    /** Receivers whose type arguments or elements are observed (Set and Map
     * keys, array search haystacks). */
    const observedContainers: ts.Expression[] = [];
    /** Arguments observed when their parameter type accepts any value
     * (`unknown`, `any`, `object`, `{}`, an unresolved type parameter) or
     * the callee is a generic function or class that observes its type
     * parameter. */
    const looseArguments: ts.Expression[] = [];
    /** The call each loose argument belongs to. */
    const looseCalls: (ts.CallExpression | ts.NewExpression)[] = [];
    /** Member writes: the receiver and the written name (null: any name). */
    const writes: { receiver: ts.Expression; name: string | null }[] = [];
    /** Annotated callback parameters: the caller's argument (the contextual
     * signature's parameter) flows into the declared parameter type. */
    const callbackParams: { fn: ts.SignatureDeclaration; index: number; name: ts.Node }[] = [];
    const contextual = (expr: ts.Expression) => () => this.checker.getContextualType(expr);
    const flow = (expr: ts.Expression | undefined): void => {
      if (expr !== undefined) sites.push({ source: expr, target: contextual(expr) });
    };
    const write = (target: ts.Expression): void => {
      while (ts.isParenthesizedExpression(target) || ts.isNonNullExpression(target))
        target = target.expression;
      if (ts.isPropertyAccessExpression(target)) {
        // `this.f = v` in a constructor initializes the instance before any
        // view of it can exist.
        if (target.expression.kind !== ts.SyntaxKind.ThisKeyword || !inConstructor(target))
          writes.push({ receiver: target.expression, name: target.name.text });
      } else if (ts.isElementAccessExpression(target)) {
        const key = target.argumentExpression;
        writes.push({
          receiver: target.expression,
          name: ts.isStringLiteralLike(key) || ts.isNumericLiteral(key) ? key.text : null,
        });
      }
    };
    const observe = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node)) {
        const op = node.operatorToken.kind;
        if (
          (op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
            op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
            op === ts.SyntaxKind.EqualsEqualsToken ||
            op === ts.SyntaxKind.ExclamationEqualsToken) &&
          !isNullishLiteral(node.left) &&
          !isNullishLiteral(node.right) &&
          !isPrimitiveLiteral(node.left) &&
          !isPrimitiveLiteral(node.right)
        )
          observed.push(node.left, node.right);
        else if (op === ts.SyntaxKind.InstanceOfKeyword) observed.push(node.left);
        else if (op === ts.SyntaxKind.InKeyword) observed.push(node.right);
        else if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment)
          write(node.left);
      } else if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken)
      ) {
        write(node.operand);
      } else if (ts.isDeleteExpression(node)) {
        write(node.expression);
      } else if (ts.isSpreadAssignment(node) || ts.isTemplateSpan(node)) {
        observed.push(node.expression);
      } else if (ts.isForInStatement(node)) {
        observed.push(node.expression);
      } else if (ts.isSwitchStatement(node)) {
        // `switch` matches its cases with ===.
        const cases = node.caseBlock.clauses.nodes
          .filter(ts.isCaseClause)
          .map((clause) => clause.expression)
          .filter((expr) => !isNullishLiteral(expr) && !isPrimitiveLiteral(expr));
        if (cases.length > 0) observed.push(node.expression, ...cases);
      } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const callee = node.expression;
        const args = node.arguments?.nodes ?? [];
        const member = ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
        const owner =
          ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
            ? callee.expression.text
            : null;
        if (
          (owner !== null && OBSERVER_NAMESPACES.has(owner)) ||
          (ts.isIdentifier(callee) &&
            (OBSERVER_FUNCTIONS.has(callee.text) ||
              (ts.isNewExpression(node) && IDENTITY_CONSTRUCTORS.has(callee.text))))
        ) {
          observed.push(...args.filter((arg) => !ts.isSpreadElement(arg)));
          // Object.assign(target, ...) and Object.defineProperty write the target.
          if (owner === "Object" && args[0] !== undefined && OBJECT_WRITERS.has(member ?? ""))
            writes.push({ receiver: args[0], name: null });
        } else if (member !== null && IDENTITY_METHODS.has(member)) {
          observed.push(...args.filter((arg) => !ts.isSpreadElement(arg)));
          observedContainers.push((callee as ts.PropertyAccessExpression).expression);
        } else {
          for (const arg of args) {
            if (ts.isSpreadElement(arg)) continue;
            looseArguments.push(arg);
            looseCalls.push(node);
          }
        }
      }
    };
    const visit = (node: ts.Node): void => {
      observe(node);
      if (ts.isCallExpression(node) || ts.isNewExpression(node))
        node.arguments?.nodes.forEach(flow);
      else if (ts.isVariableDeclaration(node) && node.type !== undefined) flow(node.initializer);
      else if (ts.isPropertyDeclaration(node) && node.type !== undefined) flow(node.initializer);
      else if (ts.isParameter(node) && node.type !== undefined) flow(node.initializer);
      else if (ts.isReturnStatement(node)) flow(node.expression);
      else if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) flow(node.body);
      else if (ts.isYieldExpression(node)) flow(node.expression);
      else if (ts.isArrayLiteralExpression(node))
        node.elements.nodes.forEach((element) => {
          if (!ts.isSpreadElement(element) && !ts.isOmittedExpression(element)) flow(element);
        });
      else if (ts.isPropertyAssignment(node)) flow(node.initializer);
      else if (ts.isShorthandPropertyAssignment(node) && ts.isIdentifier(node.name))
        flow(node.name);
      else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        !ts.isObjectLiteralExpression(node.left) &&
        !ts.isArrayLiteralExpression(node.left)
      ) {
        const left = node.left;
        sites.push({ source: node.right, target: () => this.checker.getTypeAtLocation(left) });
      } else if ((ts.isAsExpression(node) || ts.isTypeAssertion(node)) && !accessedInPlace(node)) {
        const typeNode = node.type;
        sites.push({
          source: node.expression,
          target: () => this.checker.getTypeFromTypeNode(typeNode),
        });
      }
      if (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
        node.parameters.nodes.forEach((param, index) => {
          if (param.type !== undefined) callbackParams.push({ fn: node, index, name: param.name });
        });
      ts.forEachChild(node, visit);
    };
    for (const source of this.sources) if (!source.isDeclarationFile) visit(source);
    if (sites.length === 0 && callbackParams.length === 0) return;

    // One batched checker round trip for every node the scan reads: flow
    // sites sit in bodies whose reachability is not known yet, so the
    // facade has not prefetched them.
    const sourceNodes = sites.map((site) => this.flowSourceNode(site.source));
    const observedNodes = observed.map((expr) => this.flowSourceNode(expr));
    const containerNodes = observedContainers.map((expr) => this.flowSourceNode(expr));
    const looseNodes = looseArguments.map((expr) => this.flowSourceNode(expr));
    const writeNodes = writes.map((w) => this.flowSourceNode(w.receiver));
    attempt(() =>
      this.checker.prefetchClassCollection(
        [
          ...sourceNodes,
          ...callbackParams.map((param) => param.name),
          ...observedNodes,
          ...containerNodes,
          ...looseNodes,
          ...writeNodes,
        ],
        [],
      ),
    );

    const marked = protocols;
    const facts: FlowFacts = {
      observed: new Set(),
      written: new Map(),
      loose: [],
      bases: new Map(),
      origins: new Map(),
      targets: new Map(),
      flows: new Map(),
      genericObservers: new Set(),
    };
    const typeOf = (node: ts.Node): ts.Type | undefined =>
      attempt(() => this.checker.getTypeAtLocation(node));
    for (const node of [...observedNodes, ...containerNodes]) {
      const type = typeOf(node);
      if (type === undefined) continue;
      this.collectSymbols(type, facts.observed, 0);
      // A type parameter observed in a generic function or class: calls of
      // it observe whatever their arguments hold.
      const parts = type.isUnionType() ? ts.constituentTypes(type) : [type];
      for (const part of parts) {
        if ((part.flags & ts.TypeFlags.TypeParameter) === 0) continue;
        const symbol = part.getSymbol();
        for (const declaration of symbol ? symbol.declarations : [])
          if (ts.isTypeParameterDeclaration(declaration) && declaration.parent !== undefined)
            facts.genericObservers.add(declaration.parent);
      }
    }
    for (let i = 0; i < writes.length; i++) {
      const symbols = new Set<ts.Symbol>();
      // `this` has the polymorphic this type: the write lands on the
      // enclosing class's instance.
      const owner =
        writeNodes[i]!.kind === ts.SyntaxKind.ThisKeyword ? thisClass(writeNodes[i]!) : undefined;
      const ownerSymbol = owner?.name ? this.checker.getSymbolAtLocation(owner.name) : undefined;
      if (ownerSymbol !== undefined) symbols.add(ownerSymbol);
      else {
        const type = typeOf(writeNodes[i]!);
        if (type === undefined) continue;
        this.collectSymbols(type, symbols, 2);
      }
      const name = writes[i]!.name;
      for (const symbol of symbols) {
        const names = facts.written.get(symbol);
        if (name === null) facts.written.set(symbol, "all");
        else if (names === undefined) facts.written.set(symbol, new Set([name]));
        else if (names !== "all") names.add(name);
      }
    }
    for (let i = 0; i < looseArguments.length; i++) {
      const type = typeOf(looseNodes[i]!);
      if (type === undefined) continue;
      const symbols = new Set<ts.Symbol>();
      this.collectSymbols(type, symbols, 0);
      if (symbols.size > 0)
        facts.loose.push({ node: looseArguments[i]!, call: looseCalls[i]!, symbols });
    }
    this.facts = facts;
    const pending: { sourceType: ts.Type; target: () => ts.Type | undefined }[] = [];
    for (let i = 0; i < sites.length; i++) {
      const site = sites[i]!;
      const source = sourceNodes[i]!;
      const sourceType = attempt(() => this.checker.getTypeAtLocation(source));
      if (sourceType !== undefined) pending.push({ sourceType, target: site.target });
    }
    for (const { fn, index, name } of callbackParams) {
      attempt(() => {
        // Only structural declared types can lose identity; the contextual
        // signature is a checker round trip, so query it for those alone.
        const declared = this.checker.getTypeAtLocation(name);
        const parts = declared.isUnionType() ? ts.constituentTypes(declared) : [declared];
        if (!parts.some((part) => this.isStructuralTarget(part))) return;
        const context = this.checker.getContextualType(fn as ts.Expression);
        if (context === undefined) return;
        for (const signature of this.checker.getCallSignatures(context)) {
          const parameter = signature.getParameters()[index];
          if (parameter === undefined) continue;
          pending.push({
            sourceType: this.checker.getTypeOfSymbol(parameter),
            target: () => declared,
          });
        }
      });
    }
    // Every site is revisited until nothing new is marked, so each mark's
    // flows and origins are complete.
    const before = new Set(marked);
    const targets = new Map<number, ts.Type | undefined>();
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = pending.length - 1; i >= 0; i--) {
        const entry = pending[i]!;
        if (attempt(() => this.carriesIdentity(entry.sourceType, marked)) !== true) continue;
        if (!targets.has(i)) targets.set(i, attempt(entry.target));
        const target = targets.get(i);
        if (
          target !== undefined &&
          attempt(() => this.markTarget(entry.sourceType, target, marked)) === true
        )
          changed = true;
      }
    }
    // Keep the marks a copy would be told apart from, and the marks whose
    // values flow into a kept view or another live protocol.
    const added = [...marked].filter((symbol) => !before.has(symbol));
    const kept = new Set(added.filter((symbol) => this.needsView(symbol, marked, facts)));
    let grew = true;
    while (grew) {
      grew = false;
      for (const symbol of added) {
        if (kept.has(symbol)) continue;
        for (const into of facts.flows.get(symbol) ?? NO_SYMBOLS) {
          if (kept.has(into) || before.has(into)) {
            kept.add(symbol);
            grew = true;
            break;
          }
        }
      }
    }
    for (const symbol of added) if (!kept.has(symbol)) marked.delete(symbol);
    this.facts = null;
  }

  /** The symbols of `type`'s object parts: union and intersection members,
   * and to `depth` levels the elements and type arguments they hold. */
  private collectSymbols(type: ts.Type, out: Set<ts.Symbol>, depth: number): void {
    if (type.isUnionType() || type.isIntersectionType()) {
      for (const part of ts.constituentTypes(type)) this.collectSymbols(part, out, depth);
      return;
    }
    if ((type.flags & ts.TypeFlags.Object) === 0) return;
    const symbol = type.getSymbol();
    if (symbol !== undefined) out.add(symbol);
    if (depth >= 2 || !type.isTypeReference()) return;
    for (const argument of this.checker.getTypeArguments(type))
      this.collectSymbols(argument, out, depth + 1);
  }

  /** Program classes whose instances can be values of `source`: a class,
   * its bases and the classes extending it, or the classes behind a marked
   * structural type. */
  private originsOf(source: ts.Type, facts: FlowFacts): Set<ts.Symbol> {
    const out = new Set<ts.Symbol>();
    const add = (type: ts.Type): void => {
      if (type.isUnionType() || type.isIntersectionType()) {
        for (const part of ts.constituentTypes(type)) add(part);
        return;
      }
      // A Pick or Omit view's values are instances of the class it views,
      // or of any other program class that has the view's members.
      if (this.pickOfProgramClass(type)) {
        add(type.getAliasTypeArguments()[0]!);
        for (const other of this.classesAcceptedBy(type))
          for (const related of this.classFamily(other, facts)) out.add(related);
        return;
      }
      const symbol = type.getSymbol();
      if (symbol === undefined) return;
      if (this.isProgramClassInstance(type)) {
        for (const related of this.classFamily(symbol, facts)) out.add(related);
      } else {
        for (const origin of facts.origins.get(symbol) ?? NO_SYMBOLS) out.add(origin);
      }
    };
    if (this.checker.isArrayType(source)) {
      const [element] = this.checker.getTypeArguments(source as ts.TypeReference);
      if (element !== undefined) add(element);
    } else add(source);
    return out;
  }

  /** The program classes with methods whose instances are assignable to
   * `type`. */
  private classesAcceptedBy(type: ts.Type): ts.Symbol[] {
    const known = this.accepted.get(type);
    if (known !== undefined) return known;
    this.index();
    const found = new Set<ts.Symbol>();
    for (const entries of this.methods.values())
      for (const declaration of entries) {
        const symbol = declaration.name
          ? this.checker.getSymbolAtLocation(declaration.name)
          : undefined;
        if (
          symbol !== undefined &&
          !found.has(symbol) &&
          this.checker.isTypeAssignableTo(this.checker.getDeclaredTypeOfSymbol(symbol), type)
        )
          found.add(symbol);
      }
    const result = [...found];
    this.accepted.set(type, result);
    return result;
  }

  /** A class symbol with its base classes and the program classes that
   * extend it. */
  private classFamily(symbol: ts.Symbol, facts: FlowFacts): ts.Symbol[] {
    const known = facts.bases.get(symbol);
    if (known !== undefined) return known;
    const family = new Set<ts.Symbol>([symbol]);
    const addBases = (sym: ts.Symbol): void => {
      const declared = this.checker.getDeclaredTypeOfSymbol(sym);
      const target = declared.isTypeReference() ? declared.getTarget() : declared;
      if (!target?.isClassOrInterface()) return;
      for (const base of this.checker.getBaseTypes(target)) {
        const baseSymbol = base.getSymbol();
        if (baseSymbol !== undefined && !family.has(baseSymbol)) {
          family.add(baseSymbol);
          addBases(baseSymbol);
        }
      }
    };
    addBases(symbol);
    const declared = this.checker.getDeclaredTypeOfSymbol(symbol);
    for (const entries of this.methods.values())
      for (const declaration of entries) {
        const other = declaration.name
          ? this.checker.getSymbolAtLocation(declaration.name)
          : undefined;
        if (
          other !== undefined &&
          !family.has(other) &&
          this.checker.isTypeAssignableTo(this.checker.getDeclaredTypeOfSymbol(other), declared)
        )
          family.add(other);
      }
    const result = [...family];
    facts.bases.set(symbol, result);
    return result;
  }

  /** Whether the program can tell a copy of a value of the marked type
   * `symbol` from the original: see markIdentityFlows. */
  private needsView(symbol: ts.Symbol, marked: ReadonlySet<ts.Symbol>, facts: FlowFacts): boolean {
    if (facts.observed.has(symbol) || facts.written.has(symbol)) return true;
    const target = facts.targets.get(symbol);
    if (target === undefined) return true;
    const names = new Set(this.checker.getPropertiesOfType(target).map((p) => ts.symbolName(p)));
    const origins = facts.origins.get(symbol) ?? new Set<ts.Symbol>();
    const writesNames = (written: Set<string> | "all"): boolean =>
      written === "all" || [...written].some((name) => names.has(name));
    for (const origin of origins) {
      const written = facts.written.get(origin);
      if (written !== undefined && writesNames(written)) return true;
      // An accessor runs on every read of the instance: a copy would keep
      // the value of one call.
      if (this.hasAccessorFor(origin, names)) return true;
    }
    // Writes through another live view of the same instances.
    for (const [view, written] of facts.written) {
      if (view === symbol || !marked.has(view) || !writesNames(written)) continue;
      for (const origin of facts.origins.get(view) ?? NO_SYMBOLS)
        if (origins.has(origin)) return true;
    }
    // An argument holding the type, passed where any value is accepted or
    // to a generic function or class that observes its type parameter.
    return facts.loose.some(
      (arg) =>
        arg.symbols.has(symbol) &&
        attempt(() => {
          const context = this.checker.getContextualType(arg.node);
          if (context !== undefined && this.acceptsAnyValue(context)) return true;
          if (facts.genericObservers.size === 0) return false;
          const signature = this.checker.getResolvedSignature(arg.call);
          const declaration = signature && signature.declaration;
          return (
            declaration !== undefined &&
            (facts.genericObservers.has(declaration) ||
              (declaration.parent !== undefined && facts.genericObservers.has(declaration.parent)))
          );
        }) === true,
    );
  }

  /** Whether class `symbol` declares a get or set accessor for one of
   * `names`. */
  private hasAccessorFor(symbol: ts.Symbol, names: ReadonlySet<string>): boolean {
    const declared = this.checker.getDeclaredTypeOfSymbol(symbol);
    return this.checker
      .getPropertiesOfType(declared)
      .some(
        (property) =>
          names.has(ts.symbolName(property)) &&
          property.declarations.some(
            (declaration) =>
              ts.isGetAccessorDeclaration(declaration) || ts.isSetAccessorDeclaration(declaration),
          ),
      );
  }

  /** `unknown`, `any`, `object`, `{}` and type-parameter parameters, alone
   * or in a union. */
  private acceptsAnyValue(type: ts.Type): boolean {
    if (type.isUnionType()) return ts.constituentTypes(type).some((p) => this.acceptsAnyValue(p));
    if (
      (type.flags &
        (ts.TypeFlags.Any |
          ts.TypeFlags.Unknown |
          ts.TypeFlags.NonPrimitive |
          ts.TypeFlags.TypeParameter)) !==
      0
    )
      return true;
    return (
      (type.flags & ts.TypeFlags.Object) !== 0 &&
      this.checker.getPropertiesOfType(type).length === 0 &&
      this.checker.getCallSignatures(type).length === 0 &&
      this.checker.getConstructSignatures(type).length === 0 &&
      !this.checker.isArrayType(type)
    );
  }

  /** The value a flow site hands over: casts through `unknown` or `any`
   * keep the original value (`t as unknown as { v: number }`). */
  /** The expression whose type a flow site carries: parentheses, non-null
   * assertions and casts through `unknown`/`any` keep the value itself. */
  private flowSourceNode(expr: ts.Expression): ts.Expression {
    let inner: ts.Expression = expr;
    for (;;) {
      if (ts.isParenthesizedExpression(inner) || ts.isNonNullExpression(inner)) {
        inner = inner.expression;
        continue;
      }
      if (
        (ts.isAsExpression(inner) || ts.isTypeAssertion(inner)) &&
        (inner.type.kind === ts.SyntaxKind.UnknownKeyword ||
          inner.type.kind === ts.SyntaxKind.AnyKeyword)
      ) {
        inner = inner.expression;
        continue;
      }
      return inner;
    }
  }

  /** `Pick<C, K>` or `Omit<C, K>` over a program class instance type: a
   * view of the class's own members, spelled inline instead of as an
   * interface. Like an interface the class matches, a view that exposes a
   * method needs a live receiver (see protocol). */
  private pickOfProgramClass(type: ts.Type): boolean {
    const alias = type.getAliasSymbol();
    if (alias === undefined || (ts.symbolName(alias) !== "Pick" && ts.symbolName(alias) !== "Omit"))
      return false;
    if (!alias.declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile))
      return false;
    const source = type.getAliasTypeArguments()[0];
    return source !== undefined && this.isProgramClassInstance(source);
  }

  private isProgramClassInstance(type: ts.Type): boolean {
    const symbol = type.getSymbol();
    return (
      symbol !== undefined &&
      (symbol.flags & ts.SymbolFlags.Class) !== 0 &&
      symbol.declarations.some(
        (declaration) => !ts.getSourceFileOfNode(declaration).isDeclarationFile,
      ) &&
      // `typeof C` (the class value) shares the class symbol.
      this.checker.getConstructSignatures(type).length === 0
    );
  }

  private carriesIdentity(type: ts.Type, marked: ReadonlySet<ts.Symbol>): boolean {
    if (type.isUnionType() || type.isIntersectionType())
      return ts.constituentTypes(type).some((part) => this.carriesIdentity(part, marked));
    if ((type.flags & ts.TypeFlags.Object) === 0) return false;
    if (this.checker.isArrayType(type)) {
      const [element] = this.checker.getTypeArguments(type as ts.TypeReference);
      return element !== undefined && this.carriesIdentity(element, marked);
    }
    if (this.isProgramClassInstance(type)) return true;
    // A live Pick or Omit view of a program class holds the instance itself.
    if (this.pickOfProgramClass(type) && this.usesCheckedIdentity(type)) return true;
    const symbol = type.getSymbol();
    if (symbol === undefined) return false;
    if (marked.has(symbol)) return true;
    // A program interface a class matches by its methods (protocol below).
    return (
      this.methods.size > 0 &&
      symbol.declarations.some(
        (declaration) =>
          ts.isInterfaceDeclaration(declaration) &&
          !ts.getSourceFileOfNode(declaration).isDeclarationFile,
      ) &&
      this.protocol(type)
    );
  }

  /** A structural target that natively becomes a record: a program object
   * type that is not a class instance, array, tuple, function or library
   * type. */
  private isStructuralTarget(type: ts.Type): boolean {
    if ((type.flags & ts.TypeFlags.Object) === 0) return false;
    if (this.checker.isArrayType(type) || this.checker.isTupleType(type)) return false;
    if (this.checker.getCallSignatures(type).length > 0) return false;
    if (this.checker.getConstructSignatures(type).length > 0) return false;
    const symbol = type.getSymbol();
    if (symbol === undefined || (symbol.flags & ts.SymbolFlags.Class) !== 0) return false;
    const declarations = symbol.declarations;
    return (
      declarations.length > 0 &&
      declarations.every((declaration) => !ts.getSourceFileOfNode(declaration).isDeclarationFile)
    );
  }

  /** Marks the structural parts of `target` that the identity-carrying
   * parts of `source` flow into. Answers whether anything new was marked. */
  private markTarget(source: ts.Type, target: ts.Type, marked: Set<ts.Symbol>): boolean {
    if (source.isUnionType()) {
      let changed = false;
      for (const part of ts.constituentTypes(source))
        if (this.carriesIdentity(part, marked) && this.markTarget(part, target, marked))
          changed = true;
      return changed;
    }
    if (target.isUnionType()) {
      // Only the arms that accept the value receive it. An accepting arm
      // that holds it as itself (its own type, its class, or another
      // representation with identity) needs no structural view.
      const accepting: ts.Type[] = [];
      for (const part of ts.constituentTypes(target)) {
        if ((part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) !== 0) continue;
        if (part === source || part.getSymbol() === source.getSymbol()) return false;
        if (!this.checker.isTypeAssignableTo(source, part)) continue;
        if (!this.isStructuralTarget(part)) return false;
        accepting.push(part);
      }
      let changed = false;
      for (const part of accepting) if (this.markTarget(source, part, marked)) changed = true;
      return changed;
    }
    if (this.checker.isArrayType(source) && this.checker.isArrayType(target)) {
      const [from] = this.checker.getTypeArguments(source as ts.TypeReference);
      const [to] = this.checker.getTypeArguments(target as ts.TypeReference);
      return from !== undefined && to !== undefined && this.markTarget(from, to, marked);
    }
    if (!this.isStructuralTarget(target)) return false;
    const symbol = target.getSymbol();
    if (symbol === undefined) return false;
    const from = source.getSymbol();
    if (from === symbol) return false;
    const facts = this.facts;
    if (facts !== null) {
      // The flow: the source's classes and marked type reach `symbol`.
      const origins = facts.origins.get(symbol) ?? new Set<ts.Symbol>();
      for (const origin of this.originsOf(source, facts)) origins.add(origin);
      facts.origins.set(symbol, origins);
      if (!facts.targets.has(symbol)) facts.targets.set(symbol, target);
      if (from !== undefined && marked.has(from)) {
        const flows = facts.flows.get(from) ?? new Set<ts.Symbol>();
        flows.add(symbol);
        facts.flows.set(from, flows);
      }
    }
    if (marked.has(symbol)) return false;
    marked.add(symbol);
    return true;
  }

  /** Class-backed protocols require live receiver dispatch. Other interfaces,
   * including factories backed by static methods and ordinary records of
   * closures, retain their fixed native layouts. */
  usesCheckedIdentity(type: ts.Type): boolean {
    if (type.isUnionType()) {
      const present = ts
        .constituentTypes(type)
        .filter((part) => (part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) === 0);
      return present.length > 0 && present.every((part) => this.usesCheckedIdentity(part));
    }
    if (type.isIntersectionType())
      return ts.constituentTypes(type).some((part) => this.usesCheckedIdentity(part));
    if ((type.flags & ts.TypeFlags.Object) === 0) return false;
    const previous = this.answers.get(type);
    if (previous !== undefined) return previous;
    const answer = this.protocol(type);
    this.answers.set(type, answer);
    return answer;
  }

  private protocol(type: ts.Type): boolean {
    const protocols = this.index();
    const symbol = type.getSymbol();
    const properties = this.checker.getPropertiesOfType(type);
    if (symbol && protocols.has(symbol)) return true;
    if (
      !this.pickOfProgramClass(type) &&
      (!symbol ||
        !symbol.declarations.some(
          (declaration) =>
            ts.isInterfaceDeclaration(declaration) &&
            !ts.getSourceFileOfNode(declaration).isDeclarationFile,
        ))
    )
      return false;
    for (const property of properties) {
      const memberType = this.checker.getTypeOfSymbol(property);
      if (this.checker.getCallSignatures(memberType).length === 0) continue;
      for (const declaration of this.methods.get(ts.symbolName(property)) ?? []) {
        const classSymbol = declaration.name
          ? this.checker.getSymbolAtLocation(declaration.name)
          : undefined;
        if (
          classSymbol &&
          this.checker.isTypeAssignableTo(this.checker.getDeclaredTypeOfSymbol(classSymbol), type)
        )
          return true;
      }
    }
    return false;
  }
}

interface FlowFacts {
  /** Types whose values reach identity comparisons, Set/Map keys, array
   * searches or whole-object observers. */
  observed: Set<ts.Symbol>;
  /** Member names written after construction, per receiver type. */
  written: Map<ts.Symbol, Set<string> | "all">;
  /** Call arguments that may reach an any-value parameter. */
  loose: {
    node: ts.Expression;
    call: ts.CallExpression | ts.NewExpression;
    symbols: Set<ts.Symbol>;
  }[];
  /** Generic functions and classes that observe a type parameter's values. */
  genericObservers: Set<ts.Node>;
  /** Class families (see classFamily). */
  bases: Map<ts.Symbol, ts.Symbol[]>;
  /** The classes behind each marked structural type. */
  origins: Map<ts.Symbol, Set<ts.Symbol>>;
  /** A target type per marked symbol, for its member names. */
  targets: Map<ts.Symbol, ts.Type>;
  /** The marked types each marked type's values flow into. */
  flows: Map<ts.Symbol, Set<ts.Symbol>>;
}

/** The empty answer of the symbol maps above. */
const NO_SYMBOLS: ReadonlySet<ts.Symbol> = new Set();

/** Calls of these namespaces and functions observe whole objects. */
const OBSERVER_NAMESPACES = new Set(["console", "JSON", "Object", "Reflect", "util", "assert"]);
const OBSERVER_FUNCTIONS = new Set([
  "structuredClone",
  "String",
  "inspect",
  "format",
  "isDeepStrictEqual",
  // node:assert's named exports.
  "strictEqual",
  "notStrictEqual",
  "deepStrictEqual",
  "notDeepStrictEqual",
  "deepEqual",
  "notDeepEqual",
  "equal",
  "notEqual",
]);
/** Constructors that key their arguments' values by identity. */
const IDENTITY_CONSTRUCTORS = new Set(["Set", "Map", "WeakSet", "WeakMap", "WeakRef"]);
/** Object statics that write their first argument. */
const OBJECT_WRITERS = new Set(["assign", "defineProperty", "defineProperties", "setPrototypeOf"]);
/** Methods that compare their arguments by identity (Set, Map, WeakMap,
 * WeakSet and array searches). */
const IDENTITY_METHODS = new Set([
  "add",
  "has",
  "delete",
  "set",
  "get",
  "indexOf",
  "lastIndexOf",
  "includes",
]);

function isNullishLiteral(node: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return (
    node.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(node) && node.text === "undefined") ||
    ts.isVoidExpression(node)
  );
}

/** A literal or `typeof` operand, which cannot hold an object. */
function isPrimitiveLiteral(node: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return (
    ts.isStringLiteralLike(node) ||
    ts.isNumericLiteral(node) ||
    ts.isBigIntLiteral(node) ||
    ts.isTypeOfExpression(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    ts.isTemplateExpression(node)
  );
}

/** The class whose instance `this` is at `node`: the nearest enclosing
 * class, unless a non-arrow function rebinds `this` first. */
function thisClass(node: ts.Node): ts.ClassLikeDeclaration | undefined {
  for (let cur = node.parent; cur !== undefined; cur = cur.parent) {
    if (ts.isClassDeclaration(cur) || ts.isClassExpression(cur)) return cur;
    if (ts.isFunctionDeclaration(cur) || ts.isFunctionExpression(cur)) return undefined;
  }
  return undefined;
}

/** Whether `node` sits directly in a constructor body (not in a nested
 * function). */
function inConstructor(node: ts.Node): boolean {
  for (let cur = node.parent; cur !== undefined; cur = cur.parent) {
    if (ts.isConstructorDeclaration(cur)) return true;
    if (ts.isFunctionLike(cur) || ts.isClassDeclaration(cur) || ts.isClassExpression(cur))
      return false;
  }
  return false;
}

/** A checker query that may hit an upstream checker panic: the flow scan
 * skips a site it cannot type rather than failing the build. */
function attempt<T>(query: () => T): T | undefined {
  try {
    return query();
  } catch {
    return undefined;
  }
}

/** `(value as T).member` and `(value as T)[key]`: the assertion is read or
 * written member-wise in place, which lowers to the instance's own fields
 * and creates no view that could outlive it. */
function accessedInPlace(node: ts.Expression): boolean {
  let outer: ts.Node = node;
  while (ts.isParenthesizedExpression(outer.parent)) outer = outer.parent;
  const parent = outer.parent;
  return (
    (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
    parent.expression === outer
  );
}
