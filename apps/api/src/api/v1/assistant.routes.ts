import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AssistantService } from '../../application/assistant/assistant-service.js';
import { MAX_HISTORY_CHARS, MAX_MESSAGE_CHARS } from '../../application/assistant/safety.js';
import type { TutorialProgressService } from '../../application/tutorial-progress-service.js';
import { RateLimitedError } from '../../application/rate-limiter.js';
import { tutorialStatuses } from '../../modules/learning/index.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { parseInput } from '../http/validation.js';

/**
 * The help assistant and the tutorial progress of the signed-in member (Help centre). Every route
 * needs a session and an active membership of the current organization; the organization always
 * comes from the session, never from the request.
 */

const TUTORIAL_ID = /^[a-z0-9][a-z0-9-]{0,59}$/;

const turn = z
  .object({
    role: z.enum(['user', 'assistant']),
    content: z.string().max(MAX_HISTORY_CHARS * 2),
  })
  .strict();

const askBody = z
  .object({
    message: z.string().min(1).max(MAX_MESSAGE_CHARS),
    history: z.array(turn).max(10).default([]),
    // The current page, only to pick a fixed help topic. Never stored or logged.
    path: z.string().max(200).optional(),
  })
  .strict();

const tutorialParams = z.object({ tutorialId: z.string().regex(TUTORIAL_ID) }).strict();
const progressBody = z
  .object({
    status: z.enum(tutorialStatuses),
    step: z.number().int().min(0).max(100),
  })
  .strict();

export function registerAssistantRoutes(
  app: FastifyInstance,
  {
    assistant,
    tutorialProgress,
  }: { assistant: AssistantService; tutorialProgress: TutorialProgressService },
) {
  app.get('/assistant/status', async (request) => ({
    data: await assistant.status(requirePrincipal(request)),
  }));

  app.post('/assistant/messages', async (request, reply) => {
    const input = parseInput(askBody, request.body);
    try {
      return {
        data: await assistant.ask(requirePrincipal(request), input, eventOrigin(request)),
      };
    } catch (error) {
      if (error instanceof RateLimitedError) {
        void reply.header('Retry-After', String(error.decision.resetSeconds));
      }
      throw error;
    }
  });

  app.get('/tutorials/progress', async (request) => ({
    data: await tutorialProgress.list(requirePrincipal(request)),
  }));

  app.put('/tutorials/progress/:tutorialId', async (request) => {
    const { tutorialId } = parseInput(tutorialParams, request.params);
    const { status, step } = parseInput(progressBody, request.body);
    return {
      data: await tutorialProgress.set(requirePrincipal(request), tutorialId, { status, step }),
    };
  });

  app.delete('/tutorials/progress/:tutorialId', async (request) => {
    const { tutorialId } = parseInput(tutorialParams, request.params);
    return { data: await tutorialProgress.reset(requirePrincipal(request), tutorialId) };
  });
}
