import { ALL_SPECIAL_TOKENS, DEFAULT_MERGE_CACHE_SIZE } from "../constants.js";
import { EndOfPrompt, EndOfText, FimMiddle, FimPrefix, FimSuffix, HarmonyCall, HarmonyChannel, HarmonyConstrain, HarmonyEnd, HarmonyMessage, HarmonyReturn, HarmonyStart, HarmonyStartOfText, ImEnd, ImSep, ImStart } from "../specialTokens.js";
import { GptEncoding } from "../GptEncoding.js";
import bpe from "../bpeRanks/o200k_base.js";
//#region src/encoding/o200k_base.ts
const api = GptEncoding.getEncodingApi("o200k_base", () => bpe);
const { decode, decodeAsyncGenerator, decodeGenerator, encode, encodeGenerator, isWithinTokenLimit, countTokens, encodeChat, encodeChatGenerator, vocabularySize, setMergeCacheSize, clearMergeCache, estimateCost } = api;
//#endregion
export { ALL_SPECIAL_TOKENS, DEFAULT_MERGE_CACHE_SIZE, EndOfPrompt, EndOfText, FimMiddle, FimPrefix, FimSuffix, HarmonyCall, HarmonyChannel, HarmonyConstrain, HarmonyEnd, HarmonyMessage, HarmonyReturn, HarmonyStart, HarmonyStartOfText, ImEnd, ImSep, ImStart, clearMergeCache, countTokens, decode, decodeAsyncGenerator, decodeGenerator, api as default, encode, encodeChat, encodeChatGenerator, encodeGenerator, estimateCost, isWithinTokenLimit, setMergeCacheSize, vocabularySize };

//# sourceMappingURL=o200k_base.js.map