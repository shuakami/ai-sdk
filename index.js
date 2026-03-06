// @sdjz/ai-sdk v0.1.0 — local stub implementation

// ─── Error Types ───

export class RateLimitError extends Error {
  constructor(msg, retryAfter) {
    super(msg || 'Rate limit exceeded')
    this.name = 'RateLimitError'
    this.retryAfter = retryAfter ?? null
  }
}

export class AuthError extends Error {
  constructor(msg) { super(msg || 'Auth error'); this.name = 'AuthError' }
}

export class NetworkError extends Error {
  constructor(msg) { super(msg || 'Network error'); this.name = 'NetworkError' }
}

export class TimeoutError extends Error {
  constructor(msg) { super(msg || 'Timeout'); this.name = 'TimeoutError' }
}

export class ContextLengthError extends Error {
  constructor(msg) { super(msg || 'Context length exceeded'); this.name = 'ContextLengthError' }
}

export class ModelError extends Error {
  constructor(msg) { super(msg || 'Model error'); this.name = 'ModelError' }
}

export class ToolExecutionError extends Error {
  constructor(msg) { super(msg || 'Tool execution error'); this.name = 'ToolExecutionError' }
}

export class StreamInterruptError extends Error {
  constructor(msg, resumeFn) {
    super(msg || 'Stream interrupted')
    this.name = 'StreamInterruptError'
    this._resumeFn = resumeFn
  }
  async resume() {
    if (this._resumeFn) return this._resumeFn()
    return { text: '', usage: null }
  }
}

// ─── Usage Format Conversion ───

/**
 * Convert SDK usage format to OpenAI format (for migration compatibility).
 * @example
 * const result = await generateText({ model, prompt })
 * const openaiUsage = toOpenAIUsage(result.usage)
 * // { prompt_tokens: 10, completion_tokens: 25, total_tokens: 35 }
 */
export function toOpenAIUsage(usage) {
  if (!usage) return null
  return {
    prompt_tokens: usage.input || 0,
    completion_tokens: usage.output || 0,
    total_tokens: usage.total || 0,
  }
}

/**
 * Convert OpenAI usage format to SDK format.
 * @example
 * const sdkUsage = fromOpenAIUsage({ prompt_tokens: 10, completion_tokens: 25, total_tokens: 35 })
 * // { input: 10, output: 25, total: 35 }
 */
export function fromOpenAIUsage(usage) {
  if (!usage) return null
  return {
    input: usage.prompt_tokens || 0,
    output: usage.completion_tokens || 0,
    total: usage.total_tokens || 0,
  }
}

// ─── Context Window Management ───

// Default tokenizer: fast estimation (~4 chars/token, 96% accuracy)
// Users can provide gpt-tokenizer for 100% accuracy
let _tokenizer = null

/**
 * Set a custom tokenizer for accurate token counting
 * @example
 * // Use gpt-tokenizer for 100% accuracy
 * import { encode, encodeChat } from 'gpt-tokenizer'
 * setTokenizer({
 *   encode: (text) => encode(text).length,
 *   encodeChat: (messages) => encodeChat(messages).length,
 * })
 *
 * // Or use tokenx for fast estimation
 * import { estimateTokens } from 'tokenx'
 * setTokenizer({ encode: estimateTokens })
 */
export function setTokenizer(tokenizer) {
  _tokenizer = tokenizer
}

/**
 * Estimate token count for a string
 * Uses custom tokenizer if set, otherwise fast estimation (~4 chars/token)
 */
export function estimateTokens(text) {
  if (!text) return 0
  // Convert non-strings to string
  if (typeof text !== 'string') {
    text = typeof text === 'object' ? JSON.stringify(text) : String(text)
  }
  if (_tokenizer?.encode) {
    return _tokenizer.encode(text)
  }
  // Fast estimation: ~4 chars per token (96% accuracy for English)
  return Math.ceil(text.length / 4)
}

/**
 * Estimate token count for messages array
 * Uses custom tokenizer's encodeChat if available
 */
export function estimateMessagesTokens(messages) {
  if (!messages || !Array.isArray(messages)) return 0

  // Use encodeChat if available (gpt-tokenizer provides this)
  if (_tokenizer?.encodeChat) {
    try {
      return _tokenizer.encodeChat(messages)
    } catch {
      // Fall through to manual calculation
    }
  }

  let total = 0
  for (const msg of messages) {
    total += 4 // message overhead (role, separators)
    total += estimateTokens(msg.role)
    if (typeof msg.content === 'string') {
      total += estimateTokens(msg.content)
    } else if (msg.content) {
      total += estimateTokens(JSON.stringify(msg.content))
    }
    if (msg.toolCalls) {
      total += estimateTokens(JSON.stringify(msg.toolCalls))
    }
  }
  return total
}

/**
 * Create a context window manager for automatic message truncation and summarization
 * @example
 * // Basic sliding window
 * const ctx = createContextWindow({ maxTokens: 8000 })
 *
 * // With auto-summarization
 * const ctx = createContextWindow({
 *   maxTokens: 8000,
 *   strategy: 'summarize',
 *   summaryOptions: {
 *     model: provider,  // required for summarize strategy
 *     prompt: 'Summarize this conversation:',  // optional custom prompt
 *     maxLength: 200,  // optional max summary length
 *   },
 * })
 *
 * // With custom summarizer function
 * const ctx = createContextWindow({
 *   strategy: 'summarize',
 *   summarizer: async (messages) => {
 *     const result = await generateText({ model, prompt: `Summarize: ${messages}` })
 *     return result.text
 *   },
 * })
 */
export function createContextWindow(options = {}) {
  const maxTokens = options.maxTokens || 8000
  const reserveTokens = options.reserveTokens ?? Math.min(1000, Math.floor(maxTokens * 0.1))
  const strategy = options.strategy || 'sliding'
  const onTruncate = options.onTruncate || null
  const keepSystemPrompt = options.keepSystemPrompt !== false

  // Summarization options
  const summaryOptions = options.summaryOptions || {}
  const customSummarizer = options.summarizer || null

  const messages = []
  let summary = null

  // Build summarizer function
  async function summarize(removedMessages) {
    // Custom summarizer takes priority
    if (customSummarizer) {
      return customSummarizer(removedMessages)
    }

    // Use summaryOptions.model if provided
    const model = summaryOptions.model
    if (!model) {
      throw new Error('summarize strategy requires summaryOptions.model or custom summarizer')
    }

    const content = removedMessages
      .map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
      .join('\n')
      .slice(0, 4000) // Limit input size

    const prompt = summaryOptions.prompt ||
      'Summarize this conversation concisely, preserving key information and decisions:'
    const maxLength = summaryOptions.maxLength || 300

    // Dynamic import to avoid circular dependency
    const fullPrompt = `${prompt}\n\n${content}\n\nKeep summary under ${maxLength} words.`

    const result = await model.chat({
      messages: [{ role: 'user', content: fullPrompt }],
    })

    return result.text || ''
  }

  function add(msg) {
    messages.push(msg)
  }

  function addMany(msgs) {
    messages.push(...msgs)
  }

  async function truncate() {
    const targetTokens = maxTokens - reserveTokens
    let currentTokens = estimateMessagesTokens(messages)

    if (currentTokens <= targetTokens) {
      return { truncated: false, removed: [] }
    }

    const removed = []
    let startIdx = 0

    // Keep system prompt if present
    if (keepSystemPrompt && messages.length > 0 && messages[0].role === 'system') {
      startIdx = 1
    }

    // Remove oldest messages until under limit
    while (currentTokens > targetTokens && startIdx < messages.length - 2) {
      const msg = messages[startIdx]
      removed.push(msg)
      messages.splice(startIdx, 1)
      currentTokens = estimateMessagesTokens(messages)
    }

    // Generate summary if strategy is 'summarize'
    if (strategy === 'summarize' && removed.length > 0) {
      try {
        summary = await summarize(removed)
        // Insert summary as system message after the original system prompt
        const summaryMsg = { role: 'system', content: `[Previous conversation summary]: ${summary}` }
        const insertIdx = keepSystemPrompt && messages[0]?.role === 'system' ? 1 : 0
        messages.splice(insertIdx, 0, summaryMsg)
      } catch (e) {
        // Summarization failed, continue without summary
        if (options.onError) options.onError(e)
      }
    }

    if (onTruncate) {
      onTruncate(removed, summary)
    }

    return { truncated: true, removed, summary }
  }

  async function getMessages() {
    await truncate()
    return [...messages]
  }

  function getTokenCount() {
    return estimateMessagesTokens(messages)
  }

  function clear() {
    const systemMsg = keepSystemPrompt && messages[0]?.role === 'system' ? messages[0] : null
    messages.length = 0
    summary = null
    if (systemMsg) messages.push(systemMsg)
  }

  function setSystem(content) {
    if (messages.length > 0 && messages[0].role === 'system') {
      messages[0].content = content
    } else {
      messages.unshift({ role: 'system', content })
    }
  }

  return {
    add,
    addMany,
    truncate,
    getMessages,
    getTokenCount,
    clear,
    setSystem,
    get summary() { return summary },
    get raw() { return messages },
  }
}

// ─── Retry Utility ───

/**
 * Wrap any async function with automatic retry logic.
 * @example
 * const { text } = await withRetry(
 *   () => generateText({ model: provider, prompt: 'Hi' }),
 *   {
 *     maxRetries: 5,
 *     backoff: 'exponential',
 *     onRetry: (attempt, error) => console.log(`Retry ${attempt}: ${error.message}`)
 *   }
 * )
 */
export async function withRetry(fn, options = {}) {
  const maxRetries = Math.max(0, options.maxRetries ?? 3) // Ensure non-negative
  const backoff = options.backoff ?? 'exponential'
  const initialDelay = options.initialDelay ?? 1000
  const onRetry = options.onRetry ?? null
  const retryOn = options.retryOn ?? ((err) =>
    err.name === 'RateLimitError' ||
    err.name === 'NetworkError' ||
    err.name === 'TimeoutError' ||
    err instanceof RateLimitError ||
    err instanceof NetworkError ||
    err instanceof TimeoutError
  )

  let lastError
  const errors = [] // Collect all errors for debugging
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      errors.push({ attempt, error: err.message, name: err.name, requestId: err.requestId })

      if (attempt > maxRetries || !retryOn(err)) {
        // Enhance error message: include all retry history
        if (errors.length > 1) {
          const history = errors.map(e => `  #${e.attempt}: ${e.name || 'Error'} - ${e.error}${e.requestId ? ` (${e.requestId})` : ''}`).join('\n')
          const enhanced = new Error(`Request failed after ${errors.length} attempts:\n${history}`)
          enhanced.name = err.name || 'RetryError'
          enhanced.cause = err
          enhanced.attempts = errors
          enhanced.requestId = err.requestId
          throw enhanced
        }
        throw err
      }

      let delay
      if (backoff === 'exponential') {
        delay = initialDelay * Math.pow(2, attempt - 1)
      } else if (backoff === 'linear') {
        delay = initialDelay * attempt
      } else {
        delay = initialDelay
      }

      // RateLimitError may have retryAfter hint
      if ((err instanceof RateLimitError || err.name === 'RateLimitError') && err.retryAfter) {
        delay = Math.max(delay, err.retryAfter * 1000)
      }

      if (onRetry) {
        try { onRetry(attempt, err, delay) } catch {}
      }

      await new Promise(r => setTimeout(r, delay))
    }
  }
  throw lastError
}

