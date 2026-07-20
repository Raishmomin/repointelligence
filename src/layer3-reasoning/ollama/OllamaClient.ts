import * as vscode from 'vscode';
import { Ollama } from 'ollama';
import * as http from 'http';
import * as https from 'https';
import { Readable } from 'stream';
import { Logger } from '../../shared/Logger';
import { OllamaHealthStatus, ModelInfo } from '../../shared/types/ollama.types';
import { ModelClient } from '../../shared/types/agent.types';

function customFetch(url: string, options: any = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const requestFn = isHttps ? https.request : http.request;
    
    const headers = { ...(options.headers || {}) };
    
    const reqOptions: http.RequestOptions = {
      method: options.method || 'GET',
      headers: headers,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      timeout: 0, // Disable timeout for local inference
    };
    
    const req = requestFn(reqOptions, (res) => {
      const chunks: Buffer[] = [];
      
      const responseObj = {
        ok: (res.statusCode ?? 200) >= 200 && (res.statusCode ?? 200) < 300,
        status: res.statusCode,
        statusText: res.statusMessage,
        headers: {
          get: (name: string) => res.headers[name.toLowerCase()] as string || null,
          get name() { return 'Headers'; }
        },
        json: async () => {
          const bodyText = await readAllChunks();
          return JSON.parse(bodyText);
        },
        text: async () => {
          return await readAllChunks();
        },
        body: Readable.toWeb ? Readable.toWeb(res) : makeWebStream(res),
      };
      
      function readAllChunks(): Promise<string> {
        return new Promise((resResolve, resReject) => {
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          res.on('end', () => resResolve(Buffer.concat(chunks).toString('utf-8')));
          res.on('error', (err) => resReject(err));
        });
      }
      
      resolve(responseObj);
    });
    
    req.on('error', (err) => {
      reject(err);
    });
    
    req.on('socket', (socket) => {
      socket.setTimeout(0);
    });
    
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

function makeWebStream(nodeStream: any) {
  return {
    getReader: () => {
      let ended = false;
      nodeStream.on('end', () => { ended = true; });
      return {
        read: async () => {
          if (ended) {
            return { done: true, value: undefined };
          }
          return new Promise((resolveRead) => {
            nodeStream.once('data', (chunk: any) => {
              resolveRead({ done: false, value: chunk });
            });
            nodeStream.once('end', () => {
              resolveRead({ done: true, value: undefined });
            });
          });
        }
      };
    }
  };
}

export class OllamaClient implements ModelClient {
  private client!: Ollama;
  private logger = Logger.getInstance();

  constructor() {
    this.updateConfig();
  }

  /** Reload config values from VS Code settings. */
  updateConfig(): void {
    const config = vscode.workspace.getConfiguration('repo-intelligence');
    const url = config.get<string>('ollama.url', 'http://127.0.0.1:11434');
    this.client = new Ollama({
      host: url,
      fetch: customFetch as any
    });
    this.logger.debug('Ollama client config updated', { url });
  }

  /** Retrieve the list of downloaded local models. */
  async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await this.client.list();
      return response.models.map(m => ({
        name: m.name,
        size: m.size,
        digest: m.digest,
        modifiedAt: m.modified_at instanceof Date ? m.modified_at.toISOString() : String(m.modified_at),
        details: {
          format: m.details?.format ?? '',
          family: m.details?.family ?? '',
          parameterSize: m.details?.parameter_size ?? '',
          quantizationLevel: m.details?.quantization_level ?? '',
        },
      }));
    } catch (error) {
      this.logger.warn('Failed to retrieve model list from Ollama', { error: String(error) });
      return [];
    }
  }

  /** Check Ollama server availability and status. */
  async checkHealth(): Promise<OllamaHealthStatus> {
    const config = vscode.workspace.getConfiguration('repo-intelligence');
    const url = config.get<string>('ollama.url', 'http://127.0.0.1:11434');
    try {
      const models = await this.listModels();
      // Simple fetch for version or base route
      const response = await customFetch(`${url}/api/tags`).catch(() => null);
      const available = !!response && response.ok;

      return {
        available,
        url,
        version: response ? response.headers.get('x-ollama-version') ?? 'unknown' : null,
        models,
        error: available ? null : 'Connection failed or service is offline',
      };
    } catch (error) {
      return {
        available: false,
        url,
        version: null,
        models: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Generate an embedding vector for text chunking. */
  async getEmbedding(text: string): Promise<number[]> {
    const config = vscode.workspace.getConfiguration('repo-intelligence');
    let model = config.get<string>('ollama.embeddingModel', 'nomic-embed-text');

    try {
      const availableModels = await this.listModels();
      if (availableModels.length > 0 && !availableModels.some(m => m.name === model || m.name.startsWith(model))) {
        // Find an embedding model if possible, otherwise return [] to gracefully fallback to keyword search
        const fallback = availableModels.find(m => m.name.includes('embed'));
        if (fallback) {
          model = fallback.name;
        } else {
          this.logger.warn(`Configured embedding model ${model} not found and no embed fallback available. Using keyword-only search.`);
          return [];
        }
      }

      const response = await this.client.embeddings({
        model,
        prompt: text,
      });
      return response.embedding;
    } catch (error) {
      this.logger.warn(`Failed to generate embeddings using model ${model}`, { error: String(error) });
      return [];
    }
  }

  /** Stream completion response back to the webview UI. */
  async chatStream(
    messages: { role: string; content: string }[],
    onProgress: (chunk: string) => void,
    cancellationToken?: vscode.CancellationToken
  ): Promise<string> {
    const config = vscode.workspace.getConfiguration('repo-intelligence');
    let model = config.get<string>('ollama.chatModel', 'deepseek-coder-v2:16b');

    try {
      const availableModels = await this.listModels();
      if (availableModels.length > 0 && !availableModels.some(m => m.name === model || m.name.startsWith(model))) {
        // Fallback to the best matching available model, prioritizing llama then gemma, or just using the first available
        const fallback = availableModels.find(m => m.name.includes('llama') || m.name.includes('gemma') || m.name.includes('deepseek'));
        model = fallback ? fallback.name : availableModels[0].name;
        this.logger.info(`Configured chat model not found. Falling back to available model: ${model}`);
      }

      const response = await this.client.chat({
        model,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        stream: true,
      });

      let fullText = '';
      for await (const part of response) {
        if (cancellationToken?.isCancellationRequested) {
          break;
        }
        const chunk = part.message.content;
        fullText += chunk;
        onProgress(chunk);
      }
      return fullText;
    } catch (error) {
      this.logger.error(`Ollama stream error (model: ${model})`, error);
      throw error;
    }
  }

  /** Non-streaming completion used by the structured agent protocol. */
  async chatComplete(messages: { role: string; content: string }[]): Promise<string> {
    const config = vscode.workspace.getConfiguration('repo-intelligence');
    const model = config.get<string>('ollama.chatModel', 'deepseek-coder-v2:16b');
    const response = await this.client.chat({ model, messages, stream: false, format: 'json' });
    return response.message.content;
  }
}
