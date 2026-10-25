/**
 * Every toolchain and pinned tool gen's tests run, by the command that installs it (bit 19 f, carry-in #14): pure
 * strings, with no toolchain and no I/O, so the env fixtures name them when one is missing and
 * toolchain-projects.test requires each, verbatim, in every CI job that runs a project reaching its fixture.
 */

/**
 * The interpreter the floor legs run under (G10): the oldest the emitted SDK supports. It is not x.y.0: uv has no
 * 3.11.0 build, and 3.11.1 and 3.11.3 need `libcrypt.so.1` (P7). Its minor is the emitted `requires-python`.
 */
export const PY_FLOOR = "3.11.4"

/**
 * The toolchain the floor legs check under: the x.y.0 of the `rust-version` every emitted crate declares, so a
 * build and `clippy -D clippy::incompatible_msrv` there prove the floor the crate claims. `sdk-cargo.ts` writes
 * that line; the two move together.
 */
export const RUST_FLOOR = "1.85.0"

/* gen's Python cache root as an install line spells it, for a shell to expand */
const PYTHON_ROOT = "$HOME/.cache/honey-tmp/python"

/**
 * The command that installs uv `version` into the honey cache, run by any uv (the user's, or CI's setup-uv), which
 * it leaves as it is: no `uv.toml` (the user's or the repo's) steers it, no Python downloads for the tool's own
 * venv, and its links go in the cache's `uv/bin`, never `~/.local/bin`.
 */
export const uvInstall = (version: string): string =>
	`UV_CACHE_DIR="${PYTHON_ROOT}/uv-cache" UV_TOOL_DIR="${PYTHON_ROOT}/uv/tools" UV_TOOL_BIN_DIR="${PYTHON_ROOT}/uv/bin" uv tool install --no-config --no-python-downloads uv==${version}`

/** The command that installs `versions` with the pinned uv, under the cache and linked nowhere (`--no-bin`). */
export const pythonInstall = (versions: readonly string[]): string =>
	`UV_CACHE_DIR="${PYTHON_ROOT}/uv-cache" UV_PYTHON_INSTALL_DIR="${PYTHON_ROOT}/pythons" UV_PYTHON_BIN_DIR="${PYTHON_ROOT}/pybin" "${PYTHON_ROOT}/uv/bin/uv" python install --no-bin ${versions.join(" ")}`

/** The runtime identifier of the pinned SDK's tarball: gen's .NET runs on linux-x64. */
export const DOTNET_RID = "linux-x64"

/** The dirs every .NET command runs with, under `root` (the cache, or the install line's `$D`). */
export const dotnetDirs = (root: string, version: string) => ({
	DOTNET_CLI_HOME: `${root}/home`,
	DOTNET_ROOT: `${root}/toolchain/${version}`,
	NUGET_HTTP_CACHE_PATH: `${root}/nuget-http`,
	NUGET_PACKAGES: `${root}/nuget`,
	NUGET_PLUGINS_CACHE_PATH: `${root}/nuget-plugins`,
	TMPDIR: `${root}/tmp`,
})

/* no telemetry, banner, first-run work, certificate or PATH edit; English output; no NuGet doc files; and the lean
 * switches (R7, mandatory): no MSBuild node reuse, no MSBuild server, no compiler server */
export const DOTNET_SETTINGS = {
	DOTNET_ADD_GLOBAL_TOOLS_TO_PATH: "false",
	DOTNET_CLI_TELEMETRY_OPTOUT: "1",
	DOTNET_CLI_UI_LANGUAGE: "en",
	DOTNET_CLI_USE_MSBUILD_SERVER: "0",
	DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE: "1",
	DOTNET_GENERATE_ASPNET_CERTIFICATE: "false",
	DOTNET_NOLOGO: "1",
	DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
	MSBUILDDISABLENODEREUSE: "1",
	NUGET_XMLDOC_MODE: "skip",
	UseSharedCompilation: "false",
} as const