// ─── defineTool ───

export function defineTool(optionsOrFn) {
  // schema-first: defineTool({ name, description, schema, execute })
  if (optionsOrFn && typeof optionsOrFn === 'object' && !('prototype' in optionsOrFn && typeof optionsOrFn === 'function')) {
    if (typeof optionsOrFn.execute === 'function') {
      const schema = optionsOrFn.schema ?? null
      const originalExecute = optionsOrFn.execute
      return {
        name: optionsOrFn.name,
        description: optionsOrFn.description ?? '',
        schema,
        execute: async (args) => {
          // Parse through Zod schema to apply defaults and validation
          let parsedArgs = args
          if (schema && schema.parse) {
            try {
              parsedArgs = schema.parse(args)
            } catch (e) {
              // If validation fails, pass original args
              parsedArgs = args
            }
          }
          return originalExecute(parsedArgs)
        },
        _type: 'schema-first',
      }
    }
  }

  // function-first: defineTool(async function name(arg1, arg2) { ... })
  if (typeof optionsOrFn === 'function') {
    const fn = optionsOrFn
    return {
      name: fn.name || 'anonymous',
      description: '',
      schema: null,
      execute: async (args) => {
        // function-first args are positional, but agent calls with object
        // Convert object args to positional args
        if (args && typeof args === 'object' && !Array.isArray(args)) {
          const paramNames = extractParamNames(fn)
          const positional = paramNames.map(n => args[n])
          return fn(...positional)
        }
        return fn(args)
      },
      _type: 'function-first',
    }
  }

  throw new Error('defineTool: invalid arguments')
}

