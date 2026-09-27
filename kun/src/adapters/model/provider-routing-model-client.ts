import { z } from 'zod'
import type { ModelClient, ModelRequest, ModelStreamChunk } from '../../ports/model-client.js'
import { MODEL_ENDPOINT_FORMATS } from '../../contracts/model-endpoint-format.js'
import { DeepseekCompatModelClient } from './deepseek-compat-model-client.js'

export const ModelProviderRoutesSchema = z.array(z.object({
  id: z.string().trim().min(1).max(200),
  baseUrl: z.string().url(),
  apiKey: z.string(),
  endpointFormat: z.enum(MODEL_ENDPOINT_FORMATS),
  model: z.string().min(1)
}).strict()).max(100).refine(routes => new Set(routes.map(route => route.id)).size === routes.length, 'duplicate model provider id')
export type ModelProviderRoutes = z.infer<typeof ModelProviderRoutesSchema>

export function unavailableModelProvider(providerId: string): Error & { code: string } {
  return Object.assign(new Error(`model_provider_unavailable: ${providerId}`), { code: 'model_provider_unavailable' })
}

/** Callers carry persisted identity; internal callers without a selection retain
 * the configured default. Unknown explicit providers never fall back. */
export class ProviderRoutingModelClient implements ModelClient {
  readonly provider: string
  readonly model: string
  private readonly routes: Map<string, ModelProviderRoutes[number]>

  constructor(private readonly fallback: ModelClient, routes: ModelProviderRoutes) {
    this.provider = fallback.provider
    this.model = fallback.model
    this.routes = new Map(ModelProviderRoutesSchema.parse(routes).map(route => [route.id, route]))
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    const providerId = request.providerId
    const route = providerId ? this.routes.get(providerId) : undefined
    if (providerId && !route) throw unavailableModelProvider(providerId)
    const client = route ? new DeepseekCompatModelClient({ ...route, model: request.model || route.model }) : this.fallback
    yield* client.stream(request)
  }
}
