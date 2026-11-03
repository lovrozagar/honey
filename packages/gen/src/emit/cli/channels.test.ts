/**
 * The release channels (release program D7): each channel's goreleaser block from its options (a Homebrew cask that
 * clears macOS's quarantine flag, Scoop, a winget pull request from a fork, AUR `-bin`, nfpm deb/rpm/apk), exactly
 * the configured channels' secrets in goreleaser's step env, each channel refused, naming the flag, without a value it
 * needs or without a repository, and each invalid option refused at generate. Every channel that pushes to a package
 * manager skips a prerelease tag (`skip_upload: auto`); the Linux packages are release files and ship with it.
 */
import { describe, expect, it } from "vitest"
import { CHANNELS } from "./__fixtures__/release.ts"
import { shop } from "./__fixtures__/shop.ts"
import { yamlValue } from "./__fixtures__/yaml.ts"
import { type GoCliOptions, generateGoCli } from "./module.ts"
import { SPAWN_TIMEOUT } from "../../gen/__fixtures__/spawn-timeout.ts"

const files = (options: GoCliOptions = { repo: "acme/shop" }) =>
	generateGoCli(shop(), { modulePath: "github.com/acme/shop", ...options }).files

const configOf = (generated: Readonly<Record<string, string>>) =>
	yamlValue(generated[".goreleaser.yaml"] ?? "") as Record<string, unknown>

/** A workflow expression reading the repository secret `name`. */
const secret = (name: string) => `\${{ secrets.${name} }}`

const ABOUT = { description: "Shop's command line", homepage: "https://shop.example.com", license: "MIT" }

/** Each channel's block as goreleaser reads it, for CHANNELS. */
const CHANNEL_BLOCKS = {
	aurs: [
		{
			...ABOUT,
			git_url: "ssh://aur@aur.archlinux.org/shop-bin.git",
			maintainers: ["Acme <ops@example.com>"],
			name: "shop-bin",
			private_key: "{{ .Env.AUR_SSH_KEY }}",
			skip_upload: "auto",
		},
	],
	homebrew_casks: [
		{
			...ABOUT,
			hooks: {
				post: {
					install:
						'if OS.mac?\n  system_command "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "#{staged_path}/shop"]\nend\n',
				},
			},
			name: "shop",
			repository: { name: "homebrew-tap", owner: "acme", token: "{{ .Env.HOMEBREW_TAP_TOKEN }}" },
			skip_upload: "auto",
		},
	],
	nfpms: [
		{
			...ABOUT,
			file_name_template: "{{ .PackageName }}_{{ .Os }}_{{ .Arch }}",
			formats: ["deb", "rpm", "apk"],
			id: "shop",
			maintainer: "Acme <ops@example.com>",
			package_name: "shop",
		},
	],
	scoops: [
		{
			...ABOUT,
			name: "shop",
			repository: { name: "scoop-bucket", owner: "acme", token: "{{ .Env.SCOOP_BUCKET_TOKEN }}" },
			skip_upload: "auto",
		},
	],
	winget: [
		{
			homepage: ABOUT.homepage,
			license: ABOUT.license,
			name: "shop",
			package_identifier: "AcmeCo.shop",
			publisher: "Acme Co.",
			repository: {
				branch: "shop-{{ .Version }}",
				name: "winget-pkgs",
				owner: "acme-bot",
				pull_request: { base: { branch: "master", name: "winget-pkgs", owner: "microsoft" }, enabled: true },
				token: "{{ .Env.WINGET_TOKEN }}",
			},
			short_description: ABOUT.description,
			skip_upload: "auto",
		},
	],
}

describe("the release channels (release program D7)", () => {
	it("adds each channel with its options' values", { timeout: SPAWN_TIMEOUT }, () => {
		const config = configOf(files(CHANNELS))
		expect({
			aurs: config.aurs,
			homebrew_casks: config.homebrew_casks,
			nfpms: config.nfpms,
			scoops: config.scoops,
			winget: config.winget,
		}).toEqual(CHANNEL_BLOCKS)
	})

	it("hands goreleaser exactly the configured channels' secrets", { timeout: SPAWN_TIMEOUT }, () => {
		type Workflow = { jobs: { release: { steps: { uses: string; env?: Record<string, string> }[] } } }
		const envOf = (options: GoCliOptions) => {
			const workflow = yamlValue(files(options)[".github/workflows/release.yml"] ?? "") as Workflow
			return workflow.jobs.release.steps.find((step) => step.uses.startsWith("goreleaser/"))?.env
		}
		expect([
			envOf(CHANNELS),
			envOf({ ...CHANNELS, aur: "false", homebrewTap: undefined, wingetFork: undefined, wingetPublisher: undefined }),
		]).toEqual([
			{
				AUR_SSH_KEY: secret("AUR_SSH_KEY"),
				GITHUB_TOKEN: secret("GITHUB_TOKEN"),
				HOMEBREW_TAP_TOKEN: secret("HOMEBREW_TAP_TOKEN"),
				SCOOP_BUCKET_TOKEN: secret("SCOOP_BUCKET_TOKEN"),
				WINGET_TOKEN: secret("WINGET_TOKEN"),
			},
			{ GITHUB_TOKEN: secret("GITHUB_TOKEN"), SCOOP_BUCKET_TOKEN: secret("SCOOP_BUCKET_TOKEN") },
		])
	})
})

describe("the release channels' refusals (release program D7)", () => {
	it.each([
		[{ homebrewTap: "acme/tap" }, "--cli-homebrew-tap needs --cli-description"],
		[{ description: "d", scoopBucket: "acme/b" }, "--cli-scoop-bucket needs --cli-homepage"],
		[{ description: "d", homepage: "https://x.dev", wingetFork: "a/w" }, "--cli-winget-fork needs --cli-license"],
		[
			{ description: "d", homepage: "https://x.dev", license: "MIT", wingetFork: "a/w" },
			"--cli-winget-fork needs --cli-winget-publisher",
		],
		[{ wingetPublisher: "Acme" }, "--cli-winget-publisher needs --cli-winget-fork"],
		[{ aur: "true", description: "d", homepage: "https://x.dev", license: "MIT" }, "--cli-aur needs --cli-maintainer"],
		[
			{ description: "d", homepage: "https://x.dev", license: "MIT", packages: "deb" },
			"--cli-packages needs --cli-maintainer",
		],
	] satisfies [GoCliOptions, string][])("refuses %j without a value it needs", (options, message) => {
		expect(() => files({ repo: "acme/shop", ...options })).toThrow(message)
	})

	it("refuses a channel without a repository, which its release publishes from", () => {
		expect(() => files({ ...CHANNELS, repo: undefined })).toThrow("--cli-homebrew-tap needs --cli-repo")
	})

	it.each([
		["homebrewTap", "acme"],
		["scoopBucket", "acme/b.git"],
		["wingetFork", "/w"],
		["homepage", "http://shop.example.com"],
		["homepage", "https://shop.example.com/a b"],
		["installUrl", "http://shop.example.com/cli"],
		["license", "MIT or Apache"],
		["maintainer", "ops@example.com"],
		["description", "two\nlines"],
		["description", "d".repeat(257)],
		["wingetPublisher", "-Acme"],
		["packages", "deb,snap"],
		["packages", "deb,deb"],
		["packages", ""],
		["aur", "yes"],
	])("refuses %s %j at generate", (option, value) => {
		expect(() => files({ ...CHANNELS, [option]: value })).toThrow(`Invalid ${option}: ${JSON.stringify(value)}`)
	})
})
