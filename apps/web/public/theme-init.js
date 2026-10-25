/* global window, document */
/*
 * Applies the saved colour theme before the first paint, so an explicit Light or Dark choice does
 * not flash the other theme while the app loads. Only an explicit choice is stored; with no choice
 * ("System") the stylesheet follows prefers-color-scheme by itself. Kept as a separate same-origin
 * file (not inline) so it keeps working under a strict script-src policy. The storage key must
 * match THEME_STORAGE_KEY in src/shared/theme.ts (a test checks that).
 */
(function () {
  try {
    var choice = window.localStorage.getItem('intuit2.theme');
    if (choice === 'light' || choice === 'dark') {
      document.documentElement.setAttribute('data-theme', choice);
    }
  } catch (error) {
    /* Storage is unavailable (private mode, blocked): follow the system setting. */
  }
})();