function extractParamNames(fn) {
  const src = fn.toString()
  const match = src.match(/(?:async\s+)?function\s*\w*\s*\(([^)]*)\)/)
    || src.match(/\(([^)]*)\)\s*=>/)
  if (!match) return []
  return match[1]
    .split(',')
    .map(p => p.replace(/\/\*.*?\*\//g, '').replace(/=.*$/, '').trim())
    .filter(Boolean)
}


// ─── createAI ───

export function createAI(options) {
  const provider = options.provider
  if (!provider) {
    throw new Error('createAI: provider is required')
  }
  const defaults = options.defaults || {}
  const hooks = new Map()
  const middlewares = []

  function on(event, handler) {
    if (!hooks.has(event)) hooks.set(event, [])
    hooks.get(event).push({ handler, once: false })
  }

  function once(event, handler) {
    if (!hooks.has(event)) hooks.set(event, [])
    hooks.get(event).push({ handler, once: true })
  }

  function off(event, handler) {
    const list = hooks.get(event)
    if (!list) return
    const idx = list.findIndex(h => h.handler === handler)
    if (idx !== -1) list.splice(idx, 1)
  }

  function emit(event, data) {
    const list = hooks.get(event)
    if (!list) return
    const toRemove = []
    for (let i = 0; i < list.length; i++) {
      try { list[i].handler(data) } catch {}
      if (list[i].once) toRemove.push(i)
    }
    for (let i = toRemove.length - 1; i >= 0; i--) list.splice(toRemove[i], 1)
  }

  /**
   * Add middleware. Middleware runs before each request.
   * @example
   * ai.use(async (ctx, next) => {
   *   // Before request: modify ctx.request
   *   ctx.request.messages.unshift({ role: 'system', content: 'Be helpful' })
   *
   *   await next()  // Execute the request
   *
   *   // After request: ctx.response is available
   *   console.log('Response:', ctx.response.text)
   * })
   */
  function use(mw) {
    middlewares.push(mw)
  }

  async function runMiddlewares(ctx, coreFn) {
    let idx = 0
    const next = async (modifiedCtx) => {
      const currentCtx = modifiedCtx || ctx
      if (idx < middlewares.length) {
        const mw = middlewares[idx++]
        return await mw(currentCtx, next)
      } else if (coreFn) {
        // Execute core function after all middlewares
        const result = await coreFn(currentCtx)
        ctx.response = result
        return result
      }
    }
    return await next()
  }

  /**
   * Create a new AI instance with modified defaults.
   * @example
   * const adminAI = ai.extend({ maxTokens: 8000 })
   * const userAI = ai.extend({ maxTokens: 1000 })
   */
  function extend(newDefaults) {
    const merged = { ...defaults, ...newDefaults }
    const child = createAI({ provider, defaults: merged })
    // Copy hooks and middlewares (preserve once flag)
    for (const [event, handlers] of hooks) {
      for (const h of handlers) {
        if (h.once) {
          child.once(event, h.handler)
        } else {
          child.on(event, h.handler)
        }
      }
    }
    for (const mw of middlewares) {
      child.use(mw)
    }
    return child
  }

  async function chat(input) {
    let request
    if (typeof input === 'string') {
      request = { messages: [{ role: 'user', content: input }] }
    } else {
      request = input
    }

    // Apply defaults (e.g., maxTokens from extend())
    if (defaults.maxTokens && !request.maxTokens) {
      request.maxTokens = defaults.maxTokens
    }

    const ctx = { request, model: provider.defaultModel || provider.name, response: undefined }
    emit('request:before', ctx)

    // Core function that actually calls the provider
    const coreFn = async () => {
      const req = ctx.request
      const effectiveProvider = provider

      // Tool loop: if tools are provided, handle tool calls
      if (req.tools && req.tools.length > 0) {
        const tools = req.tools
        const toolMap = new Map()
        for (const t of tools) toolMap.set(t.name, t)

        let messages = [...(req.messages || [])]
        let maxIter = 10
        let lastResult

        while (maxIter-- > 0) {
          const chatReq = { ...req, messages }
          lastResult = await effectiveProvider.chat(chatReq)

          if (lastResult.toolCalls && lastResult.toolCalls.length > 0) {
            // Execute tool calls
            const toolResults = []
            const parallel = req.parallel === true

            if (parallel) {
              const results = await Promise.all(lastResult.toolCalls.map(async (tc) => {
                const tool = toolMap.get(tc.name)
                if (tool) {
                  emit('tool:call', { tool: tc.name, callId: tc.callId })
                  const start = Date.now()
                  const result = await tool.execute(tc.args)
                  emit('tool:result', { tool: tc.name, latency: Date.now() - start })
                  return { name: tc.name, callId: tc.callId, result }
                }
                return null
              }))
              for (const r of results) { if (r) toolResults.push(r) }
            } else {
              for (const tc of lastResult.toolCalls) {
                const tool = toolMap.get(tc.name)
                if (tool) {
                  emit('tool:call', { tool: tc.name, callId: tc.callId })
                  const start = Date.now()
                  const result = await tool.execute(tc.args)
                  emit('tool:result', { tool: tc.name, latency: Date.now() - start })
                  toolResults.push({ name: tc.name, callId: tc.callId, result })
                }
              }
            }

            // Add tool results to messages and continue
            messages.push({
              role: 'assistant',
              content: '',
              toolCalls: lastResult.toolCalls,
              ...(lastResult.reasoningContent ? {
                reasoningContent: lastResult.reasoningContent,
                reasoning_content: lastResult.reasoningContent,
              } : {}),
            })
            for (const tr of toolResults) {
              messages.push({ role: 'tool', name: tr.name, callId: tr.callId, content: JSON.stringify(tr.result) })
            }
            continue
          }

          // No tool calls, we're done
          break
        }

        return lastResult
      }

      // No tools, simple chat
      return await effectiveProvider.chat(req)
    }

    // Run middlewares with core function
    const result = await runMiddlewares(ctx, coreFn)

    // If middleware returned a result, use it; otherwise use ctx.response
    const finalResult = result !== undefined ? result : ctx.response
    emit('response:after', { ...ctx, response: finalResult })
    return finalResult
  }

  function stream(prompt, streamOptions) {
    let req = typeof prompt === 'string'
      ? { messages: [{ role: 'user', content: prompt }] }
      : prompt

    // Apply defaults (e.g., maxTokens from extend())
    if (defaults.maxTokens && !req.maxTokens) {
      req = { ...req, maxTokens: defaults.maxTokens }
    }

    emit('request:before', { request: req, model: options.model, type: 'stream' })

    // Internal state: collect all chunks and usage
    const allChunks = []
    let collectedUsage = null
    let consumed = false
    let fullText = ''

    // Consume provider stream once, cache results
    async function* consumeStream() {
      if (!provider.stream) return
      for await (const chunk of provider.stream(req)) {
        // Collect usage info from chunk
        if (chunk.type === 'usage' && chunk.usage) {
          collectedUsage = chunk.usage
          continue // Don't yield usage chunk to user
        }
        const delta = chunk.delta || ''
        fullText += delta
        allChunks.push(chunk)
        yield chunk
      }
      consumed = true
      // Emit stream:finish event with usage
      emit('stream:finish', { text: fullText, usage: collectedUsage, request: req, model: options.model })
      emit('response:after', { request: req, response: { text: fullText, usage: collectedUsage }, model: options.model, type: 'stream' })
    }

    const rawIterator = consumeStream()

    const result = {
      // Default iterator: yield { delta, type } objects
      [Symbol.asyncIterator]() {
        return rawIterator
      },

      // textStream: yield plain text strings
      get textStream() {
        const self = this
        return {
          async *[Symbol.asyncIterator]() {
            for await (const chunk of self) {
              const text = chunk.delta || ''
              if (text) yield text
            }
          }
        }
      },

      // final(): returns full text and usage
      async final() {
        // Drain stream if not consumed yet
        if (!consumed) {
          for await (const _ of rawIterator) { /* drain */ }
        }
        return {
          text: fullText,
          usage: collectedUsage,
        }
      },

      // text Promise: returns full text after stream ends
      get text() {
        return (async () => {
          if (!consumed) {
            for await (const _ of rawIterator) { /* drain */ }
          }
          return fullText
        })()
      },

      // usage Promise: returns token usage after stream ends
      get usage() {
        return (async () => {
          if (!consumed) {
            for await (const _ of rawIterator) { /* drain */ }
          }
          return collectedUsage
        })()
      },

      // pipeToSSE: Node.js SSE output (uses cached stream)
      async pipeToSSE(res) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          'connection': 'keep-alive',
        })
        if (!provider.stream) { res.end(); return }
        // Use cached chunks if already consumed, otherwise consume stream
        if (consumed) {
          for (const chunk of allChunks) {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`)
          }
        } else {
          for await (const chunk of rawIterator) {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`)
          }
        }
        res.end()
      },

      // toReadableStream: Web Streams API (uses cached stream)
      toReadableStream() {
        const self = this
        return new ReadableStream({
          async start(controller) {
            if (!provider.stream) { controller.close(); return }
            // Use cached chunks if already consumed, otherwise consume stream
            if (consumed) {
              for (const chunk of allChunks) {
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`))
              }
            } else {
              for await (const chunk of self) {
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`))
              }
            }
            controller.close()
          }
        })
      },
    }

    return result
  }

  function conversation(convOptions = {}) {
    const messages = []
    const id = convOptions.id || `conv_${Date.now()}`
    const systemPrompt = convOptions.system || null
    let totalUsage = { input: 0, output: 0, total: 0 }

    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt })
    }

    return {
      id,
      messages,
      get totalUsage() { return { ...totalUsage } },

      async send(prompt) {
        messages.push({ role: 'user', content: prompt })
        const result = await chat({ messages: [...messages] })
        messages.push({ role: 'assistant', content: result.text })
        if (result.usage) {
          totalUsage.input += result.usage.input || 0
          totalUsage.output += result.usage.output || 0
          totalUsage.total += result.usage.total || 0
        }
        return result
      },

      stream(prompt) {
        messages.push({ role: 'user', content: prompt })
        const result = stream({ messages: [...messages] })
        // Capture assistant response after stream ends
        result.text.then(text => {
          messages.push({ role: 'assistant', content: text })
        })
        result.usage.then(usage => {
          if (usage) {
            totalUsage.input += usage.input || 0
            totalUsage.output += usage.output || 0
            totalUsage.total += usage.total || 0
          }
        })
        return result
      },

      addMessage(msg) {
        messages.push(msg)
      },

      getMessages() {
        return [...messages]
      },

      clear() {
        messages.length = 0
        totalUsage = { input: 0, output: 0, total: 0 }
        if (systemPrompt) {
          messages.push({ role: 'system', content: systemPrompt })
        }
      },
    }
  }

  function agent(agentOptions) {
    const tools = agentOptions.tools || []
    const maxSteps = agentOptions.maxSteps || 20
    const onStep = agentOptions.onStep
    const onFinish = agentOptions.onFinish || null
    const stopWhen = agentOptions.stopWhen || (() => false)
    const parallelToolCalls = agentOptions.parallelToolCalls === true || agentOptions.parallel === true
    const toolChoice = agentOptions.toolChoice || 'auto'
    const retryOptions = agentOptions.retry || null
    const signal = agentOptions.signal || null
    const requestOptions = agentOptions.request && typeof agentOptions.request === 'object'
      ? agentOptions.request
      : {}

    const toolMap = new Map()
    for (const t of tools) toolMap.set(t.name, t)

    const baseMessages = []
    if (agentOptions.system) {
      baseMessages.push({ role: 'system', content: agentOptions.system })
    }
    if (Array.isArray(agentOptions.messages) && agentOptions.messages.length > 0) {
      baseMessages.push(...agentOptions.messages)
    }

    const runChatWithRetry = async (chatReq) => {
      const invoke = () => provider.chat(chatReq, signal)
      if (!retryOptions) return await invoke()
      return await withRetry(invoke, {
        maxRetries: retryOptions.maxRetries ?? 3,
        backoff: retryOptions.backoff ?? 'exponential',
        initialDelay: retryOptions.initialDelay ?? 1000,
        onRetry: retryOptions.onRetry,
        retryOn: retryOptions.retryOn,
      })
    }

    return {
      async run(prompt = '') {
        let messages = [...baseMessages, { role: 'user', content: prompt }]
        let stepCount = 0
        let lastText = ''
        let totalUsage = { input: 0, output: 0, total: 0 }
        const trace = []
        const steps = []
        let aborted = false

        while (stepCount < maxSteps && !aborted) {
          stepCount++
          const chatReq = { ...requestOptions, messages, tools, toolChoice }
          if (chatReq.parallel === undefined) chatReq.parallel = parallelToolCalls
          const result = await runChatWithRetry(chatReq)

          if (result.usage) {
            totalUsage.input += result.usage.input || 0
            totalUsage.output += result.usage.output || 0
            totalUsage.total += result.usage.total || 0
          }

          trace.push({ step: stepCount, type: result.toolCalls ? 'tool_call' : 'text', result })

          if (result.toolCalls && result.toolCalls.length > 0) {
            messages.push({
              role: 'assistant',
              content: result.text || '',
              toolCalls: result.toolCalls,
              ...(result.reasoningContent ? {
                reasoningContent: result.reasoningContent,
                reasoning_content: result.reasoningContent,
              } : {}),
            })

            const preparedCalls = []
            for (const tc of result.toolCalls) {
              const stepInfo = {
                type: 'tool_call',
                step: stepCount,
                index: stepCount,
                tool: tc.name,
                args: tc.args,
                result: null,
              }

              if (onStep) {
                const control = {
                  continue: () => ({ action: 'continue' }),
                  abort: (reason) => ({ action: 'abort', reason }),
                  modify: (changes) => ({ action: 'modify', changes }),
                }
                const decision = await onStep(stepInfo, control)
                if (decision && decision.action === 'abort') {
                  aborted = true
                  lastText = result.text || `Aborted: ${decision.reason || 'by onStep'}`
                  stepInfo.result = { aborted: true, reason: decision.reason || 'by onStep' }
                  stepInfo.usage = result.usage || null
                  stepInfo.latency = 0
                  steps.push(stepInfo)
                  break
                }
                if (decision && decision.action === 'modify' && decision.changes && decision.changes.args) {
                  tc.args = decision.changes.args
                  stepInfo.args = tc.args
                }
              }

              if (!aborted) preparedCalls.push({ tc, stepInfo })
            }

            if (aborted) break

            const executeOne = async ({ tc, stepInfo }) => {
              const tool = toolMap.get(tc.name)
              const start = Date.now()
              let payload

              if (!tool) {
                payload = { error: `Tool "${tc.name}" not found` }
              } else {
                try {
                  payload = await tool.execute(tc.args)
                } catch (err) {
                  payload = { error: String(err?.message || err) }
                }
              }

              stepInfo.result = payload
              stepInfo.latency = Date.now() - start
              stepInfo.usage = result.usage || null

              return {
                stepInfo,
                toolMessage: {
                  role: 'tool',
                  name: tc.name,
                  callId: tc.callId,
                  content: JSON.stringify(payload),
                },
              }
            }

            const executeParallel = chatReq.parallel === true && preparedCalls.length > 1
            let executed = []
            if (executeParallel) {
              executed = await Promise.all(preparedCalls.map(executeOne))
            } else {
              for (const item of preparedCalls) {
                executed.push(await executeOne(item))
              }
            }

            for (const item of executed) {
              steps.push(item.stepInfo)
              messages.push(item.toolMessage)
            }

            if (stopWhen({ usage: totalUsage, steps })) break
            continue
          }

          lastText = result.text || ''
          const textStep = {
            type: 'text',
            step: stepCount,
            text: lastText,
            usage: result.usage || null,
          }
          steps.push(textStep)
          messages.push({
            role: 'assistant',
            content: lastText,
            ...(result.reasoningContent ? {
              reasoningContent: result.reasoningContent,
              reasoning_content: result.reasoningContent,
            } : {}),
          })

          if (stopWhen({ usage: totalUsage, steps })) break
          break
        }

        const out = { text: lastText, usage: totalUsage, trace, steps }
        if (onFinish) {
          try { onFinish(out) } catch {}
        }
        return out
      },

      async *stream(prompt = '') {
        let messages = [...baseMessages, { role: 'user', content: prompt }]
        let stepCount = 0
        let lastText = ''
        let totalUsage = { input: 0, output: 0, total: 0 }
        let aborted = false
        const steps = []

        while (stepCount < maxSteps && !aborted) {
          stepCount++
          yield { type: 'step-start', step: stepCount }

          const chatReq = { ...requestOptions, messages, tools, toolChoice }
          if (chatReq.parallel === undefined) chatReq.parallel = parallelToolCalls
          const result = await runChatWithRetry(chatReq)

          if (result.usage) {
            totalUsage.input += result.usage.input || 0
            totalUsage.output += result.usage.output || 0
            totalUsage.total += result.usage.total || 0
          }

          if (result.toolCalls && result.toolCalls.length > 0) {
            messages.push({
              role: 'assistant',
              content: result.text || '',
              toolCalls: result.toolCalls,
              ...(result.reasoningContent ? {
                reasoningContent: result.reasoningContent,
                reasoning_content: result.reasoningContent,
              } : {}),
            })

            const preparedCalls = []
            for (const tc of result.toolCalls) {
              const stepInfo = {
                type: 'tool_call',
                tool: tc.name,
                args: tc.args,
                step: stepCount,
                index: stepCount,
              }
              yield { type: 'tool-call', step: stepCount, tool: tc.name, args: tc.args }

              if (onStep) {
                const control = {
                  continue: () => ({ action: 'continue' }),
                  abort: (reason) => ({ action: 'abort', reason }),
                  modify: (changes) => ({ action: 'modify', changes }),
                }
                const decision = await onStep(stepInfo, control)
                if (decision && decision.action === 'abort') {
                  aborted = true
                  yield { type: 'aborted', reason: decision.reason }
                  break
                }
                if (decision && decision.action === 'modify' && decision.changes && decision.changes.args) {
                  tc.args = decision.changes.args
                  stepInfo.args = tc.args
                }
              }

              if (!aborted) preparedCalls.push({ tc, stepInfo })
            }

            if (aborted) break

            const executeOne = async ({ tc, stepInfo }) => {
              const tool = toolMap.get(tc.name)
              const start = Date.now()
              let payload

              if (!tool) {
                payload = { error: `Tool "${tc.name}" not found` }
              } else {
                try {
                  payload = await tool.execute(tc.args)
                } catch (err) {
                  payload = { error: String(err?.message || err) }
                }
              }

              const latency = Date.now() - start
              messages.push({ role: 'tool', name: tc.name, callId: tc.callId, content: JSON.stringify(payload) })
              return { stepInfo: { ...stepInfo, result: payload, latency, usage: result.usage || null }, payload, latency }
            }

            const executeParallel = chatReq.parallel === true && preparedCalls.length > 1
            let executed = []
            if (executeParallel) {
              executed = await Promise.all(preparedCalls.map(executeOne))
            } else {
              for (const item of preparedCalls) {
                executed.push(await executeOne(item))
              }
            }

            for (const item of executed) {
              steps.push(item.stepInfo)
              yield { type: 'tool-result', step: stepCount, tool: item.stepInfo.tool, result: item.payload, latency: item.latency }
            }

            yield { type: 'step-complete', step: stepCount }
            if (stopWhen({ usage: totalUsage, steps })) break
            continue
          }

          lastText = result.text || ''
          messages.push({
            role: 'assistant',
            content: lastText,
            ...(result.reasoningContent ? {
              reasoningContent: result.reasoningContent,
              reasoning_content: result.reasoningContent,
            } : {}),
          })

          for (const char of lastText) {
            yield { type: 'text-delta', delta: char }
          }

          const textStep = { type: 'text', step: stepCount, text: lastText, usage: result.usage || null }
          steps.push(textStep)
          yield { type: 'step-complete', step: stepCount, text: lastText }

          if (stopWhen({ usage: totalUsage, steps })) break
          break
        }

        const finishPayload = { type: 'finish', text: lastText, usage: totalUsage, steps }
        yield finishPayload
        if (onFinish) {
          try { onFinish({ text: lastText, usage: totalUsage, steps, trace: steps }) } catch {}
        }
      },
    }
  }

  return { chat, stream, conversation, agent, on, once, off, use, extend, provider, defaults }
}


