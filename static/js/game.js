import * as THREE from 'three';
import { CONTROL_ACTIONS, decodeControlMessage, decodeJoystickMessage, decodeSwingStatePacket } from '/static/js/protocol.js';
import {
  AIMING_CAMERA_ENTRY_MIN_MAGNITUDE,
  AIMING_CAMERA_ENTRY_VERTICAL_TOLERANCE_DEGREES,
  AIMING_PREVIEW_HEAD_SPEED_ANALOG_RESPONSE_EXPONENT,
  AIMING_PREVIEW_HEAD_SPEED_ANALOG_RAMP_SECONDS,
  AIMING_PREVIEW_HEAD_SPEED_ADJUST_MAX_RATE_METERS_PER_SECOND,
  AIMING_PREVIEW_HEAD_SPEED_ADJUST_MIN_RATE_METERS_PER_SECOND,
  AIMING_PREVIEW_HEAD_SPEED_ADJUST_RAMP_SECONDS,
  AIMING_ROTATION_DISTANCE_MAX_MULTIPLIER,
  AIMING_ROTATION_DISTANCE_MIN_MULTIPLIER,
  AIMING_ROTATION_DISTANCE_REFERENCE_METERS,
  AIMING_PREVIEW_HEAD_SPEED_MAX_METERS_PER_SECOND,
  AIMING_PREVIEW_HEAD_SPEED_MIN_METERS_PER_SECOND,
  AIMING_PREVIEW_HEAD_SPEED_METERS_PER_SECOND,
  BALL_GROUNDED_NORMAL_MIN_Y,
  BALL_ROLLING_RESISTANCE,
  BALL_DEFAULT_LAUNCH_DATA,
  BALL_RADIUS,
  CHARACTER_ROTATION_ANALOG_RESPONSE_EXPONENT,
  CHARACTER_ROTATION_ACCELERATION_MAX_MULTIPLIER,
  CHARACTER_ROTATION_ACCELERATION_MIN_MULTIPLIER,
  CHARACTER_ROTATION_ACCELERATION_RAMP_SECONDS,
  CHARACTER_ROTATION_SPEED_DEGREES,
  CLUB_HEAD_AIMING_PREVIEW_LAUNCH_MIN_SPEED_RATIO,
  CLUB_HEAD_CONTACT_RELEASE_DISTANCE,
  CLUB_SWING_WHOOSH_COOLDOWN_MS,
  CLUB_SWING_WHOOSH_MIN_SPEED,
  CLUB_SWING_WHOOSH_REARM_SPEED,
  PHONE_ANGULAR_SPEED_TO_CLUB_HEAD_SPEED_GAIN,
  REMOTE_CONTROL_INPUT_SMOOTHING,
  REMOTE_CONTROL_INPUT_SNAP_EPSILON,
  SHOT_AUDIO_PANGYA_MAX_HORIZONTAL_ANGLE_DEGREES,
  LAUNCH_DEBUG_INPUT_FIELDS,
} from '/static/js/game/constants.js';
import { ACTIVE_CLUB, ACTIVE_CLUB_SET } from '/static/js/game/clubData.js';
import { createBallPhysics } from '/static/js/game/ballPhysics.js';
import { createBallTrail } from '/static/js/game/ballTrail.js';
import { raycastCourseSurface, sampleCourseSurface } from '/static/js/game/collision.js';
import { getViewerDom } from '/static/js/game/dom.js';
import { formatMetersPerSecond } from '/static/js/game/formatting.js';
import { createViewerHud } from '/static/js/game/hud.js';
import { resolveClubBallImpact } from '/static/js/game/impact/clubImpact.js';
import { createShotImpactAudio } from '/static/js/game/impact/shotAudio.js';
import { loadCharacter, loadViewerModels } from '/static/js/game/models.js';
import { createViewerScene } from '/static/js/game/scene.js';
import { createAimingPreviewController } from '/static/js/gameplay/aimingPreviewController.js';
import { createClubSelectionController } from '/static/js/gameplay/clubSelectionController.js';
import { createViewHudController } from '/static/js/gameplay/viewHudController.js';
import { createViewerRtcSession } from '/static/js/session/firebaseRtcSession.js';
import { buildControllerUrl, loadStoredViewerCode, saveStoredViewerCode } from '/static/js/session/roomCode.js';
import { installButtonFocusGuard } from '/static/js/ui/focusGuards.js';

const animationClock = new THREE.Clock();
const incomingQuaternion = new THREE.Quaternion();
const incomingSwingState = {
  perpendicularAngularSpeedRadiansPerSecond: 0,
  motionAgeMilliseconds: 65535,
  sequence: 0,
  receivedAtTimeMs: 0,
};
let DEBUG_UI_ENABLED = false;
installButtonFocusGuard();
document.body.classList.toggle('viewer-debug-enabled', DEBUG_UI_ENABLED);
const dom = getViewerDom();
const viewerScene = createViewerScene(dom.canvas);
const hud = createViewerHud(dom);
const character = loadCharacter(viewerScene, (message) => hud.setStatus(message));
const ballPhysics = createBallPhysics(viewerScene);
const ballTrail = createBallTrail(BALL_RADIUS);
const shotImpactAudio = createShotImpactAudio();
const viewerPairingPanel = document.querySelector('#viewer-pairing-panel');
const roomCodeLabel = document.querySelector('#viewer-room-code');
const roomQrImage = document.querySelector('#viewer-room-qr-image');
const practiceSwingBallColor = new THREE.Color('#31e0ff');
const PRACTICE_SWING_BALL_OPACITY = 0.26;
const ballMaterialVisualState = new WeakMap();
const PUTT_AIM_DISTANCE_ADJUST_MIN_RATE_METERS_PER_SECOND = 0.25;
const PUTT_AIM_DISTANCE_ADJUST_MAX_RATE_METERS_PER_SECOND = 18;

viewerScene.scene.add(ballTrail.root);

let hasIncomingOrientation = false;
let playerState = 'control';
let clubBallContactLatched = true;
let clubWhooshLatched = false;
let lastClubWhooshTimeMs = -Infinity;
let activeClub = ACTIVE_CLUB;
let practiceSwingMode = false;
let rotateCharacterLeft = false;
let rotateCharacterRight = false;
let increaseAimingPreviewHeadSpeed = false;
let decreaseAimingPreviewHeadSpeed = false;
let remoteJoystickX = 0;
let remoteJoystickY = 0;
let remoteJoystickTargetX = 0;
let remoteJoystickTargetY = 0;
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
let characterRotationHoldSeconds = 0;
let characterRotationDirection = 0;
let aimingPreviewHeadSpeedHoldSeconds = 0;
let aimingPreviewHeadSpeedDirection = 0;
let aimingPreviewHeadSpeedAnalogHoldSeconds = 0;
let aimingPreviewHeadSpeedAnalogDirection = 0;
let practiceSwingBallVisualDirty = true;
let practiceSwingBallVisualChildCount = -1;
let viewerSession = null;
let viewerSessionGeneration = 0;
let lastViewerTransportState = null;
let viewerSessionRestartPromise = null;

const CHARACTER_ROTATION_SPEED_RADIANS = THREE.MathUtils.degToRad(CHARACTER_ROTATION_SPEED_DEGREES);
const AIMING_CAMERA_ENTRY_VERTICAL_TOLERANCE_RADIANS = THREE.MathUtils.degToRad(
  AIMING_CAMERA_ENTRY_VERTICAL_TOLERANCE_DEGREES,
);
const holeWorldPosition = new THREE.Vector3();
const cursorRaycaster = new THREE.Raycaster();
const cursorRayNdc = new THREE.Vector2();

