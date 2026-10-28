import type { ServiceMap } from "./api.runtime.gen"

export const serviceMap: ServiceMap = {
	extract: {
		once: {
			method: "POST",
			params: ["project_id"],
			path: "/v1/projects/{project_id}/extract",
		},
		stream: {
			method: "POST",
			params: ["project_id"],
			path: "/v1/projects/{project_id}/extract-stream",
			sse: true,
		},
		table: {
			once: {
				method: "POST",
				params: ["project_id", "table_id"],
				path: "/v1/projects/{project_id}/tables/{table_id}/extract",
			},
			stream: {
				method: "POST",
				params: ["project_id", "table_id"],
				path: "/v1/projects/{project_id}/tables/{table_id}/extract-stream",
				sse: true,
			},
		},
	},
	suggest: {
		schema: {
			method: "POST",
			params: ["project_id"],
			path: "/v1/projects/{project_id}/suggest-schema",
		},
	},
}
