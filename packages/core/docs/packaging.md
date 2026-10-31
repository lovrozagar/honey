# Packaging: why honey ships declarations and JavaScript, not source

## The problem

A package that ships `.ts` inherits the consumer's compiler flags. There is no per-directory suppression for `.ts`
under `node_modules`, and `skipLibCheck` covers `.d.ts` only. Measured against v0's published tarball, which shipped
raw TypeScript, from a fixture with every plausible strictness flag on:

```text
522 diagnostics originate inside @lovrozagar/honey

    358  TS4111   Property 'x' comes from an index signature, must be accessed with ['x']
     81  TS5097   An import path can only end with '.ts' when allowImportingTsExtensions is enabled
     27  TS18048  'x' is possibly 'undefined'
     22  TS2379   argument not assignable under exactOptionalPropertyTypes
      …
```

Fixing the source was not enough:

1. **TS5097 is not a style problem.** Importing `.ts` paths makes the consumer enable `allowImportingTsExtensions`,
   which requires `noEmit` or `emitDeclarationOnly`: the package would dictate the consumer's build.
2. **The flag set is unbounded.** Fixing today's diagnostics buys immunity to today's flags only. `skipLibCheck` over
   `.d.ts` is a permanent boundary.

Node also refuses to strip types under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so a package
whose runtime entry is `.ts` cannot run on plain Node at all.

## What ships

`@lovrozagar/honey` and `@lovrozagar/honey-clients` each ship `bin/`, `dist/` (compiled JavaScript and its `.d.ts`), the
README and the license. No source. Every export names three conditions:

```json
{
	"exports": {
		".": {
			"honey-source": "./src/index.ts",
			"types": "./dist/index.d.ts",
			"default": "./dist/index.js"
		}
	}
}
```

- **TypeScript** resolves `types` to the generated `.d.ts`, which `skipLibCheck` covers. A consumer never type-checks
  honey's source, so honey's own compiler flags stay honey's.
- **Node, Bun, Cloudflare Workers and every bundler** resolve `default`, the compiled `dist/`. v0's `bun` condition,
  which pointed Bun at the source, is gone: an install runs the same `dist/` on every runtime.
- **`honey-source`** is this repository's own condition. Every tool here resolves it first: `customConditions` in the
  tsconfigs, `resolve.conditions` in the Vite and vitest configs, `--conditions=honey-source` for Node and Bun
  (`NODE_OPTIONS` and `BUN_OPTIONS` in the e2e runners), and `WRANGLER_BUILD_CONDITIONS` for wrangler. Development and
  tests run the source and never a stale `dist/`. A consumer never sets it.
- **The bins** (`bin/honey.js`, `bin/honey-clients.js`) follow the same split: in a repository checkout, marked by
  `tsconfig.json`, which is not published, they run the source; an install runs `dist/`.

## How a tarball is made

`prepack` runs `bun scripts/build.ts`, which compiles `src` with `tsconfig.build.json` and copies the non-TypeScript
assets generation reads at run time. npm runs `prepack` for both `npm pack` and `npm publish`, so a tarball cannot
ship a stale or missing `dist/`.

`bun scripts/pack.ts <out> <package>...` packs each package from a staged copy. npm packs a manifest as written, and
`catalog:` and `workspace:` resolve only inside this repository, so the staged manifest names versions; the build runs
in the copy, and the checkout never gets a `dist/`. The release workflow and the packaging tests both pack this way.

## The trade-off

A build step, and compiled output and declarations in the tarball, which `prepack` keeps current. In exchange,
consumers are decoupled from honey's compiler flags, and the package runs on every runtime the README names.

## The tests

- **`bun run test:packaging`** (`packages/core/tests/e2e/run-strict-consumer.ts`) installs the packed tarball into a
  throwaway consumer and type-checks `packages/core/tests/e2e/strict-consumer/`: `strict`,
  `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, `noUncheckedIndexedAccess`,
  `verbatimModuleSyntax` and the rest. It fails on any diagnostic whose path is inside the package, then runs the
  installed package on Node and Bun. CI runs it on Node 22 and the current Node.
- **`packages/core/tests/build/packaging.test.ts`** packs both real tarballs and checks what they carry (bin, dist, the
  README, the license, every export's files, and no source), that each installs and runs, and that a consumer
  type-checks against every core subpath with every strictness flag on.
