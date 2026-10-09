# Regression matrix

The deep review of `packages/core/src` at `3ab88ce` (v0.6.8) produced a list of findings. The
files here map each finding to a test that reproduces its scenario, and record whether that test
fails on `3ab88ce`. A test that passes on the old code guards nothing, so each one was checked
against it. Each test carries its finding id in its name or in a `// regression: <id>` comment, so
`grep -r "H12" packages/core/tests` finds the guard for H12.

| Workstreams                                                     | Matrix                 |
| --------------------------------------------------------------- | ---------------------- |
| 1–3: route model, middleware finalize, request normalization    | [ws1-3.md](ws1-3.md)   |
| 4–8: streaming, Node/WS, realtime bus, security middleware, I/O | [ws4-8.md](ws4-8.md)   |
| 9–12: OpenAPI, codegen, client runtimes, tooling                | [ws9-12.md](ws9-12.md) |
| Code review of the rework (`3ab88ce..HEAD`), R1–R8              | [review.md](review.md) |

## Re-verify against 3ab88ce

The regression tests use only APIs that already existed at `3ab88ce` where the scenario allows,
so they run unchanged against the old source:

```sh
OLD=$(mktemp -d)
git archive 3ab88ce packages/core | tar -x -C "$OLD"
ln -s "$PWD/node_modules" "$OLD/node_modules"
mkdir -p "$OLD/packages/core/tests/regression"
cp packages/core/tests/regression/<file>.regression.test.ts "$OLD/packages/core/tests/regression/"
(cd "$OLD/packages/core" && "$OLDPWD/node_modules/.bin/vitest" run tests/regression)
```

Every test listed as failing on `3ab88ce` must fail there, for the reason its finding describes.
Import the package by relative path in these tests: in the extracted tree, `@lovrozagar/honey`
resolves to the workspace (current) package.
