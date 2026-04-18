import { isTextEntryTarget } from '../ui/domUtils.js';

/**
 * Manages keyboard and mouse input for the game.
 */
export function createInputController(params) {
  const {
    viewerScene,
    dom,
    hud,
    ballPhysics,
    aimingPreviewController,
    clubSelectionController,
    viewHudController,
    actions
  } = params;

  let rotateCharacterLeft = false;
  let rotateCharacterRight = false;
  let increaseAimingPreviewHeadSpeed = false;
  let decreaseAimingPreviewHeadSpeed = false;
  let freeCameraMoveForward = false;
  let freeCameraMoveBackward = false;
  let freeCameraMoveLeft = false;
  let freeCameraMoveRight = false;
  let freeCameraLookActive = false;
  let hasFreeCameraFallbackPointerPosition = false;
  let lastFreeCameraPointerClientX = 0;
  let lastFreeCameraPointerClientY = 0;
  let hasCursorPointerPosition = false;
  let lastCursorPointerClientX = 0;
  let lastCursorPointerClientY = 0;

  const onKeyDown = (event) => {
    if (event.code === 'KeyG' && event.altKey && !event.repeat) {
      event.preventDefault();
      actions.warpBallToMousePosition();
      return;
    }

    if (event.code === 'KeyT' && event.altKey && !event.repeat) {
      event.preventDefault();
      actions.warpBallToTee();
      return;
    }

    if (event.code === 'KeyF' && !event.repeat) {
      const freeCameraEnabled = viewerScene.setFreeCameraEnabled(!viewerScene.isFreeCameraEnabled());
      rotateCharacterLeft = false;
      rotateCharacterRight = false;
      actions.resetCharacterRotationAcceleration();
      increaseAimingPreviewHeadSpeed = false;
      decreaseAimingPreviewHeadSpeed = false;
      actions.resetAimingPreviewHeadSpeedAcceleration();
      freeCameraMoveForward = false;
      freeCameraMoveBackward = false;
      freeCameraMoveLeft = false;
      freeCameraMoveRight = false;
      if (!freeCameraEnabled && document.pointerLockElement === dom.canvas) {
        document.exitPointerLock();
      }
      endFreeCameraLook();
      event.preventDefault();
      hud.setStatus(freeCameraEnabled ? 'Free camera enabled.' : actions.getGameplayCameraStatusMessage());
      return;
    }

    if (event.code === 'Space' && !event.repeat) {
      if (isTextEntryTarget(event.target) || viewerScene.isFreeCameraEnabled()) {
        return;
      }

      if (actions.toggleAimingCamera()) {
        event.preventDefault();
      }
      return;
    }

    if (viewerScene.isFreeCameraEnabled()) {
      if (event.code === 'KeyW') {
        freeCameraMoveForward = true;
        event.preventDefault();
        return;
      }
      if (event.code === 'KeyS') {
        freeCameraMoveBackward = true;
        event.preventDefault();
        return;
      }
      if (event.code === 'KeyA') {
        freeCameraMoveLeft = true;
        event.preventDefault();
        return;
      }
      if (event.code === 'KeyD') {
        freeCameraMoveRight = true;
        event.preventDefault();
        return;
      }
    }

    if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
      if (viewerScene.isFreeCameraEnabled()) {
        event.preventDefault();
        return;
      }
      if (event.code === 'ArrowLeft') {
        rotateCharacterLeft = true;
      } else {
        rotateCharacterRight = true;
      }
      event.preventDefault();
      return;
    }

    if (event.code === 'ArrowUp' || event.code === 'ArrowDown') {
      if (isTextEntryTarget(event.target)) return;
      if (viewerScene.isFreeCameraEnabled()) {
        event.preventDefault();
        return;
      }

      if (!actions.canUseAimingControls()) {
        event.preventDefault();
        return;
      }

      const aimingWasEnabled = viewerScene.isAimingCameraEnabled();
      viewerScene.setAimingCameraEnabled(true);
      let shouldResetHeadSpeedAcceleration = !event.repeat;
      if (event.code === 'ArrowUp') {
        shouldResetHeadSpeedAcceleration = shouldResetHeadSpeedAcceleration || decreaseAimingPreviewHeadSpeed;
        increaseAimingPreviewHeadSpeed = true;
        decreaseAimingPreviewHeadSpeed = false;
      } else {
        shouldResetHeadSpeedAcceleration = shouldResetHeadSpeedAcceleration || increaseAimingPreviewHeadSpeed;
        decreaseAimingPreviewHeadSpeed = true;
        increaseAimingPreviewHeadSpeed = false;
      }
      if (shouldResetHeadSpeedAcceleration) {
        actions.resetAimingPreviewHeadSpeedAcceleration();
      }
      if (!aimingWasEnabled) {
        hud.setStatus(actions.getGameplayCameraStatusMessage());
      }
      event.preventDefault();
      return;
    }

    if (event.repeat) return;

    if (event.code === 'KeyL') {
      if (isTextEntryTarget(event.target)) return;
      actions.launchDebugBallFromInput();
      return;
    }

    if (event.code === 'KeyR') {
      actions.resetShotFlow();
      event.preventDefault();
      return;
    }

    if (event.code === 'KeyQ') {
      if (isTextEntryTarget(event.target)) return;
      clubSelectionController.selectPreviousClub();
      event.preventDefault();
      return;
    }

    if (event.code === 'KeyE') {
      if (isTextEntryTarget(event.target)) return;
      clubSelectionController.selectNextClub();
      event.preventDefault();
      return;
    }

    if (event.code === 'KeyP') {
      if (isTextEntryTarget(event.target)) return;
      actions.togglePracticeSwingMode();
      event.preventDefault();
    }
  };

  const onKeyUp = (event) => {
    if (event.code === 'KeyW') { freeCameraMoveForward = false; return; }
    if (event.code === 'KeyS') { freeCameraMoveBackward = false; return; }
    if (event.code === 'KeyA') { freeCameraMoveLeft = false; return; }
    if (event.code === 'KeyD') { freeCameraMoveRight = false; return; }

    if (event.code === 'ArrowLeft') {
      rotateCharacterLeft = false;
      actions.resetCharacterRotationAcceleration();
      event.preventDefault();
      return;
    }
    if (event.code === 'ArrowRight') {
      rotateCharacterRight = false;
      actions.resetCharacterRotationAcceleration();
      event.preventDefault();
      return;
    }
    if (event.code === 'ArrowUp' || event.code === 'ArrowDown') {
      if (event.code === 'ArrowUp') {
        increaseAimingPreviewHeadSpeed = false;
      } else {
        decreaseAimingPreviewHeadSpeed = false;
      }
      actions.resetAimingPreviewHeadSpeedAcceleration();
      event.preventDefault();
    }
  };

  const onBlur = () => {
    rotateCharacterLeft = false;
    rotateCharacterRight = false;
    actions.resetCharacterRotationAcceleration();
    increaseAimingPreviewHeadSpeed = false;
    decreaseAimingPreviewHeadSpeed = false;
    actions.resetAimingPreviewHeadSpeedAcceleration();
    freeCameraMoveForward = false;
    freeCameraMoveBackward = false;
    freeCameraMoveLeft = false;
    freeCameraMoveRight = false;
    endFreeCameraLook();
    if (document.pointerLockElement === dom.canvas) {
      document.exitPointerLock();
    }
  };

  const onPointerLockChange = () => {
    if (document.pointerLockElement === dom.canvas) {
      beginFreeCameraLook();
      return;
    }
    endFreeCameraLook();
  };

  const onMouseDown = (event) => {
    if (!viewerScene.isFreeCameraEnabled() || event.button !== 2) {
      return;
    }
    if (dom.canvas.requestPointerLock) {
      dom.canvas.requestPointerLock();
    } else {
      beginFreeCameraLook(event.clientX, event.clientY);
    }
    event.preventDefault();
  };

  const onMouseUp = (event) => {
    if (event.button !== 2) return;
    if (document.pointerLockElement === dom.canvas) {
      document.exitPointerLock();
      return;
    }
    endFreeCameraLook();
  };

  const onMouseMove = (event) => {
    rememberCursorPointerPosition(event.clientX, event.clientY);
    if (!viewerScene.isFreeCameraEnabled() || !freeCameraLookActive) {
      return;
    }
    if (document.pointerLockElement === dom.canvas) {
      viewerScene.rotateFreeCamera(event.movementX, event.movementY);
      return;
    }
    if (!hasFreeCameraFallbackPointerPosition) {
      hasFreeCameraFallbackPointerPosition = true;
      lastFreeCameraPointerClientX = event.clientX;
      lastFreeCameraPointerClientY = event.clientY;
      return;
    }
    viewerScene.rotateFreeCamera(
      event.clientX - lastFreeCameraPointerClientX,
      event.clientY - lastFreeCameraPointerClientY,
    );
    lastFreeCameraPointerClientX = event.clientX;
    lastFreeCameraPointerClientY = event.clientY;
  };

  function beginFreeCameraLook(pointerClientX = null, pointerClientY = null) {
    freeCameraLookActive = true;
    hasFreeCameraFallbackPointerPosition = Number.isFinite(pointerClientX) && Number.isFinite(pointerClientY);
    if (hasFreeCameraFallbackPointerPosition) {
      lastFreeCameraPointerClientX = pointerClientX;
      lastFreeCameraPointerClientY = pointerClientY;
    }
  }

  function endFreeCameraLook() {
    freeCameraLookActive = false;
    hasFreeCameraFallbackPointerPosition = false;
  }

  function rememberCursorPointerPosition(clientX, clientY) {
    hasCursorPointerPosition = Number.isFinite(clientX) && Number.isFinite(clientY);
    if (!hasCursorPointerPosition) return;
    lastCursorPointerClientX = clientX;
    lastCursorPointerClientY = clientY;
  }

  const initialize = () => {
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    document.addEventListener('pointerlockchange', onPointerLockChange);
    dom.canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('mousemove', onMouseMove);
  };

  return {
    initialize,
    getKeyboardRotationInputDirection: () => Number(rotateCharacterLeft) - Number(rotateCharacterRight),
    getKeyboardAimingPreviewHeadSpeedInputDirection: () => Number(increaseAimingPreviewHeadSpeed) - Number(decreaseAimingPreviewHeadSpeed),
    getFreeCameraMovement: () => ({
      forward: Number(freeCameraMoveForward) - Number(freeCameraMoveBackward),
      right: Number(freeCameraMoveRight) - Number(freeCameraMoveLeft),
    }),
    getCursorPosition: () => ({
      hasPosition: hasCursorPointerPosition,
      clientX: lastCursorPointerClientX,
      clientY: lastCursorPointerClientY
    }),
    clearKeyboardInputs: () => {
      rotateCharacterLeft = false; rotateCharacterRight = false;
      increaseAimingPreviewHeadSpeed = false; decreaseAimingPreviewHeadSpeed = false;
      freeCameraMoveForward = false; freeCameraMoveBackward = false;
      freeCameraMoveLeft = false; freeCameraMoveRight = false;
    }
  };
}
