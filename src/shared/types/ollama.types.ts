// ═══════════════════════════════════════════════════════════════
// Ollama Types — Client options, model info, health
// ═══════════════════════════════════════════════════════════════

export interface OllamaConfig {
  url: string;
  chatModel: string;
  embeddingModel: string;
}

export interface OllamaOptions {
  model: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  topP?: number;
  topK?: number;
  repeatPenalty?: number;
}

export interface ModelInfo {
  name: string;
  size: number;
  digest: string;
  modifiedAt: string;
  details: {
    format: string;
    family: string;
    parameterSize: string;
    quantizationLevel: string;
  };
}

export interface OllamaHealthStatus {
  available: boolean;
  url: string;
  version: string | null;
  models: ModelInfo[];
  error: string | null;
}
