import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useT } from '../../i18n/i18n';
import { Alert } from '../../shared/ui/Alert';
import { Badge, type BadgeTone } from '../../shared/ui/Badge';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { LoadingState } from '../../shared/ui/LoadingState';
import { useAssistant } from './AssistantPanel';
import { useSaveTutorialProgress, useTutorialProgress, type TutorialProgress } from './helpApi';
import {
  availability,
  tutorialById,
  tutorialKey,
  TUTORIALS,
  type TutorialDef,
  type VisibleStep,
} from './tutorials';
import { useHelpAccess } from './useHelpAccess';

/**
 * The Help centre: the list of tutorials with the member's own progress, and the assistant. A
 * tutorial the member cannot use (a permission they lack, a module that is off) is shown as
 * unavailable with the reason, never as if it worked.
 */

const STATUS_TONE: Record<string, BadgeTone> = {
  completed: 'success',
  in_progress: 'info',
  skipped: 'neutral',
};

export function HelpCentrePage() {
  const t = useT();
  const access = useHelpAccess();
  const progress = useTutorialProgress();
  const { openAssistant } = useAssistant();
  const byId = new Map((progress.data?.items ?? []).map((p) => [p.tutorialId, p]));
  const done = TUTORIALS.filter((tut) => byId.get(tut.id)?.status === 'completed').length;

  return (
    <>
      <PageHeader title={t('help.centre.title')} description={t('help.centre.description')} />
      <Card title={t('help.centre.assistantTitle')}>
        <p>{t('help.centre.assistantText')}</p>
        <div>
          <Button onClick={openAssistant}>{t('help.centre.openAssistant')}</Button>
        </div>
      </Card>
      <Card title={t('help.centre.tutorials')}>
        {progress.isError ? <Alert tone="info">{t('help.centre.loadFailed')}</Alert> : null}
        {progress.isLoading ? (
          <LoadingState />
        ) : (
          <>
            <p className="muted">{t('help.centre.progress', { done, total: TUTORIALS.length })}</p>
            <ul className="help-list">
              {TUTORIALS.map((tutorial) => (
                <TutorialRow
                  key={tutorial.id}
                  tutorial={tutorial}
                  progress={byId.get(tutorial.id)}
                  available={availability(tutorial, access)}
                />
              ))}
            </ul>
          </>
        )}
      </Card>
    </>
  );
}

function TutorialRow({
  tutorial,
  progress,
  available,
}: {
  tutorial: TutorialDef;
  progress: TutorialProgress | undefined;
  available: ReturnType<typeof availability>;
}) {
  const t = useT();
  const title = t(tutorialKey(tutorial.id, 'title'));
  const total = available.available ? available.steps.length : 0;
  const status = progress?.status;
  const label = !available.available
    ? t('help.status.unavailable')
    : status === 'completed'
      ? t('help.status.completed')
      : status === 'skipped'
        ? t('help.status.skipped')
        : status === 'in_progress'
          ? t('help.status.inProgress', {
              step: Math.min(progress!.currentStep + 1, total),
              total,
            })
          : t('help.status.notStarted');
  const tone: BadgeTone = !available.available
    ? 'warning'
    : (STATUS_TONE[status ?? ''] ?? 'neutral');
  const action =
    status === 'completed' || status === 'skipped'
      ? (['help.action.repeat', 'help.action.repeatFor'] as const)
      : status === 'in_progress'
        ? (['help.action.resume', 'help.action.resumeFor'] as const)
        : (['help.action.start', 'help.action.startFor'] as const);

  return (
    <li className="help-item">
      <div className="help-item__text">
        <h3>{title}</h3>
        <p>{t(tutorialKey(tutorial.id, 'summary'))}</p>
        {!available.available ? <p className="muted">{t('help.unavailable.reason')}</p> : null}
      </div>
      <div className="help-item__side">
        <Badge tone={tone}>{label}</Badge>
        {available.available ? (
          <Link
            className="btn btn--secondary"
            to={`/help/tutorials/${tutorial.id}`}
            aria-label={t(action[1], { title })}
          >
            {t(action[0])}
          </Link>
        ) : null}
      </div>
    </li>
  );
}

export function TutorialPage() {
  const t = useT();
  const { tutorialId = '' } = useParams();
  const tutorial = tutorialById(tutorialId);
  const access = useHelpAccess();
  const progress = useTutorialProgress();

  if (!tutorial) {
    return (
      <>
        <PageHeader title={t('help.centre.title')} />
        <Alert tone="info">{t('help.player.notFound')}</Alert>
        <Link to="/help">{t('help.player.backToCentre')}</Link>
      </>
    );
  }
  const title = t(tutorialKey(tutorial.id, 'title'));
  const available = availability(tutorial, access);
  if (!available.available) {
    return (
      <>
        <PageHeader title={title} />
        <Alert tone="info">{t('help.unavailable.reason')}</Alert>
        <Link to="/help">{t('help.player.backToCentre')}</Link>
      </>
    );
  }
  if (progress.isLoading) return <LoadingState />;
  return (
    <TutorialPlayer
      key={tutorial.id}
      tutorial={tutorial}
      steps={available.steps}
      existing={progress.data?.items.find((p) => p.tutorialId === tutorial.id)}
      limited={available.steps.length < tutorial.steps.length}
      loadFailed={progress.isError}
    />
  );
}

