/**
 * The Python package's metadata (plan 39 8.4): the run's metadata block in pyproject.toml as PEP 621 and PEP 639 have
 * it, read back by the pinned interpreter's tomllib, then built into an sdist by hatchling at the floor the manifest
 * declares, whose PKG-INFO is what PyPI shows. The Python classifiers span the floor CI installs to the version
 * `.python-version` pins, and honey's own manifest stays out of the sdist.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { generated, type GenerateRun } from "../../index.ts"
import { MANIFEST } from "../../gen/write.ts"
import { SPAWN_TIMEOUT } from "../../gen/__fixtures__/spawn-timeout.ts"
import { written } from "../mcp/__fixtures__/written.ts"
import { PY_FLOOR } from "../shared/__fixtures__/installs.ts"
import minimal from "../../ir/__fixtures__/specs/python/minimal.json" with { type: "json" }
import { pinnedPython, runPython, venv, withPython } from "./__fixtures__/python-env.ts"
import { PYTHON_CLASSIFIERS, PYTHON_REQUIRES } from "./sdk-pyproject.ts"

const PY = withPython()

const RUN: GenerateRun = {
	metadata: {
		authors: ["Acme Inc <oss@acme.dev>", "Bo"],
		changelog: "https://acme.dev/changelog",
		description: 'The Shop API\'s "client" \\ v2',
		documentation: "https://docs.acme.dev",
		homepage: "https://acme.dev",
		keywords: ["shop", "api"],
		license: "MIT OR Apache-2.0",
		repository: "https://github.com/acme/shop-py",
	},
	options: { python: { packageName: "acme_shop", version: "1.2.0" } },
	targets: ["python"],
}

/* the README and license file a run ships (plan 39 8.7), by the paths its metadata block names them by */
const SHIPPED: Readonly<Record<string, string>> = {
	"docs/README.md": "# acme-shop\n\nThe Shop API's «client».\n",
	"LICENSE.txt": "MIT License\n",
}
const read = (path: string) => new TextEncoder().encode(SHIPPED[path] ?? "")

/** The python target's files for `run`. */
async function pythonFiles(run: GenerateRun = RUN): Promise<Readonly<Record<string, string>>> {
	return (await generated(run, minimal, { env: {}, read, report: () => undefined })).python?.files ?? {}
}

/** `text` parsed by the pinned interpreter's tomllib. */
function parsedToml(text: string): unknown {
	const parse = "import json, sys, tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())))"
	const run = runPython(venv({ python: pinnedPython(), requirements: [] }), ["-c", parse], { input: text })
	if (run.status !== 0) throw new Error(`tomllib refused pyproject.toml:\n${run.stderr}\n${text}`)
	return JSON.parse(run.stdout)
}

describe("the Python classifiers (plan 39 8.4)", () => {
	it("span the floor requires-python names, which CI installs, to the version .python-version pins", () => {
		const minor = (version: string) => Number(version.split(".")[1])
		const pinned = readFileSync(join(import.meta.dirname, "../../../../../.python-version"), "utf8").trim()
		const versions = PYTHON_CLASSIFIERS.flatMap(
			(line) => /^Programming Language :: Python :: (3\.\d+)$/.exec(line)?.[1] ?? [],
		)
		expect([PYTHON_REQUIRES, versions[0], versions.at(-1), versions.length]).toEqual([
			`>=3.${minor(PY_FLOOR)}`,
			`3.${minor(PY_FLOOR)}`,
			`3.${minor(pinned)}`,
			minor(pinned) - minor(PY_FLOOR) + 1,
		])
		expect(PYTHON_CLASSIFIERS.filter((line) => line.startsWith("License ::"))).toEqual([])
	})
})

describe.skipIf(!PY)("the metadata block in pyproject.toml (plan 39 8.4)", () => {
	it(
		"fills PEP 621's fields with an SPDX license, the well-known URLs and the derived classifiers",
		{ timeout: SPAWN_TIMEOUT },
		async () => {
			const project = (parsedToml((await pythonFiles())["pyproject.toml"] ?? "") as { project: unknown }).project
			expect(project).toEqual({
				authors: [{ email: "oss@acme.dev", name: "Acme Inc" }, { name: "Bo" }],
				classifiers: [...PYTHON_CLASSIFIERS],
				dependencies: ["httpx2>=2.12.0,<3"],
				description: 'The Shop API\'s "client" \\ v2',
				keywords: ["shop", "api"],
				license: "MIT OR Apache-2.0",
				name: "acme-shop",
				"requires-python": ">=3.11",
				urls: {
					Changelog: "https://acme.dev/changelog",
					Documentation: "https://docs.acme.dev",
					Homepage: "https://acme.dev",
					Issues: "https://github.com/acme/shop-py/issues",
					Source: "https://github.com/acme/shop-py",
				},
				version: "1.2.0",
			})
		},
	)

	it(
		"keeps honey's manifest out of the sdist, and leaves out each field the block does not give",
		{ timeout: SPAWN_TIMEOUT },
		async () => {
			const toml = parsedToml((await pythonFiles({ targets: ["python"] }))["pyproject.toml"] ?? "") as {
				project: Record<string, unknown>
				tool: unknown
			}
			expect([Object.keys(toml.project).sort(), toml.tool]).toEqual([
				["classifiers", "dependencies", "name", "requires-python", "version"],
				{
					hatch: {
						build: {
							targets: { sdist: { exclude: [MANIFEST] }, wheel: { packages: ["src/honey_sdk"] } },
						},
					},
				},
			])
		},
	)
})

