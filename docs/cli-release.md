# Releasing a generated CLI

`honey-codegen generate --target cli --repo <owner>/<repo>` writes a Go module ready to release from its own
repository. Besides the commands, it holds a goreleaser config, a GitHub Actions release workflow, and `install.sh` and
`install.ps1`. It ships no README: you write one for your users, and this page is what it should say.

## What the module documents itself

`<bin> --help` at every level, `<bin> commands` (every command), `<bin> schema <command>` (a command's inputs and
output as JSON Schema) and `<bin> skill` (the embedded `SKILL.md`, for agents). Your README points at these rather
than copying them, so it never goes stale.

## The README to write

Your README needs four parts:

1. **What it is:** a sentence on your API and what the CLI is for.
2. **Install:** the one-liner below, with your repository in it.
3. **Configure:** the base URL and the credentials, by flag, environment variable or config file.
4. **Verify:** for users who check what they install, the release section below.

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/install.sh | sh
```

On Windows:

```sh
irm https://raw.githubusercontent.com/<owner>/<repo>/main/install.ps1 | iex
```

## The release flow

Pushing a `v*` tag runs the release workflow:

1. goreleaser builds the binaries for Linux, macOS and Windows on amd64 and arm64.
2. It writes `checksums.txt`.
3. cosign signs `checksums.txt` keyless (`checksums.txt.sigstore.json`).
4. GitHub attests the build's provenance.

## What the installers check

Each installer checks the archive's sha256 against `checksums.txt` before anything installs.

- **With `cosign` on PATH,** it first checks `checksums.txt` against its bundle, as signed by your repository's
  release workflow on a `v*` tag.
- **`<PREFIX>_INSTALL_VERIFY=require`** refuses to install without that check.
- **A CLI generated without `--repo`** installs by sha256 alone.

The flow assumes a public repository: an anonymous one-liner cannot fetch a private repository's release assets, and
attestations need a public repository or a paid plan.

## Verifying by hand

The commands, as the installers run them. The checksums:

```sh
cosign verify-blob --bundle checksums.txt.sigstore.json --certificate-identity-regexp '(?i)^https://github\.com/<owner>/<repo>/\.github/workflows/release\.yml@refs/tags/v' --certificate-oidc-issuer https://token.actions.githubusercontent.com checksums.txt
```

An archive's build provenance:

```sh
gh attestation verify <archive> --repo <owner>/<repo>
```
