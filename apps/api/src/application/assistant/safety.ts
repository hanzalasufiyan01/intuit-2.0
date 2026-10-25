import type { ChatTurn } from './types.js';

/** Limits shared by the route's schema and the service, so one change cannot leave a gap. */
export const MAX_MESSAGE_CHARS = 2000;
export const MAX_HISTORY_TURNS = 8;
export const MAX_HISTORY_CHARS = 1500;
export const MAX_REPLY_CHARS = 4000;

// Everything below space except tab, newline and carriage return, plus DEL.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Plain text only: control characters removed, line endings normalized, trimmed, bounded. */
export function cleanText(value: string, max: number): string {
  const text = value.replace(CONTROL_CHARACTERS, '').replace(/\r\n?/g, '\n').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * The conversation sent along with a question: the most recent turns, each cleaned and bounded,
 * starting with a person's turn, with neighbouring turns of the same speaker merged (the model APIs
 * expect alternating speakers). The browser can send anything, so this is data, never instructions.
 */
export function prepareHistory(turns: readonly ChatTurn[]): ChatTurn[] {
  const recent = turns
    .slice(-MAX_HISTORY_TURNS)
    .map((t) => ({ role: t.role, content: cleanText(t.content, MAX_HISTORY_CHARS) }))
    .filter((t) => t.content.length > 0);
  while (recent.length > 0 && recent[0]!.role !== 'user') recent.shift();
  const merged: ChatTurn[] = [];
  for (const turn of recent) {
    const last = merged.at(-1);
    if (last && last.role === turn.role) last.content = `${last.content}\n\n${turn.content}`;
    else merged.push({ ...turn });
  }
  return merged;
}

/**
 * Model output is untrusted. It is shown as plain text (the web page never interprets it as
 * markup), and here it is cleaned of control characters, collapsed and bounded. Returns null when
 * nothing usable is left, so the caller can fall back to the built-in answer.
 */
export function sanitizeModelOutput(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const cleaned = cleanText(text, MAX_REPLY_CHARS).replace(/\n{3,}/g, '\n\n');
  return cleaned.length > 0 ? cleaned : null;
}
