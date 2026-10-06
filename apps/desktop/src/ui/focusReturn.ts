/** Where keyboard focus goes back to when a drawer closes. The map unmounts
 * while a drawer is open, so the control that opened it is remembered by a
 * key (its data-return-focus value) rather than by the element itself. */

let opener: string | null = null;
let drawerClosed = false;

export function rememberOpener(key: string | null): void {
  opener = key;
}

export function noteDrawerClosed(): void {
  drawerClosed = true;
}

/** Once, on the map's return: the opener's key, or null for the heading.
 * Undefined when the map is not coming back from a drawer (first load). */
export function takeReturnFocus(): string | null | undefined {
  if (!drawerClosed) return undefined;
  drawerClosed = false;
  const key = opener;
  opener = null;
  return key;
}
