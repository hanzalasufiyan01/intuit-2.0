import { ValidationError } from '../../domain/errors.js';
import { recordAuditEvent, type EventOrigin } from '../../modules/audit/index.js';
import type { Principal } from '../authorization.js';
import type { AppDependencies } from '../dependencies.js';
import { withOrganization } from '../organization-service.js';
import { RateLimitedError, type RateLimiter } from '../rate-limiter.js';
import {
  resolvePage,
  selectTopics,
  SUGGESTED_QUESTIONS,
  topicById,
  type HelpTopic,
} from './knowledge.js';
import { DocumentationProvider } from './provider.js';
import { cleanText, MAX_MESSAGE_CHARS, prepareHistory } from './safety.js';
import { buildSummaries, detectSummaryKinds, type SummarySources } from './summaries.js';
import {
  AssistantProviderError,
  type AssistantProvider,
  type ChatTurn,
  type UnavailableFigure,
  type VerifiedFigure,
} from './types.js';

export interface AssistantReply {
  reply: string;
  /** `documentation`: the built-in catalogue answered. `ai`: a language model wrote the wording. */
  mode: 'documentation' | 'ai';
  /** True when a live model was configured but could not answer, so the catalogue answered. */
  degraded: boolean;
  notice: string | null;
  /** Figures read from the books by the server for this request (never produced by a model). */
  figures: VerifiedFigure[];
  unavailable: UnavailableFigure[];
  sources: { topicId: string; title: string; route: string | null; tutorialId: string | null }[];
  generatedAt: string;
}

export interface AssistantStatus {
  mode: 'documentation' | 'ai';
  provider: string;
  suggestions: readonly string[];
  limits: { maxMessageChars: number };
}

export interface AssistantServiceOptions {
  provider: AssistantProvider;
  rateLimiter: RateLimiter;
  sources: SummarySources;
}

const DEGRADED_NOTICE =
  'The AI service could not answer just now, so this reply comes from the built-in help catalogue.';
const DOCUMENTATION_NOTICE =
  'AI wording is not enabled on this server. Replies come from the built-in help catalogue.';

const NOTE_NO_PERMISSION = 'You do not have permission to view this figure.';
const NOTE_NOT_AVAILABLE =
  'This figure is not available right now (the books may not be set up yet).';

/**
 * The in-app help assistant. It explains the product from the help catalogue and may quote the
 * member's own aggregate figures, read through the existing report services under their own
 * permissions. It changes no financial record. Its only database writes are:
 *  - the rate-limit counters (`api_rate_windows`: one per member and one per organization per
 *    minute), written before any other work;
 *  - one audit event, `assistant.financial_summary_shown`, when figures were produced (kinds and
 *    mode only, never amounts or the question), written in the same transaction as the reads;
 *  - transaction-local savepoints while figures are read (nothing persistent).
 * No message text, answer or figure is stored.
 */
