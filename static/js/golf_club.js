import * as THREE from 'three';
import { CONTROL_ACTIONS, encodeControlMessage, encodeJoystickMessage, encodeSwingStatePacket } from '/static/js/protocol.js';
import { createControllerRtcSession } from '/static/js/session/firebaseRtcSession.js';
import {
  isCompleteRoomCode,
  loadControllerCodeFromUrl,
  loadStoredControllerCode,
  normalizeRoomCode,
  saveStoredControllerCode,
} from '/static/js/session/roomCode.js';
import { installButtonFocusGuard } from '/static/js/ui/focusGuards.js';

const connectButton = document.querySelector('#connect-button');
const calibrateButton = document.querySelector('#calibrate-button');
const clubPrevButton = document.querySelector('#club-prev-button');
const clubNextButton = document.querySelector('#club-next-button');
const practiceSwingButton = document.querySelector('#practice-swing-button');
const actualSwingButton = document.querySelector('#actual-swing-button');
const pairingGate = document.querySelector('#pairing-gate');
const pairingGateStatus = document.querySelector('#pairing-gate-status');
const controllerShell = document.querySelector('.controller-shell');
const joystickZone = document.querySelector('#aim-joystick');
const joystickVisual = joystickZone?.querySelector('.aim-joystick-visual');
const joystickKnob = joystickZone?.querySelector('.aim-joystick-knob');
const roomCodeInput = document.querySelector('#room-code-input');
const statusLabel = document.querySelector('#controller-status');
const debugLabel = document.querySelector('#controller-debug');

const zee = new THREE.Vector3(0, 0, 1);
const euler = new THREE.Euler();
const q0 = new THREE.Quaternion();
const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
const orientationEventName = getOrientationEventName();
const motionEventName = getMotionEventName();
const CLUB_SHAFT_AXIS_LOCAL = new THREE.Vector3(0, -1, 0);
const CLUB_FACE_AXIS_LOCAL = new THREE.Vector3(1, 0, 0);
const ANGULAR_VELOCITY_LOCAL = new THREE.Vector3();
const SHAFT_TWIST_COMPONENT = new THREE.Vector3();
const DEBUG_AXIS_WORLD = new THREE.Vector3();
const DEBUG_CALIBRATED_QUATERNION = new THREE.Quaternion();

const SWING_SPEED_FOLLOW_RATE = 8;
const SWING_SPEED_DECAY_RATE = 4;
const MOTION_FRESHNESS_LIMIT_MS = 250;
const DEBUG_QUATERNION_DECIMALS = 1;
const DEBUG_ANGULAR_SPEED_DECIMALS = 1;
const DEBUG_HEADING_DECIMALS = 1;

const rawQuaternion = new THREE.Quaternion();
const calibratedQuaternion = new THREE.Quaternion();
const neutralInverse = new THREE.Quaternion();

const joystickState = {
  pointerId: null,
  originX: 0,
  originY: 0,
  axisX: 0,
  axisY: 0,
  pointerDownTimeMs: 0,
  maxDistanceFromOrigin: 0,
  lastTapTimeMs: 0,
  lastTapX: 0,
  lastTapY: 0,
};

const JOYSTICK_RADIUS = 90;
const JOYSTICK_DEADZONE = 0.0001;
const JOYSTICK_TAP_MAX_DURATION_MS = 240;
const JOYSTICK_DOUBLE_TAP_WINDOW_MS = 320;
const JOYSTICK_TAP_MAX_MOVEMENT = 16;
const JOYSTICK_DOUBLE_TAP_MAX_DISTANCE = 40;
const JOYSTICK_NETWORK_STEP = 0.02;

let motionEnabled = false;
let hasOrientation = false;
let hasMotion = false;
let controllerSession = null;
let controllerSessionState = null;
let filteredPerpendicularAngularSpeedRadiansPerSecond = 0;
let decayingPerpendicularAngularSpeedRadiansPerSecond = 0;
let lastMotionSampleTimeMs = 0;
let lastMotionDebugUpdateTimeMs = 0;
let packetSequence = 0;
let lastOrientationDebugState = {
  source: 'none',
  absolute: false,
  headingDegrees: null,
  alphaDegrees: null,
  betaDegrees: null,
  gammaDegrees: null,
};

