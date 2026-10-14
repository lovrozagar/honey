/**
 * `@lovrozagar/honey/telemetry`: `otelAdapter` and the types of the value `app.telemetry()` carries.
 * A plain subpath for tree-shaking: honey imports no OpenTelemetry package.
 */
export { type OtelAdapterOptions, type OtelApi, otelAdapter } from "./otel.ts"
export type {
	Attributes,
	AttributeValue,
	Span,
	SpanOptions,
	Telemetry,
	TelemetryErrorReport,
	Tracer,
} from "./request-trace.ts"
export type { RemoteContext } from "./traceparent.ts"
