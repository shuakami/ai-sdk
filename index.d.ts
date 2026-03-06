import type { ZodType } from 'zod'

// ─── Error Types ───
export class RateLimitError extends Error {
  retryAfter: number | null
  requestId?: string
}
export class AuthError extends Error {
  requestId?: string
}
export class NetworkError extends Error {
  requestId?: string
  status?: number
  code?: string
}
export class TimeoutError extends Error {}
export class ContextLengthError extends Error {
  requestId?: string
}
export class ModelError extends Error {
  requestId?: string
}
export class ToolExecutionError extends Error {}
export class StreamInterruptError extends Error {
  resume(): Promise<{ text: string; usage: Usage | null }>
}

/** Error thrown after all retry attempts fail */
export class RetryError extends Error {
  /** All attempts made before failure */
  attempts: Array<{ attempt: number; error: string; name?: string; requestId?: string }>
  /** The underlying error from the last attempt */
  cause: Error
  requestId?: string
}

// ─── Core Types ───
export interface Usage {
  input: number
  output: number
  total: number
  cost?: number
}

export interface ChatRequest {
  messages?: Message[]
  tools?: ToolDefinition[]
  toolChoice?: 'auto' | 'required' | { name: string }
  /** Whether to execute multiple tool calls in parallel. Default: false */
  parallel?: boolean
  model?: string
  [key: string]: any
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[]
  name?: string
  [key: string]: any
}

export interface ContentPart {
  type: string
  [key: string]: any
}

export interface ChatResponse {
  text: string
  usage?: Usage
  toolCalls?: ToolCall[] | null
  reasoningContent?: string
  reasoning_content?: string
  [key: string]: any
}

export interface ToolCall {
  name: string
  args: Record<string, unknown>
  callId?: string
}

export interface StreamChunk {
  type?: 'delta' | 'usage'
  delta?: string
  usage?: Usage
  [key: string]: any
}

// ─── Provider ───
export interface EmbedOptions { [key: string]: any }
export interface ModelInfo { id: string; contextWindow?: number; [key: string]: any }

