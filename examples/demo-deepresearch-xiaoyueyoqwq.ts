import { createAI, defineTool } from '@shuakami/ai-sdk'
import { openai } from '@shuakami/ai-sdk-provider-openai'
import { z } from 'zod'

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
}

function color(text: string, code: string) {
  return `${code}${text}${ANSI.reset}`
}

function section(title: string) {
  console.log(color(`\n=== ${title} ===`, `${ANSI.bold}${ANSI.blue}`))
}

function decodeHtmlEntities(text: string) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
}

function cleanWhitespace(text: string) {
  return text.replace(/\s+/g, ' ').trim()
}

function stripHtml(html: string) {
  return cleanWhitespace(
    decodeHtmlEntities(
      html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<[^>]+>/g, ' '),
    ),
  )
}

function truncate(text: string, maxChars: number) {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}...`
}

function extractTitle(html: string) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return match ? cleanWhitespace(decodeHtmlEntities(match[1])) : ''
}

function isPrivateHost(hostname: string) {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true
  if (host.startsWith('10.')) return true
  if (host.startsWith('192.168.')) return true
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true
  return false
}

function ensureSafeHttpUrl(input: string) {
  const url = new URL(input)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http/https URLs are allowed: ${input}`)
  }
  if (isPrivateHost(url.hostname)) {
    throw new Error(`Private or local hosts are blocked: ${url.hostname}`)
  }
  return url.toString()
}

function simplifyValue(value: unknown, depth: number = 0): unknown {
  if (depth > 4) return '[truncated-depth]'
  if (typeof value === 'string') return truncate(value, 1200)
  if (Array.isArray(value)) return value.slice(0, 12).map(item => simplifyValue(item, depth + 1))
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 30)
    return Object.fromEntries(entries.map(([key, val]) => [key, simplifyValue(val, depth + 1)]))
  }
  return value
}

function decodeDuckDuckGoLink(rawHref: string) {
  const href = decodeHtmlEntities(rawHref)
  if (href.startsWith('//')) {
    const redirect = new URL(`https:${href}`)
    const target = redirect.searchParams.get('uddg')
    return target ? decodeURIComponent(target) : `https:${href.slice(2)}`
  }
  if (href.startsWith('/')) {
    const redirect = new URL(`https://duckduckgo.com${href}`)
    const target = redirect.searchParams.get('uddg')
    return target ? decodeURIComponent(target) : redirect.toString()
  }
  return href
}

function parseDuckDuckGoResults(html: string, maxResults: number) {
  const blocks = html.split('<div class="result results_links').slice(1)
  const results = []

  for (const block of blocks) {
    const linkMatch = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
    if (!linkMatch) continue

    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i)
    const url = decodeDuckDuckGoLink(linkMatch[1])
    const title = cleanWhitespace(decodeHtmlEntities(linkMatch[2].replace(/<[^>]+>/g, ' ')))
    const snippet = snippetMatch
      ? cleanWhitespace(decodeHtmlEntities(snippetMatch[1].replace(/<[^>]+>/g, ' ')))
      : ''

    results.push({ title, url, snippet })
    if (results.length >= maxResults) break
  }

  return results
}

const apiKey = process.env.OPENAI_API_KEY
const baseURL = process.env.OPENAI_BASE_URL || 'https://gpt-agent.cc/v1'
const model = process.env.OPENAI_MODEL || 'kimi-for-coding'

if (!apiKey) {
  throw new Error('Missing OPENAI_API_KEY')
}

const searchWebTool = defineTool({
  name: 'search_web',
  description: 'Search the public web and return the top results with titles, URLs, and snippets.',
  schema: z.object({
    query: z.string().describe('Search query'),
    maxResults: z.number().int().min(1).max(10).default(5),
  }),
  execute: async ({ query, maxResults }) => {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
    const resp = await fetch(url, {
      headers: {
        'user-agent': 'ai-sdk-deepresearch-demo',
        'accept': 'text/html',
      },
    })

    const html = await resp.text()
    return {
      query,
      status: resp.status,
      results: parseDuckDuckGoResults(html, maxResults),
    }
  },
})

const fetchPageTool = defineTool({
  name: 'fetch_page',
  description: 'Fetch a public web page and extract readable text content.',
  schema: z.object({
    url: z.string().url().describe('Public page URL'),
    maxChars: z.number().int().min(500).max(20000).default(5000),
  }),
  execute: async ({ url, maxChars }) => {
    const safeUrl = ensureSafeHttpUrl(url)
    const resp = await fetch(safeUrl, {
      headers: {
        'user-agent': 'ai-sdk-deepresearch-demo',
        'accept': 'text/html, text/plain, application/xhtml+xml, application/xml;q=0.9, */*;q=0.8',
      },
    })

    const contentType = resp.headers.get('content-type') || ''
    const raw = await resp.text()
    const text = contentType.includes('html') ? stripHtml(raw) : cleanWhitespace(raw)

    return {
      url: safeUrl,
      finalUrl: resp.url,
      status: resp.status,
      contentType,
      title: contentType.includes('html') ? extractTitle(raw) : '',
      text: truncate(text, maxChars),
    }
  },
})

