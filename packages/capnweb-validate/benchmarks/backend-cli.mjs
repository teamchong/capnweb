// Compares cold, end-to-end CLI builds using the classic and tsgo backends.
// Each timed run starts a fresh Node process, reads the same on-disk project,
// transforms all files, and writes a fresh output tree. Run with:
//
//   npm run bench:backends --workspace packages/capnweb-validate

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const FILE_COUNT = 100;
const ROUNDS = 12;
const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(packageDir, "dist", "cli.mjs");
const projectDir = mkdtempSync(join(tmpdir(), "capnweb-backend-bench-"));

const shim = `
declare module "capnweb" {
  export class RpcTarget { readonly __RPC_TARGET_BRAND: never; }
}
declare module "capnweb-validate" {
  export function validateRpc<T = unknown>(): any;
}
`;

const source = (i) => `
import { RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";

interface User${i} {
  id: string;
  profile: { name: string; flags: { admin: boolean; active: boolean } };
  tags: string[];
  metadata: Map<string, string | number>;
}

@validateRpc()
export class Api${i} extends RpcTarget {
  getUser(id: string): Promise<User${i}> { throw new Error(id); }
  listUsers(limit?: number): Promise<User${i}[]> { throw new Error(String(limit)); }
  updateUser(id: string, patch: Partial<User${i}>): Promise<User${i}> { throw new Error(id); }
  search(query: { text: string; filters?: string[] }): Promise<Array<User${i} | null>> { throw new Error(query.text); }
  setRoles(id: string, roles: Set<"reader" | "writer">): Promise<boolean> { throw new Error(id); }
}
`;

function createProject() {
  writeFileSync(join(projectDir, "shim.d.ts"), shim);
  const names = Array.from({ length: FILE_COUNT }, (_, i) => `api-${i}.ts`);
  for (let i = 0; i < names.length; i++) {
    writeFileSync(join(projectDir, names[i]), source(i));
  }
  writeFileSync(
    join(projectDir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ES2022",
        lib: ["ES2022", "DOM"],
        module: "ESNext",
        moduleResolution: "bundler",
        skipLibCheck: true,
        types: [],
      },
      files: ["shim.d.ts", ...names],
    }),
  );
}

function run(backend) {
  const out = join(projectDir, `out-${backend}`);
  const start = performance.now();
  const result = spawnSync(
    process.execPath,
    [cli, "build", "--cwd", projectDir, "--out", out, "--backend", backend],
    { encoding: "utf8" },
  );
  const elapsed = performance.now() - start;
  if (result.status !== 0) {
    throw new Error(`${backend}: ${result.stderr || result.stdout}`);
  }
  return elapsed;
}

function hashTree(root) {
  const hash = createHash("sha256");
  const walk = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else {
        hash.update(relative(root, path));
        hash.update(readFileSync(path));
      }
    }
  };
  walk(root);
  return hash.digest("hex");
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    medianMs: sorted[Math.floor(sorted.length / 2)],
    meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
    minMs: sorted[0],
    maxMs: sorted.at(-1),
  };
}

try {
  createProject();

  // Untimed warm-up runs remove first-launch noise while every measured build
  // still starts a fresh process and compiler context.
  run("classic");
  run("tsgo");

  const results = { classic: [], tsgo: [] };
  for (let round = 0; round < ROUNDS; round++) {
    const order = round % 2 === 0 ? ["classic", "tsgo"] : ["tsgo", "classic"];
    for (const backend of order) results[backend].push(run(backend));
  }

  const classicHash = hashTree(join(projectDir, "out-classic"));
  const tsgoHash = hashTree(join(projectDir, "out-tsgo"));
  const outputIdentical = classicHash === tsgoHash;
  if (!outputIdentical) throw new Error("backend output trees differ");

  const classic = stats(results.classic);
  const tsgo = stats(results.tsgo);
  console.log(
    JSON.stringify(
      {
        files: FILE_COUNT,
        rounds: ROUNDS,
        outputIdentical,
        classic,
        tsgo,
        medianRatio: tsgo.medianMs / classic.medianMs,
        rawMs: results,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(projectDir, { recursive: true, force: true });
}
