// @sdjz/ai-sdk/testing — mock provider for tests

/**
 * Create a mock provider for testing.
 *
 * @example
 * const mock = createMockProvider({
 *   responses: [
 *     { text: 'Hello!', usage: { input: 5, output: 10, total: 15 } },
 *     { text: 'Goodbye!' },
 *   ]
 * })
 *
 * // Use with generateText/agent
 * const { text } = await generateText({ model: mock, prompt: 'Hi' })
 *
 * // Check what was called
 * console.log(mock.calls.length)  // 1
 * console.log(mock.calls[0].messages[0].content)  // 'Hi'
 */
export function createMockProvider(options = {}) {
  let responses = options.responses || []

  // Support shorthand: ['Hello', 'World'] → [{ text: 'Hello' }, { text: 'World' }]
  responses = responses.map(r => typeof r === 'string' ? { text: r } : r)

  let idx = 0
  const calls = []

  const provider = {
    name: 'mock',
    calls,
    async chat(req) {
      calls.push(req)
      if (idx >= responses.length) {
        return { text: '', usage: { input: 0, output: 0, total: 0 } }
      }
      const resp = responses[idx++]
      return {
        text: resp.text || '',
        usage: resp.usage || { input: 0, output: 0, total: 0 },
        toolCalls: resp.toolCalls || null,
      }
    },
    async *stream(req) {
      calls.push(req)
      if (idx >= responses.length) return
      const resp = responses[idx++]
      const text = resp.text || ''
      for (const ch of text) {
        yield { delta: ch }
      }
      if (resp.usage) {
        yield { type: 'usage', usage: resp.usage }
      }
    },
  }

  return provider
}
