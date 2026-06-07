import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';

const FALLBACK_CLAUDE_MODELS = [
  'claude-opus-4-5',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
];

export async function fetchClaudeModels(apiKey: string): Promise<string[]> {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/models',
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    }, (res) => {
      let data = '';
      res.on('data', (c: Buffer) => (data += c.toString()));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const ids: string[] = (json.data as { id: string }[])
            .map((m) => m.id)
            .filter((id) => id.startsWith('claude-'));
          resolve(ids.length ? ids : FALLBACK_CLAUDE_MODELS);
        } catch {
          resolve(FALLBACK_CLAUDE_MODELS);
        }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve(FALLBACK_CLAUDE_MODELS); });
    req.on('error', () => resolve(FALLBACK_CLAUDE_MODELS));
    req.end();
  });
}

export async function fetchOllamaModels(baseUrl: string): Promise<string[]> {
  const url = new globalThis.URL('/api/tags', baseUrl);
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    transport
      .get(url.toString(), (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk.toString()));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve((json.models as { name: string }[]).map((m) => m.name));
          } catch {
            resolve([]);
          }
        });
      })
      .on('error', () => resolve([]));
  });
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type InterviewerMode = 'harsh' | 'hint' | 'followup';

const SYSTEM_PROMPTS: Record<InterviewerMode, string> = {
  harsh: `You are a senior engineer conducting a live technical interview. You are direct, impatient, and hold extremely high standards. You are NOT a tutor or an assistant.

Behave exactly like a real interviewer sitting across the table:
- React to what you actually see in the code. Say things like "I'm looking at this loop here — walk me through why you did it this way" or "This doesn't handle the case where the input is empty. Did you consider that?"
- Be skeptical. When something looks wrong or naive, say so plainly: "This is O(n²). That's not going to work at scale."
- Do NOT offer solutions or hints. If they're stuck, make them work for it: "You tell me — what's wrong with this approach?"
- When something is flat-out wrong, say it's wrong and demand they explain themselves before moving on
- React to progress too — if something improved since last time, note it briefly then move on
- Keep responses tight. You're not writing an essay — you're in a room with someone. 2–4 sentences per point max.
- Never use bullet lists in your response. Speak like a person.`,

  hint: `You are a senior engineer conducting a live technical interview. You want the candidate to succeed, but you're not going to hold their hand — you're going to guide them like a good mentor would in a real interview.

Behave like a real interviewer, not a help assistant:
- React to what you see. "I notice you're iterating over the array twice here — is that intentional?" or "Okay, this part looks solid. What's your plan for the edge cases?"
- When they're on the right track, acknowledge it briefly and push forward: "Good, that handles the basic case. What about duplicates?"
- When they're stuck or going the wrong direction, give a nudge toward the right thinking — not the answer. "Think about what data structure would give you O(1) lookup here."
- Ask them to explain their reasoning. "Why did you choose this approach over a hashmap?"
- Keep responses conversational, 2–4 sentences. No bullet lists. Talk like you're in the room with them.`,

  followup: `You are a senior engineer conducting a live technical interview. Your style is Socratic — you never give answers, only questions that force the candidate to think harder and expose gaps in their understanding.

Behave like a real interviewer who is genuinely probing, not a chatbot running through a checklist:
- React to the actual code in front of you. "I see you're using a nested loop here. What's the time complexity of that?" Don't ask generic questions — ask about THIS code.
- After any explanation they give, dig deeper immediately: "Okay, and what happens when the array has 10 million elements?" or "You said it's O(n) — walk me through exactly why."
- Circle back to contradictions: "Earlier you said you wanted to avoid extra space, but now you're using a second array. What changed?"
- Never validate or correct them directly — respond to every answer with another question
- Maximum 2 questions per response. Stay focused.
- No bullet lists. Speak like you're sitting across from them.`,
};

const SYSTEM_SEEDS: Record<InterviewerMode, ChatMessage[]> = {
  harsh: [
    { role: 'user', content: SYSTEM_PROMPTS.harsh },
    { role: 'assistant', content: "Let's see what you've got." },
  ],
  hint: [
    { role: 'user', content: SYSTEM_PROMPTS.hint },
    { role: 'assistant', content: "Alright, let's take a look at where you are." },
  ],
  followup: [
    { role: 'user', content: SYSTEM_PROMPTS.followup },
    { role: 'assistant', content: "Okay. Before I say anything, tell me — what's your approach here?" },
  ],
};

