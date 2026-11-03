/**
 * The CLI's install scripts (bit 17 phase g, D8 of the release program): `install.sh` (Linux and macOS) and
 * `install.ps1` (Windows), written by installgen from the layout `release.ts` publishes. Each reads the latest tag
 * from the release's `version.txt` (a version by `<PREFIX>_VERSION` over it), downloads this platform's archive
 * `<bin>_<os>_<arch>` and `checksums.txt` from the repository's GitHub Releases, checks `checksums.txt` with cosign
 * against the repository's release workflow on that exact tag when cosign is on PATH (`<PREFIX>_INSTALL_VERIFY=require`
 * refuses without it), checks the archive's sha256 against it, and installs the binary to `<PREFIX>_INSTALL_DIR`,
 * `~/.local/bin` by default. installgen holds the scripts' hardening and their tests; this file holds the layout.
 * Without a repository there is nowhere to download from, so there are no scripts.
 */
import { generateInstallers, type InstallgenConfig } from "@lovrozagar/installgen"

/** The options the scripts are written from: the binary, its repository, the variables' prefix, the scripts' URL. */
export type InstallApp = {
	readonly bin: string
	readonly repo: string
	readonly prefix: string
	readonly installUrl: string
}

/** The issuer of the OIDC token a GitHub Actions run signs with. */
export const ISSUER = "https://token.actions.githubusercontent.com"

/** installgen's config for `app`, its files under `base` (the repository's GitHub Releases outside a test). */
export function installerConfig(app: InstallApp, base = `https://github.com/${app.repo}/releases`): InstallgenConfig {
	return {
		assetPath: ({ arch, os, tag }) =>
			`download/${tag}/${app.bin}_${os}_${arch}${os === "windows" ? ".zip" : ".tar.gz"}`,
		baseUrl: base,
		checksumsPath: ({ tag }) => `download/${tag}/checksums.txt`,
		envPrefix: app.prefix,
		installDir: "~/.local/bin",
		latestPath: "latest/download/version.txt",
		message: `Run \`${app.bin} --help\` to get started.`,
		name: app.bin,
		scriptUrls: { ps1: `${app.installUrl}/install.ps1`, sh: `${app.installUrl}/install.sh` },
		signature: {
			identity: ({ tag }) => `https://github.com/${app.repo}/.github/workflows/release.yml@refs/tags/${tag}`,
			issuer: ISSUER,
		},
	}
}

/** `install.sh` and `install.ps1` for `app`, by file name. */
export function installers(app: InstallApp): Record<string, string> {
	const { ps1, sh } = generateInstallers(installerConfig(app))
	/* every platform is configured, so installgen writes both */
	const scripts: [string, string | undefined][] = [
		["install.ps1", ps1],
		["install.sh", sh],
	]
	return Object.fromEntries(scripts.filter((entry): entry is [string, string] => entry[1] !== undefined))
}