type View = 'steps' | 'completed' | 'skipped';

function TutorialPlayer({
  tutorial,
  steps,
  existing,
  limited,
  loadFailed,
}: {
  tutorial: TutorialDef;
  steps: VisibleStep[];
  existing: TutorialProgress | undefined;
  limited: boolean;
  loadFailed: boolean;
}) {
  const t = useT();
  const navigate = useNavigate();
  const save = useSaveTutorialProgress();
  const total = steps.length;
  const title = t(tutorialKey(tutorial.id, 'title'));

  // Resume where the member left off; a finished or skipped tutorial opens on its summary.
  const [view, setView] = useState<View>(
    existing?.status === 'completed'
      ? 'completed'
      : existing?.status === 'skipped'
        ? 'skipped'
        : 'steps',
  );
  const [step, setStep] = useState(
    existing?.status === 'in_progress' ? Math.min(Math.max(existing.currentStep, 0), total - 1) : 0,
  );

  // After a step change, move focus to the step heading so keyboard and screen reader users
  // land on the new content. Not on the first render.
  const heading = useRef<HTMLHeadingElement>(null);
  const summary = useRef<HTMLParagraphElement>(null);
  const moved = useRef(false);
  useEffect(() => {
    if (moved.current) (heading.current ?? summary.current)?.focus();
  }, [step, view]);

  const record = (status: 'in_progress' | 'completed' | 'skipped', at: number) =>
    save.mutate({ tutorialId: tutorial.id, status, step: at });
  const goTo = (next: number) => {
    moved.current = true;
    setStep(next);
    record('in_progress', next);
  };
  const next = () => {
    if (step < total - 1) return goTo(step + 1);
    moved.current = true;
    record('completed', total);
    setView('completed');
  };
  const skip = () => {
    moved.current = true;
    record('skipped', step);
    setView('skipped');
  };
  const repeat = () => {
    moved.current = true;
    setStep(0);
    setView('steps');
    record('in_progress', 0);
  };

  if (view !== 'steps') {
    const done = view === 'completed';
    return (
      <>
        <PageHeader title={title} />
        <Card title={done ? t('help.player.doneTitle') : t('help.player.skippedTitle')}>
          <p tabIndex={-1} ref={summary}>
            {done ? t('help.player.doneText', { title }) : t('help.player.skippedText', { title })}
          </p>
          {save.isError ? <Alert tone="info">{t('help.player.saveFailed')}</Alert> : null}
          <div className="help-actions">
            <Button onClick={repeat}>
              {done ? t('help.player.repeat') : t('help.action.start')}
            </Button>
            <Link className="btn btn--secondary" to="/help">
              {t('help.player.backToCentre')}
            </Link>
          </div>
        </Card>
      </>
    );
  }

  const current = steps[step]!;
  const prefix = `s${current.number}`;
  const prerequisites = Array.from({ length: tutorial.prerequisites }, (_, i) => i + 1);
  return (
    <>
      <PageHeader title={title} description={t(tutorialKey(tutorial.id, 'summary'))} />
      {loadFailed ? <Alert tone="info">{t('help.centre.loadFailed')}</Alert> : null}
      {limited ? <Alert tone="info">{t('help.player.limited')}</Alert> : null}
      {step === 0 ? (
        <Card>
          <h2 className="help-subtitle">{t('help.player.objective')}</h2>
          <p>{t(tutorialKey(tutorial.id, 'objective'))}</p>
          {prerequisites.length > 0 ? (
            <>
              <h2 className="help-subtitle">{t('help.player.prerequisites')}</h2>
              <ul>
                {prerequisites.map((n) => (
                  <li key={n}>{t(tutorialKey(tutorial.id, `prereq${n}`))}</li>
                ))}
              </ul>
            </>
          ) : null}
        </Card>
      ) : null}
      <Card>
        <p className="muted" aria-live="polite">
          {t('help.player.stepOf', { step: step + 1, total })}
        </p>
        <progress
          className="help-progress"
          value={step + 1}
          max={total}
          aria-label={t('help.player.progressLabel')}
        />
        <h2 className="help-step__title" tabIndex={-1} ref={heading}>
          {t(tutorialKey(tutorial.id, `${prefix}.title`))}
        </h2>
        <p>{t(tutorialKey(tutorial.id, `${prefix}.body`))}</p>
        {current.route ? (
          <p>
            <Link to={current.route}>{t('help.player.openPage')}</Link>
            <span className="muted"> {t('help.player.openPageHint')}</span>
          </p>
        ) : null}
        {save.isError ? <Alert tone="info">{t('help.player.saveFailed')}</Alert> : null}
        <div className="help-actions">
          <Button variant="secondary" disabled={step === 0} onClick={() => goTo(step - 1)}>
            {t('help.player.back')}
          </Button>
          <Button onClick={next}>
            {step === total - 1 ? t('help.player.finish') : t('help.player.next')}
          </Button>
          <Button variant="ghost" onClick={skip}>
            {t('help.player.skip')}
          </Button>
          <Button variant="ghost" onClick={() => void navigate('/help')}>
            {t('help.player.exit')}
          </Button>
        </div>
      </Card>
    </>
  );
}
