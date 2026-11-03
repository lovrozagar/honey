/**
 * The channels a generated CLI's release publishes to (release program D7): the flat `--cli-*` options parsed into
 * one `Release`, each channel holding exactly the metadata its goreleaser block needs and refused, naming the flag,
 * without it or without a repository; and each channel's goreleaser block and the secret its push reads.
 */
import { q } from "./release.ts"

/** The Linux package formats nfpm builds. */
export const PACKAGE_FORMATS = ["deb", "rpm", "apk"] as const
export type PackageFormat = (typeof PACKAGE_FORMATS)[number]

/** What a package manager shows about the CLI. */
type About = { readonly description: string; readonly homepage: string; readonly license: string }
/** What a Linux package also names: who maintains it. */
type Maintained = About & { readonly maintainer: string }

/** A channel the release publishes to, holding exactly the values its goreleaser block needs. */
export type Channel =
	| { readonly kind: "homebrew"; readonly about: About; readonly owner: string; readonly name: string }
	| { readonly kind: "scoop"; readonly about: About; readonly owner: string; readonly name: string }
	| {
			readonly kind: "winget"
			readonly about: About
			readonly publisher: string
			readonly owner: string
			readonly name: string
	  }
	| { readonly kind: "aur"; readonly about: Maintained }
	| { readonly kind: "packages"; readonly about: Maintained; readonly formats: readonly PackageFormat[] }

/** A CLI released to a GitHub repository: its owner and name, the channels, and where its install scripts live. */
export type Release = {
	readonly owner: string
	readonly name: string
	readonly channels: readonly Channel[]
	readonly installUrl: string
	/** whether the scripts are served from the release itself, so the release uploads them */
	readonly scriptsInRelease: boolean
}

/** The release options as `--cli-<option>` carries them: strings, `aur` a switch. */
export type ReleaseOptions = {
	readonly description?: string
	readonly homepage?: string
	readonly license?: string
	readonly maintainer?: string
	readonly installUrl?: string
	readonly homebrewTap?: string
	readonly scoopBucket?: string
	readonly wingetPublisher?: string
	readonly wingetFork?: string
	readonly aur?: boolean | string
	readonly packages?: string
}

/** The secret each channel's push reads, by the environment variable goreleaser's config names. */
export const SECRETS: Readonly<Record<Channel["kind"], string | undefined>> = {
	aur: "AUR_SSH_KEY",
	homebrew: "HOMEBREW_TAP_TOKEN",
	packages: undefined,
	scoop: "SCOOP_BUCKET_TOKEN",
	winget: "WINGET_TOKEN",
}

/* a description: one line of printable text, at most 256 characters (winget's ShortDescription); a homepage or an
 * install URL: https and a host; a license: an SPDX expression of ids joined by AND, OR or WITH; a maintainer:
 * `Name <email>`; a winget publisher: a name of letters, digits, spaces and `.,&'-`, at most 64 characters */
