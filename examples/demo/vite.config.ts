import { honey } from "@ecomet/honey/plugin"
import { defineConfig } from "vite"

export default defineConfig({
	plugins: [
		honey({
			build: { target: "node" },
			entry: "src/app.ts",
			manifest: true,
			openApi: { title: "Demo API", version: "1.0.0" },
			types: true,
			watch: ["src/**/*.ts"],
		}),
	],
})
