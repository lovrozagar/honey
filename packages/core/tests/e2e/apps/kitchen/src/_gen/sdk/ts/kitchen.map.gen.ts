import { sseOp, wsOp, type ServiceMap } from "./kitchen.runtime.gen"

export const serviceMap: ServiceMap = {
	deleteApiEcho: {
		empty: true,
		method: "DELETE",
		path: "/api/echo",
	},
	deleteApiV1OrganizationsByOrgId: {
		empty: true,
		method: "DELETE",
		params: ["orgId"],
		path: "/api/v1/organizations/{orgId}",
	},
	getApi: {
		method: "GET",
		path: "/api",
	},
	getApiBoundaryCustom: {
		empty: true,
		method: "GET",
		path: "/api/boundary/custom",
	},
	getApiBoundaryDefault: {
		empty: true,
		method: "GET",
		path: "/api/boundary/default",
	},
	getApiEcho: {
		empty: true,
		method: "GET",
		path: "/api/echo",
	},
	getApiEchoWs: {
		call: wsOp,
		method: "GET",
		path: "/api/echo-ws",
		ws: true,
	},
	getApiEvents: {
		call: sseOp,
		method: "GET",
		path: "/api/events",
		sse: true,
	},
	getApiEventsLive: {
		call: sseOp,
		method: "GET",
		path: "/api/events-live",
		sse: true,
	},
	getApiHealth: {
		empty: true,
		method: "GET",
		path: "/api/health",
	},
	getApiRealtimeChatByRoomId: {
		call: wsOp,
		method: "GET",
		params: ["roomId"],
		path: "/api/realtime/chat/{roomId}",
		ws: true,
	},
	getApiRealtimeEcho: {
		call: wsOp,
		method: "GET",
		path: "/api/realtime/echo",
		ws: true,
	},
	getApiReconnectWs: {
		call: wsOp,
		method: "GET",
		path: "/api/reconnect-ws",
		ws: true,
	},
	getApiV1Organizations: {
		empty: true,
		method: "GET",
		path: "/api/v1/organizations",
	},
	getApiV1OrganizationsByOrgId: {
		empty: true,
		method: "GET",
		params: ["orgId"],
		path: "/api/v1/organizations/{orgId}",
	},
	getApiV1Socket: {
		call: wsOp,
		method: "GET",
		path: "/api/v1/socket",
		ws: true,
	},
	patchApiEcho: {
		empty: true,
		method: "PATCH",
		path: "/api/echo",
	},
	postApiEcho: {
		empty: true,
		method: "POST",
		path: "/api/echo",
	},
	postApiRealtimeBroadcastByTopic: {
		empty: true,
		method: "POST",
		params: ["topic"],
		path: "/api/realtime/broadcast/{topic}",
	},
	postApiV1Organizations: {
		empty: true,
		method: "POST",
		path: "/api/v1/organizations",
	},
	putApiEcho: {
		empty: true,
		method: "PUT",
		path: "/api/echo",
	},
}
