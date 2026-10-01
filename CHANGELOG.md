# Changelog

All notable changes to [`@lovrozagar/honey`](https://www.npmjs.com/package/@lovrozagar/honey) are documented in this file.

## 0.5.0 - 2026-10-01

### Added

- Route-tree codegen interns shared values in `routes.gen.ts`. Identical JSON Schema subtrees, meta objects, selectors, and error-key arrays are emitted once (`T*` / `U*` / `A*` / `J*` / `I*` / `O*` / `M*` / `P*`) and referenced. Handler objects and error-key `Set`s stay unique so `.routeTree()` patches cannot cross-wire routes. `MetaShape` keeps literal and tuple types. `RouteSelector` is `typeof P0 | typeof P1 | …`.

Regenerate after upgrading: `honey generate`.
