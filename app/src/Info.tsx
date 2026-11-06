/**
 * Hover explanations.
 *
 * The project's whole point is that a number should be traceable to where it
 * came from. On screen that means: hovering anything says what it is, what it
 * does, and how sure we are. A track full of coloured bars that you have to
 * already understand is no better than the wiki.
 *
 * Deliberately dependency-free and unstyled-by-library: one fixed-position
 * card that follows the pointer, clamped to the viewport.
 */

import { useCallback, useRef, useState, type ReactNode } from 'react';

const OFFSET = 14;
const MAX_WIDTH = 380;

export function Info({
  content,
  children,
  className,
  onClick,
}: {
  content: ReactNode;
  children: ReactNode;
  className?: string;
  onClick?: (event: React.MouseEvent) => void;
}): JSX.Element {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const frame = useRef<number | null>(null);

  const move = useCallback((event: React.MouseEvent) => {
    // Throttled to one update per frame: the card follows the pointer and
    // without this a wide track repaints on every mousemove.
    if (frame.current != null) return;
    const { clientX, clientY } = event;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const x = Math.min(clientX + OFFSET, window.innerWidth - MAX_WIDTH - 12);
      const y = Math.min(clientY + OFFSET, window.innerHeight - 40);
      setAt({ x: Math.max(8, x), y: Math.max(8, y) });
    });
  }, []);

  const leave = useCallback(() => {
    if (frame.current != null) cancelAnimationFrame(frame.current);
    frame.current = null;
    setAt(null);
  }, []);

  return (
    <>
      <span
        className={className}
        onMouseMove={move}
        onMouseLeave={leave}
        onClick={onClick}
        style={{ display: 'contents' }}
      >
        {children}
      </span>
      {at && content != null && (
        <div className="infocard" style={{ left: at.x, top: at.y, maxWidth: MAX_WIDTH }}>
          {content}
        </div>
      )}
    </>
  );
}

/** Body of a tooltip: a title, a source line and free content. */
export function InfoBody({
  title,
  kind,
  source,
  children,
}: {
  title: string;
  kind?: string | undefined;
  source?: string | undefined;
  children?: ReactNode;
}): JSX.Element {
  return (
    <>
      <div className="infocard__head">
        <b>{title}</b>
        {kind && <span className="infocard__kind">{kind}</span>}
      </div>
      {children}
      {source && <div className="infocard__source">{source}</div>}
    </>
  );
}
