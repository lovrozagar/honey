import { EndOfPrompt, EndOfText, HarmonyCall, HarmonyChannel, HarmonyConstrain, HarmonyEnd, HarmonyMessage, HarmonyReturn, HarmonyStart, HarmonyStartOfText } from "../specialTokens.js";
import { O200K_TOKEN_SPLIT_REGEX } from "./constants.js";
//#region src/encodingParams/o200k_harmony.ts
const RESERVED_TOKEN_RANGE_START = 200013;
const RESERVED_TOKEN_RANGE_END = 201088;
const STATIC_SPECIAL_TOKEN_ENTRIES = [
	[HarmonyStartOfText, 199998],
	[EndOfText, 199999],
	["<|reserved_200000|>", 2e5],
	["<|reserved_200001|>", 200001],
	[HarmonyReturn, 200002],
	[HarmonyConstrain, 200003],
	["<|reserved_200004|>", 200004],
	[HarmonyChannel, 200005],
	[HarmonyStart, 200006],
	[HarmonyEnd, 200007],
	[HarmonyMessage, 200008],
	["<|reserved_200009|>", 200009],
	["<|reserved_200010|>", 200010],
	["<|reserved_200011|>", 200011],
	[HarmonyCall, 200012]
];
function O200KHarmony(bytePairRankDecoder) {
	const specialTokensEncoder = new Map(STATIC_SPECIAL_TOKEN_ENTRIES);
	for (let tokenId = RESERVED_TOKEN_RANGE_START; tokenId < RESERVED_TOKEN_RANGE_END; tokenId += 1) specialTokensEncoder.set(`<|reserved_${tokenId}|>`, tokenId);
	specialTokensEncoder.set(EndOfPrompt, 200018);
	return {
		tokenSplitRegex: O200K_TOKEN_SPLIT_REGEX,
		bytePairRankDecoder,
		specialTokensEncoder,
		chatFormatter: "harmony"
	};
}
//#endregion
export { O200KHarmony };

//# sourceMappingURL=o200k_harmony.js.map