export interface IProvider {
  name: string
  defaultModel?: string
  /** Base URL of the API endpoint */
  baseURL?: string
  chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>
  stream?(request: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamChunk>
  embed?(texts: string[], options?: EmbedOptions): Promise<number[][]>
  models?(): Promise<ModelInfo[]>
  tokenize?(text: string): Promise<number[]>
}

// ─── Tool ───
export interface ToolDefinition<T = any> {
  name: string
  description: string
  schema: any
  execute: (args: T) => Promise<any>
}

export function defineTool(options: {
  name: string
  description: string
  schema: ZodType<any>
  execute: (args: any) => Promise<any>
}): ToolDefinition

export function defineTool(fn: Function): ToolDefinition

// ─── Stream Result (unified for both ai.stream() and streamText()) ───
export interface StreamResult {
  [Symbol.asyncIterator](): AsyncIterator<StreamChunk>
  /** Yields only text strings (no metadata) */
  textStream: AsyncIterable<string>
  /** Resolves to the full concatenated text after stream ends */
  text: Promise<string>
  /** Resolves to token usage after stream ends (null if provider doesn't report) */
  usage: Promise<Usage | null>
  /** Returns { text, usage } after stream ends */
  final(): Promise<{ text: string; usage: Usage | null }>
  /** Pipe to Node.js ServerResponse as SSE */
  pipeToSSE(res: any): Promise<void>
  /** Convert to Web ReadableStream */
  toReadableStream(): ReadableStream
}

// ─── AI Instance Events ───
export type AIEventName =
  | 'request:before'   // Before any request (chat or stream)
  | 'response:after'   // After any request completes
  | 'stream:finish'    // When a stream finishes (includes text and usage)
  | 'tool:call'        // Before a tool is executed
  | 'tool:result'      // After a tool returns

export interface RequestBeforeEvent {
  request: ChatRequest
  type?: 'chat' | 'stream'
}

export interface ResponseAfterEvent {
  request: ChatRequest
  response: ChatResponse | { text: string; usage: Usage | null }
  type?: 'chat' | 'stream'
}

export interface StreamFinishEvent {
  text: string
  usage: Usage | null
  request: ChatRequest
}

export interface ToolCallEvent {
  tool: string
  callId?: string
}

export interface ToolResultEvent {
  tool: string
  latency: number
}

// ─── Conversation ───
export interface ConversationOptions {
  /** Unique conversation ID */
  id?: string
  /** System prompt for the conversation */
  system?: string
}

export interface Conversation {
  /** Conversation ID */
  id: string
  /** All messages in the conversation */
  messages: Message[]
  /** Cumulative token usage across all messages */
  totalUsage: Usage
  /** Send a message and get a response (non-streaming) */
  send(prompt: string): Promise<ChatResponse>
  /** Send a message and get a streaming response */
  stream(prompt: string): StreamResult
  /** Manually add a message to the conversation */
  addMessage(msg: Message): void
  /** Get a copy of all messages */
  getMessages(): Message[]
  /** Clear all messages (keeps system prompt if set) */
  clear(): void
}

// ─── AI Instance ───
export interface AIInstance {
  chat(input: string | ChatRequest): Promise<ChatResponse>
  stream(prompt: string | ChatRequest, options?: any): StreamResult
  conversation(options?: ConversationOptions): Conversation
  agent(options: Omit<AgentOptions, 'model'>): { run(prompt?: string): Promise<AgentResult>; stream(prompt?: string): AsyncIterable<any> }
  /** Listen to events. Events: 'request:before', 'response:after', 'stream:finish', 'tool:call', 'tool:result' */
  on(event: 'request:before', handler: (e: RequestBeforeEvent) => void): void
  on(event: 'response:after', handler: (e: ResponseAfterEvent) => void): void
  on(event: 'stream:finish', handler: (e: StreamFinishEvent) => void): void
  on(event: 'tool:call', handler: (e: ToolCallEvent) => void): void
  on(event: 'tool:result', handler: (e: ToolResultEvent) => void): void
  on(event: AIEventName, handler: Function): void
  once(event: AIEventName, handler: Function): void
  off(event: AIEventName, handler: Function): void
  use(middleware: (ctx: { request: ChatRequest; response?: ChatResponse }, next: () => Promise<void>) => Promise<void>): void
  extend(defaults: Record<string, any>): AIInstance
  /** Access the underlying provider */
  readonly provider: IProvider
  /** Current defaults */
  readonly defaults: Record<string, any>
}

export function createAI(options: {
  provider: IProvider | any
  model?: string
  defaults?: any
  retry?: any
  timeout?: number
  telemetry?: any
}): AIInstance

// ─── Top-level Convenience Functions ───
export interface StreamTextOptions {
  /** The provider instance (e.g. from openai()) */
  model: IProvider
  /** Chat messages array */
  messages?: Message[]
  /** Shorthand: single user prompt (will be wrapped into messages) */
  prompt?: string
  /** Shorthand: system prompt (prepended to messages) */
  system?: string
  /** Override the provider's default model for this request */
  modelId?: string
  /** Maximum tokens to generate */
  maxTokens?: number
  /** AbortSignal to cancel the request */
  signal?: AbortSignal
  /** Called for each text chunk as it arrives */
  onChunk?: (event: { delta: string; text: string }) => void
  /** Called when the stream finishes */
  onFinish?: (event: { text: string; usage: Usage | null }) => void
}

export interface StreamTextResult {
  [Symbol.asyncIterator](): AsyncIterator<StreamChunk>
  /** Yields only text strings */
  textStream: AsyncIterable<string>
  /** Resolves to the full concatenated text after stream ends */
  text: Promise<string>
  /** Resolves to token usage after stream ends */
  usage: Promise<Usage | null>
  /** Returns { text, usage } after stream ends */
  final(): Promise<{ text: string; usage: Usage | null }>
  /** Convert stream to Web ReadableStream (for Response, etc.) */
  toReadableStream(): ReadableStream<Uint8Array>
  /** Pipe stream to Node.js SSE response */
  pipeToSSE(res: { writeHead: Function; write: Function; end: Function }): Promise<void>
}

export function streamText(options: StreamTextOptions): StreamTextResult

/** Retry options for automatic retry on transient errors */
export interface RetryOptions {
  /** Maximum number of retries (default: 3) */
  maxRetries?: number
  /** Backoff strategy: 'exponential', 'linear', or 'fixed' (default: 'exponential') */
  backoff?: 'exponential' | 'linear' | 'fixed'
  /** Initial delay in ms (default: 1000) */
  initialDelay?: number
  /** Called on each retry attempt */
  onRetry?: (attempt: number, error: Error, delay: number) => void
  /** Custom retry condition */
  retryOn?: (error: Error) => boolean
}

export interface GenerateTextOptions {
  /** The provider instance (e.g. from openai()) */
  model: IProvider
  /** Chat messages array */
  messages?: Message[]
  /** Shorthand: single user prompt */
  prompt?: string
  /** Shorthand: system prompt */
  system?: string
  /** Maximum tokens to generate */
  maxTokens?: number
  /** AbortSignal to cancel the request */
  signal?: AbortSignal
  /** Automatic retry on transient errors (rate limit, network, timeout) */
  retry?: RetryOptions
}

export function generateText(options: GenerateTextOptions): Promise<ChatResponse>

// ─── Agent ───

export interface AgentStep {
  type: 'tool_call' | 'text'
  step: number
  /** Alias of step number for compatibility */
  index?: number
  /** Tool name (for tool_call steps) */
  tool?: string
  /** Tool arguments (for tool_call steps) */
  args?: Record<string, unknown>
  /** Tool execution result (for tool_call steps) */
  result?: unknown
  /** Final text (for text steps) */
  text?: string
  /** Model usage for this step (if available) */
  usage?: Usage | null
  /** Tool latency in ms (for tool_call steps) */
  latency?: number
}

export interface AgentResult {
  /** The agent's final text response */
  text: string
  /** Total token usage across all steps */
  usage: Usage
  /** Detailed log of every step the agent took (tool calls + final text) */
  steps: AgentStep[]
}

export interface AgentOptions {
  /** The provider instance */
  model: IProvider
  /** Tools the agent can use */
  tools: ToolDefinition[]
  /** The task prompt */
  prompt?: string
  /** System prompt */
  system?: string
  /** Chat messages (alternative to prompt) */
  messages?: Message[]
  /** Tool choice behavior (default: 'auto') */
  toolChoice?: 'auto' | 'required' | { name: string }
  /** Execute multiple tool calls in parallel (default: false) */
  parallel?: boolean
  /** Alias of parallel; only explicit true enables parallel execution */
  parallelToolCalls?: boolean
  /** Maximum number of LLM calls (default: 20) */
  maxSteps?: number
  /** Request-level extras forwarded to provider.chat */
  request?: Record<string, any>
  /** AbortSignal for cancellation */
  signal?: AbortSignal
  /** Automatic retry for provider.chat on transient failures */
  retry?: RetryOptions
  /** Called before each tool execution — can approve, modify, or abort */
  onStep?: (step: AgentStep, control: {
    continue: () => { action: 'continue' }
    abort: (reason?: string) => { action: 'abort'; reason?: string }
    modify: (changes: { args?: Record<string, unknown> }) => { action: 'modify'; changes: any }
  }) => Promise<{ action: string; [key: string]: any }> | { action: string; [key: string]: any }
  /** Called when the agent finishes */
  onFinish?: (result: AgentResult) => void
  /** Custom stop condition — return true to stop early */
  stopWhen?: (state: { usage: Usage; steps: AgentStep[] }) => boolean
}

/** Run an agent that can use tools to complete a task */
export function agent(options: AgentOptions): Promise<AgentResult>

// ─── Usage Format Conversion ───

/** OpenAI-compatible usage format */
export interface OpenAIUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

/** Convert SDK usage format to OpenAI format (for migration compatibility) */
export function toOpenAIUsage(usage: Usage | null): OpenAIUsage | null

/** Convert OpenAI usage format to SDK format */
export function fromOpenAIUsage(usage: OpenAIUsage | null): Usage | null

// ─── Context Window Management ───

/** Custom tokenizer interface for accurate token counting */
export interface Tokenizer {
  /** Count tokens in a string */
  encode: (text: string) => number
  /** Count tokens in a chat messages array (optional, for gpt-tokenizer compatibility) */
  encodeChat?: (messages: Message[]) => number
}

/**
 * Set a custom tokenizer for accurate token counting
 * @example
 * // Use gpt-tokenizer for 100% accuracy
 * import { encode, encodeChat } from 'gpt-tokenizer'
 * setTokenizer({
 *   encode: (text) => encode(text).length,
 *   encodeChat: (messages) => encodeChat(messages).length,
 * })
 */
export function setTokenizer(tokenizer: Tokenizer | null): void

/** Estimate token count for a string (uses custom tokenizer if set) */
export function estimateTokens(text: string): number

/** Estimate token count for messages array */
export function estimateMessagesTokens(messages: Message[]): number

/** Summary generation options */
export interface SummaryOptions {
  /** Provider/model to use for summarization */
  model: IProvider
  /** Custom prompt for summarization */
  prompt?: string
  /** Maximum summary length in words (default: 300) */
  maxLength?: number
}

export interface ContextWindowOptions {
  /** Maximum tokens allowed (default: 8000) */
  maxTokens?: number
  /** Tokens to reserve for response (default: 1000) */
  reserveTokens?: number
  /** Truncation strategy: 'sliding' removes oldest, 'summarize' generates summary first */
  strategy?: 'sliding' | 'summarize'
  /** Summary options when using 'summarize' strategy */
  summaryOptions?: SummaryOptions
  /** Custom summarizer function (alternative to summaryOptions) */
  summarizer?: (messages: Message[]) => Promise<string>
  /** Callback when messages are truncated */
  onTruncate?: (removed: Message[], summary: string | null) => void
  /** Callback when summarization fails */
  onError?: (error: Error) => void
  /** Keep system prompt when truncating (default: true) */
  keepSystemPrompt?: boolean
}

export interface ContextWindow {
  /** Add a single message */
  add(msg: Message): void
  /** Add multiple messages */
  addMany(msgs: Message[]): void
  /** Manually trigger truncation */
  truncate(): Promise<{ truncated: boolean; removed: Message[]; summary?: string }>
  /** Get messages (auto-truncates if needed) */
  getMessages(): Promise<Message[]>
  /** Get current estimated token count */
  getTokenCount(): number
  /** Clear all messages (keeps system prompt if set) */
  clear(): void
  /** Set or update system prompt */
  setSystem(content: string): void
  /** Last generated summary (if using 'summarize' strategy) */
  readonly summary: string | null
  /** Direct access to raw messages array */
  readonly raw: Message[]
}

/** Create a context window manager for automatic message truncation and summarization */
export function createContextWindow(options?: ContextWindowOptions): ContextWindow

// ─── Orchestration ───
export function createFallback(providers: IProvider[], options?: { onFallback?: (error: Error, nextIndex: number) => void }): IProvider
export function createRace(providers: IProvider[]): IProvider
export function createFanOut(providers: IProvider[], options?: { pick?: (responses: ChatResponse[]) => ChatResponse }): IProvider
export function createPipeline(stages: Array<{ provider: IProvider; transform?: (r: ChatResponse) => string }>): IProvider
/** Route requests to different providers. Match function can be sync or async. */
export function createRouter(routes: Array<{ match: (req: ChatRequest) => boolean | Promise<boolean>; provider: IProvider }>): IProvider

// ─── Pool (Load Balancing) ───

export interface PoolOptions {
  /** Load balancing strategy: 'round-robin', 'random', 'least-latency' (default: 'round-robin') */
  strategy?: 'round-robin' | 'random' | 'least-latency'
}

export interface PoolStats {
  [providerName: string]: {
    avgLatency: number
    requests: number
  }
}

export interface Pool extends IProvider {
  /** All providers in the pool */
  providers: IProvider[]
  /** Current strategy */
  strategy: string
  /** Get latency stats for all providers */
  getStats(): PoolStats
  /** Reset stats and round-robin index */
  reset(): void
}

/**
 * Create a load-balanced pool of providers
 * @example
 * const pool = createPool([provider1, provider2], { strategy: 'round-robin' })
 * // Requests are distributed across providers
 */
export function createPool(providers: IProvider[], options?: PoolOptions): Pool

// ─── Observability & Utilities ───

/** Metrics stats returned by getStats() */
export interface MetricsStats {
  requests: number
  success: number
  errors: number
  errorRate: number
  errorTypes: Record<string, number>
  tokens: { input: number; output: number; total: number }
  latency: {
    avg: number
    p50: number
    p95: number
    p99: number
    min: number
    max: number
  }
  avgLatency: number
}

export interface MetricsOptions {
  /** Number of requests to keep for percentile calculations (default: 100) */
  windowSize?: number
}

export interface Metrics {
  /** Attach to an AI instance to auto-collect metrics */
  attach(ai: AIInstance): AIInstance
  /** Get current stats */
  getStats(): MetricsStats
  /** Reset all stats */
  reset(): void
  /** Set threshold alert */
  onThreshold(metric: 'latency' | 'errorRate' | 'tokens' | 'requests', threshold: number, callback: (stats: MetricsStats) => void): () => void
  /** Manual recording for custom integrations */
  recordStart(requestId: number | string): void
  recordEnd(requestId: number | string, response: ChatResponse | null, error: Error | null): void
}

/** Create a metrics collector for observability */
export function createMetrics(options?: MetricsOptions): Metrics

/** Cost estimation result */
export interface CostTotal {
  usd: number
  requests: number
  tokens: { input: number; output: number }
  breakdown: Array<{ model: string; cost: number; tokens: Usage | null }>
}

export interface CostEstimate {
  usd: number
  breakdown: { input: number; output: number }
}

export interface CostEstimatorOptions {
  /** Custom pricing per 1M tokens: { 'model-name': { input: number, output: number } } */
  pricing?: Record<string, { input: number; output: number }>
  /** Currency label (default: 'usd') */
  currency?: string
}

export interface CostEstimator {
  /** Attach to an AI instance to auto-track costs */
  attach(ai: AIInstance): AIInstance
  /** Record a request manually */
  record(model: string, usage: Usage): number
  /** Get total cost */
  getTotal(): CostTotal
  /** Estimate cost without making a request */
  getEstimate(model: string, inputTokens: number, outputTokens: number): CostEstimate
  /** Reset all tracking */
  reset(): void
  /** Access/modify pricing table */
  pricing: Record<string, { input: number; output: number }>
}

/** Create a cost estimator to track API costs */
export function createCostEstimator(options?: CostEstimatorOptions): CostEstimator

/** Mock provider options */
export interface MockProviderOptions {
  /** Array of responses to cycle through */
  responses?: string[]
  /** Custom response function */
  response?: (messages: Message[]) => string | Promise<string>
  /** Error to throw on every call */
  error?: Error
  /** Simulated latency in ms */
  latency?: number
  /** Custom usage stats */
  usage?: Usage
  /** Tool calls to return */
  toolCalls?: Array<{ name: string; args: Record<string, unknown>; callId: string }>
  /** Chunk size for streaming (default: 5) */
  chunkSize?: number
}

export interface MockProvider extends IProvider {
  /** Reset call counter and history */
  reset(): void
  /** Get all recorded calls */
  getCalls(): Array<{ type: 'chat' | 'stream'; messages: Message[]; timestamp: number }>
  /** Get the last call */
  getLastCall(): { type: 'chat' | 'stream'; messages: Message[]; timestamp: number } | null
  /** Direct access to calls array */
  calls: Array<{ type: 'chat' | 'stream'; messages: Message[]; timestamp: number }>
}

/** Create a mock provider for testing */
export function createMockProvider(options?: MockProviderOptions): MockProvider

/** Rate limiter options */
export interface RateLimiterOptions {
  /** Max requests per minute */
  requestsPerMinute?: number
  /** Max tokens per minute */
  tokensPerMinute?: number
}

export interface RateLimiterStats {
  requestsInWindow: number
  tokensInWindow: number
  requestLimit: number
  tokenLimit: number
  queueLength: number
}

export interface RateLimiter {
  /** Attach to an AI instance */
  attach(ai: AIInstance): AIInstance
  /** Manually acquire a rate limit slot */
  acquire(estimatedTokens?: number): Promise<void>
  /** Record token usage */
  recordTokens(tokens: number): void
  /** Get current stats */
  getStats(): RateLimiterStats
  /** Get time to wait before next request (ms) */
  getWaitTime(): number
}

/** Create a rate limiter to control request rate */
export function createRateLimiter(options?: RateLimiterOptions): RateLimiter

/** Cache options */
export interface CacheOptions {
  /** Time-to-live in ms (default: 5 minutes) */
  ttl?: number
  /** Maximum cache entries (default: 1000) */
  maxSize?: number
  /** Custom key function */
  keyFn?: (request: ChatRequest) => string
}

export interface CacheStats {
  size: number
  maxSize: number
  ttl: number
  hits: number
  misses: number
  hitRate: number
}

export interface Cache {
  /** Attach to an AI instance */
  attach(ai: AIInstance): AIInstance
  /** Get cached value */
  get(key: string): ChatResponse | null
  /** Set cached value */
  set(key: string, value: ChatResponse): void
  /** Check if key exists */
  has(key: string): boolean
  /** Clear all cache */
  clear(): void
  /** Get cache stats */
  getStats(): CacheStats
  /** Direct cache access */
  cache: Map<string, { value: ChatResponse; expiresAt: number; createdAt: number }>
}

/** Create a response cache */
export function createCache(options?: CacheOptions): Cache

// ─── Debug Logger ───

export interface LogEntry {
  id: number
  timestamp: number
  model: string
  request: {
    messages: Array<{ role: string; content: string }>
  }
  response: {
    text: string
    usage: Usage | null
  } | null
  error: {
    name: string
    message: string
    requestId?: string
  } | null
  duration: number
}

export interface LoggerOptions {
  /** Max history entries to keep (default: 100) */
  maxHistory?: number
  /** Output to console (default: false) */
  console?: boolean
  /** Custom format function */
  format?: (entry: LogEntry) => string
}

export interface Logger {
  /** Attach to an AI instance */
  attach(ai: AIInstance): AIInstance
  /** Get all history */
  getHistory(): LogEntry[]
  /** Get last N entries */
  getLast(n?: number): LogEntry[]
  /** Clear history */
  clear(): void
  /** Export as JSON string */
  exportJSON(): string
  /** Search history */
  search(predicate: (entry: LogEntry) => boolean): LogEntry[]
  /** Direct history access */
  history: LogEntry[]
}

/** Create a debug logger */
export function createLogger(options?: LoggerOptions): Logger

// ─── Prompt Template ───

export interface TemplateOptions {
  /** Default values for variables */
  defaults?: Record<string, string | number>
  /** Required variables (throws if missing) */
  required?: string[]
}

export interface Template {
  (vars?: Record<string, string | number>): string
  /** Original template string */
  template: string
  /** Extracted variable names */
  variables: string[]
  /** Default values */
  defaults: Record<string, string | number>
  /** Required variables */
  required: string[]
}

/** Create a prompt template with variable substitution */
export function createTemplate(templateStr: string, options?: TemplateOptions): Template

export interface PromptLibrary {
  [name: string]: Template | ((...args: any[]) => any)
  /** Add a new template */
  add(name: string, templateStr: string, options?: TemplateOptions): void
  /** List all template names */
  list(): string[]
}

/** Create a collection of prompt templates */
export function createPromptLibrary(templates: Record<string, string>, options?: TemplateOptions): PromptLibrary

// ─── Batch Processing ───

export interface BatchOptions {
  /** Max concurrent requests (default: 3) */
  concurrency?: number
  /** Progress callback */
  onProgress?: (completed: number, total: number) => void
  /** Error callback */
  onError?: (error: Error, index: number) => void
  /** Stop on first error (default: false) */
  stopOnError?: boolean
}

export interface BatchResult {
  results: (ChatResponse | null)[]
  errors: Array<{ index: number; error: Error }>
}

/** Process multiple requests with controlled concurrency */
export function batch(ai: AIInstance, prompts: (string | ChatRequest)[], options?: BatchOptions): Promise<BatchResult>

// ─── Retry Utility ───

export interface RetryOptions {
  /** Max retry attempts (default: 3) */
  maxRetries?: number
  /** Base delay in ms (default: 1000) */
  delay?: number
  /** Backoff strategy: 'fixed', 'linear', 'exponential' (default: 'exponential') */
  backoff?: 'fixed' | 'linear' | 'exponential'
  /** Custom retry condition (default: retry on NetworkError, RateLimitError, TimeoutError) */
  retryIf?: (error: Error) => boolean
  /** Callback on each retry */
  onRetry?: (error: Error, attempt: number, waitTime: number) => void
}

/**
 * Wrap a function with automatic retry logic
 * @example
 * const result = await retry(() => ai.chat('Hello'), {
 *   maxRetries: 3,
 *   backoff: 'exponential',
 * })
 */
export function retry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T>

// ─── Session Management ───

export interface SessionOptions {
  /** System prompt for the session */
  systemPrompt?: string
  /** Max messages to keep in history (default: 100) */
  maxHistory?: number
  /** Session ID (auto-generated if not provided) */
  id?: string
  /** Restore from exported data */
  restore?: SessionData
}

export interface SessionData {
  id: string
  messages: Message[]
  metadata: { createdAt: number; updatedAt: number }
  totalUsage: Usage
  systemPrompt: string | null
}

export interface Session {
  /** Session ID */
  readonly id: string
  /** Send a message and get response */
  chat(content: string, options?: Partial<ChatRequest>): Promise<ChatResponse>
  /** Get all messages */
  getMessages(): Message[]
  /** Clear history (optionally keep system prompt) */
  clear(keepSystem?: boolean): void
  /** Add a message manually */
  addMessage(role: 'user' | 'assistant' | 'system', content: string): void
  /** Export session data for persistence */
  export(): SessionData
  /** Current messages (readonly copy) */
  readonly messages: Message[]
  /** Total usage across all requests */
  readonly usage: Usage
  /** Session metadata */
  readonly metadata: { createdAt: number; updatedAt: number }
}

/**
 * Create a conversation session with history management
 * @example
 * const session = createSession(ai, { systemPrompt: 'You are helpful.' })
 * await session.chat('Hello')
 * await session.chat('What did I just say?')
 *
 * // Persistence
 * const data = session.export()
 * localStorage.setItem('session', JSON.stringify(data))
 * const restored = createSession(ai, { restore: JSON.parse(localStorage.getItem('session')) })
 */
export function createSession(ai: AIInstance, options?: SessionOptions): Session

// ─── Timeout Utility ───

/**
 * Wrap a promise with a timeout
 * @example
 * const result = await withTimeout(ai.chat('Hello'), 5000)
 * // Throws TimeoutError if not resolved within 5 seconds
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message?: string): Promise<T>

// ─── Parallel Utility ───

export interface ParallelResult<T> {
  status: 'fulfilled' | 'rejected'
  value?: T
  reason?: Error
}

export interface ParallelOptions {
  /** Max concurrent executions (default: all) */
  limit?: number
}