const aimingPreviewController = createAimingPreviewController({
  viewerScene,
  hud,
  ballPhysics,
  getActiveClub: () => activeClub,
  syncLaunchDebugInputs: (launchData) => syncLaunchDebugInputs(launchData),
});
const clubSelectionController = createClubSelectionController({
  dom,
  hud,
  clubSet: ACTIVE_CLUB_SET,
  getActiveClub: () => activeClub,
  onSelectClub: (nextClub) => setActiveClub(nextClub),
});
const viewHudController = createViewHudController({
  viewerScene,
  hud,
  resolveHoleWorldPosition: (target = holeWorldPosition) => aimingPreviewController.resolveHoleWorldPosition(target),
  getPlayerState: () => playerState,
  updateLaunchDebugUiState: (statusMessage = null) => updateLaunchDebugUiState(statusMessage),
});

loadViewerModels(viewerScene, (message) => hud.setStatus(message));
hud.initialize(viewerScene.camera.position, incomingQuaternion);
hud.updateClubDebug(ACTIVE_CLUB_SET, activeClub);
aimingPreviewController.syncPuttAimDistanceToHole();
aimingPreviewController.syncSwingPreviewTarget();
initializeLaunchDebugUi();
clubSelectionController.initializeClubDebugUi();

window.addEventListener('beforeunload', () => {
  void viewerSession?.close();
});

void startViewerSession();

function handleIncomingSwingPacket(packet) {
  const decodedSwingState = decodeSwingStatePacket(packet, incomingQuaternion, incomingSwingState);
  if (!decodedSwingState) {
    return;
  }

  incomingSwingState.receivedAtTimeMs = performance.now();
  hasIncomingOrientation = true;
  viewHudController.recordPacket();
  hud.updateQuaternion(incomingQuaternion);
}

function handleIncomingControlPayload(payloadText) {
  const payload = JSON.parse(payloadText);
  const joystickMessage = decodeJoystickMessage(payload);
  if (joystickMessage) {
    applyRemoteJoystickInput(joystickMessage.x, joystickMessage.y);
    return;
  }

  const controlMessage = decodeControlMessage(payload);
  if (!controlMessage) {
    return;
  }

  applyRemoteControl(controlMessage.action, controlMessage.active, controlMessage.value);
}

function handleRemoteControlDisconnect() {
  resetRemoteJoystickInput();
  if (!rotateCharacterLeft && !rotateCharacterRight) {
    resetCharacterRotationAcceleration();
  }
  if (!increaseAimingPreviewHeadSpeed && !decreaseAimingPreviewHeadSpeed) {
    resetAimingPreviewHeadSpeedAcceleration();
  }
}

/**
 * Recreates the viewer signaling session on the same code so a re-scan gets a fresh offer after controller loss.
 */
function scheduleViewerSessionRestart() {
  if (viewerSessionRestartPromise) {
    return;
  }

  viewerSessionRestartPromise = Promise.resolve()
    .then(() => startViewerSession())
    .finally(() => {
      viewerSessionRestartPromise = null;
    });
}

function updateViewerTransportState(state) {
  const swingConnected = state.swingChannelState === 'open';
  const controlConnected = state.controlChannelState === 'open';
  const fullyConnected = swingConnected && controlConnected;
  const previousState = lastViewerTransportState;
  lastViewerTransportState = state;
  updateViewerPairingUi(roomCodeLabel?.textContent ?? '', state);

  if (previousState?.controlChannelState === 'open' && !controlConnected) {
    handleRemoteControlDisconnect();
    scheduleViewerSessionRestart();
  }

  if (previousState?.remoteUid && !state.remoteUid) {
    scheduleViewerSessionRestart();
  }

  if (
    state.remoteUid
    && (state.connectionState === 'failed' || state.connectionState === 'closed')
  ) {
    scheduleViewerSessionRestart();
  }

  if (state.errorMessage) {
    hud.updateSocketState('Error');
    hud.setStatus(state.errorMessage);
    return;
  }

  if (!state.remoteUid) {
    hud.updateSocketState('Waiting');
    if (!hasIncomingOrientation) {
      hud.setStatus('Viewer ready. Waiting for phone connection.');
    }
    return;
  }

  if (!fullyConnected) {
    hud.updateSocketState('Connecting');
    if (!hasIncomingOrientation) {
      hud.setStatus('Phone joined. Establishing direct link.');
    }
    return;
  }

  hud.updateSocketState('Connected');
  if (!hasIncomingOrientation) {
    hud.setStatus('Phone connected. Waiting for swing data.');
  }
}

async function startViewerSession() {
  viewerSessionGeneration += 1;
  const sessionGeneration = viewerSessionGeneration;
  const retainedRoomCode = /^\d{4}$/.test(roomCodeLabel?.textContent ?? '')
    ? roomCodeLabel.textContent.trim()
    : loadStoredViewerCode();

  await viewerSession?.close();
  viewerSession = null;
  lastViewerTransportState = null;
  hasIncomingOrientation = false;
  if (roomCodeLabel && retainedRoomCode) {
    roomCodeLabel.textContent = retainedRoomCode;
  }
  updateViewerPairingUi(retainedRoomCode || '----', null);
  hud.updateSocketState('Connecting');
  hud.updatePacketRate(0);
  handleRemoteControlDisconnect();

  try {
    const session = await createViewerRtcSession({
      preferredRoomId: loadStoredViewerCode(),
      onSwingPacket: handleIncomingSwingPacket,
      onControlMessage: handleIncomingControlPayload,
      onStateChange: (state) => {
        if (sessionGeneration !== viewerSessionGeneration) {
          return;
        }

        updateViewerTransportState(state);
      },
    });

    if (sessionGeneration !== viewerSessionGeneration) {
      await session.close();
      return;
    }

    viewerSession = session;
    if (roomCodeLabel) {
      roomCodeLabel.textContent = session.roomId;
    }
    updateViewerPairingUi(session.roomId, session.getState());
    saveStoredViewerCode(session.roomId);
    updateViewerTransportState(session.getState());
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to create room.';
    hud.updateSocketState('Error');
    hud.setStatus(message);
  }
}

/**
 * Keeps the pairing affordance visible only while the controller is still joining and updates the QR target when the code changes.
 */
function updateViewerPairingUi(roomCode, transportState) {
  const controlConnected = transportState?.controlChannelState === 'open';

  if (viewerPairingPanel) {
    viewerPairingPanel.hidden = controlConnected;
  }

  if (!roomQrImage) {
    return;
  }

  const normalizedRoomCode = String(roomCode ?? '').trim();
  if (!/^\d{4}$/.test(normalizedRoomCode)) {
    roomQrImage.hidden = true;
    delete roomQrImage.dataset.qrValue;
    roomQrImage.removeAttribute('src');
    roomQrImage.alt = '';
    return;
  }

  const controllerUrl = buildControllerUrl(normalizedRoomCode);
  const qrUrl = new URL('https://api.qrserver.com/v1/create-qr-code/');
  qrUrl.searchParams.set('size', '176x176');
  qrUrl.searchParams.set('margin', '0');
  qrUrl.searchParams.set('data', controllerUrl);

  if (roomQrImage.dataset.qrValue !== controllerUrl || !roomQrImage.getAttribute('src')) {
    roomQrImage.dataset.qrValue = controllerUrl;
    roomQrImage.src = qrUrl.toString();
    roomQrImage.alt = `QR code linking to ${controllerUrl}`;
  }

  roomQrImage.hidden = controlConnected;
}

window.addEventListener('resize', () => {
  viewerScene.resize();
  hud.updateCameraPosition(viewerScene.camera.position);
});