// ─── Orchestration Primitives ───

export function createFallback(providers, options = {}) {
  const onFallback = options.onFallback || null
  return {
    name: 'fallback',
    async chat(req) {
      let lastErr
      for (let i = 0; i < providers.length; i++) {
        const p = providers[i]
        try {
          return await p.chat(req)
        } catch (e) {
          lastErr = e
          if (onFallback && i < providers.length - 1) {
            try { onFallback(e, i + 1) } catch {}
          }
        }
      }
      throw lastErr || new Error('All providers failed')
    },
    async *stream(req) {
      let lastErr
      for (let i = 0; i < providers.length; i++) {
        const p = providers[i]
        if (!p.stream) continue
        try {
          // Try to yield from this provider's stream
          const iterator = p.stream(req)
          let hasYielded = false
          for await (const chunk of iterator) {
            hasYielded = true
            yield chunk
          }
          // If we got here without error, we're done
          if (hasYielded) return
        } catch (e) {
          lastErr = e
          if (onFallback && i < providers.length - 1) {
            try { onFallback(e, i + 1) } catch {}
          }
          // Continue to next provider
        }
      }
      if (lastErr) throw lastErr
    },
  }
}

export function createRace(providers) {
  return {
    name: 'race',
    async chat(req) {
      // Race for first successful result, not first to settle
      // If one fails quickly, we still wait for others
      return new Promise((resolve, reject) => {
        let pending = providers.length
        let resolved = false
        const errors = []

        providers.forEach((p, i) => {
          p.chat(req)
            .then(result => {
              if (!resolved) {
                resolved = true
                resolve(result)
              }
            })
            .catch(err => {
              errors[i] = err
              pending--
              if (pending === 0 && !resolved) {
                // All failed, reject with first error
                reject(errors.find(e => e) || new Error('All providers failed'))
              }
            })
        })
      })
    },
    async *stream(req) {
      // Use first provider for stream
      const p = providers[0]
      if (p && p.stream) yield* p.stream(req)
    },
  }
}

export function createFanOut(providers, options) {
  const pick = options?.pick || null
  return {
    name: 'fanout',
    async chat(req) {
      const results = await Promise.all(
        providers.map(p => p.chat(req))
      )
      // If pick is provided, use it to select one result
      // Otherwise return all results as array
      return pick ? pick(results) : results
    },
    async *stream(req) {
      const p = providers[0]
      if (p && p.stream) yield* p.stream(req)
    },
  }
}

/**
 * createPool — Load balancing across multiple providers
 *
 * Usage:
 *   const pool = createPool([provider1, provider2, provider3], {
 *     strategy: 'round-robin', // or 'random', 'least-latency'
 *   })
 */
export function createPool(providers, options = {}) {
  const strategy = options.strategy || 'round-robin'
  let index = 0
  const latencies = new Map() // For least-latency strategy

  function selectProvider() {
    if (providers.length === 0) throw new Error('createPool: no providers')
    if (providers.length === 1) return providers[0]

    if (strategy === 'random') {
      return providers[Math.floor(Math.random() * providers.length)]
    }

    if (strategy === 'least-latency') {
      // Find provider with lowest average latency
      let best = providers[0]
      let bestLatency = Infinity

      for (const p of providers) {
        const stats = latencies.get(p)
        const avg = stats ? stats.total / stats.count : 0
        if (avg < bestLatency) {
          bestLatency = avg
          best = p
        }
      }
      return best
    }

    // Default: round-robin
    const p = providers[index % providers.length]
    index++
    return p
  }

  function recordLatency(provider, ms) {
    if (!latencies.has(provider)) {
      latencies.set(provider, { total: 0, count: 0 })
    }
    const stats = latencies.get(provider)
    stats.total += ms
    stats.count++
  }

  return {
    name: 'pool',
    providers,
    strategy,

    async chat(req) {
      const provider = selectProvider()
      const start = Date.now()
      try {
        const result = await provider.chat(req)
        recordLatency(provider, Date.now() - start)
        return result
      } catch (err) {
        recordLatency(provider, Date.now() - start)
        throw err
      }
    },

    async *stream(req) {
      const provider = selectProvider()
      if (provider.stream) {
        yield* provider.stream(req)
      }
    },

    getStats() {
      const stats = {}
      for (const p of providers) {
        const name = p.name || `provider_${providers.indexOf(p)}`
        const data = latencies.get(p)
        stats[name] = data ? {
          avgLatency: data.total / data.count,
          requests: data.count,
        } : { avgLatency: 0, requests: 0 }
      }
      return stats
    },

    reset() {
      index = 0
      latencies.clear()
    },
  }
}

export function createPipeline(stages) {
  return {
    name: 'pipeline',
    async chat(req) {
      let currentReq = req
      let lastResult = null

      for (const stage of stages) {
        // Apply transform before calling provider if provided
        if (stage.transform) {
          currentReq = stage.transform(currentReq, lastResult)
        }

        lastResult = await stage.provider.chat(currentReq)
      }

      return lastResult
    },
    async *stream(req) {
      const p = stages[0]?.provider
      if (p && p.stream) yield* p.stream(req)
    },
  }
}

export function createRouter(routes) {
  return {
    name: 'router',
    async chat(req) {
      for (const route of routes) {
        // Support both sync and async match functions
        const matched = await Promise.resolve(route.match(req))
        if (matched) {
          return route.provider.chat(req)
        }
      }
      throw new Error('No route matched')
    },
    async *stream(req) {
      for (const route of routes) {
        const matched = await Promise.resolve(route.match(req))
        if (matched) {
          if (route.provider.stream) yield* route.provider.stream(req)
          return
        }
      }
      throw new Error('No route matched')
    },
  }
}

// ─── Top-level convenience functions (Vercel AI SDK style) ───

/**
 * streamText — One-shot streaming text generation
 * Usage:
 *   const result = await streamText({ model: provider, messages: [...] })
 *   for await (const text of result.textStream) { process.stdout.write(text) }
 *   const final = await result.usage
 */
export function streamText(options) {
  const provider = options.model || options.provider
  if (!provider) throw new Error('streamText: model (provider) is required')

  const messages = [...(options.messages || [])]
  if (options.prompt) {
    messages.push({ role: 'user', content: options.prompt })
  }
  if (options.system) {
    messages.unshift({ role: 'system', content: options.system })
  }

  const onChunk = options.onChunk || null
  const onFinish = options.onFinish || null
  const signal = options.signal || null

  // Support per-request model override and maxTokens
  const req = { messages }
  if (options.modelId) req.model = options.modelId
  if (options.maxTokens) req.maxTokens = options.maxTokens

  // Internal state
  let fullText = ''
  let collectedUsage = null
  let consumed = false

  async function* consumeStream() {
    if (!provider.stream) return
    for await (const chunk of provider.stream(req, signal)) {
      if (chunk.type === 'usage' && chunk.usage) {
        collectedUsage = chunk.usage
        continue
      }
      const delta = chunk.delta || ''
      fullText += delta
      if (onChunk) {
        try { onChunk({ delta, text: fullText }) } catch {}
      }
      yield chunk
    }
    consumed = true
    if (onFinish) {
      try { onFinish({ text: fullText, usage: collectedUsage }) } catch {}
    }
  }

  const rawIterator = consumeStream()

  const result = {
    [Symbol.asyncIterator]() {
      return rawIterator
    },

    get textStream() {
      const self = this
      return {
        async *[Symbol.asyncIterator]() {
          for await (const chunk of self) {
            const text = chunk.delta || ''
            if (text) yield text
          }
        }
      }
    },

    get text() {
      return (async () => {
        if (!consumed) {
          for await (const _ of rawIterator) { /* drain */ }
        }
        return fullText
      })()
    },

    get usage() {
      return (async () => {
        if (!consumed) {
          for await (const _ of rawIterator) { /* drain */ }
        }
        return collectedUsage
      })()
    },

    async final() {
      if (!consumed) {
        for await (const _ of rawIterator) { /* drain */ }
      }
      return { text: fullText, usage: collectedUsage }
    },

    toReadableStream() {
      const self = this
      return new ReadableStream({
        async start(controller) {
          try {
            for await (const chunk of self) {
              const text = chunk.delta || ''
              if (text) {
                controller.enqueue(new TextEncoder().encode(text))
              }
            }
            controller.close()
          } catch (err) {
            controller.error(err)
          }
        }
      })
    },

    // pipeToSSE: Node.js SSE output
    async pipeToSSE(res) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'connection': 'keep-alive',
      })
      try {
        for await (const chunk of this) {
          res.write(`data: ${JSON.stringify(chunk)}\n\n`)
        }
      } finally {
        res.end()
      }
    },
  }

  return result
}

