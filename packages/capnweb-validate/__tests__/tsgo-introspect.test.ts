// Proves the real IR generator (resolveServiceShape) runs on tsgo's API.
import { describe, it, expect } from "vitest";
import { resolveServiceShape } from "../src/transform/type-introspector.js";
import { createTsgoCompiler } from "../src/transform/tsgo-checker.js";

const tsconfig = JSON.stringify({
  compilerOptions: {
    strict: true,
    target: "ES2022",
    lib: ["ES2022"],
    module: "ESNext",
    moduleResolution: "bundler",
  },
  files: ["svc.ts"],
});

describe("tsgo backend: resolveServiceShape generates IR via TypeScript-Go", () => {
  it("lowers a simple service to the validator IR", () => {
    const c = createTsgoCompiler({
      "/tsconfig.json": tsconfig,
      "/svc.ts":
        "export interface S { greet(name: string): string; add(a: number, b: number): number; }",
    });
    try {
      const type = c.getType("/svc.ts", "S");
      const shape = resolveServiceShape(c.tsm, c.checker, type);
      expect(shape).toBeTruthy();
      const byName = Object.fromEntries(shape!.methods.map((m) => [m.name, m]));
      expect(byName.greet).toMatchObject({
        params: [{ kind: "string" }],
        returns: { kind: "string" },
      });
      expect(byName.add).toMatchObject({
        params: [{ kind: "number" }, { kind: "number" }],
        returns: { kind: "number" },
      });
    } finally {
      c.dispose();
    }
  });

  it("lowers objects, arrays, unions and optionals via tsgo", () => {
    const c = createTsgoCompiler({
      "/tsconfig.json": tsconfig,
      "/svc.ts": [
        "export interface Api {",
        "  getUser(id: string): { id: string; name: string; admin: boolean };",
        "  tags(): string[];",
        "  status(): 'on' | 'off';",
        "  maybe(x?: number): boolean;",
        "}",
      ].join("\n"),
    });
    try {
      const shape = resolveServiceShape(c.tsm, c.checker, c.getType("/svc.ts", "Api"));
      const m = Object.fromEntries(shape!.methods.map((x) => [x.name, x]));

      expect(m.getUser).toMatchObject({
        params: [{ kind: "string" }],
        returns: {
          kind: "object",
          properties: {
            id: { kind: "string" },
            name: { kind: "string" },
            admin: { kind: "boolean" },
          },
        },
      });
      expect(m.tags).toMatchObject({ returns: { kind: "array", element: { kind: "string" } } });
      expect((m.status as any).returns.kind).toBe("union");
      expect(
        ((m.status as any).returns.branches as any[]).map((b) => b.value).sort(),
      ).toEqual(["off", "on"]);
      // optional param widens to `T | undefined`
      const maybeParam = (m.maybe as any).params[0];
      const kinds = maybeParam.kind === "union"
        ? maybeParam.branches.map((b: any) => b.kind).sort()
        : [maybeParam.kind];
      expect(kinds).toContain("undefined");
    } finally {
      c.dispose();
    }
  });
});
