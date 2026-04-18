import * as THREE from 'three';
import {
  BALL_DEFAULT_LAUNCH_DATA,
  LAUNCH_DEBUG_INPUT_FIELDS
} from '../game/constants.js';

/**
 * Manages the launch debug UI overlay.
 */
export function createLaunchDebugController(params) {
  const { dom, hud, ballPhysics, actions } = params;
  let debugEnabled = false;

  const getLaunchDebugInputState = () => {
    const fields = LAUNCH_DEBUG_INPUT_FIELDS;
    if (!fields.every(({ inputKey }) => Boolean(dom[inputKey]))) {
      return { launchData: null, errorMessage: '' };
    }

    const launchData = { ...BALL_DEFAULT_LAUNCH_DATA };
    for (const { key, inputKey } of fields) {
      const rawValue = dom[inputKey].value.trim();
      if (!rawValue) {
        return { launchData: null, errorMessage: `Launch field "${key}" is required.` };
      }

      const fieldValue = Number(rawValue);
      if (!Number.isFinite(fieldValue)) {
        return { launchData: null, errorMessage: `Launch field "${key}" must be a finite number.` };
      }

      launchData[key] = fieldValue;
    }

    if (launchData.ballSpeed <= 0) {
      return { launchData: null, errorMessage: 'Launch field "ballSpeed" must be greater than 0.' };
    }

    return { launchData, errorMessage: '' };
  };

  const updateLaunchDebugUiState = (statusMessage = null) => {
    if (!dom.launchDebugButton || !dom.launchDebugMessage) return;

    const state = getLaunchDebugInputState();
    const canLaunch = actions.canLaunchDebugShot() && Boolean(state.launchData);

    for (const { inputKey } of LAUNCH_DEBUG_INPUT_FIELDS) {
      if (dom[inputKey]) {
        dom[inputKey].setAttribute('aria-invalid', String(Boolean(state.errorMessage)));
      }
    }
    dom.launchDebugButton.disabled = !canLaunch;

    if (statusMessage) {
      dom.launchDebugMessage.textContent = statusMessage;
      return;
    }

    if (state.errorMessage) {
      dom.launchDebugMessage.textContent = state.errorMessage;
      return;
    }

    if (!actions.canLaunchDebugShot()) {
      dom.launchDebugMessage.textContent = 'Launch is available only while player control is active and the ball is ready.';
      return;
    }

    dom.launchDebugMessage.textContent = 'Edit the launch values, then click Launch or press L.';
  };

  const syncLaunchDebugInputs = (launchData) => {
    if (!launchData) return;
    for (const { key, inputKey } of LAUNCH_DEBUG_INPUT_FIELDS) {
      if (dom[inputKey]) {
        const val = Number.isFinite(launchData[key]) ? launchData[key] : BALL_DEFAULT_LAUNCH_DATA[key];
        dom[inputKey].value = String(val);
      }
    }
    updateLaunchDebugUiState('LaunchDebug synced with the current aiming preview.');
  };

  const initialize = () => {
    hud.updateLaunchPanelVisible(debugEnabled);
    if (!dom.launchDebugButton) return;

    for (const { inputKey } of LAUNCH_DEBUG_INPUT_FIELDS) {
      if (dom[inputKey]) {
        dom[inputKey].addEventListener('input', () => updateLaunchDebugUiState());
      }
    }

    dom.launchDebugButton.addEventListener('click', () => actions.launchDebugBallFromInput());

    const debugToggleButton = document.getElementById('viewer-debug-toggle');
    if (debugToggleButton) {
      debugToggleButton.addEventListener('click', () => {
        debugEnabled = !debugEnabled;
        document.body.classList.toggle('viewer-debug-enabled', debugEnabled);
        hud.updateLaunchPanelVisible(debugEnabled);
        if (debugEnabled) updateLaunchDebugUiState();
      });
    }
    updateLaunchDebugUiState();
  };

  return {
    initialize,
    getLaunchDebugInputState,
    updateLaunchDebugUiState,
    syncLaunchDebugInputs,
    isDebugEnabled: () => debugEnabled
  };
}