window.addEventListener('keydown', (event) => {
  if (event.code === 'KeyG' && event.altKey && !event.repeat) {
    event.preventDefault();
    warpBallToMousePosition();
    return;
  }

  if (event.code === 'KeyF' && !event.repeat) {
    const freeCameraEnabled = viewerScene.setFreeCameraEnabled(!viewerScene.isFreeCameraEnabled());
    rotateCharacterLeft = false;
    rotateCharacterRight = false;
    resetCharacterRotationAcceleration();
    increaseAimingPreviewHeadSpeed = false;
    decreaseAimingPreviewHeadSpeed = false;
    resetAimingPreviewHeadSpeedAcceleration();
    freeCameraMoveForward = false;
    freeCameraMoveBackward = false;
    freeCameraMoveLeft = false;
    freeCameraMoveRight = false;
    if (!freeCameraEnabled && document.pointerLockElement === dom.canvas) {
      document.exitPointerLock();
    }
    endFreeCameraLook();
    event.preventDefault();
    hud.setStatus(freeCameraEnabled ? 'Free camera enabled.' : getGameplayCameraStatusMessage());
    return;
  }

  if (event.code === 'Space' && !event.repeat) {
    if (isTextEntryTarget(event.target) || viewerScene.isFreeCameraEnabled()) {
      return;
    }

    if (toggleAimingCamera()) {
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
    if (isTextEntryTarget(event.target)) {
      return;
    }

    if (viewerScene.isFreeCameraEnabled()) {
      event.preventDefault();
      return;
    }

    if (!canUseAimingControls()) {
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
      resetAimingPreviewHeadSpeedAcceleration();
    }
    if (!aimingWasEnabled) {
      hud.setStatus(getGameplayCameraStatusMessage());
    }
    event.preventDefault();
    return;
  }

  if (event.repeat) {
    return;
  }

  if (event.code === 'KeyL') {
    if (isTextEntryTarget(event.target)) {
      return;
    }

    launchDebugBallFromInput();
    return;
  }

  if (event.code === 'KeyR') {
    resetShotFlow();
    event.preventDefault();
    return;
  }

  if (event.code === 'KeyQ') {
    if (isTextEntryTarget(event.target)) {
      return;
    }
    clubSelectionController.selectPreviousClub();
    event.preventDefault();
    return;
  }

  if (event.code === 'KeyE') {
    if (isTextEntryTarget(event.target)) {
      return;
    }
    clubSelectionController.selectNextClub();
    event.preventDefault();
    return;
  }

  if (event.code === 'KeyP') {
    if (isTextEntryTarget(event.target)) {
      return;
    }

    togglePracticeSwingMode();
    event.preventDefault();
  }
});

window.addEventListener('keyup', (event) => {
  if (event.code === 'KeyW') {
    freeCameraMoveForward = false;
    return;
  }

  if (event.code === 'KeyS') {
    freeCameraMoveBackward = false;
    return;
  }

  if (event.code === 'KeyA') {
    freeCameraMoveLeft = false;
    return;
  }

  if (event.code === 'KeyD') {
    freeCameraMoveRight = false;
    return;
  }

  if (event.code === 'ArrowLeft') {
    rotateCharacterLeft = false;
    resetCharacterRotationAcceleration();
    event.preventDefault();
    return;
  }

  if (event.code === 'ArrowRight') {
    rotateCharacterRight = false;
    resetCharacterRotationAcceleration();
    event.preventDefault();
    return;
  }

  if (event.code === 'ArrowUp' || event.code === 'ArrowDown') {
    if (event.code === 'ArrowUp') {
      increaseAimingPreviewHeadSpeed = false;
    } else {
      decreaseAimingPreviewHeadSpeed = false;
    }
    resetAimingPreviewHeadSpeedAcceleration();
    event.preventDefault();
  }
});

window.addEventListener('blur', () => {
  rotateCharacterLeft = false;
  rotateCharacterRight = false;
  resetCharacterRotationAcceleration();
  increaseAimingPreviewHeadSpeed = false;
  decreaseAimingPreviewHeadSpeed = false;
  resetAimingPreviewHeadSpeedAcceleration();
  freeCameraMoveForward = false;
  freeCameraMoveBackward = false;
  freeCameraMoveLeft = false;
  freeCameraMoveRight = false;
  endFreeCameraLook();
  if (document.pointerLockElement === dom.canvas) {
    document.exitPointerLock();
  }
});

document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement === dom.canvas) {
    beginFreeCameraLook();
    return;
  }

  endFreeCameraLook();
});

const debugToggleButton = document.getElementById('viewer-debug-toggle');
if (debugToggleButton) {
  debugToggleButton.addEventListener('click', () => {
    DEBUG_UI_ENABLED = !DEBUG_UI_ENABLED;
    document.body.classList.toggle('viewer-debug-enabled', DEBUG_UI_ENABLED);
    hud.updateLaunchPanelVisible(DEBUG_UI_ENABLED);
    if (DEBUG_UI_ENABLED) {
      updateLaunchDebugUiState();
    }
  });
}

dom.canvas.addEventListener('contextmenu', (event) => {
  if (!viewerScene.isFreeCameraEnabled()) {
    return;
  }

  event.preventDefault();
});

dom.canvas.addEventListener('mousedown', (event) => {
  if (!viewerScene.isFreeCameraEnabled() || event.button !== 2) {
    return;
  }

  if (dom.canvas.requestPointerLock) {
    dom.canvas.requestPointerLock();
  } else {
    beginFreeCameraLook(event.clientX, event.clientY);
  }
  event.preventDefault();
});

window.addEventListener('mouseup', (event) => {
  if (event.button !== 2) {
    return;
  }

  if (document.pointerLockElement === dom.canvas) {
    document.exitPointerLock();
    return;
  }

  endFreeCameraLook();
});

window.addEventListener('mousemove', (event) => {
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
});

animate();

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

/**
 * Keeps the last visible mouse position available so debug movement can raycast from the cursor.
 */
function rememberCursorPointerPosition(clientX, clientY) {
  hasCursorPointerPosition = Number.isFinite(clientX) && Number.isFinite(clientY);
  if (!hasCursorPointerPosition) {
    return;
  }

  lastCursorPointerClientX = clientX;
  lastCursorPointerClientY = clientY;
}

function animate() {
  requestAnimationFrame(animate);

  const deltaSeconds = animationClock.getDelta();
  viewHudController.recordFrame();
  updateRemoteControlInput(deltaSeconds);
  updateCharacterRotationInput(deltaSeconds);
  updateAimingPreviewHeadSpeedInput(deltaSeconds);
  character.update(deltaSeconds, hasIncomingOrientation ? incomingQuaternion : null);
  const characterTelemetry = character.getDebugTelemetry();
  aimingPreviewController.updateIfNeeded(playerState);
  aimingPreviewController.updatePresentation(deltaSeconds);
  updateClubWhooshAudio();
  detectClubBallImpact(characterTelemetry);
  ballPhysics.update(deltaSeconds);
  const surfaceImpactEvents = ballPhysics.consumeSurfaceImpactEvents();
  for (const surfaceImpactEvent of surfaceImpactEvents) {
    shotImpactAudio.playSurfaceImpact(
      surfaceImpactEvent.surfaceType,
      surfaceImpactEvent.impactSpeedMetersPerSecond,
    );
  }
  let ballTelemetry = ballPhysics.getDebugTelemetry();
  const trailTelemetry = ballTelemetry;

  if (playerState === 'waiting' && ballPhysics.consumeShotSettled()) {
    viewerScene.positionCharacterForBall(ballTelemetry.position);
    if (!viewerScene.isFreeCameraEnabled()) {
      viewerScene.setAimingCameraEnabled(false);
      viewHudController.faceCameraTowardHole(ballTelemetry.position);
    }
    ballPhysics.prepareForNextShot();
    playerState = 'control';
    clubBallContactLatched = true;
    ballTelemetry = ballPhysics.getDebugTelemetry();
    aimingPreviewController.syncPuttAimDistanceToHole(ballTelemetry.position);
    hud.updateSwingPreviewCapture(null, aimingPreviewController.getCurrentAimingPreviewHeadSpeed(ballTelemetry.position));
    aimingPreviewController.invalidate();
  }

  viewerScene.ballRoot.position.copy(ballPhysics.getPosition());
  viewerScene.ballRoot.quaternion.copy(ballPhysics.getOrientation());
  syncPracticeSwingBallVisualState();
  ballTrail.update(ballPhysics.getPosition(), trailTelemetry, deltaSeconds);
  viewerScene.updateFreeCamera(deltaSeconds, {
    forward: Number(freeCameraMoveForward) - Number(freeCameraMoveBackward),
    right: Number(freeCameraMoveRight) - Number(freeCameraMoveLeft),
  });
  viewerScene.updateBallFollowCamera(deltaSeconds, aimingPreviewController.getBallFollowPreviewState());
  viewHudController.updateCharacterDebugTelemetry(characterTelemetry);
  viewHudController.updateBallDebugTelemetry(ballTelemetry);
  viewHudController.updateFpsIfNeeded();
  viewHudController.updatePacketRateIfNeeded();
  viewerScene.updateControls();
  viewerScene.applyCameraTilt();
  viewHudController.updateHoleMarker(ballTelemetry);
  aimingPreviewController.updateMarker(ballTelemetry);
  viewHudController.updateCameraPositionLabelIfNeeded();
  viewerScene.updateShadows();
  viewerScene.renderer.render(viewerScene.scene, viewerScene.camera);
}

