import { BytePairEncodingConfig, RawBytePairRanks } from "./BytePairEncodingCore.js";
import { EncodingName, ModelName } from "./mapping.js";
import { ModelSpec } from "./modelTypes.js";
//#region src/modelParams.d.ts
type ChatFormatter = 'chatml' | 'harmony';
interface EncodingParams extends BytePairEncodingConfig {
  /**
   * The expected total number of tokens in the vocabulary, including both regular and special tokens.
   * This parameter is used to ensure that the combined number of regular and special tokens matches the expected total.
   */
  expectedVocabularySize?: number;
  /**
   * A regular expression that is designed to tokenize or break up a text into parts
   * that can be contractions, letters, numbers, or other characters,
   * while handling line terminators and spaces in a specific manner.
   * It's complex due to its need to deal with a wide variety of cases in text processing.
   */
  tokenSplitRegex: RegExp;
  specialTokensEncoder: Map<string, number>;
  modelName?: ModelName;
  modelSpec?: ModelSpec;
  chatFormatter?: ChatFormatter;
}
type GetMergeableRanksFn = (encodingName: EncodingName) => RawBytePairRanks;
declare function getEncodingParams(encodingName: EncodingName, getMergeableRanks: GetMergeableRanksFn): EncodingParams;
//#endregion
export { ChatFormatter, EncodingParams, GetMergeableRanksFn, getEncodingParams };
//# sourceMappingURL=modelParams.d.ts.map