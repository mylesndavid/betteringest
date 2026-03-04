/**
 * Config — resolution order: defaults → config file → env vars → CLI flags.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const PROVIDERS = {
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'google/gemini-2.0-flash-lite-001' },
  openai:     { baseUrl: 'https://api.openai.com/v1',     defaultModel: 'gpt-4o-mini' },
  groq:       { baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.1-8b-instant' },
  ollama:     { baseUrl: 'http://localhost:11434/v1',       defaultModel: 'llama3.1' },
};

function loadConfigFile() {
  try {
    const path = join(homedir(), '.betteringest', 'config.json');
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
}

export function resolveConfig(cliFlags = {}) {
  const file = loadConfigFile();

  const provider = cliFlags.provider || process.env.BETTERINGEST_PROVIDER || file.provider || 'openrouter';
  const providerDefaults = PROVIDERS[provider] || PROVIDERS.openrouter;

  return {
    provider,
    apiKey: cliFlags.apiKey || process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || file.apiKey || '',
    model: cliFlags.model || process.env.BETTERINGEST_MODEL || file.model || providerDefaults.defaultModel,
    baseUrl: cliFlags.baseUrl || process.env.BETTERINGEST_BASE_URL || file.baseUrl || providerDefaults.baseUrl,
    output: cliFlags.output || './graph.json',
    maxConcurrent: parseInt(cliFlags.maxConcurrent) || file.maxConcurrent || 3,
    chunkSize: parseInt(cliFlags.chunkSize) || file.chunkSize || 6000,
    yes: !!cliFlags.yes,
    dryRun: !!cliFlags.dryRun,
    verbose: !!cliFlags.verbose,
  };
}
