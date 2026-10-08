# Packaging — why honey ships source, declarations and JavaScript

## The problem

honey shipped raw TypeScript: `"files": ["docs", "src"]`, and every `exports` subpath pointed at
`./src/*.ts`. That is pleasant for us and hostile to a consumer, because **a package that ships
`.ts` inherits the consumer's compiler flags**. There is no per-directory suppression for `.ts`
under `node_modules`, and `skipLibCheck` does not help — it covers `.d.ts` only.

Measured against the real published tarball, from a fixture with every plausible strictness flag on:

```
522 diagnostics originate inside @lovrozagar/honey

    358  TS4111   Property 'x' comes from an index signature, must be accessed with ['x']
     81  TS5097   An import path can only end with '.ts' when allowImportingTsExtensions is enabled
     27  TS18048  'x' is possibly 'undefined'
     22  TS2379   argument not assignable under exactOptionalPropertyTypes
      …
```

A downstream app reported 482 under its own flag set. Same wall, different height.

## Why "just fix the source" was not enough

The obvious answer is to make our source satisfy those flags — `@lovrozagar/comb` ships raw `src`
and produces zero errors in the same app, so it is demonstrably possible. Two things ruled it out:

1. **TS5097 is not a style problem.** 81 of the diagnostics say the consumer must enable
   `allowImportingTsExtensions`, which in turn requires `noEmit` or `emitDeclarationOnly` — we would
   be dictating a consumer's build configuration. No amount of tidying our own source removes that;
   it is inherent to importing `.ts` paths with extensions.
2. **The flag set is unbounded.** Fixing 522 errors buys immunity to _today's_ flags. Tomorrow a
   consumer enables something that does not exist yet, and we are back here. `skipLibCheck` over
   `.d.ts` is a real, permanent boundary; matching an open set of lint flags is a treadmill.

## What we do instead

Ship source, declarations _and_ compiled JavaScript, and split the conditions:

```json
"exports": {
	".": {
		"honey-source": "./src/index.ts",
		"types": "./dist/index.d.ts",
		"bun": "./src/index.ts",
		"default": "./dist/index.js"
	}
}
```

- **TypeScript** resolves `types` → generated `.d.ts`, which `skipLibCheck` covers. The consumer
  never type-checks our source, so our lint posture is ours alone.
- **Node, Deno, Workers bundlers and Vite** resolve `default` → `./dist/*.js`. Node refuses to strip
  types from `.ts` files under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so
  a package whose runtime entry is `.ts` cannot be imported on plain Node at all — not the core
  entry, not the Vite plugin, not the CLI. Shipping only source made the package Bun-only in
  practice while the README promised Node.
- **Bun** resolves `bun` → `./src/*.ts`. It runs TypeScript natively, and the `honey` bin
  (`bin/honey.js`) does the same split: Bun runs `src/cli.ts`, every other runtime `dist/cli.js`.
- **`honey-source`** is this repository's own condition. Every tool here resolves it first —
  `customConditions` in the tsconfigs, `resolve.conditions` in the vitest configs,
  `--conditions=honey-source` for Node and Deno, `WRANGLER_BUILD_CONDITIONS` for wrangler — so
  development and tests always run the source and never a stale `dist/`. A consumer never sets it.
- **`declarationMap` and `sourceMap` are emitted and `src` still ships**, so go-to-definition and
  stack traces land in real source.

`bun run build` (`scripts/build.ts`) compiles `src` with `tsconfig.build.json` and copies the
non-TypeScript assets codegen reads at run time (the Go, Python and Rust SDK runtimes, the Go CLI
and MCP templates). `prepack` runs it; npm runs `prepack` for both `npm pack` and `npm publish`, so
a tarball cannot ship with a stale or missing `dist`. The build tier (`bun run test:build`) also
builds first, because its bundles resolve honey the way a consumer's do.

## The trade-off, stated

We pay: a build step, the compiled output and declarations in the tarball, and one more artifact that
must stay in sync (it is generated, so it does — but it is a step that can be forgotten, which is why
it hangs off `prepack` rather than a human).

We keep: source shipping for Bun and for debugging.

We buy: consumers are decoupled from our compiler flags, and the package runs on every runtime the
README names.

**This generalizes.** Any package of ours that ships source has the same exposure. The rule: ship
compiled JavaScript for the runtime condition, declarations for the `types` condition, source for
Bun and debugging, and gate it with a packaging test that runs on plain Node.

## The regression test

`bun run test:packaging` (`e2e/run-strict-consumer.ts`) packs the tarball exactly as npm would,
installs it into a throwaway consumer, type-checks against `e2e/strict-consumer/` — a fixture with
`strict`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`,
`noUncheckedIndexedAccess`, `verbatimModuleSyntax` and friends — and fails on any diagnostic whose
path is inside the package.

It then runs the installed package: on Bun, and on plain Node — the core entry, `honey generate`
against a Vite config, and `vite build` with `honey()` and `createBuildPlugin`, whose output must
serve `/health`. No tsx, no type stripping.

It runs as its own CI job, on Node 22 and the current Node. Every other tier runs honey from source,
so this is the only place the consumer's view is visible at all.