/**
 * generateText — One-shot non-streaming text generation
 * Usage:
 *   const { text, usage } = await generateText({ model: provider, messages: [...] })
 *
 * With auto-retry:
 *   const { text } = await generateText({
 *     model: provider,
 *     prompt: 'Hi',
 *     retry: { maxRetries: 3, backoff: 'exponential' }
 *   })
 */
export async function generateText(options) {
  const provider = options.model || options.provider
  if (!provider) throw new Error('generateText: model (provider) is required')

  const messages = [...(options.messages || [])]
  if (options.prompt) {
    messages.push({ role: 'user', content: options.prompt })
  }
  if (options.system) {
    messages.unshift({ role: 'system', content: options.system })
  }

  const signal = options.signal || null
  const req = { messages }
  if (options.maxTokens) req.maxTokens = options.maxTokens

  // Support auto-retry
  if (options.retry) {
    return withRetry(
      () => provider.chat(req, signal),
      {
        maxRetries: options.retry.maxRetries ?? 3,
        backoff: options.retry.backoff ?? 'exponential',
        initialDelay: options.retry.initialDelay ?? 1000,
        onRetry: options.retry.onRetry,
      }
    )
  }

  const result = await provider.chat(req, signal)
  return result
}

// ─── Top-level Agent function ───

/**
 * agent — Create and run an Agent
 * Usage:
 *   const result = await agent({
 *     model: provider,
 *     tools: [searchTool, writeTool],
 *     prompt: 'Search for X and save to file',
 *     maxSteps: 10,
 *   })
 *   console.log(result.text)       // Final text
 *   console.log(result.steps)      // Step details
 *   console.log(result.usage)      // Total token usage
 */
export async function agent(options) {
  const provider = options.model || options.provider
  if (!provider) throw new Error('agent: model (provider) is required')
  const {
    model: _model,
    provider: _provider,
    prompt = '',
    ...agentOptions
  } = options

  const ai = createAI({ provider })
  const instance = ai.agent(agentOptions)
  return await instance.run(prompt)
}

/**
 * generateObject — Generate structured JSON output with Zod schema validation
 * @example
 * const { data } = await generateObject({
 *   model: provider,
 *   prompt: 'Generate a user profile',
 *   schema: z.object({
 *     name: z.string(),
 *     score: z.number(),
 *     tags: z.array(z.string()),
 *   }),
 * })
 * // data is typed as { name: string, score: number, tags: string[] }
 */
export async function generateObject(options) {
  const provider = options.model || options.provider
  if (!provider) throw new Error('generateObject: model (provider) is required')
  if (!options.schema) throw new Error('generateObject: schema is required')

  const messages = [...(options.messages || [])]
  if (options.system) {
    messages.unshift({ role: 'system', content: options.system })
  }

  // Build JSON schema from Zod
  let jsonSchema
  if (options.schema._def) {
    // It's a Zod schema, convert to JSON schema
    jsonSchema = zodToJsonSchema(options.schema)
  } else {
    // Assume it's already a JSON schema
    jsonSchema = options.schema
  }

  const prompt = options.prompt || ''
  if (prompt) {
    messages.push({
      role: 'user',
      content: `${prompt}\n\nRespond with valid JSON matching this schema:\n${JSON.stringify(jsonSchema, null, 2)}`
    })
  }

  const req = {
    messages,
    responseFormat: { type: 'json_object' },
  }

  const result = await provider.chat(req)

  // Parse and validate the response
  let data
  try {
    // Strip markdown code blocks if present (e.g., ```json ... ```)
    let jsonText = result.text.trim()
    const codeBlockMatch = jsonText.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
    if (codeBlockMatch) {
      jsonText = codeBlockMatch[1].trim()
    }
    data = JSON.parse(jsonText)
  } catch {
    throw new Error(`generateObject: Failed to parse JSON response: ${result.text}`)
  }

  // Validate with Zod if provided
  if (options.schema.parse) {
    try {
      data = options.schema.parse(data)
    } catch (err) {
      throw new Error(`generateObject: Schema validation failed: ${err.message}`)
    }
  }

  return { data, usage: result.usage, raw: result }
}

// Simple Zod to JSON Schema converter (basic types)
function zodToJsonSchema(zodSchema) {
  const def = zodSchema._def
  if (!def) return { type: 'object' }

  const typeName = def.typeName

  if (typeName === 'ZodString') return { type: 'string' }
  if (typeName === 'ZodNumber') return { type: 'number' }
  if (typeName === 'ZodBoolean') return { type: 'boolean' }
  if (typeName === 'ZodArray') {
    return { type: 'array', items: zodToJsonSchema(def.type) }
  }
  if (typeName === 'ZodObject') {
    const shape = def.shape?.() || def.shape || {}
    const properties = {}
    const required = []
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value)
      // ZodOptional 不加到 required
      if (value?._def?.typeName !== 'ZodOptional') {
        required.push(key)
      }
    }
    const result = { type: 'object', properties }
    if (required.length > 0) result.required = required
    return result
  }
  if (typeName === 'ZodOptional') {
    return zodToJsonSchema(def.innerType)
  }
  if (typeName === 'ZodDefault') {
    return zodToJsonSchema(def.innerType)
  }
  if (typeName === 'ZodEnum') {
    return { type: 'string', enum: def.values }
  }
  if (typeName === 'ZodLiteral') {
    return { type: typeof def.value, enum: [def.value] }
  }
  if (typeName === 'ZodUnion') {
    return { oneOf: (def.options || []).map(o => zodToJsonSchema(o)) }
  }
  if (typeName === 'ZodNullable') {
    const inner = zodToJsonSchema(def.innerType)
    return { ...inner, nullable: true }
  }
  // Fallback
  return { type: 'object' }
}

// ─── Metrics & Observability ───

/**
 * createMetrics — Create a metrics collector for observability
 *
 * Usage:
 *   const metrics = createMetrics()
 *   const ai = createAI({ provider })
 *   metrics.attach(ai)
 *
 *   // After some requests...
 *   console.log(metrics.getStats())
 *   // { requests: 10, success: 9, errors: 1, avgLatency: 1234, tokens: { input: 5000, output: 2000 } }
 *
 * With thresholds:
 *   metrics.onThreshold('latency', 5000, (stats) => {
 *     console.warn('High latency detected:', stats.avgLatency)
 *   })
 */
export function createMetrics(options = {}) {
  const windowSize = options.windowSize || 100 // Keep last N requests for percentiles

  // Core stats
  let requests = 0
  let success = 0
  let errors = 0
  let tokens = { input: 0, output: 0, total: 0 }

  // Latency tracking (sliding window for percentiles)
  const latencies = []
  let totalLatency = 0

  // Error breakdown
  const errorTypes = new Map()

  // Thresholds
  const thresholds = []

  // Request tracking (for latency calculation)
  const pendingRequests = new Map()

  function recordStart(requestId) {
    pendingRequests.set(requestId, Date.now())
  }

  function recordEnd(requestId, response, error) {
    const startTime = pendingRequests.get(requestId)
    pendingRequests.delete(requestId)

    requests++

    if (error) {
      errors++
      const errorName = error.name || 'UnknownError'
      errorTypes.set(errorName, (errorTypes.get(errorName) || 0) + 1)
    } else {
      success++

      // Track tokens
      if (response?.usage) {
        tokens.input += response.usage.input || 0
        tokens.output += response.usage.output || 0
        tokens.total += response.usage.total || 0
      }
    }

    // Track latency
    if (startTime) {
      const latency = Date.now() - startTime
      latencies.push(latency)
      totalLatency += latency

      // Keep sliding window
      if (latencies.length > windowSize) {
        totalLatency -= latencies.shift()
      }
    }

    // Check thresholds
    checkThresholds()
  }

  function checkThresholds() {
    const stats = getStats()
    for (const t of thresholds) {
      let value
      if (t.metric === 'latency') value = stats.avgLatency
      else if (t.metric === 'errorRate') value = stats.errorRate
      else if (t.metric === 'tokens') value = stats.tokens.total
      else if (t.metric === 'requests') value = stats.requests

      if (value !== undefined && value >= t.threshold) {
        try { t.callback(stats) } catch {}
      }
    }
  }

  function getStats() {
    const avgLatency = latencies.length > 0 ? Math.round(totalLatency / latencies.length) : 0
    const errorRate = requests > 0 ? errors / requests : 0

    // Calculate percentiles
    const sorted = [...latencies].sort((a, b) => a - b)
    const p50 = sorted[Math.floor(sorted.length * 0.5)] || 0
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0
    const p99 = sorted[Math.floor(sorted.length * 0.99)] || 0

    return {
      requests,
      success,
      errors,
      errorRate: Math.round(errorRate * 1000) / 1000,
      errorTypes: Object.fromEntries(errorTypes),
      tokens: { ...tokens },
      latency: {
        avg: avgLatency,
        p50,
        p95,
        p99,
        min: sorted[0] || 0,
        max: sorted[sorted.length - 1] || 0,
      },
      // Convenience aliases
      avgLatency,
    }
  }

  function reset() {
    requests = 0
    success = 0
    errors = 0
    tokens = { input: 0, output: 0, total: 0 }
    latencies.length = 0
    totalLatency = 0
    errorTypes.clear()
    pendingRequests.clear()
  }

  function onThreshold(metric, threshold, callback) {
    thresholds.push({ metric, threshold, callback })
    return () => {
      const idx = thresholds.findIndex(t => t.metric === metric && t.threshold === threshold && t.callback === callback)
      if (idx >= 0) thresholds.splice(idx, 1)
    }
  }

  function attach(ai) {
    let requestCounter = 0

    // Track request start
    ai.on('request:before', (ctx) => {
      ctx._metricsId = ++requestCounter
      recordStart(ctx._metricsId)
    })

    // Track request end
    ai.on('response:after', (ctx) => {
      recordEnd(ctx._metricsId, ctx.response, null)
    })

    // Use middleware to catch errors
    ai.use(async (ctx, next) => {
      try {
        return await next(ctx)
      } catch (err) {
        recordEnd(ctx._metricsId, null, err)
        throw err
      }
    })

    return ai
  }

  return {
    attach,
    getStats,
    reset,
    onThreshold,
    // Direct recording for custom integrations
    recordStart,
    recordEnd,
  }
}

