# AGENTS.md

## Writing style

Use en-US English throughout — code, comments, docs, and commit messages.

## Git safety

Moving forward is yours to do without asking: `status`, `diff`, `log`, `add`,
`commit`, creating branches, and pushing.

Ask first — and wait for an answer — before anything that moves sideways:
discarding work, rewriting history, forcing a change through, or recovering
something. That includes:

- `reset --hard`, `checkout` / `restore` over uncommitted changes, `clean`
- `stash`, `stash pop`, `stash drop`
- `push --force`, including `--force-with-lease`
- `rebase`, `cherry-pick`, `revert`, `commit --amend`
- deleting a branch or tag, local or remote
- anything reflog-driven

If you cannot tell whether a command can lose work, treat it as one that can.

## Before you call it done

Run these from the repo root; CI runs the same set. `generate` comes first —
the e2e apps' generated clients are inputs to typecheck and tests.

    bun run generate
    bun run fmt          # oxfmt, rewrites in place
    bun run lint         # oxlint
    bun run typecheck
    bun run typecheck:consumers
    bun run test
    bun run test:consumers

Before touching `src/build`, `codegen-loaders.ts`, or anything a bundler sees,
also run the build tier — it is the only thing that catches an optional
dependency leaking into a worker bundle:

    bun run test:build

The per-runtime e2e suites (`test:e2e:node`, `test:e2e:deno`, `test:e2e:cf`)
and the polyglot `test:harness` suite need extra toolchains and are normally
left to CI.
