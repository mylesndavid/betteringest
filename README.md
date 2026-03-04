# betteringest

Zero-dependency CLI to bulk-ingest files into a knowledge graph. Powered by cheap LLMs.

```
npx betteringest ./docs/ -o knowledge.json
npx betteringest ui
```

## What it does

Reads files (text, markdown, JSON, CSV, zip, or piped stdin), splits them into smart chunks (chat-aware, markdown-aware), sends each chunk to a cheap LLM for structured extraction, deduplicates entities across chunks, and outputs a MiniGraph-compatible JSON knowledge graph.

## Install

```bash
npm i -g betteringest
```

## Usage

```bash
# Ingest files or directories
betteringest ./notes/ ./data.csv -o graph.json

# Ingest from stdin
cat chat.txt | betteringest --stdin -o graph.json

# Web UI — upload files, run ingestion, visualize the graph
betteringest ui

# Cost estimate without processing
betteringest --dry-run ./big-folder/

# Utility commands
betteringest stats graph.json
betteringest search graph.json "some query"
betteringest merge a.json b.json -o combined.json
betteringest export graph.json --dot | dot -Tpng -o graph.png
```

## Configuration

Set your API key (supports OpenRouter, OpenAI, Groq, Ollama):

```bash
export OPENROUTER_API_KEY=sk-or-...
```

Or use `--api-key`, or create `~/.betteringest/config.json`:

```json
{
  "apiKey": "sk-or-...",
  "provider": "openrouter",
  "model": "google/gemini-2.0-flash-lite-001"
}
```

## Options

```
-o, --output <path>      Output graph file (default: ./graph.json)
-k, --api-key <key>      API key
-m, --model <model>      Model (default: gemini-flash-lite)
-p, --provider <name>    openrouter, openai, groq, ollama
--base-url <url>         Custom API base URL
--max-concurrent <n>     Parallel LLM calls (default: 3)
--chunk-size <tokens>    Max tokens per chunk (default: 6000)
--yes                    Skip cost confirmation
--dry-run                Show cost estimate only
--verbose                Per-chunk extraction details
```

## Features

- **Zero npm dependencies** — Node.js built-ins only
- **Chat-aware chunking** — auto-detects WhatsApp/chat format, groups by conversation segments
- **Markdown-aware** — splits on headers, preserves section context
- **Structured data** — JSON arrays and CSV chunk intelligently
- **Resume/incremental** — re-run skips already-processed chunks
- **Cross-chunk dedup** — alias-based entity merging
- **Rich relationships** — LLM extracts WORKS_ON, COLLABORATES, MANAGES, BLOCKED_BY, etc.
- **Web UI** — upload, ingest, and explore with force-directed graph visualization
- **BetterBot compatible** — output drops directly into `~/.betterbot/graph/`

## Cost

Uses the cheapest available models. With Gemini Flash Lite on OpenRouter:
- ~$0.03 per 100 chunks
- A 2000-line WhatsApp chat (~200 chunks) costs ~$0.02

## License

MIT
