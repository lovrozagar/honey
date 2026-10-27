import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as tsMorph from "ts-morph"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type FixtureProject, fixtureProject, lines } from "./__fixtures__/project.ts"
import { findTsConfig, loadEntry, registrations } from "./walk.ts"

const SLOW = 60_000

describe("findTsConfig: the project's own tsconfig", () => {
	it("is the nearest one walking up, never one past the package root, and none when there is none", () => {
		const root = mkdtempSync(join(tmpdir(), "honey-tsconfig-"))
		try {
			const put = (rel: string) => {
				mkdirSync(join(root, rel, ".."), { recursive: true })
				writeFileSync(join(root, rel), "{}")
			}
			put("tsconfig.json")
			put("pkg/package.json")
			put("app/deep/x.ts")
			put("pkg/src/x.ts")
			put("solo/src/x.ts")
			put("solo/tsconfig.json")
			expect([
				findTsConfig(join(root, "app/deep/x.ts")),
				findTsConfig(join(root, "pkg/src/x.ts")),
				findTsConfig(join(root, "solo/src/x.ts")),
				findTsConfig("/x.ts"),
			]).toEqual([join(root, "tsconfig.json"), undefined, join(root, "solo/tsconfig.json"), undefined])
		} finally {
			rmSync(root, { force: true, recursive: true })
		}
	})
})

describe("loadEntry: the app under its export", () => {
	let project: FixtureProject
	beforeAll(() => {
		project = fixtureProject()
	})
	afterAll(() => project.dispose())

	it(
		"finds the app through an export list, an unexported declaration of the name, and a default export",
		() => {
			const sources = {
				"entry/default.ts": "export default honey<{ D: 1 }>()",
				"entry/list.ts": "const inner = honey<{ L: 1 }>()\nexport { inner as app }",
				"entry/local.ts": "const app = honey<{ U: 1 }>()\nexport const other = 1",
			}
			const names: Record<string, string> = { "entry/default.ts": "default" }
			const envs = Object.entries(sources).map(([rel, body]) => {
				const entryPath = project.write(rel, lines('import { honey } from "@lovrozagar/honey"', body))
				const entry = loadEntry(tsMorph, { entryPath, exportName: names[rel] ?? "app" })
				const env = entry.appType.getProperty("$env")
				return env === undefined ? null : entry.checker.typeToString(entry.checker.getTypeOfSymbol(env))
			})
			expect(envs).toEqual(["{ D: 1; }", "{ L: 1; }", "{ U: 1; }"])
		},
		SLOW,
	)
})

describe("registrations: the routes the program's own files register", () => {
	let project: FixtureProject
	beforeAll(() => {
		project = fixtureProject()
	})
	afterAll(() => project.dispose())

	it(
		"walks every program file but declaration files and packages, and takes only a builder's .handler()",
		() => {
			project.write(
				"walk/node_modules/dep/index.ts",
				lines(
					'import { honey } from "@lovrozagar/honey"',
					'export const dep = honey<{}>().get("/dep").handler((c) => c.res.text("ok", "ok"))',
				),
			)
			project.write("walk/node_modules/dep/package.json", JSON.stringify({ main: "index.ts", name: "dep" }))
			project.write(
				"walk/more.ts",
				lines(
					'import type { Honey } from "@lovrozagar/honey"',
					'export const more = (app: Honey<{}>) => app.on(["GET", "PUT"], "/more").handler((c) => c.res.text("ok", "ok"))',
				),
			)
			const entryPath = project.write(
				"walk/app.ts",
				lines(
					'import { honey } from "@lovrozagar/honey"',
					'import { ws } from "@lovrozagar/honey/ws"',
					'import "dep"',
					'import { more } from "./more.ts"',
					"export const app = honey<{}>()",
					'app.get("/a").handler((c) => c.res.text("ok", "ok"))',
					'ws(app, "/socket").handler({ onMessage: () => {} })',
					"const fake = { handler: (f: unknown) => f }",
					"fake.handler(() => 1)",
					"more(app)",
				),
			)
			const found = registrations(loadEntry(tsMorph, { entryPath, exportName: "app" }))
			expect(found.map(({ at, methods, path }) => ({ at: at.slice(project.root.length + 1), methods, path }))).toEqual([
				{ at: "walk/app.ts:6", methods: ["GET"], path: "/a" },
				{ at: "walk/more.ts:2", methods: ["GET", "PUT"], path: "/more" },
			])
		},
		SLOW,
	)
})