/** The fields of a built PKG-INFO, each name to its values in order. */
function fields(info: string): Record<string, string[]> {
	const out: Record<string, string[]> = {}
	for (const [, name, value] of info.split("\n\n")[0]?.matchAll(/^([\w-]+): (.*)$/gm) ?? [])
		(out[name as string] ??= []).push(value as string)
	return out
}

/* the floor the generated build-system declares: the oldest hatchling a publisher's build may resolve */
const HATCHLING = venv({ python: pinnedPython(), requirements: ["hatchling==1.27.0"] })

const BUILD = `import json, os, sys, tarfile
import hatchling.build as backend
name = backend.build_sdist(sys.argv[1])
with tarfile.open(os.path.join(sys.argv[1], name)) as sdist:
    members = sorted(m.name.split("/", 1)[1] for m in sdist.getmembers() if m.isfile())
    info = sdist.extractfile(name[: -len(".tar.gz")] + "/PKG-INFO").read().decode()
print(json.dumps({"members": members, "info": info}))`

describe.skipIf(!PY)("the package hatchling builds (plan 39 8.4, 8.7)", () => {
	it(
		"carries the README and the license file a run ships, the README as PyPI's Markdown description",
		{ timeout: 2 * SPAWN_TIMEOUT },
		async () => {
			const files = await pythonFiles({ ...RUN, metadata: { licenseFile: "LICENSE.txt", readme: "docs/README.md" } })
			const dir = written(files)
			const run = runPython(HATCHLING, ["-c", BUILD, join(dir, "dist")], { cwd: dir })
			if (run.status !== 0) throw new Error(`hatchling refused the package:\n${run.stderr}`)
			const { info, members } = JSON.parse(run.stdout) as { info: string; members: string[] }
			const built = fields(info)
			expect({
				body: info.slice(info.indexOf("\n\n") + 2),
				members: members.filter((member) => !member.startsWith("src/")),
				shipped: [built["Description-Content-Type"], built["License-File"]],
			}).toEqual({
				body: SHIPPED["docs/README.md"],
				members: ["LICENSE", "PKG-INFO", "README.md", "pyproject.toml"],
				shipped: [["text/markdown"], ["LICENSE"]],
			})
		},
	)

	it(
		"is an sdist whose PKG-INFO PyPI reads the metadata from, honey's manifest left out",
		{ timeout: 2 * SPAWN_TIMEOUT },
		async () => {
			const dir = written(await pythonFiles())
			writeFileSync(join(dir, MANIFEST), "{}\n")
			const run = runPython(HATCHLING, ["-c", BUILD, join(dir, "dist")], { cwd: dir })
			if (run.status !== 0) throw new Error(`hatchling refused the package:\n${run.stderr}`)
			const { info, members } = JSON.parse(run.stdout) as { info: string; members: string[] }
			const built = fields(info)
			expect({
				author: [built.Author, built["Author-email"]],
				classifiers: built.Classifier,
				keywords: built.Keywords,
				license: built["License-Expression"],
				manifest: members.includes(MANIFEST),
				metadata: built["Metadata-Version"],
				urls: built["Project-URL"],
			}).toEqual({
				author: [["Bo"], ["Acme Inc <oss@acme.dev>"]],
				classifiers: [...PYTHON_CLASSIFIERS].sort(),
				keywords: ["api,shop"],
				license: ["MIT OR Apache-2.0"],
				manifest: false,
				metadata: ["2.4"],
				urls: [
					"Homepage, https://acme.dev",
					"Source, https://github.com/acme/shop-py",
					"Issues, https://github.com/acme/shop-py/issues",
					"Documentation, https://docs.acme.dev",
					"Changelog, https://acme.dev/changelog",
				],
			})
		},
	)
})
