import { labelsProcessor } from "./processor-labels.js";
import { recordsProcessor } from "./processor-records.js";
import { summaryProcessor } from "./processor-knowledge.js";
import { synthesisProcessor } from "./processor-synthesis.js";
import { ProcessorRegistry } from "./processor.js";
export function createProcessorRegistry() {
  const registry = new ProcessorRegistry();
  for (const processor of [
    summaryProcessor,
    synthesisProcessor,
    labelsProcessor,
    recordsProcessor,
  ])
    registry.register(processor);
  return registry;
}