function updateCharacterRotationInput(deltaSeconds) {
  if (viewerScene.isFreeCameraEnabled()) {
    resetCharacterRotationAcceleration();
    return;
  }

  if (!canUseAimingControls()) {
    resetCharacterRotationAcceleration();
    return;
  }

  const keyboardRotationDirection = getKeyboardRotationInputDirection();
  const remoteRotationDirection = getRemoteRotationInputDirection();
  const rotationDirection = keyboardRotationDirection !== 0 ? keyboardRotationDirection : remoteRotationDirection;
  if (rotationDirection === 0) {
    resetCharacterRotationAcceleration();
    return;
  }

  let rotationSpeedMultiplier = 1;
  if (keyboardRotationDirection !== 0) {
    if (rotationDirection !== characterRotationDirection) {
      characterRotationDirection = rotationDirection;
      characterRotationHoldSeconds = 0;
    } else {
      characterRotationHoldSeconds += deltaSeconds;
    }

    rotationSpeedMultiplier = getCharacterRotationAccelerationMultiplier(characterRotationHoldSeconds);
  } else {
    characterRotationDirection = rotationDirection;
    characterRotationHoldSeconds = 0;
    rotationSpeedMultiplier = getAnalogResponseMagnitude(
      Math.abs(rotationDirection),
      CHARACTER_ROTATION_ANALOG_RESPONSE_EXPONENT,
    );
  }

  const aimingRotationDistanceMultiplier = getAimingRotationDistanceMultiplier();
  const rotationRadians = rotationDirection
    * CHARACTER_ROTATION_SPEED_RADIANS
    * rotationSpeedMultiplier
    * aimingRotationDistanceMultiplier
    * deltaSeconds;

  viewerScene.rotateCharacterAroundBall(
    ballPhysics.getPosition(),
    rotationRadians,
  );
  viewerScene.orbitNormalCameraAroundBall(
    ballPhysics.getPosition(),
    rotationRadians,
  );
  aimingPreviewController.invalidate();

}

/**
 * Converts held up/down input into either a head-speed change or a putt target-distance change.
 * Keyboard input may still enter aim mode directly, while phone joystick input only adjusts after a double-tap toggle.
 */
function updateAimingPreviewHeadSpeedInput(deltaSeconds) {
  if (viewerScene.isFreeCameraEnabled()) {
    resetAimingPreviewHeadSpeedAcceleration();
    resetAimingPreviewHeadSpeedAnalogAcceleration();
    return;
  }

  if (!canUseAimingControls()) {
    resetAimingPreviewHeadSpeedAcceleration();
    resetAimingPreviewHeadSpeedAnalogAcceleration();
    return;
  }

  const keyboardHeadSpeedDirection = getKeyboardAimingPreviewHeadSpeedInputDirection();
  const remoteHeadSpeedDirection = getRemoteAimingPreviewHeadSpeedInputDirection();
  const isKeyboardInputActive = keyboardHeadSpeedDirection !== 0;
  const isRemoteAimEntryActive = !isKeyboardInputActive && isRemoteAimEntryGestureActive();
  const headSpeedDirection = isKeyboardInputActive ? keyboardHeadSpeedDirection : remoteHeadSpeedDirection;
  if (headSpeedDirection === 0) {
    resetAimingPreviewHeadSpeedAcceleration();
    resetAimingPreviewHeadSpeedAnalogAcceleration();
    return;
  }

  if (!viewerScene.isAimingCameraEnabled()) {
    if (!isKeyboardInputActive && !isRemoteAimEntryActive) {
      resetAimingPreviewHeadSpeedAnalogAcceleration();
      return;
    }

    viewerScene.setAimingCameraEnabled(true);
    hud.setStatus(getGameplayCameraStatusMessage());
  }

  const useLaunchPreview = usesLaunchAimingPreview();
  let adjustmentRate = useLaunchPreview
    ? AIMING_PREVIEW_HEAD_SPEED_ADJUST_MIN_RATE_METERS_PER_SECOND
    : PUTT_AIM_DISTANCE_ADJUST_MIN_RATE_METERS_PER_SECOND;
  if (isKeyboardInputActive) {
    resetAimingPreviewHeadSpeedAnalogAcceleration();
    if (headSpeedDirection !== aimingPreviewHeadSpeedDirection) {
      aimingPreviewHeadSpeedDirection = headSpeedDirection;
      aimingPreviewHeadSpeedHoldSeconds = 0;
    } else {
      aimingPreviewHeadSpeedHoldSeconds += deltaSeconds;
    }

    adjustmentRate = useLaunchPreview
      ? getAimingPreviewHeadSpeedAdjustmentRate(aimingPreviewHeadSpeedHoldSeconds)
      : getPuttAimDistanceAdjustmentRate(aimingPreviewHeadSpeedHoldSeconds);
  } else {
    resetAimingPreviewHeadSpeedAcceleration();
    adjustmentRate = useLaunchPreview
      ? getAnalogAimingPreviewHeadSpeedAdjustmentRate(headSpeedDirection, deltaSeconds)
      : getAnalogPuttAimDistanceAdjustmentRate(headSpeedDirection, deltaSeconds);
  }

  const previewDelta = headSpeedDirection * adjustmentRate * deltaSeconds;
  if (useLaunchPreview) {
    aimingPreviewController.adjustAimingPreviewHeadSpeed(previewDelta);
    return;
  }

  aimingPreviewController.adjustPuttAimDistance(previewDelta);
}

/**
 * Clears the hold-duration state so tap-versus-hold acceleration always restarts cleanly.
 */
function resetCharacterRotationAcceleration() {
  characterRotationHoldSeconds = 0;
  characterRotationDirection = 0;
}

/**
 * Clears held up/down acceleration so the next tap starts from the fine-adjustment rate.
 */
function resetAimingPreviewHeadSpeedAcceleration() {
  aimingPreviewHeadSpeedHoldSeconds = 0;
  aimingPreviewHeadSpeedDirection = 0;
}

/**
 * Clears the mobile analog hold state so the next joystick pull starts from the precise initial adjustment rate.
 */
function resetAimingPreviewHeadSpeedAnalogAcceleration() {
  aimingPreviewHeadSpeedAnalogHoldSeconds = 0;
  aimingPreviewHeadSpeedAnalogDirection = 0;
}

/**
 * Ramps rotation speed from a precise tap speed into a faster sustained turn while the input is held.
 */