neutralInverse.identity();
installButtonFocusGuard();
setStatus(statusLabel?.textContent?.trim() || 'Offline');

connectButton.addEventListener('click', async () => {
  await connectWithMotion();
});

roomCodeInput?.addEventListener('input', () => {
  roomCodeInput.value = normalizeRoomCode(roomCodeInput.value);
  saveStoredControllerCode(roomCodeInput.value);
});

window.addEventListener('beforeunload', () => {
  void controllerSession?.close({ preserveDisconnectCleanup: true });
});

calibrateButton.addEventListener('click', () => {
  if (!hasOrientation) {
    setStatus('Move phone');
    return;
  }

  neutralInverse.copy(rawQuaternion).invert();
  setStatus('Forward set');
});

clubPrevButton.addEventListener('click', () => {
  sendControlTap(CONTROL_ACTIONS.clubPrevious);
});

clubNextButton.addEventListener('click', () => {
  sendControlTap(CONTROL_ACTIONS.clubNext);
});

practiceSwingButton?.addEventListener('click', () => {
  sendControlTap(CONTROL_ACTIONS.practiceSwingEnable);
});

actualSwingButton?.addEventListener('click', () => {
  sendControlTap(CONTROL_ACTIONS.actualSwingEnable);
});

bindAimJoystick();
setControlButtonsEnabled(false);

if (roomCodeInput) {
  const urlRoomCode = loadControllerCodeFromUrl();
  const initialRoomCode = urlRoomCode || loadStoredControllerCode();
  roomCodeInput.value = initialRoomCode;
  if (urlRoomCode) {
    saveStoredControllerCode(urlRoomCode);
  }
}

updatePairingGate();

if (orientationEventName) {
  window.addEventListener(orientationEventName, (event) => {
    if (!motionEnabled) {
      return;
    }

    const orientationSample = resolveOrientationSample(event);
    const alpha = THREE.MathUtils.degToRad(orientationSample.alphaDegreesForQuaternion);
    const beta = THREE.MathUtils.degToRad(orientationSample.betaDegrees);
    const gamma = THREE.MathUtils.degToRad(orientationSample.gammaDegrees);
    const orient = THREE.MathUtils.degToRad(orientationSample.screenOrientationDegrees);

    rawQuaternion.copy(deviceOrientationToQuaternion(alpha, beta, gamma, orient));
    hasOrientation = true;
    lastOrientationDebugState = {
      source: orientationSample.source,
      absolute: orientationSample.absolute,
      headingDegrees: orientationSample.headingDegrees,
      alphaDegrees: orientationSample.alphaDegrees,
      betaDegrees: orientationSample.betaDegrees,
      gammaDegrees: orientationSample.gammaDegrees,
    };
    updateDebugLabel();
  });
}

if (motionEventName) {
  window.addEventListener(motionEventName, (event) => {
    if (!motionEnabled) {
      return;
    }

    const sampleTimeMs = Number.isFinite(event.timeStamp) ? event.timeStamp : performance.now();
    const deltaSeconds = lastMotionSampleTimeMs > 0
      ? Math.min(Math.max((sampleTimeMs - lastMotionSampleTimeMs) / 1000, 1 / 240), 0.25)
      : (1 / 60);
    lastMotionSampleTimeMs = sampleTimeMs;

    const instantaneousPerpendicularAngularSpeedRadiansPerSecond = getInstantaneousPerpendicularAngularSpeedRadiansPerSecond(event.rotationRate);
    if (hasFiniteRotationRate(event.rotationRate)) {
      hasMotion = true;
    }

    const followAlpha = 1 - Math.exp(-SWING_SPEED_FOLLOW_RATE * deltaSeconds);
    filteredPerpendicularAngularSpeedRadiansPerSecond = THREE.MathUtils.lerp(
      filteredPerpendicularAngularSpeedRadiansPerSecond,
      instantaneousPerpendicularAngularSpeedRadiansPerSecond,
      followAlpha,
    );

    const decayMultiplier = Math.exp(-SWING_SPEED_DECAY_RATE * deltaSeconds);
    decayingPerpendicularAngularSpeedRadiansPerSecond = Math.max(
      filteredPerpendicularAngularSpeedRadiansPerSecond,
      decayingPerpendicularAngularSpeedRadiansPerSecond * decayMultiplier,
    );

    if (sampleTimeMs - lastMotionDebugUpdateTimeMs >= 32) {
      lastMotionDebugUpdateTimeMs = sampleTimeMs;
      updateDebugLabel();
    }
  });
}

