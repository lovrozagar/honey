/** The release options with every channel on (release program D7), each with the values it needs. */
import type { GoCliOptions } from "../module.ts"

export const CHANNELS = {
	aur: "true",
	description: "Shop's command line",
	homebrewTap: "acme/homebrew-tap",
	homepage: "https://shop.example.com",
	license: "MIT",
	maintainer: "Acme <ops@example.com>",
	packages: "deb,rpm,apk",
	repo: "acme/shop",
	scoopBucket: "acme/scoop-bucket",
	wingetFork: "acme-bot/winget-pkgs",
	wingetPublisher: "Acme Co.",
} as const satisfies GoCliOptions
