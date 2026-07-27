// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Real-filesystem TransformContext backed by tsgo (the native TypeScript port).
// Mirrors createTransformContext (context.ts) but drives the per-module transform
// on tsgo's IPC API instead of the classic compiler. The transform reads its
// `typeof ts` surface and source files through this context, so the only tsgo-
// specific work lives here and in tsgo-checker.ts.

import { resolve } from "node:path";
import ts from "typescript";

import { API, type Project } from "typescript7/unstable/sync";
import { computeLineStarts, skipTrivia } from "typescript7/unstable/ast";

import {
  fileMatchesTransformFilters,
  type TransformContext,
  type TransformContextOptions,
} from "./context.js";
import { buildTsgoCompiler, type TsgoCompiler } from "./tsgo-checker.js";

// computeLineStarts is O(text). Diagnostics come in batches per file, so cache
// the scan; without this a file with many findings is quadratic in its size.
let lineStartsCache = new WeakMap<object, readonly number[]>();

function getLineStarts(sourceFile: object, text: string): readonly number[] {
  let cached = lineStartsCache.get(sourceFile);
  if (!cached) {
    cached = computeLineStarts(text);
    lineStartsCache.set(sourceFile, cached);
  }
  return cached;
}

function lineAndCharacter(
  starts: readonly number[],
  pos: number,
): { line: number; character: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    let mid = (low + high + 1) >> 1;
    if (starts[mid]! <= pos) low = mid;
    else high = mid - 1;
  }
  return { line: low, character: pos - starts[low]! };
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
      : ts.findConfigFile(cwd, ts.sys.fileExists, "tsconfig.json");
    if (!tsconfigPath || !ts.sys.fileExists(tsconfigPath)) {
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

    return compiler;
  }

  function getSourceFile(id: string): ts.SourceFile | undefined {
    let raw = ensure().project.program.getSourceFile(id);
    return raw as unknown as ts.SourceFile | undefined;
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

    getNodeStart(node: ts.Node, sourceFile: ts.SourceFile): number {
      return skipTrivia((sourceFile as any).text, (node as any).pos);
    },

    getNodeEnd(node: ts.Node): number {
      return (node as any).end;
    },

    getLineAndCharacter(sourceFile: ts.SourceFile, position: number) {
      return lineAndCharacter(
        getLineStarts(sourceFile, (sourceFile as any).text),
        position,
      );
    },

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