export class AssistantService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly options: AssistantServiceOptions,
  ) {}

  /** What the panel needs to describe itself honestly: which mode this server runs in. */
  status(principal: Principal): Promise<AssistantStatus> {
    return withOrganization(this.deps, principal, { readOnlySnapshot: true }, async () => ({
      mode: this.options.provider.mode,
      provider: this.options.provider.name,
      suggestions: SUGGESTED_QUESTIONS,
      limits: { maxMessageChars: MAX_MESSAGE_CHARS },
    }));
  }

  async ask(
    principal: Principal,
    input: { message: string; history: ChatTurn[]; path?: string | undefined },
    origin: EventOrigin,
  ): Promise<AssistantReply> {
    const message = cleanText(input.message, MAX_MESSAGE_CHARS);
    if (message.length === 0) {
      throw new ValidationError([{ path: 'message', message: 'Enter a question.' }]);
    }
    await this.enforceLimits(principal);

    const history = prepareHistory(input.history);
    const page = resolvePage(input.path);
    const kinds = detectSummaryKinds(message);
    let topics = selectTopics(message, page, kinds.length > 0);
    if (topics.length === 0 && page && /\b(this|here|page|screen)\b/i.test(message)) {
      const pageTopic = topicById(page.topicId);
      if (pageTopic) topics = [pageTopic];
    }

    // One short transaction: membership and role are re-checked, and any figures are read under the
    // member's own permissions. It is released before the provider is called.
    const { figures, unavailable } = await withOrganization(
      this.deps,
      principal,
      {},
      async (tx, ctx) => {
        if (kinds.length === 0) return { figures: [], unavailable: [] };
        const today = this.deps.clock.now().toISOString().slice(0, 10);
        const result = await buildSummaries(kinds, this.options.sources, tx, ctx, today);
        if (result.figures.length > 0) {
          // Who looked at financial figures through the assistant; kinds only, never amounts.
          await recordAuditEvent(tx, {
            occurredAt: this.deps.clock.now(),
            organizationId: ctx.organizationId,
            actorUserId: ctx.userId,
            action: 'assistant.financial_summary_shown',
            resourceType: 'assistant',
            resourceId: null,
            metadata: { kinds: result.figures.map((f) => f.id), mode: this.options.provider.mode },
            origin,
          });
        }
        return result;
      },
    );

    const providerInput = { message, history, topics, figures, page };
    let mode = this.options.provider.mode;
    let degraded = false;
    let text: string;
    try {
      text = (await this.options.provider.answer(providerInput)).text;
    } catch (error) {
      if (!(error instanceof AssistantProviderError)) {
        // Unexpected: log the kind of failure only (no message, no body, no key) and fall back.
        this.deps.logger.error(
          { provider: this.options.provider.name },
          'assistant provider crashed',
        );
      } else {
        this.deps.logger.warn(
          { provider: this.options.provider.name, kind: error.kind },
          'assistant provider failed; using the help catalogue',
        );
      }
      text = (await new DocumentationProvider().answer(providerInput)).text;
      mode = 'documentation';
      degraded = true;
    }

    if (unavailable.length > 0) {
      const lines = unavailable.map(
        (u) =>
          `${u.title}: ${u.reason === 'no_permission' ? NOTE_NO_PERMISSION : NOTE_NOT_AVAILABLE}`,
      );
      text = `${text}\n\n${lines.join('\n')}`;
    }

    return {
      reply: text,
      mode,
      degraded,
      notice: degraded ? DEGRADED_NOTICE : mode === 'documentation' ? DOCUMENTATION_NOTICE : null,
      figures,
      unavailable,
      sources: topics.map((t: HelpTopic) => ({
        topicId: t.id,
        title: t.title,
        route: t.route ?? null,
        tutorialId: t.tutorialId ?? null,
      })),
      generatedAt: this.deps.clock.now().toISOString(),
    };
  }

  /**
   * Per-member and per-organization limits, counted before any other work or provider call.
   * The member's own budget is spent first. The organization's budget is spent only after the
   * member's CURRENT active membership has been confirmed (roles and status are read from the
   * database, not from the session), and for the organization that membership resolves to: a person
   * who has left or been disabled cannot use up an organization's budget.
   */
  private async enforceLimits(principal: Principal): Promise<void> {
    const { assistant } = this.deps.config;
    const user = await this.options.rateLimiter.consume(
      `assistant:u:${principal.user.id}`,
      assistant.userPerMinute,
    );
    if (!user.allowed) throw new RateLimitedError(user);
    const organizationId = await withOrganization(
      this.deps,
      principal,
      { readOnlySnapshot: true },
      async (_tx, ctx) => ctx.organizationId,
    );
    const org = await this.options.rateLimiter.consume(
      `assistant:o:${organizationId}`,
      assistant.orgPerMinute,
    );
    if (!org.allowed) throw new RateLimitedError(org);
  }
}
