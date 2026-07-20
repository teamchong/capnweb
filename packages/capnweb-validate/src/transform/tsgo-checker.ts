// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Adapts tsgo's (TypeScript-Go) unstable programmatic API to the `{ tsm, checker }`
// shape that `resolveServiceShape` consumes. The introspector imports `typescript`
// type-only and reads everything through these two parameters, so feeding it a
// tsgo-backed pair makes the IR generator run on tsgo.
//
// tsgo differs from the classic API in three ways this adapter bridges:
//   1. Enum *values* differ -- so we hand the introspector tsgo's own enums as
//      `tsm.TypeFlags` etc.; bitwise checks stay self-consistent.
//   2. Type/Symbol/Signature expose data as properties; the introspector calls
//      classic accessor *methods* (getFlags(), getName(), getReturnType()).
//   3. AST nodes are NodeHandles resolved lazily against the Project.
//
// Wrappers are memoised by tsgo object id so identity-keyed Maps in the
// introspector (the service/recursion caches) behave like the classic API.
//
// "typescript7" in the imports below is the package.json devDependency alias for
// npm:typescript@~7.1.0-dev -- the TypeScript 7.1 line (the native "tsgo" port).
// TS 7.0 is GA, but its programmatic API is still shipped under the /unstable/*
// sub-paths and is only frozen in TS 7.1, so we pin the 7.1 nightlies (and the
// eventual 7.1 release) rather than a fixed build; this backend stays a draft
// until 7.1 stabilises the API.

import {
  API,
  SignatureKind,
  TypeFlags,
  SymbolFlags,
  ObjectFlags,
  NodeBuilderFlags,
  type Project,
  type Checker as TsgoChecker,
} from "typescript7/unstable/sync";
import { createVirtualFileSystem } from "typescript7/unstable/fs";
import { SyntaxKind } from "typescript7/unstable/ast";

export let RAW = Symbol("tsgo.raw");
// Marks a wrapped signature-parameter symbol with its (signature, index) so the
// checker adapter can resolve its type via getParameterType(). On recent tsgo
// builds the parameter symbols themselves carry an empty handle, so
// getTypeOfSymbol() on them throws "empty symbol handle"; getParameterType is
// the supported path.
let PARAM = Symbol("tsgo.param");

type Raw = { [RAW]: unknown };

// IndexKind / TypeFormatFlags the introspector references but tsgo doesn't expose
// in the same shape; the values it actually compares against are these.
let IndexKind = { String: 0, Number: 1 } as const;
let TypeFormatFlags = { NoTruncation: NodeBuilderFlags.NoTruncation ?? 1 } as const;
// tsgo's NodeFlags has no GlobalAugmentation member (its bit 1<<11 is YieldContext),
// and the flag isn't surfaced any other way, so isGlobalSymbol's `declare global`
// check can't run on tsgo. 0 makes it a reliable no-op -- global-augmentation built-ins
// fall back to structural validation. Known gap vs the classic backend.
let NodeFlags = { GlobalAugmentation: 0 } as const;

export interface TsgoCompiler {
  tsm: any;
  checker: any;
  // The opened tsgo project (program + checker).
  project: Project;
  // Strip the adapter wrapper from a node, returning the raw tsgo node.
  unwrapNode(node: any): any;
  // Resolve the named top-level type in `fileName` to a wrapped service type.
  getType(fileName: string, typeName: string): any;
  dispose(): void;
}

export function createTsgoCompiler(files: Record<string, string>): TsgoCompiler {
  let api = new API({ cwd: "/", fs: createVirtualFileSystem(files) });
  let project: Project = api
    .updateSnapshot({ openProject: "/tsconfig.json" })
    .getProjects()[0]!;
  return buildTsgoCompiler(api, project);
}