setInterval(() => {
  if (!motionEnabled) {
    return;
  }

  if (!hasOrientation || !controllerSession?.sendSwingPacket) {
    return;
  }

  calibratedQuaternion.copy(neutralInverse).multiply(rawQuaternion).normalize();
  controllerSession.sendSwingPacket(encodeSwingStatePacket({
    quaternion: calibratedQuaternion,
    perpendicularAngularSpeedRadiansPerSecond: getOutboundPerpendicularAngularSpeedRadiansPerSecond(),
    motionAgeMilliseconds: getMotionAgeMilliseconds(),
    sequence: packetSequence,
  }));
  packetSequence = (packetSequence + 1) & 0xffff;
}, 1000 / 60);

async function enableMotion() {
  if (!orientationEventName || !motionEventName) {
    setStatus(getUnsupportedMessage());
    return false;
  }

  try {
    if (typeof window.DeviceOrientationEvent?.requestPermission === 'function') {
      const permission = await window.DeviceOrientationEvent.requestPermission();
      motionEnabled = permission === 'granted';
    } else {
      motionEnabled = true;
    }

    if (motionEnabled && typeof window.DeviceMotionEvent?.requestPermission === 'function') {
      const motionPermission = await window.DeviceMotionEvent.requestPermission();
      motionEnabled = motionPermission === 'granted';
    }
  } catch (error) {
    motionEnabled = false;
    setStatus('Motion error');
    debugLabel.textContent = error.message;
    return false;
  }

  if (!motionEnabled) {
    setStatus('Motion denied');
    calibrateButton.disabled = true;
    return false;
  }

  calibrateButton.disabled = false;
  return motionEnabled;
}

async function connectWithMotion() {
  const roomCode = normalizeRoomCode(roomCodeInput?.value);
  if (!isCompleteRoomCode(roomCode)) {
    setStatus('Enter 4 digits');
    updatePairingGate();
    return;
  }

  connectButton.disabled = true;
  updatePairingGate();

  try {
    const motionReady = await enableMotion();
    if (!motionReady) {
      updateConnectionStatus();
      updatePairingGate();
      return;
    }

    await controllerSession?.close();
    controllerSession = null;
    controllerSessionState = null;
    setStatus('Joining');
    debugLabel.textContent = `joining game client ${roomCode}`;
    saveStoredControllerCode(roomCode);
    controllerSession = await createControllerRtcSession({
      roomId: roomCode,
      onStateChange: handleControllerSessionState,
    });
    handleControllerSessionState(controllerSession.getState());
    updateConnectionStatus();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to join room.';
    setStatus('Connect error');
    debugLabel.textContent = message;
    setControlButtonsEnabled(false);
    releaseAimJoystick();
  } finally {
    connectButton.disabled = false;
    updatePairingGate();
  }
}

function handleControllerSessionState(nextState) {
  const previousState = controllerSessionState;
  controllerSessionState = nextState;

  if (previousState?.controlChannelState === 'open' && nextState.controlChannelState !== 'open') {
    setControlButtonsEnabled(false);
    releaseAimJoystick();
  }

  if (nextState.controlChannelState === 'open') {
    setControlButtonsEnabled(true);
  }

  if (nextState.errorMessage) {
    debugLabel.textContent = nextState.errorMessage;
  }

  updateConnectionStatus();
  updatePairingGate();
}

/**
 * Keeps the landing modal visible until the control channel is open so the playfield cannot be used prematurely.
 */
