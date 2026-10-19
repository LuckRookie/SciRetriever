import { labelsProcessor } from "./processor-labels.js";
import { recordsProcessor } from "./processor-records.js";
import type { KnowledgeAnalysisService } from "./knowledge.js";
import { ProcessorRegistry } from "./processor.js";
import { registerKnowledgeProcessors } from "./processor-knowledge.js";
import { synthesisProcessor } from "./processor-synthesis.js";
export function createProcessorRegistry(
  analysis: KnowledgeAnalysisService | null = null,
) {
  const registry = new ProcessorRegistry();
  registerKnowledgeProcessors(registry, analysis);
  registry.register(synthesisProcessor(analysis));
  registry.register(labelsProcessor);
  registry.register(recordsProcessor);
  return registry;
}
