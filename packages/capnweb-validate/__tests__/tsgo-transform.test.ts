// The tsgo backend runs the entire per-module transform on the native compiler
// over a real on-disk project. These prove the validators it emits behave
// identically to the classic backend, using the same fixtures and runtime
// assertions as the rest of the suite (transformFixture + loadValidator).
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accepts,
  checkedMethod,
  loadValidator,
  transformFixture,
} from "./helpers.js";
import { createTsgoTransformContext } from "../src/transform/tsgo-context.js";
import { v } from "../src/internal/core.js";

let API = `interface User {
  id: string;
  name: string;
  admin: boolean;
}
class Api extends RpcTarget {
  async greet(name: string): Promise<string> {
    return name;
  }
  async add(a: number, b: number): Promise<number> {
    return a + b;
  }
  async getUser(id: string): Promise<User> {
    return null as any;
  }
  async tags(): Promise<string[]> {
    return [];
  }
}`;

function tsgoValidator() {
  let { code } = transformFixture(API, {
    target: "new Api()",
    backend: "tsgo",
  });
  return loadValidator(code);
}

describe("tsgo backend: emitted validators match the classic backend", () => {
  it("validates primitive method parameters (via getParameterType)", () => {
    let validator = tsgoValidator();

    let greet = checkedMethod(validator, "greet");
    expect(greet.args![0]).toBe(v.string);

    let add = checkedMethod(validator, "add");
    expect(add.args![0]).toBe(v.number);
    expect(add.args![1]).toBe(v.number);
  });

  it("validates object and array return shapes at runtime", () => {
    let validator = tsgoValidator();

    let user = checkedMethod(validator, "getUser").returns;
    expect(accepts(user, { id: "u1", name: "Ada", admin: true })).toBe(true);
    expect(accepts(user, { id: "u1", name: "Ada", admin: "yes" })).toBe(false);
    expect(accepts(user, { id: "u1", name: "Ada" })).toBe(false);

    let tags = checkedMethod(validator, "tags").returns;
    expect(accepts(tags, ["a", "b"])).toBe(true);
    expect(accepts(tags, ["a", 2])).toBe(false);
  });

  it("emits byte-identical output to the classic backend", () => {
    let tsgo = transformFixture(API, {
      target: "new Api()",
      backend: "tsgo",
    }).code;
    let classic = transformFixture(API, { target: "new Api()" }).code;
    expect(tsgo).toBe(classic);
  });

  it("preserves alias metadata exposed by the tsgo API", () => {
    let code = transformFixture(
      `class Api extends RpcTarget {
        flags(): Promise<Record<"admin" | "active", boolean>> {
          throw new Error();
        }
      }`,
      { target: "new Api()", backend: "tsgo" },
    ).code;
    expect(code).toContain('}, "Record")');
  });
});

// The real Worker/Durable-Object shape: a @validateRpc class extends a
// cloudflare:workers base, whose platform methods (fetch/alarm/tailStream) must
// be filtered to pass-through rather than validated. If tsgo handles this the
// same as classic, capnweb-validate works in a Worker + Durable Object.
let WORKERS_SHIM = `
declare module "capnweb" {
  export class RpcTarget { readonly __RPC_TARGET_BRAND: never; }
}
declare module "cloudflare:workers" {
  export class WorkerEntrypoint<Env = unknown> {
    readonly __WORKER_ENTRYPOINT_BRAND: never;
    fetch?(request: Request): Response | Promise<Response>;
    tailStream?(event: unknown): unknown;
  }
  export class DurableObject<Env = unknown> {
    readonly __DURABLE_OBJECT_BRAND: never;
    fetch?(request: Request): Response | Promise<Response>;
    alarm?(): void | Promise<void>;
  }
}
declare module "capnweb-validate" {
  export function validateRpc(...args: unknown[]): unknown;
}
`;

function bothBackends(source: string): { classic: string; tsgo: string } {
  let opts = { shim: WORKERS_SHIM, imports: "" };
  let classic = transformFixture(source, opts).code;
  let tsgo = transformFixture(source, { ...opts, backend: "tsgo" }).code;
  return { classic, tsgo };
}

describe("tsgo backend: Worker + Durable Object parity", () => {
  it("WorkerEntrypoint -- validates rpc, passes platform methods through, matches classic", () => {
    let { classic, tsgo } = bothBackends(`
      import { WorkerEntrypoint } from "cloudflare:workers";
      import { validateRpc } from "capnweb-validate";
      @validateRpc()
      class Api extends WorkerEntrypoint {
        rpc(x: string): Promise<string> { return null as any; }
      }
      export default Api;
    `);
    expect(tsgo).toBe(classic);

    let validator = loadValidator(tsgo);
    expect(Object.keys(validator.methods)).toEqual(["rpc"]);
    expect(checkedMethod(validator, "rpc").args![0]).toBe(v.string);
    expect(validator.passthrough).toEqual(
      expect.arrayContaining(["fetch", "tailStream"]),
    );
  });

  it("DurableObject -- validates rpc, passes platform methods through, matches classic", () => {
    let { classic, tsgo } = bothBackends(`
      import { DurableObject } from "cloudflare:workers";
      import { validateRpc } from "capnweb-validate";
      @validateRpc()
      class Api extends DurableObject {
        rpc(x: string): Promise<string> { return null as any; }
      }
      export default Api;
    `);
    expect(tsgo).toBe(classic);

    let validator = loadValidator(tsgo);
    expect(Object.keys(validator.methods)).toEqual(["rpc"]);
    expect(validator.passthrough).toEqual(
      expect.arrayContaining(["fetch", "alarm"]),
    );
    // The nominal brand is filtered, not exposed as a method or pass-through.
    expect(validator.passthrough).not.toContain("__DURABLE_OBJECT_BRAND");
  });
});

// The CLI build (run.ts) enumerates files via listSourceFiles; the transform
// tests drive transformModule directly, so this covers that separate path --
// a regression here would make `capnweb-validate build --backend tsgo` silently
// transform nothing.
describe("tsgo backend: project enumeration", () => {
  it("listSourceFiles returns project sources and skips declaration files", () => {
    let dir = mkdtempSync(join(tmpdir(), "capnweb-tsgo-ls-"));
    try {
      writeFileSync(
        join(dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            target: "ES2022",
            lib: ["ES2022"],
            module: "ESNext",
            moduleResolution: "bundler",
            skipLibCheck: true,
            types: [],
          },
          files: ["worker.ts", "shim.d.ts"],
        }),
      );
      writeFileSync(join(dir, "worker.ts"), "export let x: number = 1;\n");
      writeFileSync(join(dir, "shim.d.ts"), 'declare module "x" {}\n');

      let ctx = createTsgoTransformContext({ cwd: dir, tsconfig: "tsconfig.json" });
      try {
        let files = [...ctx.listSourceFiles()];
        expect(files.some((f) => f.endsWith("worker.ts"))).toBe(true);
        expect(files.some((f) => f.endsWith(".d.ts"))).toBe(false);
      } finally {
        ctx.dispose();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