function updatePairingGate() {
  if (!pairingGate) {
    return;
  }

  const gateOpen = controllerSessionState?.controlChannelState !== 'open';
  pairingGate.hidden = !gateOpen;

  if (controllerShell) {
    if ('inert' in controllerShell) {
      controllerShell.inert = gateOpen;
    }

    controllerShell.setAttribute('aria-hidden', String(gateOpen));
  }

  if (pairingGateStatus) {
    pairingGateStatus.textContent = statusLabel?.textContent?.trim() || 'Offline';
  }
}

function bindAimJoystick() {
  if (!joystickZone || !joystickVisual || !joystickKnob) {
    return;
  }

  joystickZone.addEventListener('pointerdown', (event) => {
    if (joystickState.pointerId !== null) {
      return;
    }

    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }

    if (!isAimEnabled()) {
      return;
    }

    event.preventDefault();
    const rect = joystickZone.getBoundingClientRect();
    joystickState.pointerId = event.pointerId;
    joystickState.originX = event.clientX - rect.left;
    joystickState.originY = event.clientY - rect.top;
    joystickState.pointerDownTimeMs = performance.now();
    joystickState.maxDistanceFromOrigin = 0;
    joystickZone.classList.add('is-active');
    joystickZone.setPointerCapture(event.pointerId);
    joystickVisual.style.setProperty('--joystick-x', `${joystickState.originX}px`);
    joystickVisual.style.setProperty('--joystick-y', `${joystickState.originY}px`);
    joystickKnob.style.transform = 'translate(-50%, -50%)';
    applyAimFromDelta(0, 0);
  });

  joystickZone.addEventListener('pointermove', (event) => {
    if (event.pointerId !== joystickState.pointerId) {
      return;
    }

    event.preventDefault();
    const rect = joystickZone.getBoundingClientRect();
    const currentX = event.clientX - rect.left;
    const currentY = event.clientY - rect.top;
    const deltaX = currentX - joystickState.originX;
    const deltaY = currentY - joystickState.originY;
    const limitedDelta = limitJoystickDelta(deltaX, deltaY);

    joystickState.maxDistanceFromOrigin = Math.max(
      joystickState.maxDistanceFromOrigin,
      Math.hypot(limitedDelta.x, limitedDelta.y),
    );
    joystickKnob.style.transform = `translate(calc(-50% + ${limitedDelta.x}px), calc(-50% + ${limitedDelta.y}px))`;
    applyAimFromDelta(limitedDelta.x, limitedDelta.y);
  });

  const endInteraction = (event) => {
    if (event.pointerId !== joystickState.pointerId) {
      return;
    }

    event.preventDefault();
    maybeToggleAimCameraFromTap(event);
    releaseAimJoystick();
  };

  joystickZone.addEventListener('pointerup', endInteraction);
  joystickZone.addEventListener('pointercancel', endInteraction);
  joystickZone.addEventListener('lostpointercapture', endInteraction);
}

window.addEventListener('blur', () => {
  stopAimControls();
  releaseAimJoystick();
});

function sendControlTap(action) {
  sendControlState(action, true);
}

function sendControlState(action, active, value = null) {
  if (!controllerSession?.sendControlMessage) {
    return;
  }

  controllerSession.sendControlMessage(encodeControlMessage(action, active, value));
}

function setControlButtonsEnabled(enabled) {
  for (const button of [clubPrevButton, clubNextButton, practiceSwingButton, actualSwingButton]) {
    if (button) {
      button.disabled = !enabled;
    }
  }

  if (joystickZone) {
    joystickZone.classList.toggle('is-disabled', !enabled);
  }
}

function setStatus(text) {
  statusLabel.textContent = text;

  if (pairingGateStatus) {
    pairingGateStatus.textContent = text;
  }
}

function updateConnectionStatus() {
  const orientationReady = controllerSessionState?.swingChannelState === 'open';
  const controlReady = controllerSessionState?.controlChannelState === 'open';

  if (controllerSessionState?.errorMessage) {
    setStatus('Link error');
    return;
  }

  if (!orientationReady && !controlReady) {
    if (controllerSessionState?.signalingState === 'joining-room' || controllerSessionState?.signalingState === 'connecting') {
      setStatus('Pairing');
      return;
    }

    setStatus('Offline');
    return;
  }

  if (!orientationReady) {
    setStatus('Controls only');
    return;
  }

  if (!controlReady) {
    setStatus(motionEnabled ? 'Motion only' : 'Enable motion');
    return;
  }

  if (!hasMotion && motionEventName) {
    setStatus('Gyro wait');
    return;
  }

  setStatus(motionEnabled ? 'Live' : 'Enable motion');
}