function getCharacterRotationAccelerationMultiplier(holdSeconds) {
  const holdAlpha = CHARACTER_ROTATION_ACCELERATION_RAMP_SECONDS > 1e-8
    ? THREE.MathUtils.clamp(holdSeconds / CHARACTER_ROTATION_ACCELERATION_RAMP_SECONDS, 0, 1)
    : 1;
  return THREE.MathUtils.lerp(
    CHARACTER_ROTATION_ACCELERATION_MIN_MULTIPLIER,
    CHARACTER_ROTATION_ACCELERATION_MAX_MULTIPLIER,
    holdAlpha,
  );
}

/**
 * Scales aiming rotation by preview carry distance so near and far landing points shift more consistently.
 */
function getAimingRotationDistanceMultiplier() {
  const aimingPreviewState = aimingPreviewController.getState();
  if (!viewerScene.isAimingCameraEnabled() || !aimingPreviewState.isVisible) {
    return 1;
  }

  const carryDistanceMeters = Math.max(aimingPreviewState.carryDistanceMeters, 1);
  return THREE.MathUtils.clamp(
    AIMING_ROTATION_DISTANCE_REFERENCE_METERS / carryDistanceMeters,
    AIMING_ROTATION_DISTANCE_MIN_MULTIPLIER,
    AIMING_ROTATION_DISTANCE_MAX_MULTIPLIER,
  );
}

/**
 * Ramps the aiming-preview head-speed change rate from a small nudge into a faster hold adjustment.
 */
function getAimingPreviewHeadSpeedAdjustmentRate(holdSeconds) {
  const holdAlpha = AIMING_PREVIEW_HEAD_SPEED_ADJUST_RAMP_SECONDS > 1e-8
    ? THREE.MathUtils.clamp(holdSeconds / AIMING_PREVIEW_HEAD_SPEED_ADJUST_RAMP_SECONDS, 0, 1)
    : 1;
  return THREE.MathUtils.lerp(
    AIMING_PREVIEW_HEAD_SPEED_ADJUST_MIN_RATE_METERS_PER_SECOND,
    AIMING_PREVIEW_HEAD_SPEED_ADJUST_MAX_RATE_METERS_PER_SECOND,
    holdAlpha,
  );
}

/**
 * Ramps putt target-distance changes from fine nudges into faster sweeps while the input stays held.
 */
function getPuttAimDistanceAdjustmentRate(holdSeconds) {
  const holdAlpha = AIMING_PREVIEW_HEAD_SPEED_ADJUST_RAMP_SECONDS > 1e-8
    ? THREE.MathUtils.clamp(holdSeconds / AIMING_PREVIEW_HEAD_SPEED_ADJUST_RAMP_SECONDS, 0, 1)
    : 1;
  return THREE.MathUtils.lerp(
    PUTT_AIM_DISTANCE_ADJUST_MIN_RATE_METERS_PER_SECOND,
    PUTT_AIM_DISTANCE_ADJUST_MAX_RATE_METERS_PER_SECOND,
    holdAlpha,
  );
}

/**
 * Applies a dedicated ramp for mobile analog input so small stick holds stay precise while sustained larger pulls can still speed up.
 */
function getAnalogAimingPreviewHeadSpeedAdjustmentRate(headSpeedDirection, deltaSeconds) {
  const analogDirection = Math.sign(headSpeedDirection);
  if (analogDirection !== aimingPreviewHeadSpeedAnalogDirection) {
    aimingPreviewHeadSpeedAnalogDirection = analogDirection;
    aimingPreviewHeadSpeedAnalogHoldSeconds = 0;
  } else {
    aimingPreviewHeadSpeedAnalogHoldSeconds += deltaSeconds;
  }

  const targetRate = THREE.MathUtils.lerp(
    AIMING_PREVIEW_HEAD_SPEED_ADJUST_MIN_RATE_METERS_PER_SECOND,
    AIMING_PREVIEW_HEAD_SPEED_ADJUST_MAX_RATE_METERS_PER_SECOND,
    getAnalogResponseMagnitude(
      Math.abs(headSpeedDirection),
      AIMING_PREVIEW_HEAD_SPEED_ANALOG_RESPONSE_EXPONENT,
    ),
  );
  const rampAlpha = AIMING_PREVIEW_HEAD_SPEED_ANALOG_RAMP_SECONDS > 1e-8
    ? THREE.MathUtils.clamp(
      aimingPreviewHeadSpeedAnalogHoldSeconds / AIMING_PREVIEW_HEAD_SPEED_ANALOG_RAMP_SECONDS,
      0,
      1,
    )
    : 1;

  return THREE.MathUtils.lerp(
    AIMING_PREVIEW_HEAD_SPEED_ADJUST_MIN_RATE_METERS_PER_SECOND,
    targetRate,
    rampAlpha,
  );
}

/**
 * Applies the same analog hold behavior to putt target distance so mobile aiming stays consistent across club types.
 */
function getAnalogPuttAimDistanceAdjustmentRate(headSpeedDirection, deltaSeconds) {
  const analogDirection = Math.sign(headSpeedDirection);
  if (analogDirection !== aimingPreviewHeadSpeedAnalogDirection) {
    aimingPreviewHeadSpeedAnalogDirection = analogDirection;
    aimingPreviewHeadSpeedAnalogHoldSeconds = 0;
  } else {
    aimingPreviewHeadSpeedAnalogHoldSeconds += deltaSeconds;
  }

  const targetRate = THREE.MathUtils.lerp(
    PUTT_AIM_DISTANCE_ADJUST_MIN_RATE_METERS_PER_SECOND,
    PUTT_AIM_DISTANCE_ADJUST_MAX_RATE_METERS_PER_SECOND,
    getAnalogResponseMagnitude(
      Math.abs(headSpeedDirection),
      AIMING_PREVIEW_HEAD_SPEED_ANALOG_RESPONSE_EXPONENT,
    ),
  );
  const rampAlpha = AIMING_PREVIEW_HEAD_SPEED_ANALOG_RAMP_SECONDS > 1e-8
    ? THREE.MathUtils.clamp(
      aimingPreviewHeadSpeedAnalogHoldSeconds / AIMING_PREVIEW_HEAD_SPEED_ANALOG_RAMP_SECONDS,
      0,
      1,
    )
    : 1;

  return THREE.MathUtils.lerp(
    PUTT_AIM_DISTANCE_ADJUST_MIN_RATE_METERS_PER_SECOND,
    targetRate,
    rampAlpha,
  );
}

/**
 * Returns whether the player can currently change the gameplay aiming state.
 */
function canUseAimingControls() {
  return playerState === 'control' && ballPhysics.getStateSnapshot().phase === 'ready';
}

/**
 * Returns whether the current club uses the neutral launch preview instead of the putt slope grid.
 */
function usesLaunchAimingPreview() {
  return activeClub?.category !== 'putter';
}

/**
 * Keeps practice mode in the viewer layer so practice swings can reuse impact math without entering physics.
 */
function togglePracticeSwingMode() {
  return setPracticeSwingMode(!practiceSwingMode);
}

/**
 * Applies an explicit swing mode so remote UI buttons can select practice or actual play directly.
 */
function setPracticeSwingMode(enabled) {
  const shouldEnablePracticeMode = Boolean(enabled);
  if (shouldEnablePracticeMode && !canUseAimingControls()) {
    hud.setStatus('Practice swing mode is available only while the ball is ready.');
    return false;
  }

  practiceSwingMode = shouldEnablePracticeMode;
  practiceSwingBallVisualDirty = true;
  syncPracticeSwingBallVisualState();
  hud.setStatus(shouldEnablePracticeMode
    ? 'Practice swing mode enabled.'
    : 'Actual swing mode enabled.');
  return true;
}