const apiRequestTool = defineTool({
  name: 'api_request',
  description: 'Send an HTTP API request and return JSON or text. Use this for GitHub API and other public APIs.',
  schema: z.object({
    url: z.string().url().describe('Public API URL'),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
    headers: z.record(z.string()).optional().describe('Optional request headers'),
    bodyText: z.string().optional().describe('Plain text request body'),
    bodyJson: z.record(z.any()).optional().describe('JSON request body'),
    maxChars: z.number().int().min(500).max(20000).default(6000),
  }),
  execute: async ({ url, method, headers, bodyText, bodyJson, maxChars }) => {
    const safeUrl = ensureSafeHttpUrl(url)
    const nextHeaders: Record<string, string> = {
      'user-agent': 'ai-sdk-deepresearch-demo',
      'accept': 'application/json, text/plain, */*',
      ...(headers || {}),
    }

    let body: string | undefined
    if (bodyJson) {
      nextHeaders['content-type'] = nextHeaders['content-type'] || 'application/json'
      body = JSON.stringify(bodyJson)
    } else if (bodyText) {
      body = bodyText
    }

    const resp = await fetch(safeUrl, {
      method,
      headers: nextHeaders,
      body,
    })

    const contentType = resp.headers.get('content-type') || ''
    const raw = await resp.text()
    let parsed: unknown = null

    if (contentType.includes('json')) {
      try {
        parsed = simplifyValue(JSON.parse(raw))
      } catch {
        parsed = null
      }
    }

    return {
      url: safeUrl,
      finalUrl: resp.url,
      method,
      status: resp.status,
      contentType,
      data: parsed,
      text: parsed ? '' : truncate(cleanWhitespace(raw), maxChars),
    }
  },
})

async function main() {
  const provider = openai({ apiKey, baseURL, model })
  const ai = createAI({ provider })

  const researcher = ai.agent({
    tools: [searchWebTool, fetchPageTool, apiRequestTool],
    maxSteps: 16,
    system: [
      'You are a deep research agent.',
      'You must use tools to gather evidence before answering.',
      'Goal: identify who xiaoyueyoqwq is and estimate their MBTI from public evidence.',
      'Rules:',
      '1. Search first, then fetch pages, then call APIs when useful.',
      '2. Separate confirmed facts from inference.',
      '3. If MBTI is not explicitly stated, say it is an inference only.',
      '4. Cite concrete URLs in the final answer.',
      '5. Prefer public GitHub pages, GitHub API, profile README, personal website, and other public pages.',
      '6. You do not need exhaustive research. Stop as soon as you have enough evidence.',
      '7. Minimum evidence needed before answering: one GitHub profile source, one GitHub API source, one representative project source, and optional one extra web source.',
      '8. After the minimum evidence is collected, answer immediately instead of continuing to search.',
      '9. Only list a fact as confirmed if it appears directly in tool output. If a field is noisy or uncertain, move it to the uncertainty section.',
      '10. Give one primary MBTI guess. You may add one backup guess, but the primary guess must be explicit.',
    ].join('\n'),
    request: {
      temperature: 0.2,
    },
  })

  const prompt = [
    '请你自己使用工具做 deep research，不要假设结论。',
    '研究对象是 XiaoyueyoQwQ，也就是 GitHub 用户 https://github.com/xiaoyueyoqwq 。',
    '目标有两个：',
    '1. 这个人是谁，主要在做什么。',
    '2. 它的 MBTI 是什么，或者如果没有公开自述，就给出“最可能的推测型 MBTI + 依据 + 置信度”。',
    '输出要求：',
    '- 用中文。',
    '- 分成“确认信息”“MBTI 判断”“证据链接”“不确定点”四部分。',
    '- 不要把推测说成事实。',
    '- 确认信息只允许写工具返回里直接出现过的内容。',
    '- MBTI 必须给一个最可能的主判断，必要时再给一个备选。',
  ].join('\n')

  section('Deep Research Agent')
  console.log(color(`baseURL=${baseURL}`, ANSI.gray))
  console.log(color(`model=${model}`, ANSI.gray))
  console.log(color(`target=https://github.com/xiaoyueyoqwq`, ANSI.gray))

  let answer = ''

  for await (const event of researcher.stream(prompt)) {
    switch (event.type) {
      case 'step-start':
        console.log(color(`STEP ${event.step} START`, `${ANSI.bold}${ANSI.cyan}`))
        break
      case 'tool-call':
        console.log(color(`TOOL CALL ${event.tool} ${JSON.stringify(event.args)}`, ANSI.yellow))
        break
      case 'tool-result':
        console.log(color(`TOOL RESULT ${event.tool} ${truncate(JSON.stringify(event.result), 600)} (${event.latency}ms)`, ANSI.green))
        break
      case 'text-delta':
        if (!answer) section('Final Answer Stream')
        answer += event.delta
        process.stdout.write(color(event.delta, `${ANSI.bold}${ANSI.magenta}`))
        break
      case 'step-complete':
        console.log(color(`STEP ${event.step} COMPLETE`, `${ANSI.bold}${ANSI.cyan}`))
        break
      case 'finish':
        console.log('')
        console.log(color(`USAGE ${JSON.stringify(event.usage)}`, ANSI.gray))
        break
      default:
        break
    }
  }

  section('Final Answer')
  console.log(color(answer.trim(), `${ANSI.bold}${ANSI.magenta}`))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
