import { vi } from 'vitest';
import { makeSession } from './fake-api';

/**
 * A fetch stub for the Help centre and assistant tests: the session, the module switches, tutorial
 * progress (kept in memory like the server would) and a programmable assistant. Records every
 * request so tests can assert on what the browser sent.
 */

export interface StubProgress {
  tutorialId: string;
  status: 'in_progress' | 'completed' | 'skipped';
  currentStep: number;
  startedAt: string;
  completedAt: string | null;
  updatedAt: string;
}

export interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

export interface HelpStubOptions {
  permissions?: string[];
  modules?: { payroll: boolean; projects: boolean; clinic: boolean };
  progress?: StubProgress[];
  /** Fails the progress calls (load and save) with a 500. */
  progressFails?: boolean;
  mode?: 'documentation' | 'ai';
  /** Answers POST /assistant/messages: a body to return with 200, or a Response. */
  assistant?: (request: { body: Record<string, unknown>; count: number }) => unknown;
}

export const progressRow = (
  tutorialId: string,
  status: StubProgress['status'],
  currentStep = 0,
): StubProgress => ({
  tutorialId,
  status,
  currentStep,
  startedAt: '2026-10-01T00:00:00.000Z',
  completedAt: status === 'completed' ? '2026-10-02T00:00:00.000Z' : null,
  updatedAt: '2026-10-02T00:00:00.000Z',
});

export const reply = (over: Record<string, unknown> = {}) => ({
  reply: 'Open Sales > Invoices and choose New invoice.',
  mode: 'documentation',
  degraded: false,
  notice: null,
  figures: [],
  unavailable: [],
  sources: [],
  generatedAt: '2026-10-25T00:00:00.000Z',
  ...over,
});

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

export function stubHelpApi(options: HelpStubOptions = {}) {
  const state = {
    requests: [] as Recorded[],
    progress: [...(options.progress ?? [])],
    questions: 0,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = new URL(String(input), 'http://localhost').pathname.replace(/^\/api\/v1/, '');
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      state.requests.push({ method, path, body });

      if (path === '/auth/session') {
        return json(200, {
          data: makeSession(options.permissions ? { permissions: options.permissions } : {}),
        });
      }
      if (path === '/organizations/current/modules') {
        return json(200, {
          data: { modules: options.modules ?? { payroll: false, projects: false, clinic: false } },
        });
      }
      if (path === '/assistant/status') {
        return json(200, {
          data: {
            mode: options.mode ?? 'documentation',
            provider: options.mode === 'ai' ? 'anthropic' : 'documentation',
            suggestions: ['How do I create and issue an invoice?', 'What can each role do?'],
            limits: { maxMessageChars: 2000 },
          },
        });
      }
      if (path === '/assistant/messages' && method === 'POST') {
        state.questions += 1;
        const result = options.assistant
          ? options.assistant({ body, count: state.questions })
          : reply();
        return result instanceof Response ? result : json(200, { data: result });
      }
      if (path.startsWith('/tutorials/progress')) {
        if (options.progressFails) {
          return json(500, {
            error: { code: 'INTERNAL', message: 'Server error', requestId: 'r' },
          });
        }
        if (method === 'GET') return json(200, { data: { items: state.progress } });
        const id = path.split('/').pop()!;
        if (method === 'PUT') {
          const row = progressRow(id, body.status, body.step);
          state.progress = [...state.progress.filter((p) => p.tutorialId !== id), row];
          return json(200, { data: { progress: row } });
        }
        if (method === 'DELETE') {
          state.progress = state.progress.filter((p) => p.tutorialId !== id);
          return json(200, { data: { reset: true } });
        }
      }
      return json(404, { error: { code: 'NOT_FOUND', message: 'Not found', requestId: 'r' } });
    }),
  );
  return state;
}