/**
 * The command that installs SDK `version` into the honey cache, from anywhere in the repo: Microsoft's tarball,
 * checked against `dotnet-sdk.sha512` before anything is extracted, extracted whole or not at all, then the seed
 * restore under the env every run uses, the one NuGet fetch (the build-time package an AOT-compatible build
 * pulls), so every later restore is offline. Its HOME is the cache's, since the fetch's certificate checks write
 * the runtime's revocation cache under HOME, and the user's `~/.dotnet` is left as it is.
 */
export function dotnetInstall(version: string): string {
	const tarball = `"$D/dl/dotnet-sdk-$V-${DOTNET_RID}.tar.gz"`
	const env = Object.entries({ ...dotnetDirs("$D", "$V"), HOME: "$D/home", ...DOTNET_SETTINGS })
		.map(([key, value]) => `${key}="${value}"`)
		.join(" ")
	return [
		`V=${version}`,
		`D="$HOME/.cache/honey-tmp/dotnet"`,
		`F="$(git rev-parse --show-toplevel)/packages/gen/src/emit/csharp/__fixtures__"`,
		`T="$D/toolchain/$V"`,
		`mkdir -p "$D/dl" "$D/home" "$D/tmp"`,
		`curl -fsSL -o ${tarball} "https://builds.dotnet.microsoft.com/dotnet/Sdk/$V/dotnet-sdk-$V-${DOTNET_RID}.tar.gz"`,
		`(cd "$D/dl" && sha512sum -c "$F/dotnet-sdk.sha512")`,
		`rm -rf "$T" "$T.partial"`,
		`mkdir -p "$T.partial"`,
		`tar -xzf ${tarball} -C "$T.partial"`,
		`mv "$T.partial" "$T"`,
		`rm ${tarball}`,
		`${env} "$T/dotnet" restore "$F/seed/Seed.csproj" --source https://api.nuget.org/v3/index.json --artifacts-path "$D/tmp/seed"`,
	].join(" && ")
}

/* `query` is a jq filter over the pins whose `.url` and `.sha256` name one download; `$k` is the loop's JDK */
const fetchLine = (query: string, out: string) =>
	`curl -fsSL -o ${out} "$(jq -r --arg k "$k" '${query}.url' "$P")" && echo "$(jq -r --arg k "$k" '${query}.sha256' "$P")  ${out}" | sha256sum -c -`

/**
 * The command that installs every Java pin into the honey cache, from anywhere in the repo: each JDK tarball, the
 * google-java-format jar, the Gradle zip and the Jackson set, each checked against `java-pins.json`'s sha256 before
 * it is kept, each JDK extracted whole or not at all.
 */
export function javaInstall(): string {
	const jdk = [
		`for k in $(jq -r '.jdk | keys[]' "$P"); do R="$(jq -r --arg k "$k" '.jdk[$k].release' "$P")"`,
		fetchLine(".jdk[$k]", `"$D/dl/$R.tar.gz"`),
		`rm -rf "$D/toolchain/$R" "$D/toolchain/$R.partial" && mkdir -p "$D/toolchain/$R.partial"`,
		`tar -xzf "$D/dl/$R.tar.gz" -C "$D/toolchain/$R.partial" --strip-components=1`,
		`mv "$D/toolchain/$R.partial" "$D/toolchain/$R" && rm "$D/dl/$R.tar.gz" || exit 1; done`,
	].join(" && ")
	const gjf = fetchLine(".googleJavaFormat", `"$D/toolchain/google-java-format-$G.jar"`)
	const gradle = [
		fetchLine(".gradle", `"$D/dl/gradle.zip"`),
		`rm -rf "$D/toolchain/gradle-$W" && unzip -q "$D/dl/gradle.zip" -d "$D/toolchain" && rm "$D/dl/gradle.zip"`,
	].join(" && ")
	const jackson = [
		`for a in $(jq -r '.jackson.artifacts[].path' "$P"); do mkdir -p "$D/repo/$(dirname "$a")"`,
		`curl -fsSL -o "$D/repo/$a" "$(jq -r .jackson.repository "$P")/$a"`,
		`echo "$(jq -r --arg a "$a" '.jackson.artifacts[] | select(.path == $a) | .sha256' "$P")  $D/repo/$a" | sha256sum -c - || exit 1; done`,
	].join(" && ")
	return [
		`P="$(git rev-parse --show-toplevel)/packages/gen/src/emit/java/__fixtures__/java-pins.json"`,
		`D="$HOME/.cache/honey-tmp/java"`,
		`G="$(jq -r .googleJavaFormat.version "$P")"`,
		`W="$(jq -r .gradle.version "$P")"`,
		`mkdir -p "$D/dl" "$D/toolchain" "$D/repo" "$D/tmp"`,
		jdk,
		gjf,
		gradle,
		jackson,
	].join(" && ")
}

