import type { AdapterContext } from './registry.js';
import type { ChatRequest, ModelCapabilities, ModelInfo, Provider, StreamEvent } from './types.js';
import { ProviderError, UNKNOWN_CAPS } from './types.js';

export class AnthropicProvider implements Provider {
  readonly type = 'openai' as const;
  readonly endpoint = '';
  readonly name: string;
  constructor(ctx: AdapterContext) {
    this.name = ctx.config.name;
  }
  async listModels(): Promise<ModelInfo[]> {
    return [];
  }
  async capabilities(_model: string): Promise<ModelCapabilities> {
    return UNKNOWN_CAPS;
  }
  // eslint-disable-next-line require-yield
  async *stream(_req: ChatRequest): AsyncGenerator<StreamEvent> {
    throw new ProviderError('unknown', 'not implemented');
  }
}
