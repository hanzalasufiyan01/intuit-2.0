import { Link, useLocation } from 'react-router';
import { useT } from '../../i18n/i18n';
import { Button } from '../../shared/ui/Button';
import { useSaveTutorialProgress, useTutorialProgress } from './helpApi';
import { availability, contextualTutorial, tutorialById, tutorialKey } from './tutorials';
import { useHelpAccess } from './useHelpAccess';

/**
 * Contextual help: a link in the top bar to the tutorial that covers the page being shown. It
 * appears only when a tutorial covers the page and the member can follow it.
 */
export function ContextHelpLink() {
  const t = useT();
  const { pathname } = useLocation();
  const access = useHelpAccess();
  const tutorial = contextualTutorial(pathname);
  if (!tutorial || !availability(tutorial, access).available) return null;
  return (
    <Link
      to={`/help/tutorials/${tutorial.id}`}
      aria-label={t('help.context.linkFor', { title: t(tutorialKey(tutorial.id, 'title')) })}
    >
      {t('help.context.link')}
    </Link>
  );
}

/**
 * A first-sign-in prompt on the Overview page: offers the welcome tutorial until the member has
 * started, skipped or finished it (their own progress, stored on the server).
 */
export function WelcomePrompt() {
  const t = useT();
  const { pathname } = useLocation();
  const access = useHelpAccess();
  const progress = useTutorialProgress();
  const save = useSaveTutorialProgress();
  const tutorial = tutorialById('welcome');
  if (pathname !== '/' || !tutorial || !progress.data) return null;
  if (progress.data.items.some((p) => p.tutorialId === 'welcome')) return null;
  if (!availability(tutorial, access).available) return null;
  return (
    <section className="welcome-prompt" aria-labelledby="welcome-prompt-title">
      <div>
        <h2 id="welcome-prompt-title">{t('help.welcome.title')}</h2>
        <p>{t('help.welcome.text')}</p>
      </div>
      <div className="help-actions">
        <Link className="btn btn--primary" to="/help/tutorials/welcome">
          {t('help.welcome.start')}
        </Link>
        <Button
          variant="ghost"
          busy={save.isPending}
          onClick={() => save.mutate({ tutorialId: 'welcome', status: 'skipped', step: 0 })}
        >
          {t('help.welcome.skip')}
        </Button>
      </div>
    </section>
  );
}