/**
 * Applies the practice ball look lazily so the ball model can load asynchronously and still pick up the mode.
 */
function syncPracticeSwingBallVisualState() {
  const childCount = viewerScene.ballRoot.children.length;
  if (!practiceSwingBallVisualDirty && childCount === practiceSwingBallVisualChildCount) {
    return;
  }

  practiceSwingBallVisualDirty = false;
  practiceSwingBallVisualChildCount = childCount;
  viewerScene.ballRoot.traverse((node) => {
    if (!node.isMesh || !node.material) {
      return;
    }

    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      if (!material) {
        continue;
      }

      if (!ballMaterialVisualState.has(material)) {
        ballMaterialVisualState.set(material, {
          wireframe: Boolean(material.wireframe),
          transparent: Boolean(material.transparent),
          opacity: Number.isFinite(material.opacity) ? material.opacity : 1,
          color: material.color?.clone?.() ?? null,
        });
      }

      const visualState = ballMaterialVisualState.get(material);
      material.wireframe = visualState.wireframe;
      material.transparent = practiceSwingMode ? true : visualState.transparent;
      material.opacity = practiceSwingMode ? PRACTICE_SWING_BALL_OPACITY : visualState.opacity;
      if (visualState.color && material.color) {
        material.color.copy(practiceSwingMode ? practiceSwingBallColor : visualState.color);
      }
      material.needsUpdate = true;
    }
  });
}

/**
 * Maps the current gameplay camera mode to a short HUD status message.
 */
function getGameplayCameraStatusMessage() {
  return viewerScene.isAimingCameraEnabled() ? 'Aiming camera enabled.' : 'Normal camera enabled.';
}

/**
 * Smooths remote joystick values so packet jitter and inconsistent mobile event timing do not show up as camera jitter.
 */
function updateRemoteControlInput(deltaSeconds) {
  remoteJoystickX = smoothRemoteStrength(remoteJoystickX, remoteJoystickTargetX, deltaSeconds);
  remoteJoystickY = smoothRemoteStrength(remoteJoystickY, remoteJoystickTargetY, deltaSeconds);
}

/**
 * Returns the local keyboard rotation direction without mixing in networked analog input.
 */
function getKeyboardRotationInputDirection() {
  return Number(rotateCharacterLeft) - Number(rotateCharacterRight);
}

/**
 * Returns the smoothed mobile joystick rotation direction.
 */
function getRemoteRotationInputDirection() {
  if (isRemoteAimEntryGestureActive()) {
    return 0;
  }

  return -remoteJoystickX;
}

/**
 * Returns the local keyboard aiming-preview direction without mixing in networked analog input.
 */
function getKeyboardAimingPreviewHeadSpeedInputDirection() {
  return Number(increaseAimingPreviewHeadSpeed) - Number(decreaseAimingPreviewHeadSpeed);
}

/**
 * Returns the smoothed mobile joystick aiming-preview direction.
 */
function getRemoteAimingPreviewHeadSpeedInputDirection() {
  return remoteJoystickY;
}

/**
 * Treats a strong near-vertical remote joystick pull as the mobile equivalent of keyboard up/down so it can enter aim mode directly.
 */
function isRemoteAimEntryGestureActive() {
  const verticalDirection = remoteJoystickTargetY;
  if (verticalDirection === 0) {
    return false;
  }

  const horizontalDirection = remoteJoystickTargetX;
  const radialMagnitude = Math.hypot(horizontalDirection, verticalDirection);
  if (radialMagnitude < AIMING_CAMERA_ENTRY_MIN_MAGNITUDE) {
    return false;
  }

  const verticalMagnitude = Math.abs(verticalDirection);
  const horizontalMagnitude = Math.abs(horizontalDirection);
  if (horizontalMagnitude <= 1e-6) {
    return true;
  }

  const angleFromVerticalRadians = Math.atan2(horizontalMagnitude, verticalMagnitude);
  return angleFromVerticalRadians <= AIMING_CAMERA_ENTRY_VERTICAL_TOLERANCE_RADIANS;
}

/**
 * Shapes analog stick magnitude so small deflections stay controllable while full deflection still reaches full speed.
 */
function getAnalogResponseMagnitude(magnitude, exponent) {
  return Math.pow(THREE.MathUtils.clamp(magnitude, 0, 1), exponent);
}

function smoothRemoteStrength(current, target, deltaSeconds) {
  const smoothingAlpha = 1 - Math.exp(-REMOTE_CONTROL_INPUT_SMOOTHING * deltaSeconds);
  const next = THREE.MathUtils.lerp(current, target, smoothingAlpha);
  return Math.abs(next - target) <= REMOTE_CONTROL_INPUT_SNAP_EPSILON ? target : next;
}

/**
 * Applies the latest raw mobile joystick axes so gameplay state can interpret them centrally.
 */
function applyRemoteJoystickInput(x, y) {
  remoteJoystickTargetX = THREE.MathUtils.clamp(x, -1, 1);
  remoteJoystickTargetY = THREE.MathUtils.clamp(y, -1, 1);
}

function resetRemoteJoystickInput() {
  remoteJoystickX = 0;
  remoteJoystickY = 0;
  remoteJoystickTargetX = 0;
  remoteJoystickTargetY = 0;
}

/**
 * Mirrors the Space-bar gameplay rule: aiming can always be turned off, but only turned on while the ball is ready.
 */
function toggleAimingCamera() {
  if (!viewerScene.isAimingCameraEnabled() && !canUseAimingControls()) {
    return false;
  }

  viewerScene.setAimingCameraEnabled(!viewerScene.isAimingCameraEnabled());
  aimingPreviewController.invalidate();
  resetCharacterRotationAcceleration();
  if (!viewerScene.isAimingCameraEnabled()) {
    increaseAimingPreviewHeadSpeed = false;
    decreaseAimingPreviewHeadSpeed = false;
    resetAimingPreviewHeadSpeedAcceleration();
  }
  hud.setStatus(getGameplayCameraStatusMessage());
  return true;
}

function applyRemoteControl(action, active, value = null) {
  const analogStrength = active ? Math.max(0, Math.min(1, value ?? 1)) : 0;

  switch (action) {
    case CONTROL_ACTIONS.clubPrevious:
      if (active) {
        clubSelectionController.selectPreviousClub();
      }
      break;
    case CONTROL_ACTIONS.clubNext:
      if (active) {
        clubSelectionController.selectNextClub();
      }
      break;
    case CONTROL_ACTIONS.practiceSwingEnable:
      if (active) {
        setPracticeSwingMode(true);
      }
      break;
    case CONTROL_ACTIONS.actualSwingEnable:
      if (active) {
        setPracticeSwingMode(false);
      }
      break;
    case CONTROL_ACTIONS.rotateLeft:
      remoteJoystickTargetX = active ? -analogStrength : Math.max(remoteJoystickTargetX, 0);
      if (!rotateCharacterLeft && remoteJoystickTargetX === 0 && !rotateCharacterRight) {
        resetCharacterRotationAcceleration();
      }
      break;
    case CONTROL_ACTIONS.rotateRight:
      remoteJoystickTargetX = active ? analogStrength : Math.min(remoteJoystickTargetX, 0);
      if (!rotateCharacterLeft && remoteJoystickTargetX === 0 && !rotateCharacterRight) {
        resetCharacterRotationAcceleration();
      }
      break;
    case CONTROL_ACTIONS.aimIncrease:
      remoteJoystickTargetY = active ? analogStrength : Math.min(remoteJoystickTargetY, 0);
      if (remoteJoystickTargetY === 0 && !increaseAimingPreviewHeadSpeed && !decreaseAimingPreviewHeadSpeed) {
        resetAimingPreviewHeadSpeedAcceleration();
      }
      break;
    case CONTROL_ACTIONS.aimDecrease:
      remoteJoystickTargetY = active ? -analogStrength : Math.max(remoteJoystickTargetY, 0);
      if (remoteJoystickTargetY === 0 && !increaseAimingPreviewHeadSpeed && !decreaseAimingPreviewHeadSpeed) {
        resetAimingPreviewHeadSpeedAcceleration();
      }
      break;
    case CONTROL_ACTIONS.aimCameraToggle:
      if (active) {
        toggleAimingCamera();
      }
      break;
    default:
      break;
  }
}