// ─── Cost Estimation ───

/**
 * Default pricing per 1M tokens (USD) - updated 2024
 * Users can override with custom pricing
 */
const DEFAULT_PRICING = {
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4-turbo': { input: 10.00, output: 30.00 },
  'gpt-4': { input: 30.00, output: 60.00 },
  'gpt-3.5-turbo': { input: 0.50, output: 1.50 },
  'claude-3-opus': { input: 15.00, output: 75.00 },
  'claude-3-sonnet': { input: 3.00, output: 15.00 },
  'claude-3-haiku': { input: 0.25, output: 1.25 },
  'claude-3.5-sonnet': { input: 3.00, output: 15.00 },
  'claude-sonnet-4': { input: 3.00, output: 15.00 },
  'claude-sonnet-4-5': { input: 3.00, output: 15.00 },
  // Fallback for unknown models
  'default': { input: 1.00, output: 3.00 },
}

/**
 * createCostEstimator — Track and estimate API costs
 *
 * Usage:
 *   const cost = createCostEstimator()
 *   const ai = createAI({ provider })
 *   cost.attach(ai)
 *
 *   await ai.chat('Hello')
 *   console.log(cost.getTotal()) // { usd: 0.0023, breakdown: [...] }
 *
 * With custom pricing:
 *   const cost = createCostEstimator({
 *     pricing: {
 *       'my-model': { input: 1.00, output: 2.00 }
 *     }
 *   })
 */
export function createCostEstimator(options = {}) {
  const pricing = { ...DEFAULT_PRICING, ...options.pricing }
  const currency = options.currency || 'usd'

  // Cost tracking
  const requests = []
  let totalCost = 0

  function getModelPrice(modelName) {
    // Try exact match first
    if (pricing[modelName]) return pricing[modelName]

    // Try partial match (e.g., "gpt-4o-mini" matches "gpt-4o-mini")
    for (const [key, price] of Object.entries(pricing)) {
      if (modelName.includes(key) || key.includes(modelName)) {
        return price
      }
    }

    return pricing.default
  }

  function calculateCost(model, usage) {
    if (!usage) return 0

    const price = getModelPrice(model)
    const inputCost = (usage.input || 0) / 1_000_000 * price.input
    const outputCost = (usage.output || 0) / 1_000_000 * price.output

    return inputCost + outputCost
  }

  function record(model, usage) {
    const cost = calculateCost(model, usage)
    totalCost += cost

    requests.push({
      timestamp: Date.now(),
      model,
      usage: usage ? { ...usage } : null,
      cost,
    })

    return cost
  }

  function getTotal() {
    return {
      [currency]: Math.round(totalCost * 1_000_000) / 1_000_000, // 6 decimal places
      requests: requests.length,
      tokens: {
        input: requests.reduce((sum, r) => sum + (r.usage?.input || 0), 0),
        output: requests.reduce((sum, r) => sum + (r.usage?.output || 0), 0),
      },
      breakdown: requests.map(r => ({
        model: r.model,
        cost: Math.round(r.cost * 1_000_000) / 1_000_000,
        tokens: r.usage,
      })),
    }
  }

  function getEstimate(model, inputTokens, outputTokens) {
    const price = getModelPrice(model)
    const inputCost = inputTokens / 1_000_000 * price.input
    const outputCost = outputTokens / 1_000_000 * price.output
    return {
      [currency]: Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000,
      breakdown: {
        input: Math.round(inputCost * 1_000_000) / 1_000_000,
        output: Math.round(outputCost * 1_000_000) / 1_000_000,
      },
    }
  }

  function reset() {
    requests.length = 0
    totalCost = 0
  }

  function attach(ai) {
    ai.on('response:after', (ctx) => {
      const model = ctx.model || ctx.request?.model || 'default'
      record(model, ctx.response?.usage)
    })
    return ai
  }

  return {
    attach,
    record,
    getTotal,
    getEstimate,
    reset,
    // Expose pricing for inspection/modification
    pricing,
  }
}

// ─── Mock Provider for Testing ───

/**
 * createMockProvider — Create a mock provider for testing
 *
 * Usage:
 *   const mock = createMockProvider({
 *     responses: ['Hello!', 'How can I help?'],
 *   })
 *   const ai = createAI({ provider: mock })
 *   const { text } = await ai.chat('Hi') // Returns 'Hello!'
 *
 * With custom response function:
 *   const mock = createMockProvider({
 *     response: (messages) => `You said: ${messages[messages.length - 1].content}`
 *   })
 *
 * Simulating errors:
 *   const mock = createMockProvider({
 *     error: new RateLimitError('Too many requests', 5)
 *   })
 *
 * Simulating latency:
 *   const mock = createMockProvider({
 *     responses: ['Hello!'],
 *     latency: 1000, // 1 second delay
 *   })
 */
export function createMockProvider(options = {}) {
  const responses = options.responses || ['Mock response']
  const responseFn = options.response || null
  const errorToThrow = options.error || null
  const latency = options.latency || 0
  const usage = options.usage || { input: 10, output: 5, total: 15 }

  let callIndex = 0
  const calls = []

  async function chat(request) {
    // Record the call
    calls.push({
      type: 'chat',
      messages: request?.messages || [],
      timestamp: Date.now(),
    })

    // Simulate latency
    if (latency > 0) {
      await new Promise(r => setTimeout(r, latency))
    }

    // Throw error if configured
    if (errorToThrow) {
      throw errorToThrow
    }

    // Generate response
    let text
    if (responseFn) {
      text = await Promise.resolve(responseFn(request?.messages || []))
    } else {
      text = responses[callIndex % responses.length]
      callIndex++
    }

    return {
      text,
      usage: { ...usage },
      toolCalls: options.toolCalls || null,
    }
  }

  async function* stream(request) {
    // Record the call
    calls.push({
      type: 'stream',
      messages: request?.messages || [],
      timestamp: Date.now(),
    })

    // Simulate latency
    if (latency > 0) {
      await new Promise(r => setTimeout(r, latency))
    }

    // Throw error if configured
    if (errorToThrow) {
      throw errorToThrow
    }

    // Generate response
    let text
    if (responseFn) {
      text = await Promise.resolve(responseFn(request?.messages || []))
    } else {
      text = responses[callIndex % responses.length]
      callIndex++
    }

    // Stream character by character (or chunk by chunk)
    const chunkSize = options.chunkSize || 5
    for (let i = 0; i < text.length; i += chunkSize) {
      yield { type: 'delta', delta: text.slice(i, i + chunkSize) }
    }

    yield { type: 'usage', usage: { ...usage } }
  }

  function reset() {
    callIndex = 0
    calls.length = 0
  }

  function getCalls() {
    return [...calls]
  }

  function getLastCall() {
    return calls[calls.length - 1] || null
  }

  return {
    name: 'mock',
    defaultModel: 'mock-model',
    chat,
    stream,
    // Testing utilities
    reset,
    getCalls,
    getLastCall,
    calls, // Direct access for assertions
  }
}

// ─── Rate Limiter ───

/**
 * createRateLimiter — Control request rate to avoid API limits
 *
 * Usage:
 *   const limiter = createRateLimiter({
 *     requestsPerMinute: 60,  // Max 60 requests per minute
 *   })
 *   const ai = createAI({ provider })
 *   limiter.attach(ai)
 *
 * With token-based limiting:
 *   const limiter = createRateLimiter({
 *     tokensPerMinute: 100000,  // Max 100K tokens per minute
 *   })
 *
 * With both:
 *   const limiter = createRateLimiter({
 *     requestsPerMinute: 60,
 *     tokensPerMinute: 100000,
 *   })
 */
export function createRateLimiter(options = {}) {
  const rpm = options.requestsPerMinute || Infinity
  const tpm = options.tokensPerMinute || Infinity
  const windowMs = 60 * 1000 // 1 minute window

  // Sliding window tracking
  const requestTimestamps = []
  const tokenUsage = [] // { timestamp, tokens }

  // Queue for waiting requests
  const queue = []
  let processing = false

  function cleanOldEntries() {
    const cutoff = Date.now() - windowMs

    // Clean request timestamps
    while (requestTimestamps.length > 0 && requestTimestamps[0] < cutoff) {
      requestTimestamps.shift()
    }

    // Clean token usage
    while (tokenUsage.length > 0 && tokenUsage[0].timestamp < cutoff) {
      tokenUsage.shift()
    }
  }

  function getCurrentRequestCount() {
    cleanOldEntries()
    return requestTimestamps.length
  }

  function getCurrentTokenCount() {
    cleanOldEntries()
    return tokenUsage.reduce((sum, entry) => sum + entry.tokens, 0)
  }

  function getWaitTime() {
    cleanOldEntries()

    let waitTime = 0

    // Check request limit
    if (requestTimestamps.length >= rpm) {
      const oldestRequest = requestTimestamps[0]
      const requestWait = oldestRequest + windowMs - Date.now()
      waitTime = Math.max(waitTime, requestWait)
    }

    // Check token limit
    const currentTokens = getCurrentTokenCount()
    if (currentTokens >= tpm && tokenUsage.length > 0) {
      const oldestToken = tokenUsage[0].timestamp
      const tokenWait = oldestToken + windowMs - Date.now()
      waitTime = Math.max(waitTime, tokenWait)
    }

    return Math.max(0, waitTime)
  }

  async function acquire(estimatedTokens = 0) {
    return new Promise((resolve) => {
      queue.push({ resolve, estimatedTokens })
      processQueue()
    })
  }

  async function processQueue() {
    if (processing || queue.length === 0) return
    processing = true

    while (queue.length > 0) {
      const waitTime = getWaitTime()

      if (waitTime > 0) {
        await new Promise(r => setTimeout(r, waitTime))
      }

      const { resolve, estimatedTokens } = queue.shift()

      // Record this request
      requestTimestamps.push(Date.now())

      // Pre-record estimated tokens (will be updated with actual later)
      if (estimatedTokens > 0) {
        tokenUsage.push({ timestamp: Date.now(), tokens: estimatedTokens })
      }

      resolve()
    }

    processing = false
  }

  function recordTokens(tokens) {
    tokenUsage.push({ timestamp: Date.now(), tokens })
  }

  function getStats() {
    cleanOldEntries()
    return {
      requestsInWindow: requestTimestamps.length,
      tokensInWindow: getCurrentTokenCount(),
      requestLimit: rpm,
      tokenLimit: tpm,
      queueLength: queue.length,
    }
  }

  function attach(ai) {
    ai.use(async (ctx, next) => {
      // Estimate tokens from message length (rough estimate)
      const messages = ctx.request?.messages || []
      const estimatedInput = messages.reduce((sum, m) => {
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
        return sum + Math.ceil(content.length / 4)
      }, 0)

      // Wait for rate limit
      await acquire(estimatedInput)

      // Execute request
      const result = await next(ctx)

      // Record actual token usage
      if (result?.usage?.total) {
        recordTokens(result.usage.total)
      }

      return result
    })

    return ai
  }

  return {
    attach,
    acquire,
    recordTokens,
    getStats,
    getWaitTime,
  }
}