const DESCRIPTION = /^\P{Cc}{1,256}$/u
const HTTPS_URL = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~%!$&'()*+,;=:@/-]*)?$/
const LICENSE = /^[A-Za-z0-9.+-]+(?: (?:AND|OR|WITH) [A-Za-z0-9.+-]+)*$/
const MAINTAINER = /^[^<>\p{Cc}]+ <[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>$/u
const PUBLISHER = /^[A-Za-z0-9][A-Za-z0-9 .,&'-]{0,63}$/
/* a GitHub repository: its owner 1 to 39 letters, digits and single inner hyphens; its name 1 to 100 of letters,
 * digits, `.`, `_` and `-`, not `.` or `..` and not ending in `.git` */
export const REPO = /^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}\/(?!\.\.?$)(?![\s\S]*\.git$)[A-Za-z0-9._-]{1,100}$/

const refuse = (option: string, value: string): never => {
	throw new Error(`Invalid ${option}: ${JSON.stringify(value)}`)
}

/** `owner/name` split, once REPO has checked it. */
const split = (repo: string) => {
	const [owner = "", name = ""] = repo.split("/")
	return { name, owner }
}

/** A repository option: checked against REPO when given. */
function repoOption(option: string, value: string | undefined): { owner: string; name: string } | undefined {
	if (value === undefined) return undefined
	if (!REPO.test(value)) refuse(option, value)
	return split(value)
}

/** A checked option, or undefined when not given. */
function checked(option: string, value: string | undefined, grammar: RegExp): string | undefined {
	if (value !== undefined && !grammar.test(value)) refuse(option, value)
	return value
}

const known = (each: string): each is PackageFormat => (PACKAGE_FORMATS as readonly string[]).includes(each)

/** The Linux package formats: a comma list of deb, rpm and apk, each once. */
function formatsOf(value: string | undefined): readonly PackageFormat[] | undefined {
	if (value === undefined) return undefined
	const formats = value.split(",").map((each) => each.trim())
	if (formats.length === 0 || !formats.every(known) || new Set(formats).size !== formats.length)
		refuse("packages", value)
	return formats as PackageFormat[]
}

/** The switch as a string option carries it: `true` or `false`, or a boolean from code. */
function switchOf(option: string, value: boolean | string | undefined): boolean {
	if (value === undefined || typeof value === "boolean") return value === true
	if (value !== "true" && value !== "false") refuse(option, value)
	return value === "true"
}

/** A value a channel needs, or a refusal naming the option and the channel. */
function needed(option: string, value: string | undefined, channel: string): string {
	if (value === undefined)
		throw new Error(`--cli-${channel} needs --cli-${option}: give it, or leave --cli-${channel} out`)
	return value
}

/**
 * The release for `repo`: its channels from the options, each checked and given the metadata it needs, and the
 * install scripts' URL (`https://github.com/<repo>/releases/latest/download` unless `installUrl` names another).
 * Without a repository there is none, and a channel is refused, since each publishes from the repository's release.
 */
export function resolvedRelease(options: ReleaseOptions, repo: string | undefined): Release | undefined {
	const description = checked("description", options.description, DESCRIPTION)
	const homepage = checked("homepage", options.homepage, HTTPS_URL)
	const license = checked("license", options.license, LICENSE)
	const maintainer = checked("maintainer", options.maintainer, MAINTAINER)
	const installUrl = checked("installUrl", options.installUrl?.replace(/\/+$/, ""), HTTPS_URL)
	const tap = repoOption("homebrewTap", options.homebrewTap)
	const bucket = repoOption("scoopBucket", options.scoopBucket)
	const fork = repoOption("wingetFork", options.wingetFork)
	const publisher = checked("wingetPublisher", options.wingetPublisher, PUBLISHER)
	const aur = switchOf("aur", options.aur)
	const formats = formatsOf(options.packages)

	const about = (channel: string): About => ({
		description: needed("description", description, channel),
		homepage: needed("homepage", homepage, channel),
		license: needed("license", license, channel),
	})
	const maintained = (channel: string): Maintained => ({
		...about(channel),
		maintainer: needed("maintainer", maintainer, channel),
	})
	const channels: Channel[] = []
	if (tap !== undefined) channels.push({ about: about("homebrew-tap"), kind: "homebrew", ...tap })
	if (bucket !== undefined) channels.push({ about: about("scoop-bucket"), kind: "scoop", ...bucket })
	/* winget needs both: the fork it pushes the manifests to, and the publisher they are filed under */
	if (fork === undefined && publisher !== undefined) needed("winget-fork", undefined, "winget-publisher")
	if (fork !== undefined) {
		channels.push({
			about: about("winget-fork"),
			kind: "winget",
			...fork,
			publisher: needed("winget-publisher", publisher, "winget-fork"),
		})
	}
	if (aur) channels.push({ about: maintained("aur"), kind: "aur" })
	if (formats !== undefined) channels.push({ about: maintained("packages"), formats, kind: "packages" })

	if (repo === undefined) {
		const [first] = channels
		if (first !== undefined) throw new Error(`--cli-${optionOf(first)} needs --cli-repo: its release publishes from it`)
		return undefined
	}
	const github = `https://github.com/${repo}/releases/latest/download`
	return {
		...split(repo),
		channels,
		installUrl: installUrl ?? github,
		scriptsInRelease: installUrl === undefined || installUrl === github,
	}
}

/** The flag that turns `channel` on, as a refusal names it. */
const optionOf = (channel: Channel): string =>
	({ aur: "aur", homebrew: "homebrew-tap", packages: "packages", scoop: "scoop-bucket", winget: "winget-fork" })[
		channel.kind
	]

/** A repository a channel pushes to with its token, as goreleaser's `repository` block. */
const pushTo = (owner: string, name: string, secret: string, indent: string) =>
	`${indent}repository:
${indent}  owner: ${q(owner)}
${indent}  name: ${q(name)}
${indent}  token: "{{ .Env.${secret} }}"
`

/** What every package manager shows: the description, homepage and license. */
const aboutLines = ({ description, homepage, license }: About, descriptionKey = "description") =>
	`    homepage: ${q(homepage)}
    ${descriptionKey}: ${q(description)}
    license: ${q(license)}
`

/** The goreleaser block for one channel of `bin`. */
export function channelBlock(bin: string, channel: Channel): string {
	switch (channel.kind) {
		case "homebrew":
			return `# the Homebrew cask, pushed to the tap; the binaries are not notarized, so it clears macOS's quarantine flag
homebrew_casks:
  - name: ${q(bin)}
${pushTo(channel.owner, channel.name, SECRETS.homebrew as string, "    ")}${aboutLines(channel.about)}    hooks:
      post:
        install: |
          if OS.mac?
            system_command "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "#{staged_path}/${bin}"]
          end
`
		case "scoop":
			return `# the Scoop manifest, pushed to the bucket
scoops:
  - name: ${q(bin)}
${pushTo(channel.owner, channel.name, SECRETS.scoop as string, "    ")}${aboutLines(channel.about)}`
		case "winget":
			return `# the winget manifests, pushed to the fork and proposed to microsoft/winget-pkgs
winget:
  - name: ${q(bin)}
    publisher: ${q(channel.publisher)}
    package_identifier: ${q(`${channel.publisher.replace(/[^A-Za-z0-9]/g, "")}.${bin}`)}
${aboutLines(channel.about, "short_description")}    repository:
      owner: ${q(channel.owner)}
      name: ${q(channel.name)}
      token: "{{ .Env.${SECRETS.winget as string} }}"
      branch: ${q(`${bin}-{{ .Version }}`)}
      pull_request:
        enabled: true
        base:
          owner: microsoft
          name: winget-pkgs
          branch: master
`
		case "aur":
			return `# the AUR ${bin}-bin package, pushed over SSH
aurs:
  - name: ${q(`${bin}-bin`)}
${aboutLines(channel.about)}    maintainers: [${q(channel.about.maintainer)}]
    private_key: "{{ .Env.${SECRETS.aur as string} }}"
    git_url: ${q(`ssh://aur@aur.archlinux.org/${bin}-bin.git`)}
`
		case "packages":
			return `# Linux packages beside the archives, each named ${bin}_<os>_<arch>
nfpms:
  - id: ${q(bin)}
    package_name: ${q(bin)}
    file_name_template: "{{ .PackageName }}_{{ .Os }}_{{ .Arch }}"
    formats: [${channel.formats.join(", ")}]
${aboutLines(channel.about)}    maintainer: ${q(channel.about.maintainer)}
`
	}
}
