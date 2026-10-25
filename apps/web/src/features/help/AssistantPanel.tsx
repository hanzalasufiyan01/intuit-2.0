import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
  type ReactNode,
} from 'react';
import { Link, useLocation } from 'react-router';
import { useT } from '../../i18n/i18n';
import { ApiError } from '../../services/api-client';
import { Alert } from '../../shared/ui/Alert';
import { Badge } from '../../shared/ui/Badge';
import { Button } from '../../shared/ui/Button';
import { Dialog } from '../../shared/ui/Dialog';
import { Spinner } from '../../shared/ui/Spinner';
import { askAssistant, useAssistantStatus, type AssistantReply } from './helpApi';
import { tutorialById, tutorialKey } from './tutorials';

/**
 * The assistant panel. The conversation lives in this component's memory only: it is not stored,
 * and the provider is keyed by user and organization (see AppLayout), so signing out or switching
 * organization starts a fresh one. The server decides what the answer may contain; the browser
 * shows model text as plain text and never as markup.
 */

const MAX_CHARS = 2000;

interface Message {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  reply?: AssistantReply;
}

type Failure = { kind: 'rate_limited'; seconds: number } | { kind: 'generic' };

interface AssistantApi {
  openAssistant: () => void;
}

const AssistantContext = createContext<AssistantApi>({ openAssistant: () => {} });

export function useAssistant(): AssistantApi {
  return useContext(AssistantContext);
}

export function AssistantProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const api = useMemo(() => ({ openAssistant: () => setOpen(true) }), []);
  return (
    <AssistantContext.Provider value={api}>
      {children}
      <AssistantConversation open={open} onClose={() => setOpen(false)} />
    </AssistantContext.Provider>
  );
}

/** The top-bar button that opens the panel. */
export function AssistantButton() {
  const t = useT();
  const { openAssistant } = useAssistant();
  return (
    <Button
      variant="secondary"
      onClick={openAssistant}
      aria-haspopup="dialog"
      aria-label={t('help.assistant.openLabel')}
    >
      {t('help.assistant.open')}
    </Button>
  );
}

