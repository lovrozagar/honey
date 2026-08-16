# Packaging — why honey ships source _and_ declarations

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

Ship both, and split the conditions:

```json
"exports": {
	".": { "types": "./dist/index.d.ts", "default": "./src/index.ts" }
}
```

- **TypeScript** resolves `types` → generated `.d.ts`, which `skipLibCheck` covers. The consumer
  never type-checks our source, so our lint posture is ours alone.
- **Bundlers and runtimes** resolve `default` → `./src/*.ts`, unchanged. Workers bundling, Vite,
  and the precompiled-tree path all behave exactly as before.
- **`declarationMap` is emitted and `src` still ships**, so go-to-definition lands in real source
  rather than a generated stub. The debugging story that made source-shipping attractive survives.

`prepack` builds `dist` (`tsc -p tsconfig.dts.json`). npm runs `prepack` for both `npm pack` and
`npm publish`, and the release workflow publishes from `packages/core`, so a tarball physically
cannot ship with a stale or missing `dist`.

## The trade-off, stated

We pay: a build step, ~870KB of declarations in the tarball, and one more artifact that must stay in
sync (it is generated, so it does — but it is a step that can be forgotten, which is why it hangs off
`prepack` rather than a human).

We keep: source shipping, and with it Workers bundling with no `dist/*.js` indirection, TS-path
debugging, and the ability to read the real implementation from `node_modules`.

We buy: consumers are permanently decoupled from our compiler flags, and from any flag TypeScript
adds later.

**This generalizes.** Any package of ours that ships source has the same exposure. The rule: ship
source for the runtime condition, ship declarations for the `types` condition, and gate it with a
packaging test. `comb` passes today only because its source happens to satisfy two particular flags
— that is luck, not a boundary, and it does not cover TS5097 for a consumer who cannot enable
`allowImportingTsExtensions`.

## The regression test

`bun run test:packaging` (`e2e/run-strict-consumer.ts`) packs the tarball exactly as npm would,
installs it into a throwaway consumer, type-checks against `e2e/strict-consumer/` — a fixture with
`strict`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`,
`noUncheckedIndexedAccess`, `verbatimModuleSyntax` and friends — and fails on any diagnostic whose
path is inside the package.

It runs as its own CI job. Every other tier compiles honey with honey's own tsconfig, so this is the
only place the consumer's view is visible at all.
