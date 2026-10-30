/**
 * The build gate's bare reference (bit 21 bref diagnostic): vite.config.ts with no JS work, the honey-free build alone.
 * Each cell times it beside the worked reference (build-window.ts), and the RATIO line prints its median as ref0=, so
 * one record set measures both candidates: the 15,000-unit reference scaled +84% across two EPYC generations where the
 * app builds scaled +55% (CI 40984407519, 40986257883), and this one's class shift is the other number H1 needs.
 * Judged on neither while build.json is report-only; the one not chosen is deleted in the recording commit.
 */
import config from "./vite.config.ts"

export default { ...config, plugins: [] }