function getInstantaneousPerpendicularAngularSpeedRadiansPerSecond(rotationRate) {
  const alpha = Number(rotationRate?.alpha ?? 0);
  const beta = Number(rotationRate?.beta ?? 0);
  const gamma = Number(rotationRate?.gamma ?? 0);

  if (!Number.isFinite(alpha) || !Number.isFinite(beta) || !Number.isFinite(gamma)) {
    return 0;
  }

  ANGULAR_VELOCITY_LOCAL.set(
    THREE.MathUtils.degToRad(beta),
    THREE.MathUtils.degToRad(alpha),
    THREE.MathUtils.degToRad(-gamma),
  );

  SHAFT_TWIST_COMPONENT.copy(CLUB_SHAFT_AXIS_LOCAL)
    .multiplyScalar(ANGULAR_VELOCITY_LOCAL.dot(CLUB_SHAFT_AXIS_LOCAL));
  ANGULAR_VELOCITY_LOCAL.sub(SHAFT_TWIST_COMPONENT);
  return ANGULAR_VELOCITY_LOCAL.length();
}

function hasFiniteRotationRate(rotationRate) {
  return ['alpha', 'beta', 'gamma'].some((axis) => Number.isFinite(Number(rotationRate?.[axis])));
}

function getOutboundPerpendicularAngularSpeedRadiansPerSecond() {
  if (!hasMotion || getMotionAgeMilliseconds() > MOTION_FRESHNESS_LIMIT_MS) {
    return 0;
  }

  return decayingPerpendicularAngularSpeedRadiansPerSecond;
}

function getMotionAgeMilliseconds() {
  if (!lastMotionSampleTimeMs) {
    return 65535;
  }

  return Math.min(Math.max(performance.now() - lastMotionSampleTimeMs, 0), 65535);
}

function updateDebugLabel() {
  const perpendicularAngularSpeedRadiansPerSecond = getOutboundPerpendicularAngularSpeedRadiansPerSecond();
  const motionState = hasMotion ? `${perpendicularAngularSpeedRadiansPerSecond.toFixed(DEBUG_ANGULAR_SPEED_DECIMALS)} rad/s` : 'gyro waiting';
  const ageMs = Math.round(getMotionAgeMilliseconds());
  const rawHeadingText = formatHeadingDegrees(lastOrientationDebugState.headingDegrees);
  const packetHeadingText = formatHeadingDegrees(getQuaternionHeadingDegrees(getDebugCalibratedQuaternion()));
  const orientationState = lastOrientationDebugState.absolute ? 'abs' : 'rel';
  const alphaText = formatHeadingDegrees(lastOrientationDebugState.alphaDegrees);
  const betaText = formatSignedDegrees(lastOrientationDebugState.betaDegrees);
  const gammaText = formatSignedDegrees(lastOrientationDebugState.gammaDegrees);
  debugLabel.textContent = `ori ${formatQuaternion(rawQuaternion)} | hdg ${rawHeadingText} ${lastOrientationDebugState.source}/${orientationState} | pkt ${packetHeadingText} | a/b/g ${alphaText}/${betaText}/${gammaText} | omega ${motionState} | age ${ageMs} ms`;
}

/**
 * Prefers Safari's compass heading when available because plain alpha can be relative-only on some phones.
 */
