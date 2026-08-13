import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';

export const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Sonnet for scoring/letters (nuance), Haiku for fast classification.
export const MODEL_SMART = 'claude-sonnet-4-6';
export const MODEL_FAST = 'claude-haiku-4-5';

export function textOf(res) {
  return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

// The prompts demand bare JSON, but strip code fences defensively.
export function jsonOf(res) {
  return JSON.parse(textOf(res).replace(/```json|```/g, '').trim());
}