function detectClubBallImpact(characterTelemetry) {
  releaseClubBallContactLatch(characterTelemetry.clubHeadPosition);

  const ballTelemetry = ballPhysics.getDebugTelemetry();
  if (playerState !== 'control' || ballTelemetry.phase !== 'ready' || !characterTelemetry.hasClubHeadSample) {
    return;
  }

  if (clubBallContactLatched) {
    return;
  }

  const incomingClubHeadSpeedMetersPerSecond = getIncomingClubHeadSpeedMetersPerSecond();
  if (!isLaunchSpeedReadyForCurrentAim(incomingClubHeadSpeedMetersPerSecond)) {
    return;
  }

  const impact = resolveClubBallImpact(
    characterTelemetry,
    ballTelemetry.position,
    incomingClubHeadSpeedMetersPerSecond,
    activeClub,
  );
  if (!impact) {
    return;
  }

  hud.updateLaunchPreview(impact.launchPreview);
  aimingPreviewController.updateSwingPreviewCaptureFromImpact(impact);
  if (practiceSwingMode) {
    handlePracticeLaunch(impact);
  } else {
    launchBall(impact.launchData, impact.referenceForward, impact.impactSpeedMetersPerSecond);
  }
  clubBallContactLatched = true;
}

/**
 * Prevents tiny accidental motions from launching the ball when the current aim expects a much faster swing.
 */
function isLaunchSpeedReadyForCurrentAim(incomingClubHeadSpeedMetersPerSecond) {
  if (!Number.isFinite(incomingClubHeadSpeedMetersPerSecond) || incomingClubHeadSpeedMetersPerSecond <= 0) {
    return false;
  }

  const currentAimingHeadSpeedMetersPerSecond = aimingPreviewController.getCurrentAimingPreviewHeadSpeed();
  if (!Number.isFinite(currentAimingHeadSpeedMetersPerSecond) || currentAimingHeadSpeedMetersPerSecond <= 0) {
    return true;
  }

  return incomingClubHeadSpeedMetersPerSecond >= (
    currentAimingHeadSpeedMetersPerSecond * CLUB_HEAD_AIMING_PREVIEW_LAUNCH_MIN_SPEED_RATIO
  );
}

/**
 * Plays a single swing whoosh when the incoming club speed crosses the configured whoosh threshold, even if the swing misses the ball.
 */
function updateClubWhooshAudio() {
  const ballTelemetry = ballPhysics.getDebugTelemetry();
  const canPlayWhoosh = playerState === 'control' && ballTelemetry.phase === 'ready';

  if (!canPlayWhoosh) {
    clubWhooshLatched = false;
    return;
  }

  const incomingClubHeadSpeedMetersPerSecond = getIncomingClubHeadSpeedMetersPerSecond();
  const now = performance.now();
  if (clubWhooshLatched && incomingClubHeadSpeedMetersPerSecond < CLUB_SWING_WHOOSH_REARM_SPEED) {
    clubWhooshLatched = false;
  }

  if (incomingClubHeadSpeedMetersPerSecond > CLUB_SWING_WHOOSH_MIN_SPEED) {
    const isWhooshOffCooldown = now - lastClubWhooshTimeMs >= CLUB_SWING_WHOOSH_COOLDOWN_MS;
    if (!clubWhooshLatched && isWhooshOffCooldown) {
      shotImpactAudio.playWhoosh(incomingClubHeadSpeedMetersPerSecond);
      clubWhooshLatched = true;
      lastClubWhooshTimeMs = now;
    }
    return;
  }
}

function getIncomingClubHeadSpeedMetersPerSecond() {



  if (
    !Number.isFinite(incomingSwingState.perpendicularAngularSpeedRadiansPerSecond)
    || incomingSwingState.perpendicularAngularSpeedRadiansPerSecond <= 0
  ) {
    return 0;
  }

  const receiveAgeMilliseconds = incomingSwingState.receivedAtTimeMs > 0
    ? Math.max(performance.now() - incomingSwingState.receivedAtTimeMs, 0)
    : 65535;
  const totalAgeMilliseconds = incomingSwingState.motionAgeMilliseconds + receiveAgeMilliseconds;
  if (totalAgeMilliseconds > 250) {
    return 0;
  }

  const effectiveLengthMeters = Number.isFinite(activeClub?.effectiveLengthMeters)
    ? activeClub.effectiveLengthMeters
    : 0.9;
  return incomingSwingState.perpendicularAngularSpeedRadiansPerSecond
    * effectiveLengthMeters
    * PHONE_ANGULAR_SPEED_TO_CLUB_HEAD_SPEED_GAIN;
}

function launchBall(launchData, referenceForward, impactSpeedMetersPerSecond = null) {
  if (!viewerScene.isFreeCameraEnabled()) {
    viewerScene.setAimingCameraEnabled(false);
  }
  if (Math.abs(launchData.horizontalLaunchAngle) <= SHOT_AUDIO_PANGYA_MAX_HORIZONTAL_ANGLE_DEGREES) {
    shotImpactAudio.playPangya();
  }
  shotImpactAudio.playForImpactSpeed(
    getLaunchImpactSpeedMetersPerSecond(launchData, impactSpeedMetersPerSecond),
  );
  playerState = 'waiting';
  ballTrail.reset();
  ballPhysics.launch(launchData, referenceForward);
  aimingPreviewController.invalidate();
}

/**
 * Emits practice launch data locally so preview UI can react without advancing the real shot state.
 */
function handlePracticeLaunch(impact) {
  shotImpactAudio.playPractice();

  window.dispatchEvent(new CustomEvent('practiceLaunch', {
    detail: {
      practiceSwingMode: true,
      impactSpeedMetersPerSecond: impact.impactSpeedMetersPerSecond,
      launchData: { ...impact.launchData },
      launchPreview: impact.launchPreview ? { ...impact.launchPreview } : null,
      referenceForward: impact.referenceForward ? impact.referenceForward.clone() : null,
      timestampMs: performance.now(),
    },
  }));
  hud.setStatus(`Practice launch captured at ${formatMetersPerSecond(impact.launchPreview?.ballSpeed ?? 0)} ball speed.`);
}

function getLaunchImpactSpeedMetersPerSecond(launchData, impactSpeedMetersPerSecond) {
  if (Number.isFinite(impactSpeedMetersPerSecond) && impactSpeedMetersPerSecond > 0) {
    return impactSpeedMetersPerSecond;
  }

  if (!Number.isFinite(launchData?.ballSpeed) || launchData.ballSpeed <= 0) {
    return 0;
  }

  const smashFactor = Number.isFinite(activeClub?.smashFactor)
    ? activeClub.smashFactor
    : 1.35;
  return launchData.ballSpeed / smashFactor;
}

function releaseClubBallContactLatch(clubHeadPosition) {
  if (!clubBallContactLatched) {
    return;
  }

  if (clubHeadPosition.distanceTo(ballPhysics.getPosition()) > CLUB_HEAD_CONTACT_RELEASE_DISTANCE) {
    clubBallContactLatched = false;
  }
}

