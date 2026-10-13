//#region src/functionCalling.d.ts
type HarmonyTerminator = '<|end|>' | '<|return|>' | '<|call|>';
interface ChatMessageFunctionCall {
  name?: string;
  arguments?: string;
}
interface ChatMessage {
  role?: 'system' | 'user' | 'assistant' | 'developer' | (string & {});
  name?: string;
  content: string;
  function_call?: ChatMessageFunctionCall;
  /** Harmony-only: channel label such as `analysis`, `commentary`, or `final`. */
  channel?: string;
  /** Harmony-only: recipient metadata, e.g. `functions.get_weather` or `assistant`. */
  recipient?: string;
  /** Controls where the recipient metadata is rendered in Harmony headers. Defaults to `channel`. */
  recipientPlacement?: 'role' | 'channel';
  /** Harmony-only: constraint label, e.g. `json`. */
  constraint?: string;
  /** Harmony-only: overrides the closing token, defaults to `<|end|>`. */
  terminator?: HarmonyTerminator;
}
interface EncodeChatOptions {
  primeWithAssistantResponse?: string;
}
type ChatCompletionFunctionType = 'string' | 'integer' | 'number' | 'boolean' | 'null' | 'array' | 'object';
interface ChatCompletionStringProperty {
  type: Extract<ChatCompletionFunctionType, 'string'>;
  description?: string;
  enum?: string[];
}
interface ChatCompletionNumberProperty {
  type: Extract<ChatCompletionFunctionType, 'integer' | 'number'>;
  description?: string;
  minimum?: number;
  maximum?: number;
  enum?: (number | string)[];
}
interface ChatCompletionBooleanProperty {
  type: Extract<ChatCompletionFunctionType, 'boolean'>;
  description?: string;
}
interface ChatCompletionNullProperty {
  type: Extract<ChatCompletionFunctionType, 'null'>;
  description?: string;
}
interface ChatCompletionArrayProperty {
  type: Extract<ChatCompletionFunctionType, 'array'>;
  description?: string;
  items?: ChatCompletionFunctionProperty;
}
interface ChatCompletionObjectProperty {
  type: Extract<ChatCompletionFunctionType, 'object'>;
  description?: string;
  required?: string[];
  properties?: Record<string, ChatCompletionFunctionProperty>;
}
type ChatCompletionFunctionProperty = ChatCompletionStringProperty | ChatCompletionNumberProperty | ChatCompletionBooleanProperty | ChatCompletionNullProperty | ChatCompletionArrayProperty | ChatCompletionObjectProperty;
interface ChatCompletionFunctionParameters extends ChatCompletionObjectProperty {}
interface ChatCompletionFunctionDefinition {
  name: string;
  description?: string;
  parameters?: ChatCompletionFunctionParameters;
}
type ChatCompletionFunctionCallOption = 'auto' | 'none' | {
  name: string;
};
interface ChatCompletionRequest {
  messages: readonly ChatMessage[];
  functions?: readonly ChatCompletionFunctionDefinition[];
  function_call?: ChatCompletionFunctionCallOption;
}
type CountStringTokens = (text: string) => number;
declare const MESSAGE_TOKEN_OVERHEAD = 3;
declare const MESSAGE_NAME_TOKEN_OVERHEAD = 1;
declare const FUNCTION_ROLE_TOKEN_DISCOUNT = 2;
declare const FUNCTION_CALL_METADATA_TOKEN_OVERHEAD = 3;
declare const FUNCTION_DEFINITION_TOKEN_OVERHEAD = 9;
declare const COMPLETION_REQUEST_TOKEN_OVERHEAD = 3;
declare const FUNCTION_CALL_NAME_TOKEN_OVERHEAD = 4;
declare const FUNCTION_CALL_NONE_TOKEN_OVERHEAD = 1;
declare const SYSTEM_FUNCTION_TOKEN_DEDUCTION = 4;
declare function countMessageTokens(message: ChatMessage, countStringTokens: CountStringTokens): number;
declare function formatObjectProperties(obj: ChatCompletionObjectProperty, indent: number, formatType: (param: ChatCompletionFunctionProperty, indent: number) => string): string;
declare function formatFunctionType(param: ChatCompletionFunctionProperty, indent: number): string;
declare function formatFunctionDefinitions(functions: readonly ChatCompletionFunctionDefinition[]): string;
declare function estimateTokensInFunctions(functions: readonly ChatCompletionFunctionDefinition[], countStringTokens: CountStringTokens): number;
declare function padSystemMessage(message: ChatMessage, hasFunctions: boolean, isSystemPadded: boolean): ChatMessage;
declare function computeChatCompletionTokenCount(request: ChatCompletionRequest, countStringTokens: CountStringTokens): number;
//#endregion
export { COMPLETION_REQUEST_TOKEN_OVERHEAD, ChatCompletionArrayProperty, ChatCompletionBooleanProperty, ChatCompletionFunctionCallOption, ChatCompletionFunctionDefinition, ChatCompletionFunctionParameters, ChatCompletionFunctionProperty, ChatCompletionFunctionType, ChatCompletionNullProperty, ChatCompletionNumberProperty, ChatCompletionObjectProperty, ChatCompletionRequest, ChatCompletionStringProperty, ChatMessage, ChatMessageFunctionCall, CountStringTokens, EncodeChatOptions, FUNCTION_CALL_METADATA_TOKEN_OVERHEAD, FUNCTION_CALL_NAME_TOKEN_OVERHEAD, FUNCTION_CALL_NONE_TOKEN_OVERHEAD, FUNCTION_DEFINITION_TOKEN_OVERHEAD, FUNCTION_ROLE_TOKEN_DISCOUNT, HarmonyTerminator, MESSAGE_NAME_TOKEN_OVERHEAD, MESSAGE_TOKEN_OVERHEAD, SYSTEM_FUNCTION_TOKEN_DEDUCTION, computeChatCompletionTokenCount, countMessageTokens, estimateTokensInFunctions, formatFunctionDefinitions, formatFunctionType, formatObjectProperties, padSystemMessage };
//# sourceMappingURL=functionCalling.d.ts.map