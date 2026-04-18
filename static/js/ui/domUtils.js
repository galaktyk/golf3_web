/**
 * Domain-specific UI and input targeting helpers.
 */

/**
 * Returns whether the event target is a text entry field.
 */
export function isTextEntryTarget(target) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return target.isContentEditable
    || target.tagName === 'INPUT'
    || target.tagName === 'TEXTAREA'
    || target.tagName === 'SELECT';
}
