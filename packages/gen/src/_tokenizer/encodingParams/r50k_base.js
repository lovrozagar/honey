import { EndOfText } from "../specialTokens.js";
import { R50K_TOKEN_SPLIT_REGEX } from "./constants.js";
import "../modelParams.js";
//#region src/encodingParams/r50k_base.ts
function R50KBase(bytePairRankDecoder) {
	return {
		expectedVocabularySize: 50257,
		tokenSplitRegex: R50K_TOKEN_SPLIT_REGEX,
		bytePairRankDecoder,
		specialTokensEncoder: /* @__PURE__ */ new Map([[EndOfText, 50256]])
	};
}
//#endregion
export { R50KBase };

//# sourceMappingURL=r50k_base.js.map