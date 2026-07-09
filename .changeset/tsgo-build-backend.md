---
"capnweb-validate": minor
---

Add an experimental `tsgo` build backend (TypeScript 7, the native Go port).

Opt in with `backend: "tsgo"` on the plugin or `--backend tsgo` on the CLI to run
the whole build transform -- type introspection and validator emission -- on the
native TypeScript 7 compiler instead of the classic `typescript` package. On a
real on-disk worker it produces byte-identical output to the classic backend.

This backend consumes TypeScript 7's programmatic API, which is still shipped
under its `/unstable/*` entry points and is not frozen until TS 7.1. It therefore
tracks the TypeScript 7.1 line (`npm:typescript@~7.1.0-dev`) rather than a fixed
release -- rolling onto the 7.1 release when it ships -- and remains experimental
until that API stabilises. The classic backend (the default) is unchanged and
continues to use the `typescript` package.