// ─── Response Cache ───

/**
 * createCache — Cache responses to avoid duplicate API calls
 *
 * Usage:
 *   const cache = createCache({ ttl: 60000 }) // 1 minute TTL
 *   const ai = createAI({ provider })
 *   cache.attach(ai)
 *
 *   await ai.chat('Hello') // API call
 *   await ai.chat('Hello') // Cache hit, no API call
 *
 * With custom key function:
 *   const cache = createCache({
 *     keyFn: (request) => JSON.stringify(request.messages)
 *   })
 *
 * With max size:
 *   const cache = createCache({
 *     maxSize: 100,  // Keep max 100 entries
 *     ttl: 300000,   // 5 minutes
 *   })
 */
export function createCache(options = {}) {
  const ttl = options.ttl || 5 * 60 * 1000 // Default 5 minutes
  const maxSize = options.maxSize || 1000
  const keyFn = options.keyFn || defaultKeyFn

  // LRU cache implementation
  const cache = new Map()
  const accessOrder = [] // For LRU eviction

  function defaultKeyFn(request) {
    // Create a stable key from messages
    const messages = request?.messages || []
    const key = messages.map(m => `${m.role}:${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`).join('|')
    return key
  }

  function get(key) {
    const entry = cache.get(key)
    if (!entry) return null

    // Check TTL
    if (Date.now() > entry.expiresAt) {
      cache.delete(key)
      return null
    }

    // Update access order (LRU)
    const idx = accessOrder.indexOf(key)
    if (idx > -1) {
      accessOrder.splice(idx, 1)
      accessOrder.push(key)
    }

    return entry.value
  }

  function set(key, value) {
    // Evict oldest if at max size
    while (cache.size >= maxSize && accessOrder.length > 0) {
      const oldestKey = accessOrder.shift()
      cache.delete(oldestKey)
    }

    cache.set(key, {
      value,
      expiresAt: Date.now() + ttl,
      createdAt: Date.now(),
    })
    accessOrder.push(key)
  }

  function has(key) {
    return get(key) !== null
  }

  function clear() {
    cache.clear()
    accessOrder.length = 0
  }

  function getStats() {
    // Clean expired entries
    const now = Date.now()
    for (const [key, entry] of cache) {
      if (now > entry.expiresAt) {
        cache.delete(key)
        const idx = accessOrder.indexOf(key)
        if (idx > -1) accessOrder.splice(idx, 1)
      }
    }

    return {
      size: cache.size,
      maxSize,
      ttl,
      hits: stats.hits,
      misses: stats.misses,
      hitRate: stats.hits + stats.misses > 0
        ? Math.round(stats.hits / (stats.hits + stats.misses) * 1000) / 1000
        : 0,
    }
  }

  // Stats tracking
  const stats = { hits: 0, misses: 0 }

  function attach(ai) {
    ai.use(async (ctx, next) => {
      const key = keyFn(ctx.request)

      // Check cache
      const cached = get(key)
      if (cached) {
        stats.hits++
        return cached
      }

      stats.misses++

      // Execute request
      const result = await next(ctx)

      // Cache the result
      if (result) {
        set(key, result)
      }

      return result
    })

    return ai
  }

  return {
    attach,
    get,
    set,
    has,
    clear,
    getStats,
    // Direct cache access for advanced use
    cache,
  }
}

// ─── Debug Logger ───

/**
 * createLogger — Debug logger for request/response inspection
 *
 * Usage:
 *   const logger = createLogger()
 *   const ai = createAI({ provider })
 *   logger.attach(ai)
 *
 *   await ai.chat('Hello')
 *   console.log(logger.getHistory())
 *
 * With console output:
 *   const logger = createLogger({ console: true })
 *
 * With custom formatter:
 *   const logger = createLogger({
 *     format: (entry) => `[${entry.model}] ${entry.request.messages.length} msgs`
 *   })
 */
export function createLogger(options = {}) {
  const maxHistory = options.maxHistory || 100
  const consoleOutput = options.console || false
  const format = options.format || null
  const colors = {
    req: '\x1b[36m',   // cyan
    ok: '\x1b[32m',    // green
    err: '\x1b[31m',   // red
    dim: '\x1b[2m',    // dim
    reset: '\x1b[0m',
  }

  const history = []

  function log(type, ...args) {
    if (!consoleOutput) return
    const prefix = type === 'req' ? `${colors.req}->${colors.reset}`
      : type === 'ok' ? `${colors.ok}ok${colors.reset}`
      : `${colors.err}-${colors.reset}`
    console.log(`${prefix} [ai-sdk]`, ...args)
  }

  function formatMessages(messages) {
    if (!messages || messages.length === 0) return '(empty)'
    return messages.map(m => {
      const content = typeof m.content === 'string'
        ? m.content.slice(0, 50) + (m.content.length > 50 ? '...' : '')
        : JSON.stringify(m.content).slice(0, 50)
      return `${m.role}: ${content}`
    }).join(' | ')
  }

  function record(entry) {
    history.push(entry)
    if (history.length > maxHistory) {
      history.shift()
    }

    if (consoleOutput) {
      if (format) {
        console.log(format(entry))
      } else {
        const duration = entry.duration ? `${entry.duration}ms` : ''
        const tokens = entry.response?.usage
          ? `${entry.response.usage.input}/${entry.response.usage.output} tokens`
          : ''
        const status = entry.error ? `error: ${entry.error.name}` : 'ok'

        log(entry.error ? 'err' : 'ok',
          `${colors.dim}${entry.model}${colors.reset}`,
          duration,
          tokens,
          status
        )
      }
    }
  }

  function getHistory() {
    return [...history]
  }

  function getLast(n = 1) {
    return history.slice(-n)
  }

  function clear() {
    history.length = 0
  }

  function exportJSON() {
    return JSON.stringify(history, null, 2)
  }

  function search(predicate) {
    return history.filter(predicate)
  }

  function attach(ai) {
    ai.use(async (ctx, next) => {
      const startTime = Date.now()
      const entry = {
        id: history.length + 1,
        timestamp: startTime,
        model: ctx.model || 'unknown',
        request: {
          messages: ctx.request?.messages?.map(m => ({
            role: m.role,
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          })) || [],
        },
        response: null,
        error: null,
        duration: 0,
      }

      if (consoleOutput && !format) {
        log('req', `${colors.dim}${entry.model}${colors.reset}`, formatMessages(ctx.request?.messages))
      }

      try {
        const result = await next(ctx)
        entry.response = {
          text: result?.text || '',
          usage: result?.usage || null,
        }
        entry.duration = Date.now() - startTime
        record(entry)
        return result
      } catch (err) {
        entry.error = {
          name: err.name,
          message: err.message,
          requestId: err.requestId,
        }
        entry.duration = Date.now() - startTime
        record(entry)
        throw err
      }
    })

    return ai
  }

  return {
    attach,
    getHistory,
    getLast,
    clear,
    exportJSON,
    search,
    // Direct access
    history,
  }
}

// ─── Prompt Template ───

/**
 * createTemplate — Create reusable prompt templates with variable substitution
 *
 * Usage:
 *   const template = createTemplate('Translate "{{text}}" to {{language}}')
 *   const prompt = template({ text: 'Hello', language: 'Chinese' })
 *   // => 'Translate "Hello" to Chinese'
 *
 * With defaults:
 *   const template = createTemplate('Summarize in {{style}} style', {
 *     defaults: { style: 'concise' }
 *   })
 *
 * With validation:
 *   const template = createTemplate('{{name}} is {{age}} years old', {
 *     required: ['name', 'age']
 *   })
 */
export function createTemplate(templateStr, options = {}) {
  const defaults = options.defaults || {}
  const required = options.required || []

  // Extract variable names from template
  const varPattern = /\{\{(\w+)\}\}/g
  const variables = []
  let match
  while ((match = varPattern.exec(templateStr)) !== null) {
    if (!variables.includes(match[1])) {
      variables.push(match[1])
    }
  }

  function render(vars = {}) {
    const merged = { ...defaults, ...vars }

    // Check required variables
    for (const req of required) {
      if (merged[req] === undefined || merged[req] === null) {
        throw new Error(`Template variable "${req}" is required`)
      }
    }

    // Replace variables
    return templateStr.replace(/\{\{(\w+)\}\}/g, (_, name) => {
      const value = merged[name]
      if (value === undefined) return `{{${name}}}`
      return String(value)
    })
  }

  // Make the function callable directly
  render.template = templateStr
  render.variables = variables
  render.defaults = defaults
  render.required = required

  return render
}

/**
 * createPromptLibrary — Manage a collection of prompt templates
 *
 * Usage:
 *   const prompts = createPromptLibrary({
 *     translate: 'Translate "{{text}}" to {{language}}',
 *     summarize: 'Summarize: {{content}}',
 *   })
 *
 *   const prompt = prompts.translate({ text: 'Hello', language: 'French' })
 */
export function createPromptLibrary(templates, options = {}) {
  const library = {}

  for (const [name, templateStr] of Object.entries(templates)) {
    library[name] = createTemplate(templateStr, options)
  }

  library.add = (name, templateStr, templateOptions) => {
    library[name] = createTemplate(templateStr, templateOptions || options)
  }

  library.list = () => Object.keys(library).filter(k => typeof library[k] === 'function' && library[k].template)

  return library
}

// ─── Batch Processing ───

/**
 * batch — Process multiple requests with controlled concurrency
 *
 * Usage:
 *   const results = await batch(ai, [
 *     'What is 1+1?',
 *     'What is 2+2?',
 *     'What is 3+3?',
 *   ], { concurrency: 2 })
 *
 * With progress callback:
 *   await batch(ai, prompts, {
 *     onProgress: (completed, total) => console.log(`${completed}/${total}`)
 *   })
 */
