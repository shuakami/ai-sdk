export interface MockResponse {
  text?: string
  usage?: { input?: number; output?: number; total?: number }
  toolCalls?: Array<{ name: string; args: Record<string, unknown>; callId?: string }>
}

export interface MockProviderOptions {
  /** Mock responses to return in order. Can be objects or simple strings. */
  responses?: (MockResponse | string)[]
}

export interface MockProvider {
  name: string
  /** All requests that were made to this provider */
  calls: Array<{ messages: Array<{ role: string; content: string }> }>
  chat(req: any): Promise<{ text: string; usage: { input: number; output: number; total: number }; toolCalls?: any }>
  stream(req: any): AsyncIterable<{ delta?: string; type?: string; usage?: any }>
}

/**
 * Create a mock provider for testing.
 *
 * @example
 * ```ts
 * import { createMockProvider } from '@sdjz/ai-sdk/testing'
 *
 * const mock = createMockProvider({
 *   responses: [
 *     { text: 'Hello!', usage: { total: 15 } },
 *     'Simple string response',
 *   ]
 * })
 *
 * // Use with generateText/agent
 * const { text } = await generateText({ model: mock, prompt: 'Hi' })
 *
 * // Assert on calls
 * expect(mock.calls).toHaveLength(1)
 * expect(mock.calls[0].messages[0].content).toBe('Hi')
 * ```
 */
export function createMockProvider(options?: MockProviderOptions): MockProvider
