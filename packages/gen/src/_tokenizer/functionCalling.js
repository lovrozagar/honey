//#region src/functionCalling.ts
const MESSAGE_TOKEN_OVERHEAD = 3;
const MESSAGE_NAME_TOKEN_OVERHEAD = 1;
const FUNCTION_ROLE_TOKEN_DISCOUNT = 2;
const FUNCTION_CALL_METADATA_TOKEN_OVERHEAD = 3;
const FUNCTION_DEFINITION_TOKEN_OVERHEAD = 9;
const COMPLETION_REQUEST_TOKEN_OVERHEAD = 3;
const FUNCTION_CALL_NAME_TOKEN_OVERHEAD = 4;
const FUNCTION_CALL_NONE_TOKEN_OVERHEAD = 1;
const SYSTEM_FUNCTION_TOKEN_DEDUCTION = 4;
const NEWLINE = "\n";
function countMessageTokens(message, countStringTokens) {
	let tokens = 0;
	if (message.role) tokens += countStringTokens(message.role);
	if (message.content) tokens += countStringTokens(message.content);
	if (message.name) tokens += countStringTokens(message.name) + 1;
	if (message.function_call) {
		const { name, arguments: args } = message.function_call;
		if (name) tokens += countStringTokens(name);
		if (args) tokens += countStringTokens(args);
		tokens += 3;
	}
	tokens += 3;
	if (message.role === "function") tokens -= 2;
	return tokens;
}
function formatObjectProperties(obj, indent, formatType) {
	if (!obj.properties) return "";
	const lines = [];
	const requiredParams = new Set(obj.required ?? []);
	const indentString = " ".repeat(indent);
	for (const [name, param] of Object.entries(obj.properties)) {
		if (param.description && indent < 2) lines.push(`${indentString}// ${param.description}`);
		const isRequired = requiredParams.has(name);
		const formattedType = formatType(param, indent);
		lines.push(`${indentString}${name}${isRequired ? "" : "?"}: ${formattedType},`);
	}
	return lines.join("\n");
}
function formatFunctionType(param, indent) {
	switch (param.type) {
		case "string": return param.enum?.map((value) => JSON.stringify(value)).join(" | ") ?? "string";
		case "integer":
		case "number": return param.enum?.map((value) => `${value}`).join(" | ") ?? "number";
		case "boolean": return "boolean";
		case "null": return "null";
		case "array": return param.items ? `${formatFunctionType(param.items, indent)}[]` : "any[]";
		case "object": return `{
${formatObjectProperties(param, indent + 2, formatFunctionType)}
${" ".repeat(indent)}}`;
		default: return "any";
	}
}
function formatFunctionDefinitions(functions) {
	const lines = ["namespace functions {", ""];
	for (const fn of functions) {
		if (fn.description) lines.push(`// ${fn.description}`);
		const { parameters } = fn;
		const properties = parameters?.properties;
		if (!parameters || !properties || Object.keys(properties).length === 0) lines.push(`type ${fn.name} = () => any;`);
		else {
			lines.push(`type ${fn.name} = (_: {`);
			const formattedProperties = formatObjectProperties(parameters, 0, formatFunctionType);
			if (formattedProperties.length > 0) lines.push(formattedProperties);
			lines.push("}) => any;");
		}
		lines.push("");
	}
	lines.push("} // namespace functions");
	return lines.join("\n");
}
function estimateTokensInFunctions(functions, countStringTokens) {
	let tokens = countStringTokens(formatFunctionDefinitions(functions));
	tokens += 9;
	return tokens;
}
function padSystemMessage(message, hasFunctions, isSystemPadded) {
	if (!hasFunctions || isSystemPadded || message.role !== "system") return message;
	if (!message.content || message.content.endsWith(NEWLINE)) return message;
	return {
		...message,
		content: `${message.content}${NEWLINE}`
	};
}
function computeChatCompletionTokenCount(request, countStringTokens) {
	const { messages, functions, function_call: functionCall } = request;
	const hasFunctions = Boolean(functions && functions.length > 0);
	let paddedSystem = false;
	let total = 0;
	for (const message of messages) {
		const messageToCount = padSystemMessage(message, hasFunctions, paddedSystem);
		if (messageToCount !== message && message.role === "system") paddedSystem = true;
		else if (message.role === "system" && hasFunctions && !paddedSystem) paddedSystem = true;
		total += countMessageTokens(messageToCount, countStringTokens);
	}
	total += 3;
	if (hasFunctions && functions) {
		total += estimateTokensInFunctions(functions, countStringTokens);
		if (messages.some((message) => message.role === "system")) total -= 4;
	}
	if (functionCall && functionCall !== "auto") {
		if (functionCall === "none") total += 1;
		else if (typeof functionCall === "object" && functionCall.name) total += countStringTokens(functionCall.name) + 4;
	}
	return total;
}
//#endregion
export { COMPLETION_REQUEST_TOKEN_OVERHEAD, FUNCTION_CALL_METADATA_TOKEN_OVERHEAD, FUNCTION_CALL_NAME_TOKEN_OVERHEAD, FUNCTION_CALL_NONE_TOKEN_OVERHEAD, FUNCTION_DEFINITION_TOKEN_OVERHEAD, FUNCTION_ROLE_TOKEN_DISCOUNT, MESSAGE_NAME_TOKEN_OVERHEAD, MESSAGE_TOKEN_OVERHEAD, SYSTEM_FUNCTION_TOKEN_DEDUCTION, computeChatCompletionTokenCount, countMessageTokens, estimateTokensInFunctions, formatFunctionDefinitions, formatFunctionType, formatObjectProperties, padSystemMessage };

//# sourceMappingURL=functionCalling.js.map