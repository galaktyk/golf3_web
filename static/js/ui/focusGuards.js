/**
 * Prevent buttons from retaining DOM focus anywhere in the app.
 */
export function installButtonFocusGuard() {
  document.addEventListener('focusin', handleFocusIn, true);
}

/**
 * Blur focused buttons immediately so pointer and arrow-key input stay with the app.
 */
function handleFocusIn(event) {
  if (!(event.target instanceof HTMLButtonElement)) {
    return;
  }

  event.target.blur();
}