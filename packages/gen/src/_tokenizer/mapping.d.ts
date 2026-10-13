import { models_d_exports } from "./models.js";
import { chatEnabledModels } from "./modelsChatEnabled.gen.js";
import { modelsMap_d_exports } from "./modelsMap.js";
//#region src/mapping.d.ts
declare const cl100k_base = "cl100k_base";
declare const gpt2 = "gpt2";
declare const p50k_base = "p50k_base";
declare const p50k_edit = "p50k_edit";
declare const r50k_base = "r50k_base";
declare const o200k_base = "o200k_base";
declare const o200k_harmony = "o200k_harmony";
declare const DEFAULT_ENCODING = "o200k_base";
type EncodingName = keyof typeof modelsMap_d_exports;
declare const encodingNames: ["gpt2", "p50k_base", "r50k_base", "p50k_edit", "cl100k_base", "o200k_base", "o200k_harmony"];
/**
 * maps model names to encoding names
 * if a model is not listed, it uses the default encoding for new models
 * which is `o200k_base`
 */
declare const modelToEncodingMap: Record<ModelName, EncodingName>;
interface ChatParameters {
  messageSeparator: string;
  roleSeparator: string;
}
type ModelName = keyof typeof models_d_exports;
type ChatModelName = (typeof chatEnabledModels)[number];
declare const chatModelParams: Record<ChatModelName, ChatParameters>;
//#endregion
export { ChatModelName, ChatParameters, DEFAULT_ENCODING, EncodingName, ModelName, chatModelParams, cl100k_base, encodingNames, gpt2, modelToEncodingMap, o200k_base, o200k_harmony, p50k_base, p50k_edit, r50k_base };
//# sourceMappingURL=mapping.d.ts.map