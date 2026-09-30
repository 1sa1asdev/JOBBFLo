'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

// ------------------------------------------------------------
// Where you are, in the address bar.
//
// The whole app was one page holding its position in React state:
// which workspace, which search, which ad. Nothing of that reached the
// URL, which cost three things people expect from a web page and get
// for free everywhere else:
//
//   back           left the app entirely, from inside an ad
//   reload         dropped you on the dashboard
//   a link         could not point at a search or an ad
//
// This keeps a small object in the query string — the navigable state,
// not the whole app. Written with the History API rather than the Next
// router on purpose: this is the same document either way, and
// router.push re-runs the route. pushState is instant and keeps the
// list, the scroll and every fetched row exactly where they are.
//
// One entry per navigation, so back walks the steps the user took.
// `replace` exists for the corrections that are not navigation — the
// first search selecting itself, say, which nobody should have to press
// back through.
// ------------------------------------------------------------
const läs = () => {
  if (typeof window === 'undefined') return {};
  const p = new URLSearchParams(window.location.search);
  return Object.fromEntries([...p.entries()].filter(([, v]) => v !== ''));
};

const skriv = (state) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(state)) {
    if (v != null && v !== '' && v !== false) p.set(k, v === true ? '1' : String(v));
  }
  const q = p.toString();
  return `${window.location.pathname}${q ? `?${q}` : ''}`;
};

export function useUrlState() {
  // Empty on the first render, on the server AND in the browser.
  //
  // Reading location during render makes the client's first tree
  // disagree with the server's — React throws the whole tree away and
  // rebuilds it, and reports a hydration mismatch. The URL is read in
  // the effect below instead, one tick later: the first paint is the
  // default view, and a link straight to ?vy=auto lands there as soon
  // as the app is interactive.
  const [state, setState] = useState({});

  useEffect(() => { setState(läs()); }, []);
  // Set while applying a URL the browser gave us, so the effect that
  // pushes state back into the URL does not answer the back button with
  // a new history entry — which would trap the user on the same page.
  const frånWebbläsaren = useRef(false);

  useEffect(() => {
    const onPop = () => {
      frånWebbläsaren.current = true;
      setState(läs());
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // The history write happens HERE, not inside a setState updater.
  // React runs those during render, and Next's router listens on
  // pushState — so writing the URL from an updater set state on the
  // router while this component was rendering, which React reports as
  // "Cannot update a component while rendering a different component".
  // The current URL is the source of truth anyway, so it is read back
  // rather than kept.
  const navigate = useCallback((ändring, { replace = false } = {}) => {
    const nästa = { ...läs(), ...ändring };
    for (const k of Object.keys(nästa)) if (nästa[k] == null || nästa[k] === false) delete nästa[k];
    const url = skriv(nästa);
    if (url !== `${window.location.pathname}${window.location.search}`) {
      if (replace) window.history.replaceState(nästa, '', url);
      else window.history.pushState(nästa, '', url);
    }
    setState(nästa);
  }, []);

  // Cleared after every render that came from the browser, so the next
  // in-app navigation pushes normally.
  useEffect(() => { frånWebbläsaren.current = false; }, [state]);

  return { urlState: state, navigate };
}

// ------------------------------------------------------------
// Scroll position, remembered per list.
//
// Browsers restore scroll on back for documents they loaded. This list
// is not one: the rows arrive from fetch after the component mounts, so
// there is nothing to scroll to at restore time, and the browser gives
// up. Opening an ad and pressing back therefore landed at the top of a
// list the user had scrolled a long way down.
//
// sessionStorage rather than history.state: it survives the row fetch,
// it is per tab, and it costs nothing when it is missing.
// ------------------------------------------------------------
export const minnesplats = (nyckel) => `jobbflo:scroll:${nyckel}`;

export function sparaScroll(nyckel, element, extra = {}) {
  if (!element || typeof window === 'undefined') return;
  // A detached node reports scrollTop 0. React runs an effect's cleanup
  // around the time the DOM goes away, so saving from there wrote a 0
  // over the position the scroll listener had just stored correctly —
  // and back landed at the top of the list anyway.
  if (!element.isConnected || element.clientHeight === 0) return;
  try {
    window.sessionStorage.setItem(minnesplats(nyckel),
      JSON.stringify({ top: element.scrollTop, ...extra }));
  } catch { /* private mode, full quota: scrolling to the top is survivable */ }
}

export function läsScroll(nyckel) {
  if (typeof window === 'undefined') return null;
  try {
    const rå = window.sessionStorage.getItem(minnesplats(nyckel));
    return rå ? JSON.parse(rå) : null;
  } catch { return null; }
}
