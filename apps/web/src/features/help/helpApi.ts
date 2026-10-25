import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/auth-context';
import { api } from '../../services/api-client';

export type TutorialStatus = 'in_progress' | 'completed' | 'skipped';

export interface TutorialProgress {
  tutorialId: string;
  status: TutorialStatus;
  currentStep: number;
  startedAt: string;
  completedAt: string | null;
  updatedAt: string;
}

/** Progress belongs to one member of one organization, so the cache key carries both. */
function useProgressKey() {
  const { session, activeOrganization } = useAuth();
  return [
    'tutorial-progress',
    session?.user.id ?? 'none',
    activeOrganization?.id ?? 'none',
  ] as const;
}

export function useTutorialProgress() {
  const key = useProgressKey();
  return useQuery({
    queryKey: key,
    queryFn: () => api.get<{ items: TutorialProgress[] }>('/tutorials/progress'),
  });
}

export function useSaveTutorialProgress() {
  const key = useProgressKey();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { tutorialId: string; status: TutorialStatus; step: number }) =>
      api.put<{ progress: TutorialProgress }>(`/tutorials/progress/${input.tutorialId}`, {
        status: input.status,
        step: input.step,
      }),
    onSuccess: ({ progress }) => {
      client.setQueryData<{ items: TutorialProgress[] }>(key, (current) => ({
        items: [
          ...(current?.items ?? []).filter((p) => p.tutorialId !== progress.tutorialId),
          progress,
        ],
      }));
    },
  });
}

export interface AssistantFigure {
  id: string;
  title: string;
  rows: { label: string; amount: string; display?: string; currency: string }[];
  period: string;
  source: string;
}

export interface AssistantReply {
  reply: string;
  mode: 'documentation' | 'ai';
  degraded: boolean;
  figures: AssistantFigure[];
  unavailable: { id: string; title: string; reason: string }[];
  sources: { topicId: string; title: string; route: string | null; tutorialId: string | null }[];
  generatedAt: string;
}

export interface AssistantStatus {
  mode: 'documentation' | 'ai';
  provider: string;
  suggestions: string[];
  limits: { maxMessageChars: number };
}

export function useAssistantStatus(enabled: boolean) {
  const { session, activeOrganization } = useAuth();
  return useQuery({
    queryKey: ['assistant-status', session?.user.id ?? 'none', activeOrganization?.id ?? 'none'],
    enabled,
    queryFn: () => api.get<AssistantStatus>('/assistant/status'),
    staleTime: 5 * 60_000,
  });
}

export interface AssistantTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Sends a question with the recent conversation. The server decides everything else. */
export function askAssistant(input: { message: string; history: AssistantTurn[]; path: string }) {
  return api.post<AssistantReply>('/assistant/messages', input);
}
