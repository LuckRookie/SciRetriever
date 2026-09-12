/** MinerU backend adapters for the generic parsing contract. */
export { MinerUParser, type MinerUHttpTransport } from "./http.js";
export { MinerULoopbackParser } from "./loopback.js";
export { convertMinerUArchive, type MinerUArchiveOptions } from "./archive.js";

/** @deprecated Use MinerUParser; the backend is already identified by its module. */
export { MinerUParser as TypeScriptMinerUParser } from "./http.js";
/** @deprecated Use MinerULoopbackParser; the backend is already identified by its module. */
export { MinerULoopbackParser as TypeScriptLoopbackMinerUParser } from "./loopback.js";