function resolveOrientationSample(event) {
  const alphaDegrees = normalizeDegrees(Number(event?.alpha ?? 0));
  const betaDegrees = sanitizeFiniteDegrees(event?.beta);
  const gammaDegrees = sanitizeFiniteDegrees(event?.gamma);
  const screenOrientationDegrees = sanitizeFiniteDegrees(window.screen.orientation?.angle ?? window.orientation);
  const compassHeadingDegrees = sanitizeCompassHeading(event?.webkitCompassHeading);
  if (compassHeadingDegrees != null) {
    return {
      source: 'compass',
      absolute: true,
      headingDegrees: compassHeadingDegrees,
      alphaDegrees,
      alphaDegreesForQuaternion: normalizeDegrees(360 - compassHeadingDegrees),
      betaDegrees,
      gammaDegrees,
      screenOrientationDegrees,
    };
  }

  return {
    source: event?.absolute ? 'alpha' : 'alpha?',
    absolute: event?.absolute === true,
    headingDegrees: alphaDegreesToHeadingDegrees(alphaDegrees),
    alphaDegrees,
    alphaDegreesForQuaternion: alphaDegrees,
    betaDegrees,
    gammaDegrees,
    screenOrientationDegrees,
  };
}

/**
 * Estimates the horizontal heading of the outgoing calibrated pose so the phone can verify what the viewer receives.
 */
function getQuaternionHeadingDegrees(quaternion) {
  DEBUG_AXIS_WORLD.copy(CLUB_FACE_AXIS_LOCAL).applyQuaternion(quaternion);
  DEBUG_AXIS_WORLD.y = 0;
  if (DEBUG_AXIS_WORLD.lengthSq() <= 1e-8) {
    return null;
  }

  DEBUG_AXIS_WORLD.normalize();
  return normalizeDegrees(THREE.MathUtils.radToDeg(Math.atan2(DEBUG_AXIS_WORLD.x, -DEBUG_AXIS_WORLD.z)));
}

function getDebugCalibratedQuaternion() {
  return DEBUG_CALIBRATED_QUATERNION.copy(neutralInverse).multiply(rawQuaternion).normalize();
}

function formatHeadingDegrees(value) {
  return Number.isFinite(value)
    ? `${normalizeDegrees(value).toFixed(DEBUG_HEADING_DECIMALS)} deg`
    : '--';
}

function formatSignedDegrees(value) {
  return Number.isFinite(value)
    ? `${value >= 0 ? '+' : ''}${value.toFixed(DEBUG_HEADING_DECIMALS)} deg`
    : '--';
}