// Build the adapter over an already-opened project -- shared by the VFS
// introspection entry above and the real-FS transform context (tsgo-context.ts).
export function buildTsgoCompiler(api: API, project: Project): TsgoCompiler {
  let checkerRaw: TsgoChecker = project.checker;

  // ---- node resolution -------------------------------------------------------
  let nodeCache = new Map<string, any>();
  function resolveHandle(handle: any): any {
    if (!handle) return undefined;
    let key = handle.path + "#" + handle.index;
    let n = nodeCache.get(key);
    if (!n) {
      n = wrapNode(handle.resolve(project), handle.path);
      nodeCache.set(key, n);
    }
    return n;
  }

  function wrapNode(raw: any, path: string): any {
    if (!raw) return undefined;
    return new Proxy(raw, {
      get(t, prop) {
        if (prop === RAW) return raw;
        if (prop === "getSourceFile") return () => ({ fileName: path });
        if (prop === "parent") {
          try {
            return raw.parent ? wrapNode(raw.parent, path) : undefined;
          } catch {
            return undefined;
          }
        }
        return Reflect.get(t, prop, t);
      },
    });
  }

  // ---- memoised wrappers -----------------------------------------------------
  let typeCache = new Map<number, any>();
  let symbolCache = new Map<number, any>();

  function wrapType(t: any): any {
    if (!t) return t;
    let cached = typeCache.get(t.id);
    if (cached) return cached;
    let w: any = {
      [RAW]: t,
      id: t.id,
      flags: t.flags,
      objectFlags: t.objectFlags,
      value: t.value, // literal types: string/number/boolean value
      intrinsicName: t.intrinsicName,
      getFlags: () => t.flags,
      getSymbol: () => wrapSymbol(t.getSymbol()),
      getCallSignatures: () =>
        checkerRaw.getSignaturesOfType(t, SignatureKind.Call).map(wrapSignature),
      isUnionOrIntersection: () =>
        (t.flags & (TypeFlags.Union | TypeFlags.Intersection)) !== 0,
      isUnion: () => (t.flags & TypeFlags.Union) !== 0,
      getBaseTypes: () => (t.getBaseTypes?.() ?? []).map(wrapType),
      getTypes: () => (t.getTypes?.() ?? []).map(wrapType),
      // Union/intersection members are read as a `.types` property too.
      get types() {
        return (t.getTypes?.() ?? []).map(wrapType);
      },
    };
    typeCache.set(t.id, w);
    return w;
  }

  function wrapSymbol(s: any): any {
    if (!s) return s;
    let cached = symbolCache.get(s.id);
    if (cached) return cached;
    let w: any = {
      [RAW]: s,
      id: s.id,
      name: s.name,
      flags: s.flags,
      escapedName: s.name,
      valueDeclaration: resolveHandle(s.valueDeclaration),
      declarations: (s.declarations ?? []).map(resolveHandle),
      getName: () => s.name,
      getFlags: () => s.flags,
      getDeclarations: () => (s.declarations ?? []).map(resolveHandle),
      getParent: () => wrapSymbol(s.getParent?.()),
      // Read as a property by isCapnwebValidateSymbol; lazy to avoid walking the
      // whole parent chain eagerly.
      get parent() {
        return wrapSymbol(s.getParent?.());
      },
    };
    symbolCache.set(s.id, w);
    return w;
  }

  function wrapSignature(sig: any): any {
    // tsgo parameter symbols carry no declaration, and resolving the signature's
    // declaration to walk its AST hits tsgo's not-yet-decodable RemoteNode child
    // lists. So synthesise a minimal ParameterDeclaration from non-AST signals:
    // rest comes from the signature, the type via getParameterType (see PARAM).
    let lastIdx = sig.parameters.length - 1;
    let isRest = (i: number): boolean => !!sig.hasRestParameter && i === lastIdx;
    let params = sig.parameters.map((ps: any, i: number) =>
      wrapParamSymbol(ps, isRest(i), sig, i),
    );
    return {
      [RAW]: sig,
      getParameters: () => params,
      getReturnType: () => wrapType(checkerRaw.getReturnTypeOfSignature(sig)),
      parameters: params,
    };
  }

  function wrapParamSymbol(s: any, rest: boolean, sig: any, index: number): any {
    // Plain (un-RAW'd) synthetic node: tsm.isParameter sees `.kind`, and the
    // type lookup routes through getParameterType(sig, index) via the PARAM mark
    // since the parameter symbol itself carries no usable handle.
    let decl = {
      kind: SyntaxKind.Parameter,
      dotDotDotToken: rest ? {} : undefined,
      questionToken: undefined,
      initializer: undefined,
    };
    return {
      [RAW]: s,
      [PARAM]: { sig, index },
      id: s.id,
      name: s.name,
      flags: s.flags,
      valueDeclaration: decl,
      declarations: [decl],
      getName: () => s.name,
      getFlags: () => s.flags,
      getDeclarations: () => [decl],
    };
  }

  let unwrapType = (t: any) => (t && t[RAW]) ?? t;
  let unwrapSym = (s: any) => (s && s[RAW]) ?? s;
  let unwrapNode = (n: any) => (n && n[RAW]) ?? n;

  // ---- checker adapter -------------------------------------------------------
  let checker: any = {
    getPropertiesOfType: (t: any) =>
      checkerRaw.getPropertiesOfType(unwrapType(t)).map(wrapSymbol),
    getPropertyOfType: (t: any, name: string) => {
      let found = checkerRaw
        .getPropertiesOfType(unwrapType(t))
        .find((p) => p.name === name);
      return found ? wrapSymbol(found) : undefined;
    },
    getTypeArguments: (t: any) =>
      checkerRaw.getTypeArguments(unwrapType(t)).map(wrapType),
    getTypeAtLocation: (node: any) =>
      wrapType(checkerRaw.getTypeAtLocation(unwrapNode(node))),
    getTypeFromTypeNode: (node: any) =>
      wrapType(checkerRaw.getTypeFromTypeNode(unwrapNode(node))),
    getDeclaredTypeOfSymbol: (s: any) =>
      wrapType(checkerRaw.getDeclaredTypeOfSymbol(unwrapSym(s))),
    getTypeOfSymbol: (s: any) => {
      // Signature parameters resolve through getParameterType: their symbols have
      // no usable handle on recent tsgo builds, so getTypeOfSymbol would throw.
      let param = s && s[PARAM];
      if (param) return wrapType(checkerRaw.getParameterType(param.sig, param.index));
      return wrapType(checkerRaw.getTypeOfSymbol(unwrapSym(s)));
    },
    getTypeOfSymbolAtLocation: (s: any, node: any) => {
      // Signature parameters resolve through getParameterType: their symbols have
      // no usable handle on recent tsgo builds, so getTypeOfSymbol would throw.
      let param = s && s[PARAM];
      if (param) return wrapType(checkerRaw.getParameterType(param.sig, param.index));
      let rawSym = unwrapSym(s);
      let raw = unwrapNode(node);
      // Fall back to the symbol's declared type (also our safety net if a
      // location lookup throws).
      if (raw) {
        try {
          return wrapType(checkerRaw.getTypeOfSymbolAtLocation(rawSym, raw));
        } catch {
          /* fall through to getTypeOfSymbol */
        }
      }
      return wrapType(checkerRaw.getTypeOfSymbol(rawSym));
    },
    getNonNullableType: (t: any) =>
      wrapType(checkerRaw.getNonNullableType(unwrapType(t))),
    getReturnTypeOfSignature: (sig: any) =>
      wrapType(checkerRaw.getReturnTypeOfSignature(unwrapType(sig))),
    typeToString: (t: any) => checkerRaw.typeToString(unwrapType(t)),
    getSymbolAtLocation: (node: any) =>
      wrapSymbol(checkerRaw.getSymbolAtLocation(unwrapNode(node))),
    getAliasedSymbol: (s: any) =>
      wrapSymbol(checkerRaw.getAliasedSymbol(unwrapSym(s))),
    isArrayType: (t: any) => checkerRaw.isArrayLikeType(unwrapType(t)),
    isTupleType: (t: any) =>
      (unwrapType(t).objectFlags & ObjectFlags.Tuple) !== 0,
    getBaseConstraintOfType: (t: any) =>
      wrapType(checkerRaw.getConstraintOfTypeParameter(unwrapType(t))),
    getIndexTypeOfType: (t: any, kind: number) => {
      let infos = checkerRaw.getIndexInfosOfType(unwrapType(t));
      let want = kind === IndexKind.String ? "string" : "number";
      let info = infos.find(
        (i: any) => checkerRaw.typeToString(i.keyType) === want,
      );
      return info ? wrapType((info as any).type) : undefined;
    },
  };

  // ---- tsm (the `typeof ts` surface the introspector reads) ------------------
  let isKind = (k: number) => (node: any) => unwrapNode(node)?.kind === k;
  let tsm: any = {
    TypeFlags,
    SymbolFlags,
    ObjectFlags,
    IndexKind,
    NodeFlags,
    TypeFormatFlags,
    SyntaxKind,
    isParameter: isKind(SyntaxKind.Parameter),
    isIdentifier: isKind(SyntaxKind.Identifier),
    isSourceFile: isKind(SyntaxKind.SourceFile),
    isCallExpression: isKind(SyntaxKind.CallExpression),
    isModuleDeclaration: isKind(SyntaxKind.ModuleDeclaration),
    isPropertySignature: isKind(SyntaxKind.PropertySignature),
    isPropertyDeclaration: isKind(SyntaxKind.PropertyDeclaration),
    isPropertyAssignment: isKind(SyntaxKind.PropertyAssignment),
    isShorthandPropertyAssignment: isKind(SyntaxKind.ShorthandPropertyAssignment),
    // Additional predicates the per-module transform walks the source AST with.
    isImportDeclaration: isKind(SyntaxKind.ImportDeclaration),
    isStringLiteral: isKind(SyntaxKind.StringLiteral),
    isNumericLiteral: isKind(SyntaxKind.NumericLiteral),
    isNamespaceImport: isKind(SyntaxKind.NamespaceImport),
    isNamedImports: isKind(SyntaxKind.NamedImports),
    isNewExpression: isKind(SyntaxKind.NewExpression),
    isPropertyAccessExpression: isKind(SyntaxKind.PropertyAccessExpression),
    isClassDeclaration: isKind(SyntaxKind.ClassDeclaration),
    isMethodDeclaration: isKind(SyntaxKind.MethodDeclaration),
    isExternalModule: (sf: any) => !!unwrapNode(sf)?.externalModuleIndicator,
    canHaveModifiers: () => true,
    canHaveDecorators: () => true,
    getModifiers: (node: any) => unwrapNode(node)?.modifiers?.nodes ?? undefined,
    // Default (introspection) traversal: children are passed through raw. The
    // transform context overrides this to wrap children for position access.
    forEachChild: (node: any, cb: (child: any) => void) =>
      unwrapNode(node)?.forEachChild((child: any) => cb(child)),
    getDecorators: (node: any) => {
      // tsgo exposes decorators inside the modifier list. Return raw decorator
      // nodes.
      let mods = unwrapNode(node)?.modifiers;
      if (!mods) return undefined;
      let out: any[] = [];
      for (let i = 0; i < mods.length; i++) {
        if (mods[i]?.kind === SyntaxKind.Decorator) out.push(mods[i]);
      }
      return out.length ? out : undefined;
    },
  };

  // tsgo has no "resolve a type by name" entry point, so find the named
  // top-level declaration among the file's statements and read its type there.
  function getType(fileName: string, typeName: string): any {
    let sf = project.program.getSourceFile(fileName);
    if (!sf) throw new Error(`tsgo: source file not found: ${fileName}`);
    let decl = (sf as any).statements.find(
      (s: any) => s.name && s.name.text === typeName,
    );
    if (!decl) throw new Error(`tsgo: type not found: ${typeName}`);
    return wrapType(checkerRaw.getTypeAtLocation(decl));
  }

  return { tsm, checker, getType, project, unwrapNode, dispose: () => api.close() };
}