export async function batch(ai, prompts, options = {}) {
  const concurrency = options.concurrency || 3
  const onProgress = options.onProgress || null
  const onError = options.onError || null
  const stopOnError = options.stopOnError || false

  const results = new Array(prompts.length).fill(null)
  const errors = []
  let completed = 0
  let running = 0
  let index = 0
  let stopped = false

  return new Promise((resolve, reject) => {
    function next() {
      // Check if stopped
      if (stopped) return

      // Check if done
      if (completed === prompts.length) {
        resolve({ results, errors })
        return
      }

      // Start new tasks up to concurrency limit
      while (!stopped && running < concurrency && index < prompts.length) {
        const currentIndex = index++
        const prompt = prompts[currentIndex]
        running++

        const request = typeof prompt === 'string'
          ? ai.chat(prompt)
          : ai.chat(prompt)

        request
          .then(result => {
            if (!stopped) {
              results[currentIndex] = result
            }
          })
          .catch(err => {
            if (stopped) return
            errors.push({ index: currentIndex, error: err })
            if (onError) {
              try { onError(err, currentIndex) } catch {}
            }
            if (stopOnError) {
              stopped = true
              reject(err)
              return
            }
          })
          .finally(() => {
            if (stopped) return
            running--
            completed++
            if (onProgress) {
              try { onProgress(completed, prompts.length) } catch {}
            }
            next()
          })
      }
    }

    next()
  })
}

// ─── Retry Utility ───

/**
 * retry — Wrap a function with automatic retry logic
 *
 * Usage:
 *   const result = await retry(() => ai.chat('Hello'), {
 *     maxRetries: 3,
 *     delay: 1000,
 *     backoff: 'exponential',
 *   })
 *
 * With condition:
 *   await retry(fn, {
 *     retryIf: (err) => err.name === 'RateLimitError',
 *   })
 */
export async function retry(fn, options = {}) {
  const maxRetries = options.maxRetries ?? 3
  const delay = options.delay ?? 1000
  const backoff = options.backoff ?? 'exponential' // 'fixed', 'linear', 'exponential'
  const retryIf = options.retryIf ?? ((err) => {
    // Default: retry on network/rate limit errors
    return err.name === 'NetworkError' ||
           err.name === 'RateLimitError' ||
           err.name === 'TimeoutError'
  })
  const onRetry = options.onRetry ?? null

  let lastError
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err

      // Check if we should retry
      if (attempt >= maxRetries || !retryIf(err)) {
        throw err
      }

      // Calculate delay
      let waitTime = delay
      if (backoff === 'linear') {
        waitTime = delay * (attempt + 1)
      } else if (backoff === 'exponential') {
        waitTime = delay * Math.pow(2, attempt)
      }

      // Use retryAfter from RateLimitError if available
      if (err.retryAfter && err.retryAfter > 0) {
        waitTime = Math.max(waitTime, err.retryAfter * 1000)
      }

      if (onRetry) {
        try { onRetry(err, attempt + 1, waitTime) } catch {}
      }

      await new Promise(r => setTimeout(r, waitTime))
    }
  }

  throw lastError
}

// ─── Session Management ───

/**
 * createSession — Create a conversation session with history management
 *
 * Usage:
 *   const session = createSession(ai, { systemPrompt: 'You are helpful.' })
 *   const r1 = await session.chat('Hello')
 *   const r2 = await session.chat('What did I just say?')
 *
 * Persistence:
 *   const data = session.export()
 *   // Save to localStorage/file
 *   const restored = createSession(ai, { restore: data })
 */
export function createSession(ai, options = {}) {
  const systemPrompt = options.systemPrompt || null
  const maxHistory = options.maxHistory ?? 100
  const id = options.id || `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

  let messages = []
  let metadata = { createdAt: Date.now(), updatedAt: Date.now() }
  let totalUsage = { input: 0, output: 0, total: 0 }

  // Restore from saved state
  if (options.restore) {
    const data = options.restore
    messages = data.messages || []
    metadata = data.metadata || metadata
    totalUsage = data.totalUsage || totalUsage
  }

  // Initialize with system prompt
  if (systemPrompt && messages.length === 0) {
    messages.push({ role: 'system', content: systemPrompt })
  }

  async function chat(content, chatOptions = {}) {
    // Add user message
    messages.push({ role: 'user', content })

    // Trim history if needed (keep system prompt)
    while (messages.length > maxHistory) {
      const firstNonSystem = messages.findIndex(m => m.role !== 'system')
      if (firstNonSystem > 0) {
        messages.splice(firstNonSystem, 1)
      } else if (messages.length > 1) {
        messages.splice(1, 1)
      } else {
        break
      }
    }

    // Call AI
    const result = await ai.chat(messages, chatOptions)

    // Add assistant response
    messages.push({ role: 'assistant', content: result.text })

    // Update usage
    if (result.usage) {
      totalUsage.input += result.usage.input || 0
      totalUsage.output += result.usage.output || 0
      totalUsage.total += result.usage.total || 0
    }

    metadata.updatedAt = Date.now()

    return result
  }

  function getMessages() {
    return [...messages]
  }

  function clear(keepSystem = true) {
    if (keepSystem && systemPrompt) {
      messages = [{ role: 'system', content: systemPrompt }]
    } else {
      messages = []
    }
    totalUsage = { input: 0, output: 0, total: 0 }
    metadata.updatedAt = Date.now()
  }

  function addMessage(role, content) {
    messages.push({ role, content })
    metadata.updatedAt = Date.now()
  }

  function exportData() {
    return {
      id,
      messages: [...messages],
      metadata: { ...metadata },
      totalUsage: { ...totalUsage },
      systemPrompt,
    }
  }

  return {
    id,
    chat,
    getMessages,
    clear,
    addMessage,
    export: exportData,
    get messages() { return [...messages] },
    get usage() { return { ...totalUsage } },
    get metadata() { return { ...metadata } },
  }
}

// ─── Timeout Utility ───

/**
 * withTimeout — Wrap a promise with a timeout
 *
 * Usage:
 *   const result = await withTimeout(ai.chat('Hello'), 5000)
 *
 * With custom error:
 *   await withTimeout(fetch(url), 3000, 'Request timed out')
 */
export function withTimeout(promise, ms, message) {
  if (!ms || ms <= 0) return promise

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(message || `Operation timed out after ${ms}ms`))
    }, ms)

    promise
      .then(result => {
        clearTimeout(timer)
        resolve(result)
      })
      .catch(err => {
        clearTimeout(timer)
        reject(err)
      })
  })
}

// ─── Parallel Utility ───

/**
 * parallel — Run multiple AI calls in parallel with optional limit
 *
 * Usage:
 *   const results = await parallel([
 *     () => ai.chat('Question 1'),
 *     () => ai.chat('Question 2'),
 *     () => ai.chat('Question 3'),
 *   ], { limit: 2 })
 */
export async function parallel(fns, options = {}) {
  const limit = options.limit || fns.length
  const results = new Array(fns.length).fill(null)
  let index = 0
  let running = 0
  let completed = 0

  return new Promise((resolve, reject) => {
    function next() {
      if (completed === fns.length) {
        resolve(results)
        return
      }

      while (running < limit && index < fns.length) {
        const currentIndex = index++
        running++

        Promise.resolve()
          .then(() => fns[currentIndex]())
          .then(result => {
            results[currentIndex] = { status: 'fulfilled', value: result }
          })
          .catch(err => {
            results[currentIndex] = { status: 'rejected', reason: err }
          })
          .finally(() => {
            running--
            completed++
            next()
          })
      }
    }

    next()
  })
}

// ─── Debounce Utility ───

/**
 * debounce — Debounce a function (useful for real-time input)
 *
 * Usage:
 *   const debouncedChat = debounce((text) => ai.chat(text), 300)
 *   input.oninput = (e) => debouncedChat(e.target.value)
 */
export function debounce(fn, ms) {
  let timer = null
  let pending = null

  const debounced = (...args) => {
    return new Promise((resolve, reject) => {
      if (timer) clearTimeout(timer)

      pending = { resolve, reject }

      timer = setTimeout(async () => {
        timer = null
        const current = pending
        pending = null
        try {
          const result = await fn(...args)
          current.resolve(result)
        } catch (err) {
          current.reject(err)
        }
      }, ms)
    })
  }

  debounced.cancel = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (pending) {
      pending.reject(new Error('Cancelled'))
      pending = null
    }
  }

  debounced.flush = async (...args) => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    return fn(...args)
  }

  return debounced
}

// ─── Throttle Utility ───

/**
 * throttle — Throttle a function (limit execution rate)
 *
 * Usage:
 *   const throttledChat = throttle((text) => ai.chat(text), 1000)
 *   // Will execute at most once per second
 */
export function throttle(fn, ms) {
  let lastCall = 0
  let pending = null
  let timer = null

  const throttled = (...args) => {
    return new Promise((resolve, reject) => {
      const now = Date.now()
      const elapsed = now - lastCall

      if (elapsed >= ms) {
        // Can execute immediately
        lastCall = now
        Promise.resolve(fn(...args)).then(resolve).catch(reject)
      } else {
        // Queue for later
        if (timer) clearTimeout(timer)
        pending = { args, resolve, reject }

        timer = setTimeout(async () => {
          timer = null
          lastCall = Date.now()
          const current = pending
          pending = null
          try {
            const result = await fn(...current.args)
            current.resolve(result)
          } catch (err) {
            current.reject(err)
          }
        }, ms - elapsed)
      }
    })
  }

  throttled.cancel = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (pending) {
      pending.reject(new Error('Cancelled'))
      pending = null
    }
  }

  throttled.reset = () => {
    lastCall = 0
  }

  return throttled
}

// ─── Compose Utility ───

/**
 * compose — Compose multiple functions into one
 *
 * Usage:
 *   const process = compose(
 *     (text) => text.trim(),
 *     (text) => text.toLowerCase(),
 *     (text) => ai.chat(text)
 *   )
 *   const result = await process('  HELLO  ')
 */
export function compose(...fns) {
  if (fns.length === 0) return (x) => x
  if (fns.length === 1) return fns[0]

  return async (input) => {
    let result = input
    for (const fn of fns) {
      result = await fn(result)
    }
    return result
  }
}

// ─── Pipe Utility ───

/**
 * pipe — Pipe a value through multiple functions (same as compose but reads left-to-right)
 *
 * Usage:
 *   const result = await pipe(
 *     'Hello',
 *     (text) => text.toUpperCase(),
 *     (text) => ai.chat(text)
 *   )
 */
export async function pipe(initial, ...fns) {
  let result = initial
  for (const fn of fns) {
    result = await fn(result)
  }
  return result
}
