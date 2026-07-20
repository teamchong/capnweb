// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Real-filesystem TransformContext backed by tsgo (the native TypeScript port).
// Mirrors createTransformContext (context.ts) but drives the per-module transform
// on tsgo's IPC API instead of the classic compiler. The transform reads its
// `typeof ts` surface and source files through this context, so the only tsgo-
// specific work lives here and in tsgo-checker.ts.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type ts from "typescript";

import { API, type Project } from "typescript7/unstable/sync";
import { computeLineStarts, skipTrivia, SyntaxKind } from "typescript7/unstable/ast";

import {
  fileMatchesTransformFilters,
  type TransformContext,
  type TransformContextOptions,
} from "./context.js";
import { buildTsgoCompiler, RAW, type TsgoCompiler } from "./tsgo-checker.js";

// Carries a wrapped node's raw source file so traversal/position helpers can
// reach `.text` and child nodes belonging to the same file.
let SF = Symbol("tsgo.tx.sf");

let unwrap = (n: any): any => (n && n[RAW]) ?? n;
let isNode = (v: any): boolean =>
  !!v && typeof v === "object" && typeof v.kind === "number";
// An array-like child collection -- a real NodeArray or tsgo's RemoteNodeList.
// Detected structurally (indexable, not itself a node) rather than by class
// name, which would break under minified/renamed builds.
let isNodeList = (v: any): boolean =>
  !!v &&
  typeof v === "object" &&
  !isNode(v) &&
  typeof v.length === "number" &&
  (Array.isArray(v) ||
    typeof (v as any).forEachNode === "function" ||
    Array.isArray((v as any).nodes));

// Normalize node lists to plain arrays before wrapping their elements.
function listToArray(list: any): any[] {
  let out: any[] = [];
  for (let i = 0; i < list.length; i++) out.push(list[i]);
  return out;
}

function lineAndCharacter(
  text: string,
  pos: number,
): { line: number; character: number } {
  let starts = computeLineStarts(text);
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    let mid = (low + high + 1) >> 1;
    if (starts[mid]! <= pos) low = mid;
    else high = mid - 1;
  }
  return { line: low, character: pos - starts[low]! };
}

// Wraps a raw tsgo node so the transform can treat it like a classic ts.Node.
// tsgo nodes are binary-backed and expose children as prototype getters, so
// `node.getStart(sf)` / `node.getEnd()` and child access all have to be bridged.
// Node- and list-valued property reads are re-wrapped too, so every node the
// transform reaches carries the same position methods.
let txCache = new WeakMap<object, any>();
function wrapTx(raw: any, rawSf: any): any {
  if (!isNode(raw)) return raw;
  let cached = txCache.get(raw);
  if (cached) return cached;
  let proxy: any = new Proxy(raw, {
    get(target, prop) {
      if (prop === RAW) return raw;
      if (prop === SF) return rawSf;
      if (prop === "getStart") return () => skipTrivia(rawSf.text, raw.pos);
      if (prop === "getEnd") return () => raw.end;
      if (prop === "getSourceFile") return () => wrapTx(rawSf, rawSf);
      if (prop === "getLineAndCharacterOfPosition") {
        return (pos: number) => lineAndCharacter(rawSf.text, pos);
      }
      let v = Reflect.get(target, prop, target);
      if (typeof v === "function") return v.bind(raw);
      if (isNode(v)) return wrapTx(v, rawSf);
      if (isNodeList(v)) return listToArray(v).map((c) => wrapTx(c, rawSf));
      return v;
    },
  });
  txCache.set(raw, proxy);
  return proxy;
}

function findTsconfig(start: string): string | undefined {
  let dir = start;
  for (;;) {
    let candidate = join(dir, "tsconfig.json");
    if (existsSync(candidate)) return candidate;
    let parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function createTsgoTransformContext(
  options: TransformContextOptions = {},
): TransformContext {
  let cwd = resolve(options.cwd ?? process.cwd());
  let publicOptions: TransformContextOptions = { ...options, cwd };
  let compiler: TsgoCompiler | null = null;

  function ensure(): TsgoCompiler {
    if (compiler) return compiler;

    let tsconfigPath = options.tsconfig
      ? resolve(cwd, options.tsconfig)
      : findTsconfig(cwd);
    if (!tsconfigPath || !existsSync(tsconfigPath)) {
      throw new Error(
        `capnweb-validate: tsconfig not found ` +
          `(${tsconfigPath ?? `tsconfig.json, cwd=${cwd}`}). ` +
          `Pass \`tsconfig\` to capnwebValidate({...}) or run from a directory ` +
          `with a tsconfig.`,
      );
    }

    let api = new API({ cwd });
    let project: Project = api
      .updateSnapshot({ openProject: tsconfigPath })
      .getProjects()[0]!;
    compiler = buildTsgoCompiler(api, project);

    // The base adapter's forEachChild/getDecorators (in tsgo-checker) hand back
    // raw children, which is all the introspector needs. The transform instead
    // walks the source and reads positions, so override them here to wrap each
    // child through wrapTx.
    let tsm = compiler.tsm;
    tsm.forEachChild = (node: any, cb: (child: any) => void) => {
      let raw = unwrap(node);
      let rawSf = node?.[SF] ?? raw;
      raw?.forEachChild((child: any) => cb(wrapTx(child, rawSf)));
    };
    tsm.getDecorators = (node: any) => {
      let raw = unwrap(node);
      let rawSf = node?.[SF] ?? raw;
      let mods = raw?.modifiers;
      if (!mods) return undefined;
      let out: any[] = [];
      for (let i = 0; i < mods.length; i++) {
        if (mods[i]?.kind === SyntaxKind.Decorator) {
          out.push(wrapTx(mods[i], rawSf));
        }
      }
      return out.length ? out : undefined;
    };
    return compiler;
  }

  function getSourceFile(id: string): ts.SourceFile | undefined {
    let raw = ensure().project.program.getSourceFile(id);
    return raw ? (wrapTx(raw, raw) as unknown as ts.SourceFile) : undefined;
  }

  return {
    options: publicOptions,
    get tsm() {
      return ensure().tsm as unknown as typeof ts;
    },

    listSourceFiles(): Iterable<string> {
      let project = ensure().project as any;
      let files: string[] = [];
      for (let f of (project.rootFiles ?? []) as string[]) {
        if (f.endsWith(".d.ts")) continue;
        if (f.includes("/node_modules/")) continue;
        if (!fileMatchesTransformFilters(f, { ...options, cwd })) continue;
        files.push(f);
      }
      return files;
    },

    getChecker(): ts.TypeChecker {
      return ensure().checker as unknown as ts.TypeChecker;
    },

    getProgram(): ts.Program {
      // tsgo's Program exposes only getSourceFile; the transform never reads the
      // rest. Surface a minimal compatible shape.
      return {
        getSourceFile: (id: string) => getSourceFile(id),
      } as unknown as ts.Program;
    },

    getSourceFile,

    invalidateFile(): void {
      compiler?.dispose();
      compiler = null;
    },

    dispose(): void {
      compiler?.dispose();
      compiler = null;
    },
  };
}