export async function callAi(
  messages: ChatMessage[],
  onChunk: (text: string) => void,
  token: vscode.CancellationToken,
  mode: InterviewerMode = 'hint',
  apiKey = ''
): Promise<void> {
  const fullMessages = [...SYSTEM_SEEDS[mode], ...messages];
  const config = vscode.workspace.getConfiguration('mockInterview');
  const provider = config.get<string>('aiProvider', 'vscode-lm');

  if (provider === 'vscode-lm') {
    await callVsCodeLm(fullMessages, onChunk, token);
  } else if (provider === 'claude') {
    await callClaude(fullMessages, apiKey, config.get<string>('claudeModel', 'claude-sonnet-4-5'), onChunk, token);
  } else if (provider === 'ollama') {
    await callOllama(
      fullMessages,
      config.get<string>('ollamaModel', 'llama3'),
      config.get<string>('ollamaUrl', 'http://localhost:11434'),
      onChunk,
      token
    );
  }
}

async function callVsCodeLm(
  messages: ChatMessage[],
  onChunk: (text: string) => void,
  token: vscode.CancellationToken
): Promise<void> {
  const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  if (!models.length) {
    onChunk('> No GitHub Copilot model available. Set `mockInterview.aiProvider` in settings.');
    return;
  }
  const model = models[0];
  const lmMessages = messages.map((m) =>
    m.role === 'user'
      ? vscode.LanguageModelChatMessage.User(m.content)
      : vscode.LanguageModelChatMessage.Assistant(m.content)
  );
  const response = await model.sendRequest(lmMessages, {}, token);
  for await (const chunk of response.text) {
    if (token.isCancellationRequested) break;
    onChunk(chunk);
  }
}

async function callClaude(
  messages: ChatMessage[],
  apiKey: string,
  model: string,
  onChunk: (text: string) => void,
  token: vscode.CancellationToken
): Promise<void> {
  if (!apiKey) { onChunk('> Run **Mock Interview: Setup Claude** to add your API key.'); return; }
  const body = JSON.stringify({
    model,
    max_tokens: 4096,
    stream: true,
    messages,
  });
  await streamRequest(https, {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
  }, body, (line) => {
    if (line.startsWith('data: ')) {
      try {
        const data = JSON.parse(line.slice(6));
        if (data.type === 'content_block_delta') onChunk(data.delta?.text ?? '');
      } catch {}
    }
  }, token);
}

async function callOllama(
  messages: ChatMessage[],
  model: string,
  baseUrl: string,
  onChunk: (text: string) => void,
  token: vscode.CancellationToken
): Promise<void> {
  const url = new globalThis.URL('/api/chat', baseUrl);
  // qwen3 and other thinking models: disable thinking to get faster responses
  const body = JSON.stringify({
    model,
    stream: true,
    messages,
    options: { num_ctx: 4096 },
    think: false,
  });
  const transport = url.protocol === 'https:' ? https : http;
  const port = url.port ? parseInt(url.port) : (url.protocol === 'https:' ? 443 : 11434);
  await streamRequest(transport, {
    hostname: url.hostname,
    port,
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body, (line) => {
    if (!line.trim()) return;
    try {
      const data = JSON.parse(line);
      if (data.error) throw new Error(data.error);
      // Skip thinking content, only emit message content
      const content = data.message?.content ?? '';
      if (content) onChunk(content);
    } catch (e) {
      if (e instanceof Error && e.message !== 'Unexpected end of JSON input') {
        throw e;
      }
    }
  }, token);
}

function streamRequest(
  transport: typeof http | typeof https,
  options: http.RequestOptions,
  body: string,
  onLine: (line: string) => void,
  token: vscode.CancellationToken
): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = transport.request(options, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        let errBody = '';
        res.on('data', (c: Buffer) => errBody += c.toString());
        res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${errBody.slice(0, 200)}`)));
        return;
      }
      let buffer = '';
      res.on('data', (chunk: Buffer) => {
        if (token.isCancellationRequested) { res.destroy(); resolve(); return; }
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        lines.forEach(onLine);
      });
      res.on('end', resolve);
      res.on('error', reject);
    });
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('Request timed out after 120s')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
