# Changelog

All notable changes to [`@lovrozagar/honey`](https://www.npmjs.com/package/@lovrozagar/honey) are documented in this file.

## 0.5.2 - 2026-10-02

### Changed

- Route-tree codegen emits interned static trees again. Cloudflare Worker Startup Time on a minified isolate that only loads the anyrow gateway `routes.gen.ts`: intern **18 ms**, packed `assembleRouteTree` **25 ms**, `JSON.parse` + inflate **39 ms**. Unique handlers and unique `ek` Sets stay. `MetaShape` and `RouteSelector` stay type-only.

Regenerate after upgrading: `honey generate`.

## 0.5.1 - 2026-10-01

### Changed

- Route-tree codegen emits a columnar `PackedRouteTable` object literal plus `assembleRouteTree` from `@lovrozagar/honey/tree`. Gzip/brotli of minified workers keep repeated JSON Schema text; named intern consts (`T*` / `J*` / `H*`) lost to the compressor. JSON Schema vocabulary keys in `iv`/`os` are packed (`type`→`t`) and expanded on inflate; property names, `enum`/`const`/`default` values stay intact. Type/format strings shrink (`string`→`s`, `email`→`e`). A `{oneOf:[schema,{type:"null"}]}` node flattens to `n1`. Input sources and output content types use short keys (`json`→`j`, `application/json`→`j`). Shared error keys live in `k`; identical meta keys collapse to `u` indices. Duplicate column values collapse to `{t,x}` when that JSON is smaller. `RouteSelector` is `typeof P[number]` from a type-only `declare const P`. `MetaShape` still uses literal and tuple types. Each inflated handler and `ek` Set is unique so `.routeTree()` patches cannot cross-wire routes.

Regenerate after upgrading: `honey generate`.

## 0.5.0 - 2026-10-01

### Added

- Route-tree codegen interns shared values in `routes.gen.ts`. Identical JSON Schema subtrees, meta objects, selectors, and error-key arrays are emitted once (`T*` / `U*` / `A*` / `J*` / `I*` / `O*` / `M*` / `P*`) and referenced. Handler objects and error-key `Set`s stay unique so `.routeTree()` patches cannot cross-wire routes. `MetaShape` keeps literal and tuple types. `RouteSelector` is `typeof P0 | typeof P1 | …`.

Regenerate after upgrading: `honey generate`.
