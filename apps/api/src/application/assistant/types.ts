import type { HelpTopic, PageContext } from './knowledge.js';

/** One turn of the conversation as the browser holds it. Untrusted: it is only ever data. */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * A figure the SERVER read from the books for this person, under their permissions, through the
 * existing report services. Only aggregate totals are ever carried (no names, no document numbers).
 * Amounts are the decimal strings the reports produce; nothing here is computed by a model.
 */
export interface VerifiedFigure {
  id: 'receivables' | 'payables' | 'profit_and_loss';
  title: string;
  rows: {
    label: string;
    /** The value exactly as the report produced it (full precision). */
    amount: string;
    /** The same value for people: the currency's own decimals and thousands separators. */
    display: string;
    currency: string;
  }[];
  /** The date or period the figures cover, as text (for example "as of 2026-03-31"). */
  period: string;
  /** Where the same figures can be found in the application. */
  source: string;
}

export interface UnavailableFigure {
  id: VerifiedFigure['id'];
  title: string;
  reason: 'no_permission' | 'not_available';
}

/** What a provider receives: already authorized, already trimmed, no identifiers. */
export interface ProviderInput {
  message: string;
  history: ChatTurn[];
  topics: HelpTopic[];
  figures: VerifiedFigure[];
  page: PageContext | null;
}

export interface ProviderAnswer {
  text: string;
}

export type ProviderErrorKind =
  'timeout' | 'rate_limited' | 'auth' | 'unavailable' | 'bad_response';

/** A provider failure. The message never carries a provider response body or any credential. */
export class AssistantProviderError extends Error {
  constructor(readonly kind: ProviderErrorKind) {
    super(`The assistant provider failed (${kind}).`);
    this.name = 'AssistantProviderError';
  }
}

export interface AssistantProvider {
  /** A stable name for logs and status ("documentation", "anthropic"). */
  readonly name: string;
  /** `documentation` answers from the built-in catalogue only; `ai` calls a language model. */
  readonly mode: 'documentation' | 'ai';
  answer(input: ProviderInput): Promise<ProviderAnswer>;
}