/** Holds the conversation (kept while the panel is closed) and shows the dialog when open. */
function AssistantConversation({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const { pathname } = useLocation();
  const status = useAssistantStatus(open);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const nextId = useRef(1);
  // Bumped when the conversation is cleared, so a late answer to an old question is dropped.
  const generation = useRef(0);

  const request = (question: string, history: Message[], withUserMessage: boolean) => {
    const mine = generation.current;
    setFailure(null);
    setPending(true);
    if (withUserMessage) {
      setMessages((all) => [...all, { id: nextId.current++, role: 'user', content: question }]);
    }
    askAssistant({
      message: question,
      history: history.map((m) => ({ role: m.role, content: m.content })),
      path: pathname,
    })
      .then((reply) => {
        if (generation.current !== mine) return;
        setMessages((all) => [
          ...all,
          { id: nextId.current++, role: 'assistant', content: reply.reply, reply },
        ]);
      })
      .catch((error: unknown) => {
        if (generation.current !== mine) return;
        setFailure(
          error instanceof ApiError && error.status === 429
            ? { kind: 'rate_limited', seconds: error.retryAfterSeconds ?? 30 }
            : { kind: 'generic' },
        );
      })
      .finally(() => {
        if (generation.current === mine) setPending(false);
      });
  };

  const send = (text: string) => {
    const question = text.trim();
    if (!question || pending) return;
    setDraft('');
    request(question, messages, true);
  };

  const retry = () => {
    const last = messages.at(-1);
    if (!last || last.role !== 'user' || pending) return;
    request(last.content, messages.slice(0, -1), false);
  };

  const clear = () => {
    generation.current += 1;
    setMessages([]);
    setFailure(null);
    setPending(false);
    setDraft('');
  };

  if (!open) return null;
  return (
    <Dialog
      title={t('help.assistant.title')}
      description={t('help.assistant.description')}
      onClose={onClose}
      initialFocus={input}
      footer={
        <>
          <Button variant="secondary" onClick={clear} disabled={messages.length === 0 && !pending}>
            {t('help.assistant.clear')}
          </Button>
          <Button onClick={onClose}>{t('help.assistant.close')}</Button>
        </>
      }
    >
      <div className="assistant">
        <p className="muted">{t('help.assistant.guidance')}</p>
        {status.data ? (
          <p className="assistant__mode">
            <Badge tone={status.data.mode === 'ai' ? 'info' : 'neutral'}>
              {status.data.mode === 'ai'
                ? t('help.assistant.modeAi')
                : t('help.assistant.modeDocs')}
            </Badge>{' '}
            {status.data.mode === 'documentation' ? (
              <span className="muted">{t('help.assistant.noticeDocs')}</span>
            ) : null}
          </p>
        ) : status.isError ? (
          <Alert tone="info">{t('help.assistant.errorStatus')}</Alert>
        ) : null}

        <Transcript messages={messages} onNavigate={onClose} />

        {messages.length === 0 && status.data ? (
          <div className="assistant__suggestions">
            <p className="muted">{t('help.assistant.suggestions')}</p>
            <ul>
              {status.data.suggestions.map((question) => (
                <li key={question}>
                  <button
                    type="button"
                    className="btn btn--secondary"
                    disabled={pending}
                    onClick={() => send(question)}
                  >
                    {question}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {pending ? <Spinner label={t('help.assistant.thinking')} /> : null}
        {failure ? (
          <Alert>
            {failure.kind === 'rate_limited'
              ? t('help.assistant.errorRateLimited', { seconds: failure.seconds })
              : t('help.assistant.errorGeneric')}{' '}
            <button type="button" className="link-button" onClick={retry}>
              {t('help.assistant.retry')}
            </button>
          </Alert>
        ) : null}

        <QuestionForm
          draft={draft}
          onDraft={setDraft}
          onSend={send}
          disabled={pending}
          inputRef={input}
        />
      </div>
    </Dialog>
  );
}

function Transcript({ messages, onNavigate }: { messages: Message[]; onNavigate: () => void }) {
  const t = useT();
  const log = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  return (
    <div
      className="assistant__log"
      role="log"
      aria-live="polite"
      aria-label={t('help.assistant.conversation')}
      tabIndex={0}
      ref={log}
    >
      {messages.length === 0 ? <p className="muted">{t('help.assistant.empty')}</p> : null}
      {messages.map((message) => (
        <div key={message.id} className={`assistant__message assistant__message--${message.role}`}>
          <p className="assistant__who">
            {message.role === 'user' ? t('help.assistant.you') : t('help.assistant.assistant')}
          </p>
          <p className="assistant__text">{message.content}</p>
          {message.reply ? <ReplyExtras reply={message.reply} onNavigate={onNavigate} /> : null}
        </div>
      ))}
    </div>
  );
}

function ReplyExtras({ reply, onNavigate }: { reply: AssistantReply; onNavigate: () => void }) {
  const t = useT();
  const tutorials = reply.sources
    .map((s) => (s.tutorialId ? tutorialById(s.tutorialId) : undefined))
    .filter((tut, i, all) => tut && all.indexOf(tut) === i);
  return (
    <>
      {reply.degraded ? <Alert tone="info">{t('help.assistant.noticeDegraded')}</Alert> : null}
      {reply.figures.map((figure) => (
        <table key={figure.id} className="table assistant__figures">
          <caption>
            <strong>{t('help.assistant.figures')}</strong>: {figure.title}, {figure.period}
          </caption>
          <tbody>
            {figure.rows.map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                <td className="num">
                  {row.display ?? row.amount} {row.currency}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={2} className="muted">
                {t('help.assistant.figuresNote')} {figure.source}
              </td>
            </tr>
          </tfoot>
        </table>
      ))}
      {tutorials.length > 0 ? (
        <p className="assistant__sources">
          <span className="muted">{t('help.assistant.sources')}: </span>
          {tutorials.map((tut) => (
            <Link key={tut!.id} to={`/help/tutorials/${tut!.id}`} onClick={onNavigate}>
              {t('help.assistant.sourceTutorial', { title: t(tutorialKey(tut!.id, 'title')) })}
            </Link>
          ))}
        </p>
      ) : null}
    </>
  );
}

function QuestionForm({
  draft,
  onDraft,
  onSend,
  disabled,
  inputRef,
}: {
  draft: string;
  onDraft: (value: string) => void;
  onSend: (text: string) => void;
  disabled: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const t = useT();
  const id = useId();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSend(draft);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      onSend(draft);
    }
  };
  return (
    <form className="assistant__form field" onSubmit={submit}>
      <label htmlFor={id}>{t('help.assistant.question')}</label>
      <textarea
        id={id}
        ref={inputRef}
        rows={3}
        maxLength={MAX_CHARS}
        value={draft}
        aria-describedby={`${id}-hint`}
        onChange={(event) => onDraft(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <p id={`${id}-hint`} className="muted">
        {t('help.assistant.questionHint')}{' '}
        {t('help.assistant.counter', { used: draft.length, max: MAX_CHARS })}
      </p>
      <div>
        <Button type="submit" disabled={disabled || draft.trim().length === 0}>
          {t('help.assistant.send')}
        </Button>
      </div>
    </form>
  );
}