/**
 * The command that installs every CLI tool pin into the tools cache, from anywhere in the repo: each archive checked
 * against `tool-pins.json`'s sha256 before it is kept, then extracted whole or not at all.
 */
export function toolsInstall(): string {
	return [
		`P="$(git rev-parse --show-toplevel)/packages/gen/src/emit/cli/__fixtures__/tool-pins.json" && D="$HOME/.cache/honey-tmp/tools" && mkdir -p "$D/dl"`,
		`for k in $(jq -r 'keys[]' "$P"); do U="$(jq -r --arg k "$k" '.[$k].url' "$P")" && R="$(jq -r --arg k "$k" '.[$k].dir' "$P")"`,
		`curl -fsSL -o "$D/dl/$k" "$U" && echo "$(jq -r --arg k "$k" '.[$k].sha256' "$P")  $D/dl/$k" | sha256sum -c -`,
		`rm -rf "$D/$R" "$D/$R.partial" && mkdir -p "$D/$R.partial" && tar -xf "$D/dl/$k" -C "$D/$R.partial"`,
		`chmod +x "$D/$R.partial/$(jq -r --arg k "$k" '.[$k].bin' "$P")" && mv "$D/$R.partial" "$D/$R" && rm "$D/dl/$k" || exit 1; done`,
	].join(" && ")
}

/** The command that installs the pinned MCP clients, from anywhere in the repo: verified by npm ci, kept whole or not at all. */
export function clientsInstall(): string {
	return [
		`P="$(git rev-parse --show-toplevel)/packages/gen/src/emit/mcp/__fixtures__" && D="$HOME/.cache/honey-tmp/mcp-clients"`,
		`rm -rf "$D.partial" && mkdir -p "$D.partial" && cp "$P/client-pins.json" "$D.partial/package.json"`,
		`cp "$P/client-lock.json" "$D.partial/package-lock.json"`,
		`(cd "$D.partial" && npm ci --ignore-scripts --no-audit --no-fund)`,
		`sha256sum "$P/client-lock.json" | cut -d" " -f1 > "$D.partial/lock.sha256" && rm -rf "$D" && mv "$D.partial" "$D"`,
	].join(" && ")
}

/**
 * What CI runs for each fixture that runs a toolchain or a pinned tool (gen-relative), each as the lines one step
 * holds, verbatim: an install reading its pin from the repo's own pin file, as a missing toolchain names it.
 */
export function ciInstalls(): Readonly<Record<string, readonly string[]>> {
	return {
		"src/emit/go/__fixtures__/go-env.ts": ["uses: actions/setup-go@v5", "go-version-file: .go-version"],
		"src/emit/python/__fixtures__/python-env.ts": [
			uvInstall(`"$(sed -n 's/^required-version = "==\\(.*\\)"$/\\1/p' uv.toml)"`),
			pythonInstall(['"$(cat .python-version)"', PY_FLOOR]),
		],
		"src/emit/csharp/__fixtures__/csharp-env.ts": [
			dotnetInstall(`"$(sed -n 's/.*"version": "\\(.*\\)",/\\1/p' global.json)"`),
		],
		"src/emit/java/__fixtures__/java-env.ts": [javaInstall()],
		"src/emit/rust/__fixtures__/rust-env.ts": [
			"rustup toolchain install",
			`rustup default "$(sed -n 's/^channel = "\\(.*\\)"$/\\1/p' rust-toolchain.toml)"`,
			`rustup toolchain install ${RUST_FLOOR} --profile minimal --component clippy`,
		],
		"src/emit/cli/__fixtures__/tools.ts": [toolsInstall()],
		"src/emit/mcp/__fixtures__/clients.ts": [clientsInstall()],
	}
}
