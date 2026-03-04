/**
 * Stripped OpenAI-compatible provider. Request/response only, no streaming.
 */

async function fetchWithRetry(url, options, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, options);
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (res.status === 429 && i < retries) {
          const wait = Math.pow(2, i + 1) * 1000;
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        throw new Error(`API ${res.status}: ${body.slice(0, 200)}`);
      }
      return res;
    } catch (err) {
      if (i === retries) throw err;
      await new Promise(r => setTimeout(r, Math.pow(2, i) * 1000));
    }
  }
}

export async function chat(config, messages, { maxTokens = 1024, temperature = 0.1 } = {}) {
  const res = await fetchWithRetry(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      max_tokens: maxTokens,
      temperature,
    }),
  });

  const json = await res.json();
  const choice = json.choices?.[0];
  if (!choice) throw new Error('No response from API');

  return {
    content: choice.message?.content || '',
    usage: json.usage || {},
  };
}
