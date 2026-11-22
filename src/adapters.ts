import { validateProposal } from './runtime.ts';
import type { Proposal } from './runtime.ts';
export interface Planner { propose(intent: string): Promise<Proposal> }
export class OfflinePlanner implements Planner {
  async propose(intent: string): Promise<Proposal> { return validateProposal({ key: 'demo/result', value: intent }); }
}
export type Transport = (url: string, init: { method: string; headers: Record<string,string>; body: string }) => Promise<{ ok: boolean; json(): Promise<any> }>;
const instruction = 'Propose only. Return a JSON object with exactly key and value (strings). Key must be demo/result. No tools or commands.';
// No implicit fetch, environment credentials, or default network connector.
// The embedding host must explicitly supply a transport and credentials.
export class ProviderPlanner implements Planner {
  #provider: 'openai' | 'anthropic'; #model: string; #key: string; #transport: Transport;
  constructor(provider: 'openai' | 'anthropic', model: string, key: string, transport: Transport) {
    if (!['openai','anthropic'].includes(provider) || !model || !key || typeof transport !== 'function') throw Error('Explicit provider configuration required');
    this.#provider = provider; this.#model = model; this.#key = key; this.#transport = transport;
  }
  async propose(intent: string): Promise<Proposal> {
    const openai = this.#provider === 'openai';
    const response = await this.#transport(openai ? 'https://api.openai.com/v1/chat/completions' : 'https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: openai ? { 'content-type': 'application/json', authorization: `Bearer ${this.#key}` } :
        { 'content-type': 'application/json', 'x-api-key': this.#key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(openai ? { model: this.#model, messages: [{ role:'system',content: instruction },{ role:'user',content: intent }] } :
        { model: this.#model, max_tokens: 1024, system: instruction, messages: [{ role:'user',content: intent }] })
    });
    if (!response.ok) throw Error('Provider request failed');
    const data = await response.json();
    const text = openai ? data.choices?.[0]?.message?.content : data.content?.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    if (typeof text !== 'string' || text.length > 16384) throw Error('Invalid provider response');
    return validateProposal(JSON.parse(text));
  }
}
