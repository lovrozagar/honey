import { EndOfText } from "../specialTokens.js";
import { R50K_TOKEN_SPLIT_REGEX } from "./constants.js";
import "../modelParams.js";
//#region src/encodingParams/p50k_base.ts
function P50KBase(bytePairRankDecoder) {
	return {
		expectedVocabularySize: 50281,
		tokenSplitRegex: R50K_TOKEN_SPLIT_REGEX,
		bytePairRankDecoder,
		specialTokensEncoder: /* @__PURE__ */ new Map([[EndOfText, 50256]])
	};
}
//#endregion
export { P50KBase };

//# sourceMappingURL=p50k_base.js.map