function resetShotFlow(surfacePoint = null, surfaceNormal = null) {
  if (surfacePoint) {
    ballPhysics.teleportToSurface(surfacePoint, surfaceNormal);
  } else {
    ballPhysics.reset();
  }
  ballTrail.reset();
  viewerScene.ballRoot.position.copy(ballPhysics.getPosition());
  viewerScene.ballRoot.quaternion.copy(ballPhysics.getOrientation());
  practiceSwingBallVisualDirty = true;
  syncPracticeSwingBallVisualState();
  viewerScene.positionCharacterForBall(ballPhysics.getPosition());
  if (!viewerScene.isFreeCameraEnabled()) {
    viewerScene.setAimingCameraEnabled(false);
    viewHudController.faceCameraTowardHole(ballPhysics.getPosition());
  }
  clubWhooshLatched = false;
  lastClubWhooshTimeMs = -Infinity;
  playerState = 'control';
  clubBallContactLatched = true;
  aimingPreviewController.syncPuttAimDistanceToHole(ballPhysics.getPosition());
  aimingPreviewController.syncSwingPreviewTarget();
  hud.updateSwingPreviewCapture(null, aimingPreviewController.getCurrentAimingPreviewHeadSpeed(ballPhysics.getPosition()));
  updateLaunchDebugUiState();
  aimingPreviewController.invalidate();
}

/**
 * Raycasts from the current cursor position and moves the ball to the nearest grounded course point.
 */
function warpBallToMousePosition() {
  if (!viewerScene.courseCollision?.root) {
    hud.setStatus('Ball warp unavailable until the course collision data is ready.');
    return false;
  }

  const warpTarget = resolveCursorWarpTarget();
  if (!warpTarget) {
    hud.setStatus('Ball warp failed. Move the mouse over the course and try again.');
    return false;
  }

  resetShotFlow(warpTarget.point, warpTarget.normal);
  hud.setStatus('Ball warped to cursor.');
  return true;
}

/**
 * Resolves a stable grounded warp target from the cursor ray so the ball does not teleport onto steep walls.
 */
function resolveCursorWarpTarget() {
  if (!hasCursorPointerPosition) {
    return null;
  }

  const canvasRect = dom.canvas.getBoundingClientRect();
  if (canvasRect.width <= 1 || canvasRect.height <= 1) {
    return null;
  }

  const pointerX = lastCursorPointerClientX - canvasRect.left;
  const pointerY = lastCursorPointerClientY - canvasRect.top;
  if (pointerX < 0 || pointerX > canvasRect.width || pointerY < 0 || pointerY > canvasRect.height) {
    return null;
  }

  cursorRayNdc.set(
    (pointerX / canvasRect.width) * 2 - 1,
    -((pointerY / canvasRect.height) * 2 - 1),
  );
  cursorRaycaster.setFromCamera(cursorRayNdc, viewerScene.camera);

  const rayHit = raycastCourseSurface(
    viewerScene.courseCollision,
    cursorRaycaster.ray,
    viewerScene.camera.far,
  );
  if (!rayHit) {
    return null;
  }

  // Re-sample downward from the hit so side faces resolve to a grounded landing point when possible.
  const groundedSurface = sampleCourseSurface(viewerScene.courseCollision, rayHit.point, 2, 40) ?? rayHit;
  if (!groundedSurface?.point || !groundedSurface?.normal) {
    return null;
  }

  if (groundedSurface.normal.y < BALL_GROUNDED_NORMAL_MIN_Y) {
    return null;
  }

  return {
    point: groundedSurface.point.clone(),
    normal: groundedSurface.normal.clone(),
  };
}

function initializeLaunchDebugUi() {
  hud.updateLaunchPanelVisible(DEBUG_UI_ENABLED);

  if (!hasLaunchDebugInputs() || !dom.launchDebugButton || !dom.launchDebugMessage) {
    return;
  }

  for (const { key, inputKey } of LAUNCH_DEBUG_INPUT_FIELDS) {
    dom[inputKey].value = String(BALL_DEFAULT_LAUNCH_DATA[key]);
    dom[inputKey].addEventListener('input', () => {
      updateLaunchDebugUiState();
    });
  }

  dom.launchDebugButton.addEventListener('click', () => {
    launchDebugBallFromInput();
  });
  updateLaunchDebugUiState();
}

/**
 * Mirrors launch data into the LaunchDebug widget so the debug shot can replay the current preview setup.
 */
function syncLaunchDebugInputs(launchData) {
  if (!hasLaunchDebugInputs() || !launchData) {
    return;
  }

  for (const { key, inputKey } of LAUNCH_DEBUG_INPUT_FIELDS) {
    const nextFieldValue = Number.isFinite(launchData[key])
      ? launchData[key]
      : BALL_DEFAULT_LAUNCH_DATA[key];
    dom[inputKey].value = String(nextFieldValue);
  }

  updateLaunchDebugUiState('LaunchDebug synced with the current aiming preview.');
}

/**
 * Centralizes active-club updates so all selectors keep the widget and preview state in sync.
 */
function setActiveClub(nextClub) {
  if (!nextClub) {
    return;
  }

  const previousClub = activeClub;
  if (previousClub?.id === nextClub.id) {
    return;
  }

  activeClub = nextClub;
  aimingPreviewController.onClubChanged(previousClub, activeClub);
  hud.updateClubDebug(ACTIVE_CLUB_SET, activeClub);
  shotImpactAudio.playClubChange();
}

/**
 * Resolves the cup position in world space so gameplay code does not depend on scene-graph transforms directly.
 */
function resolveHoleWorldPosition(target = holeWorldPosition) {
  return aimingPreviewController.resolveHoleWorldPosition(target);
}

function launchDebugBallFromInput() {
  if (!canLaunchDebugShot()) {
    updateLaunchDebugUiState();
    return;
  }

  const launchDebugInputState = getLaunchDebugInputState();
  if (!launchDebugInputState.launchData) {
    updateLaunchDebugUiState(launchDebugInputState.errorMessage);
    return;
  }

  launchBall(launchDebugInputState.launchData);
  updateLaunchDebugUiState('Debug shot launched. Wait for the ball to settle before launching again.');
}

function updateLaunchDebugUiState(statusMessage = null) {
  if (!hasLaunchDebugInputs() || !dom.launchDebugButton || !dom.launchDebugMessage) {
    return;
  }

  const launchDebugInputState = getLaunchDebugInputState();
  const canLaunch = canLaunchDebugShot() && Boolean(launchDebugInputState.launchData);

  for (const { inputKey } of LAUNCH_DEBUG_INPUT_FIELDS) {
    dom[inputKey].setAttribute('aria-invalid', String(Boolean(launchDebugInputState.errorMessage)));
  }
  dom.launchDebugButton.disabled = !canLaunch;

  if (statusMessage) {
    dom.launchDebugMessage.textContent = statusMessage;
    return;
  }

  if (launchDebugInputState.errorMessage) {
    dom.launchDebugMessage.textContent = launchDebugInputState.errorMessage;
    return;
  }

  if (!canLaunchDebugShot()) {
    dom.launchDebugMessage.textContent = 'Launch is available only while player control is active and the ball is ready.';
    return;
  }

  dom.launchDebugMessage.textContent = 'Edit the launch values, then click Launch or press L.';
}

function canLaunchDebugShot() {
  return playerState === 'control' && ballPhysics.getStateSnapshot().phase === 'ready';
}

function getLaunchDebugInputState() {
  if (!hasLaunchDebugInputs()) {
    return { launchData: null, errorMessage: '' };
  }

  const launchData = { ...BALL_DEFAULT_LAUNCH_DATA };
  for (const { key, inputKey } of LAUNCH_DEBUG_INPUT_FIELDS) {
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
}

function hasLaunchDebugInputs() {
  return LAUNCH_DEBUG_INPUT_FIELDS.every(({ inputKey }) => Boolean(dom[inputKey]));
}

function isTextEntryTarget(target) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return target.isContentEditable
    || target.tagName === 'INPUT'
    || target.tagName === 'TEXTAREA'
    || target.tagName === 'SELECT';
}

