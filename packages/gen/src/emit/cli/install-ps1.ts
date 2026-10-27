/**
 * The CLI's install.ps1 (bit 17 phase g, split from install.ts at bit 19 i): install.sh's contract on Windows, for
 * the Windows archive of this architecture, verified by Get-FileHash and, with cosign on PATH, checksums.txt's
 * signature, installed under LOCALAPPDATA by default (install.ts holds the contract).
 */
import { identityOf, type InstallApp, ISSUER, MARKER } from "./install.ts"

/** install.ps1's head and the first half of its function: the base it downloads from. */
const ps1Head = ({ bin, prefix, repo }: InstallApp) => {
	const v = (name: string) => `$env:${prefix}_${name}`
	return `# ${MARKER}
# Installs ${bin} on Windows: the archive for this architecture, its sha256 checked against checksums.txt, and
# checksums.txt's signature by cosign when it is installed, before anything installs. The script is one function
# called on its last line, so a truncated download runs nothing.
#   ${v("VERSION")}         a release tag (default: the latest)
#   ${v("INSTALL_BASE")}    where the release's files are: https://, or http:// on loopback
#   ${v("INSTALL_DIR")}     where ${bin}.exe goes (default: $env:LOCALAPPDATA\\Programs\\${bin})
#   ${v("INSTALL_ARCH")}    amd64 or arm64, over this machine's
#   ${v("INSTALL_VERIFY")}  require: refuse to install unless cosign checks the signature
$ErrorActionPreference = 'Stop'

function Install-Release {
	$bin = '${bin}'
	$repo = '${repo ?? ""}'
	$identity = '${identityOf(repo)}'
	function Fail([string] $reason) {
		[Console]::Error.WriteLine("$bin install: $reason")
		exit 1
	}
	$base = ${v("INSTALL_BASE")}
	if (-not $base) {
		if (-not $repo) { Fail "set ${prefix}_INSTALL_BASE: no repository to download from" }
		$version = ${v("VERSION")}
		if ($version) {
			if ($version -notmatch '^[A-Za-z0-9_-][A-Za-z0-9._-]*$') { Fail "${prefix}_VERSION $($version): not a release tag" }
			$base = "https://github.com/$repo/releases/download/$version"
		} else {
			$base = "https://github.com/$repo/releases/latest/download"
		}
	}
`
}

/** install.ps1's base checked, its architecture, and whether cosign checks the signature: all before any fetch. */
const ps1Checks = ({ prefix }: InstallApp) => {
	const v = (name: string) => `$env:${prefix}_${name}`
	return `	$uri = $null
	if (-not [Uri]::TryCreate($base, [UriKind]::Absolute, [ref] $uri)) { Fail "$($base): not a URL" }
	if ($uri.Scheme -ne 'https' -and -not ($uri.Scheme -eq 'http' -and $uri.IsLoopback)) {
		Fail "$($base): want https://, or http:// on loopback"
	}
	$arch = ${v("INSTALL_ARCH")}
	if (-not $arch) {
		$arch = switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()) {
			'X64' { 'amd64' }
			'Arm64' { 'arm64' }
			default { Fail "$($_): no build for this architecture (set ${prefix}_INSTALL_ARCH to amd64 or arm64)" }
		}
	}
	if ($arch -notin @('amd64', 'arm64')) { Fail "${prefix}_INSTALL_ARCH $($arch): want amd64 or arm64" }
	$verify = ${v("INSTALL_VERIFY")}
	if ($verify -and $verify -cne 'require') { Fail "${prefix}_INSTALL_VERIFY $($verify): want require, or unset" }
	$cosign = if ($identity) { Get-Command cosign -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 }
	if ($verify -and -not $identity) { Fail "${prefix}_INSTALL_VERIFY=require: no repository names who signs checksums.txt" }
	if ($verify -and -not $cosign) { Fail "${prefix}_INSTALL_VERIFY=require: cosign is not installed to verify checksums.txt's signature" }
`
}

/** install.ps1's install: fetch, verify, install; the call on the last line. */
const ps1Install = ({ bin, prefix }: InstallApp) => {
	const v = (name: string) => `$env:${prefix}_${name}`
	return `	$archive = "${bin}_windows_$arch.zip"
	$dir = ${v("INSTALL_DIR")}
	if (-not $dir) { $dir = Join-Path $env:LOCALAPPDATA (Join-Path 'Programs' $bin) }
	$tmp = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
	New-Item -ItemType Directory -Path $tmp | Out-Null
	try {
		$file = Join-Path $tmp $archive
		$sums = Join-Path $tmp 'checksums.txt'
		$bundle = Join-Path $tmp 'checksums.txt.sigstore.json'
		$fetches = @(@("$base/$archive", $file), @("$base/checksums.txt", $sums))
		if ($cosign) { $fetches += , @("$base/checksums.txt.sigstore.json", $bundle) }
		foreach ($pair in $fetches) {
			try {
				Invoke-WebRequest -Uri $pair[0] -OutFile $pair[1] -UseBasicParsing
			} catch {
				Fail "could not download $($pair[0])"
			}
		}
		if ($cosign) {
			& $cosign.Source verify-blob --bundle $bundle --certificate-identity-regexp $identity --certificate-oidc-issuer '${ISSUER}' $sums *> $null
			if ($LASTEXITCODE -ne 0) { Fail "checksums.txt: cosign could not verify it as signed by $repo's release workflow" }
		}
		$want = Get-Content $sums | ForEach-Object { $fields = $_ -split '\\s+'; if ($fields[1] -eq $archive) { $fields[0] } } | Select-Object -First 1
		if (-not $want) { Fail "checksums.txt lists no $archive" }
		$got = (Get-FileHash -Algorithm SHA256 -Path $file).Hash.ToLowerInvariant()
		if ($got -ne $want) { Fail "$($archive): its sha256 is $got, checksums.txt says $want" }
		$out = Join-Path $tmp 'x'
		Expand-Archive -Path $file -DestinationPath $out
		$exe = Join-Path $out "$bin.exe"
		if (-not (Test-Path $exe)) { Fail "$archive holds no $bin.exe" }
		New-Item -ItemType Directory -Force -Path $dir | Out-Null
		Move-Item -Force -Path $exe -Destination (Join-Path $dir "$bin.exe")
		Write-Output "installed $(Join-Path $dir "$bin.exe")"
	} finally {
		Remove-Item -Recurse -Force -Path $tmp
	}
}

Install-Release
`
}

/** install.ps1 for `app`: the Windows archive, verified by Get-FileHash, installed under LOCALAPPDATA by default. */
export const installPs1 = (app: InstallApp): string => `${ps1Head(app)}${ps1Checks(app)}${ps1Install(app)}`