/**
 * Run multiple async functions in parallel with optional concurrency limit
 * @example
 * const results = await parallel([
 *   () => ai.chat('Question 1'),
 *   () => ai.chat('Question 2'),
 * ], { limit: 2 })
 */
export function parallel<T>(fns: Array<() => Promise<T>>, options?: ParallelOptions): Promise<ParallelResult<T>[]>

// ─── Debounce Utility ───

export interface DebouncedFunction<T extends (...args: any[]) => any> {
  (...args: Parameters<T>): Promise<Awaited<ReturnType<T>>>
  /** Cancel pending execution */
  cancel(): void
  /** Execute immediately, bypassing debounce */
  flush(...args: Parameters<T>): Promise<Awaited<ReturnType<T>>>
}

/**
 * Debounce a function (useful for real-time input)
 * @example
 * const debouncedChat = debounce((text) => ai.chat(text), 300)
 * input.oninput = (e) => debouncedChat(e.target.value)
 */
export function debounce<T extends (...args: any[]) => any>(fn: T, ms: number): DebouncedFunction<T>

// ─── Throttle Utility ───

export interface ThrottledFunction<T extends (...args: any[]) => any> {
  (...args: Parameters<T>): Promise<Awaited<ReturnType<T>>>
  /** Cancel pending execution */
  cancel(): void
  /** Reset throttle timer */
  reset(): void
}

/**
 * Throttle a function (limit execution rate)
 * @example
 * const throttledChat = throttle((text) => ai.chat(text), 1000)
 * // Will execute at most once per second
 */
export function throttle<T extends (...args: any[]) => any>(fn: T, ms: number): ThrottledFunction<T>

// ─── Compose Utility ───

/**
 * Compose multiple functions into one (right-to-left execution)
 * @example
 * const process = compose(
 *   (text) => text.trim(),
 *   (text) => text.toLowerCase(),
 *   (text) => ai.chat(text)
 * )
 */
export function compose<T>(...fns: Array<(arg: any) => any>): (input: T) => Promise<any>

// ─── Pipe Utility ───

/**
 * Pipe a value through multiple functions (left-to-right execution)
 * @example
 * const result = await pipe(
 *   'Hello',
 *   (text) => text.toUpperCase(),
 *   (text) => ai.chat(text)
 * )
 */
export function pipe<T>(initial: T, ...fns: Array<(arg: any) => any>): Promise<any>
