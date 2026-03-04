/**
 * Token estimation + cost display.
 */
import { createInterface } from 'node:readline';

// Approximate costs per million tokens (USD)
const MODEL_COSTS = {
  'google/gemini-2.0-flash-lite-001': { input: 0.04, output: 0.15 },
  'google/gemini-2.0-flash-001': { input: 0.10, output: 0.40 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'llama-3.1-8b-instant': { input: 0.05, output: 0.08 },
};

export function estimateCost(chunks, model) {
  const costs = MODEL_COSTS[model] || { input: 0.10, output: 0.40 };
  let totalInputTokens = 0;
  for (const chunk of chunks) {
    totalInputTokens += Math.ceil(chunk.text.length / 4);
  }
  // ~500 output tokens per chunk (extraction response)
  const totalOutputTokens = chunks.length * 500;
  // ~300 tokens for system prompt
  const systemTokens = chunks.length * 300;

  const inputCost = ((totalInputTokens + systemTokens) / 1_000_000) * costs.input;
  const outputCost = (totalOutputTokens / 1_000_000) * costs.output;

  return {
    chunks: chunks.length,
    inputTokens: totalInputTokens + systemTokens,
    outputTokens: totalOutputTokens,
    estimatedCost: inputCost + outputCost,
    model,
  };
}

export function formatCost(estimate) {
  const lines = [
    `  Chunks:        ${estimate.chunks}`,
    `  Input tokens:  ~${estimate.inputTokens.toLocaleString()}`,
    `  Output tokens: ~${estimate.outputTokens.toLocaleString()}`,
    `  Model:         ${estimate.model}`,
    `  Est. cost:     $${estimate.estimatedCost.toFixed(4)}`,
  ];
  return lines.join('\n');
}

export async function confirmCost(estimate) {
  process.stderr.write('\n' + formatCost(estimate) + '\n\n');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(resolve => {
    rl.question('  Proceed? [Y/n] ', answer => {
      rl.close();
      resolve(!answer || answer.toLowerCase().startsWith('y'));
    });
  });
}
