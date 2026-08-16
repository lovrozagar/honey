## Writing style

en-US English everywhere — code, comments, docs, commit messages.

## Git

Stay on `main`. Don't create, switch, or delete branches.

Fine without asking: `status`, `diff`, `log`, `add`, `commit`, `push`.

Ask first, and wait: anything that can lose work — `reset --hard`, `checkout` /
`restore` over uncommitted changes, `clean`, `stash` (any form), `push --force`
(including `--force-with-lease`), `rebase`, `cherry-pick`, `revert`,
`commit --amend`, deleting tags, anything reflog-driven. If you can't tell,
assume it can.

## Before you call it done

From the repo root; CI runs the same set, with `fmt:check` in place of `fmt`.
`generate` first — the e2e apps'
generated clients feed typecheck and tests.

    bun run generate
    bun run fmt          # oxfmt, rewrites in place
    bun run lint         # oxlint
    bun run typecheck
    bun run typecheck:consumers
    bun run test
    bun run test:consumers

Touching `src/build`, `codegen-loaders.ts`, or anything a bundler sees? Also run
`bun run test:build` — the only thing that catches an optional dependency
leaking into a worker bundle.

Per-runtime e2e (`test:e2e:node`, `:deno`, `:cf`) and `test:harness` need extra
toolchains — leave to CI.
