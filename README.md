# @sdjz/ai-sdk

Lightweight AI SDK for JavaScript/TypeScript.

## Installation

```bash
npm install @sdjz/ai-sdk
```

## Usage

```ts
import { createAI } from '@sdjz/ai-sdk'
import { openai } from '@sdjz/ai-sdk-provider-openai'

const provider = openai({
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-4o-mini',
})

const ai = createAI({ provider })
const result = await ai.chat('Hello')

console.log(result.text)
```

## API

- `createAI(options)`
- `generateText(options)`
- `streamText(options)`

## License

MIT
