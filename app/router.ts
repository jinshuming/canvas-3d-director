import { useEffect, useState } from 'react';

/**
 * Path routes:
 *   /canvas               the canvas (a mock, for the demo)
 *   /canvas/world         every World project
 *   /canvas/world/<id>    the 3D Studio on one World; `?node=<id>` names the
 *                         canvas node it was entered from
 * Anything else lands on /canvas; the old `#/stage/<id>` links still open.
 */
export type Route =
  | { page: 'canvas' }
  | { page: 'worlds' }
  | { page: 'world'; id: string; node: string | null };

export function parse(path: string, hash = '', search = ''): Route | { redirect: string } {
  const legacy = /^#\/stage\/([A-Za-z0-9_-]+)/.exec(hash);
  if (legacy) return { redirect: `/canvas/world/${legacy[1]}` };
  const p = path.replace(/\/+$/, '') || '/';
  if (p === '/canvas') return { page: 'canvas' };
  if (p === '/canvas/world') return { page: 'worlds' };
  const m = /^\/canvas\/world\/([A-Za-z0-9_-]+)$/.exec(p);
  if (m) return { page: 'world', id: m[1]!, node: new URLSearchParams(search).get('node') };
  return { redirect: '/canvas' };
}

const EVENT = 'director:navigate';

export function navigate(to: string, replace = false): void {
  if (replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  dispatchEvent(new Event(EVENT));
}

export function useRoute(): Route {
  const read = () => {
    const r = parse(location.pathname, location.hash, location.search);
    if ('redirect' in r) {
      history.replaceState(null, '', r.redirect);
      return parse(r.redirect) as Route;
    }
    return r;
  };
  const [route, setRoute] = useState<Route>(read);
  useEffect(() => {
    const on = () => setRoute(read());
    addEventListener('popstate', on);
    addEventListener(EVENT, on);
    return () => { removeEventListener('popstate', on); removeEventListener(EVENT, on); };
  }, []);
  return route;
}

/** An in-app link: no page reload. */
export function linkProps(to: string) {
  return {
    href: to,
    onClick: (e: React.MouseEvent) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      navigate(to);
    },
  };
}

/** The editor's address for a world, remembering the canvas node it belongs to. */
export const worldPath = (id: string, node?: string | null) => `/canvas/world/${id}${node ? `?node=${encodeURIComponent(node)}` : ''}`;