function sanitizeFiniteDegrees(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function sanitizeCompassHeading(value) {
  return Number.isFinite(Number(value)) ? normalizeDegrees(Number(value)) : null;
}

function alphaDegreesToHeadingDegrees(alphaDegrees) {
  return normalizeDegrees(360 - alphaDegrees);
}

function normalizeDegrees(value) {
  const normalized = Number(value) % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function deviceOrientationToQuaternion(alpha, beta, gamma, orient) {
  euler.set(beta, alpha, -gamma, 'YXZ');
  const quaternion = new THREE.Quaternion().setFromEuler(euler);
  quaternion.multiply(q1);
  quaternion.multiply(q0.setFromAxisAngle(zee, -orient));
  return quaternion.normalize();
}

function formatQuaternion(quaternion) {
  const { x, y, z, w } = quaternion;
  return `${x.toFixed(DEBUG_QUATERNION_DECIMALS)}, ${y.toFixed(DEBUG_QUATERNION_DECIMALS)}, ${z.toFixed(DEBUG_QUATERNION_DECIMALS)}, ${w.toFixed(DEBUG_QUATERNION_DECIMALS)}`;
}

function getOrientationEventName() {
  if ('ondeviceorientationabsolute' in window) {
    return 'deviceorientationabsolute';
  }

  if ('ondeviceorientation' in window || typeof window.DeviceOrientationEvent !== 'undefined') {
    return 'deviceorientation';
  }

  return null;
}

function getMotionEventName() {
  if ('ondevicemotion' in window || typeof window.DeviceMotionEvent !== 'undefined') {
    return 'devicemotion';
  }

  return null;
}

function getUnsupportedMessage() {
  if (!window.isSecureContext) {
    return 'Use HTTPS';
  }

  if (!orientationEventName) {
    return 'No orientation';
  }

  if (!motionEventName) {
    return 'No gyro';
  }

  return 'No motion';
}

function isAimEnabled() {
  return controllerSessionState?.controlChannelState === 'open';
}

/**
 * Sends the normalized joystick axes so the viewer owns all gameplay interpretation.
 */
function applyAimFromDelta(deltaX, deltaY) {
  const normalizedX = normalizeJoystickAxis(deltaX);
  const normalizedY = normalizeJoystickAxis(-deltaY);

  updateJoystickAxes(normalizedX, normalizedY);
}

function stopAimControls() {
  updateJoystickAxes(0, 0);
}

function releaseAimJoystick() {
  if (!joystickZone || !joystickKnob) {
    return;
  }

  stopAimControls();
  joystickState.pointerId = null;
  joystickZone.classList.remove('is-active');
  joystickKnob.style.transform = 'translate(-50%, -50%)';
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Clamps the joystick knob to a circular range so diagonal movement keeps a consistent maximum magnitude.
 */
function limitJoystickDelta(deltaX, deltaY) {
  const distance = Math.hypot(deltaX, deltaY);
  if (distance <= JOYSTICK_RADIUS || distance <= 1e-8) {
    return { x: deltaX, y: deltaY };
  }

  const scale = JOYSTICK_RADIUS / distance;
  return {
    x: deltaX * scale,
    y: deltaY * scale,
  };
}

/**
 * Keeps small motions in a deadzone and remaps the remainder into a 0..1 analog range.
 */
function normalizeJoystickAxis(delta) {
  const magnitude = Math.abs(delta);
  if (magnitude <= JOYSTICK_DEADZONE) {
    return 0;
  }

  const normalizedMagnitude = clamp(
    (magnitude - JOYSTICK_DEADZONE) / Math.max(JOYSTICK_RADIUS - JOYSTICK_DEADZONE, 1),
    0,
    1,
  );
  return Math.sign(delta) * normalizedMagnitude;
}

/**
 * Sends only changed joystick axes so the phone remains a thin input device.
 */
function updateJoystickAxes(axisX, axisY) {
  const nextAxisX = roundJoystickStrength(axisX);
  const nextAxisY = roundJoystickStrength(axisY);

  if (
    Math.abs(joystickState.axisX - nextAxisX) <= 1e-3
    && Math.abs(joystickState.axisY - nextAxisY) <= 1e-3
  ) {
    return;
  }

  joystickState.axisX = nextAxisX;
  joystickState.axisY = nextAxisY;
  sendJoystickState(nextAxisX, nextAxisY);
}

function roundJoystickStrength(value) {
  const clampedValue = clamp(value, -1, 1);
  return Math.round(clampedValue / JOYSTICK_NETWORK_STEP) * JOYSTICK_NETWORK_STEP;
}

function sendJoystickState(axisX, axisY) {
  if (!controllerSession?.sendControlMessage) {
    return;
  }

  controllerSession.sendControlMessage(encodeJoystickMessage(axisX, axisY));
}

/**
 * Treats a quick, low-movement release as a tap and toggles the aim camera on a nearby second tap.
 */
function maybeToggleAimCameraFromTap(event) {
  const tapDurationMs = performance.now() - joystickState.pointerDownTimeMs;
  const isTap = tapDurationMs <= JOYSTICK_TAP_MAX_DURATION_MS
    && joystickState.maxDistanceFromOrigin <= JOYSTICK_TAP_MAX_MOVEMENT;
  if (!isTap) {
    return;
  }

  const now = performance.now();
  const rect = joystickZone.getBoundingClientRect();
  const tapX = event.clientX - rect.left;
  const tapY = event.clientY - rect.top;
  const tapDistance = Math.hypot(tapX - joystickState.lastTapX, tapY - joystickState.lastTapY);
  const isDoubleTap = now - joystickState.lastTapTimeMs <= JOYSTICK_DOUBLE_TAP_WINDOW_MS
    && tapDistance <= JOYSTICK_DOUBLE_TAP_MAX_DISTANCE;

  joystickState.lastTapTimeMs = isDoubleTap ? 0 : now;
  joystickState.lastTapX = tapX;
  joystickState.lastTapY = tapY;

  if (isDoubleTap) {
    sendControlTap(CONTROL_ACTIONS.aimCameraToggle);
  }
}