# Releasing a generated CLI

`honey-clients generate --target cli --cli-repo <owner>/<repo>` writes a Go module ready to release from its own
repository. Besides the commands, it holds a goreleaser config, a GitHub Actions release workflow, and `install.sh` and
`install.ps1`. It ships no README: you write one for your users, and this page is what it should say.

Without `--cli-repo` there is no release to install from, so the module has no install scripts, no
`installgen.config.mts`, and its goreleaser config releases to the git remote's repository.

## What the module documents itself

`<bin> --help` at every level, `<bin> commands` (every command), `<bin> schema <command>` (a command's inputs and
output as JSON Schema) and `<bin> skill` (the embedded `SKILL.md`, for agents). Your README points at these rather
than copying them, so it never goes stale.

## The README to write

Your README needs four parts:

1. **What it is:** a sentence on your API and what the CLI is for.
2. **Install:** the one-liners below, and the package managers you publish to.
3. **Configure:** the base URL and the credentials, by flag, environment variable or config file.
4. **Verify:** for users who check what they install, the release section below.

```sh
curl -fsSL https://github.com/<owner>/<repo>/releases/latest/download/install.sh | sh
```

On Windows:

```sh
irm https://github.com/<owner>/<repo>/releases/latest/download/install.ps1 | iex
```

Each release uploads both scripts beside its archives. With `--cli-install-url <https dir>` the scripts name that
directory instead (your own site, for example), you serve them from there, and the release uploads only its
`version.txt`.

## The release flow

Pushing a `v*` tag runs the release workflow:

1. goreleaser builds the binaries for Linux, macOS and Windows on amd64 and arm64, as `<bin>_<os>_<arch>` archives.
2. It writes `checksums.txt` and `version.txt` (the tag, which the installers read for the latest release).
3. cosign signs `checksums.txt` keyless (`checksums.txt.sigstore.json`).
4. It pushes each channel below that the options turned on.
5. GitHub attests the build's provenance.
6. installgen checks the release against the install scripts. `installgen.config.mts`, written beside the scripts from
   the same layout, drives `npx --yes @lovrozagar/installgen@0.3.0 check --default-version "$GITHUB_REF_NAME"`, which
   fails the run unless every platform's archive is published under the tag and listed in `checksums.txt`. Then,
   unless the release is a prerelease, the run checks that `releases/latest/download/version.txt` reads the tag,
   which is what the one-liners install.

A tag with a semver prerelease part (`v1.2.0-rc.1`) is published as a GitHub prerelease. It never becomes the
latest release, so the one-liners keep installing the last full release, and the Homebrew, Scoop, winget and AUR
channels skip it. Users who want it name it: `<PREFIX>_VERSION=v1.2.0-rc.1`.

## Channels

Each channel is one or two options, and needs the package metadata `--cli-description`, `--cli-homepage` and
`--cli-license` (AUR and the Linux packages also `--cli-maintainer "Name <email>"`). Generation refuses a channel
without what it needs, naming the option. Set each secret in the CLI's repository before the first tag: goreleaser
pushes the channels after the GitHub release is created, so a missing secret fails a release that is already half
published.

| Channel        | Options                                                                  | Secret                                                                   | What it publishes                              |
| -------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------- |
| Homebrew       | `--cli-homebrew-tap <owner>/<tap>`                                       | `HOMEBREW_TAP_TOKEN`, a token that can push to the tap                   | a cask for macOS and Linux                     |
| Scoop          | `--cli-scoop-bucket <owner>/<bucket>`                                    | `SCOOP_BUCKET_TOKEN`, a token that can push to the bucket                | a manifest                                     |
| winget         | `--cli-winget-fork <owner>/winget-pkgs`, `--cli-winget-publisher <name>` | `WINGET_TOKEN`, a token that can push to the fork and open pull requests | a pull request to microsoft/winget-pkgs        |
| AUR            | `--cli-aur`                                                              | `AUR_SSH_KEY`, the private key of the AUR account                        | the `<bin>-bin` package                        |
| Linux packages | `--cli-packages deb,rpm,apk`                                             | none                                                                     | `<bin>_linux_<arch>.<ext>` beside the archives |

The binaries are not notarized by Apple, so the cask clears macOS's quarantine flag after install, the fallback
GoReleaser documents. Apple may close it; notarizing is the alternative.

## What the installers check

installgen writes both scripts. Each reads the latest tag from `version.txt`, downloads this platform's archive and
`checksums.txt`, and checks the archive's sha256 against `checksums.txt` before anything installs.

- **With `cosign` on PATH,** it first checks `checksums.txt` against its bundle, as signed by your repository's
  release workflow on that exact tag.
- **`<PREFIX>_INSTALL_VERIFY=require`** refuses to install without that check.
- **`<PREFIX>_VERSION`** installs a release other than the latest, **`<PREFIX>_INSTALL_DIR`** installs somewhere other
  than `~/.local/bin`, and **`<PREFIX>_NO_MODIFY_PATH=1`** leaves the shell profile or the user `Path` alone.

The flow assumes a public repository: an anonymous one-liner cannot fetch a private repository's release assets, and
attestations need a public repository or a paid plan.

## Verifying by hand

The commands, as the installers run them. The checksums, for release `v1.2.3`:

```sh
cosign verify-blob --bundle checksums.txt.sigstore.json --certificate-identity https://github.com/<owner>/<repo>/.github/workflows/release.yml@refs/tags/v1.2.3 --certificate-oidc-issuer https://token.actions.githubusercontent.com checksums.txt
```

An archive's build provenance:

```sh
gh attestation verify <archive> --repo <owner>/<repo>
```
