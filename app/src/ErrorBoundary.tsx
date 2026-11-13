/**
 * A screen that throws while rendering does not take the page with it.
 *
 * Without a boundary React unmounts the whole tree on an uncaught render
 * error, and the page stays white. When the cause is a saved build or draft,
 * it stays white after every reload as well: the saved state is what the page
 * loads (`store.ts` repairs what it loads, but a bug there is exactly the
 * case this is for). The fallback says so and offers the ways out, from the
 * mildest: draw the screen again, go back to the showcase builds (nothing is
 * deleted), erase everything saved.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

import { useT } from './i18n/index.js';
import { useApp } from './store.js';

function Crash({ error, onRetry }: { error: Error; onRetry: () => void }): JSX.Element {
  const t = useT().crash;
  const resetToShowcase = useApp((store) => store.resetToShowcase);
  const eraseSaved = useApp((store) => store.eraseSaved);
  return (
    <section className="panel panel--full" role="alert">
      <h3>{t.title}</h3>
      <p className="hint">{t.hint}</p>
      <pre className="error">{error.message}</pre>
      <p>
        <button type="button" className="chip" onClick={onRetry}>
          {t.retry}
        </button>{' '}
        <button
          type="button"
          className="chip"
          onClick={() => {
            resetToShowcase();
            onRetry();
          }}
        >
          {t.toShowcase}
        </button>{' '}
        <button
          type="button"
          className="chip"
          onClick={() => {
            if (!window.confirm(t.eraseConfirm)) return;
            eraseSaved();
            onRetry();
          }}
        >
          {t.erase}
        </button>
      </p>
    </section>
  );
}

interface Props {
  children: ReactNode;
  /** Outside the app's own frame (the root): the fallback brings its own page. */
  standalone?: boolean;
  /** The error is dropped when this changes: going to another screen is a fresh start. */
  resetKey?: string;
}

export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(error, info.componentStack);
  }

  override componentDidUpdate(previous: Props): void {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const crash = <Crash error={error} onRetry={() => this.setState({ error: null })} />;
    return this.props.standalone ? <main className="shell">{crash}</main> : crash;
  }
}
