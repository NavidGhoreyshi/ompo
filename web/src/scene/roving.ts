/**
 * Roving tabindex for a DOM list (`d09`).
 *
 * A pad list can be as long as the roadmap; one tab stop per pad would bury
 * every control after it. The list is one tab stop instead: the active row has
 * `tabIndex={0}`, the others `-1`, and ArrowUp/ArrowDown/Home/End move the stop
 * and the focus together. Rows keep their own activation (Enter/Space on their
 * button), which is the repo's existing row pattern (`RoadmapPage`, `Dag`).
 */

import { useCallback, useRef, useState, type KeyboardEvent, type RefCallback } from "react";

export interface RovingFocus {
  /** `0` for the list's single active row, `-1` for every other row. */
  tabIndexFor(id: string): 0 | -1;
  /** Stable per-id callback ref; the hook tracks the element for focus moves. */
  register(id: string): RefCallback<HTMLElement>;
  /** Arrow/Home/End handling, to be attached to the list container. */
  onKeyDown(event: KeyboardEvent<HTMLElement>): void;
  /** Called when a row gains focus by other means (a click, a tab back in). */
  activate(id: string): void;
}

export function useRovingFocus(ids: readonly string[], preferred?: string | null): RovingFocus {
  const elements = useRef(new Map<string, HTMLElement>());
  const callbacks = useRef(new Map<string, RefCallback<HTMLElement>>());
  const [active, setActive] = useState<string | null>(null);
  // The ids can change under the list (a run switch); the stop is the stored
  // preference while it exists, the first row otherwise.
  const stored = active ?? preferred ?? null;
  const current = stored !== null && ids.includes(stored) ? stored : (ids[0] ?? null);

  const register = useCallback((id: string): RefCallback<HTMLElement> => {
    const existing = callbacks.current.get(id);
    if (existing) return existing;
    const callback: RefCallback<HTMLElement> = (element) => {
      if (element) elements.current.set(id, element);
      else elements.current.delete(id);
    };
    callbacks.current.set(id, callback);
    return callback;
  }, []);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const key = event.key;
      if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return;
      if (ids.length === 0) return;
      const at = current === null ? -1 : ids.indexOf(current);
      const index =
        key === "Home"
          ? 0
          : key === "End"
            ? ids.length - 1
            : key === "ArrowDown"
              ? Math.min(ids.length - 1, at + 1)
              : Math.max(0, at - 1);
      const id = ids[index];
      if (id === undefined) return;
      event.preventDefault();
      setActive(id);
      elements.current.get(id)?.focus();
    },
    [current, ids],
  );

  const tabIndexFor = useCallback((id: string): 0 | -1 => (id === current ? 0 : -1), [current]);

  return { tabIndexFor, register, onKeyDown, activate: setActive };
}
