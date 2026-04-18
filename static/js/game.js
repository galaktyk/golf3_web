import * as THREE from 'three';
import { CONTROL_ACTIONS } from '/static/js/protocol.js';
import {
  BALL_RADIUS,
  CLUB_HEAD_AIMING_PREVIEW_LAUNCH_MIN_SPEED_RATIO,
  CLUB_HEAD_CONTACT_RELEASE_DISTANCE,
  SHOT_AUDIO_PANGYA_MAX_HORIZONTAL_ANGLE_DEGREES,
  BALL_GROUNDED_NORMAL_MIN_Y
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
import { createInputController } from '/static/js/gameplay/inputController.js';
import { createAimingModel } from '/static/js/gameplay/aimingModel.js';
import { createSwingSimulation } from '/static/js/gameplay/swingSimulation.js';
import { createLaunchDebugController } from '/static/js/gameplay/launchDebugController.js';
import { createRemoteController } from '/static/js/gameplay/remoteController.js';
import { installButtonFocusGuard } from '/static/js/ui/focusGuards.js';

const DEBUG_PARAMS = new URLSearchParams(window.location.search);
const DEBUG_SWING_MODE = DEBUG_PARAMS.get('debugSwing');
const DEBUG_SWING_LOGGING = DEBUG_SWING_MODE === 'log' || DEBUG_SWING_MODE === '1';

const animationClock = new THREE.Clock();
const incomingQuaternion = new THREE.Quaternion();

let playerState = 'control';
let clubBallContactLatched = true;
let activeClub = ACTIVE_CLUB;
let practiceSwingMode = false;
let practiceSwingBallVisualDirty = true;
let practiceSwingBallVisualChildCount = -1;

const practiceSwingBallColor = new THREE.Color('#31e0ff');
const PRACTICE_SWING_BALL_OPACITY = 0.26;
const ballMaterialVisualState = new WeakMap();
const cursorRaycaster = new THREE.Raycaster();
const cursorRayNdc = new THREE.Vector2();

installButtonFocusGuard();
const dom = getViewerDom();
const viewerScene = createViewerScene(dom.canvas);
const hud = createViewerHud(dom);
const character = loadCharacter(viewerScene, (m) => hud.setStatus(m));
const ballPhysics = createBallPhysics(viewerScene);
const ballTrail = createBallTrail(BALL_RADIUS);
const shotImpactAudio = createShotImpactAudio();

viewerScene.scene.add(ballTrail.root);

const aimingPreviewController = createAimingPreviewController({
  viewerScene, hud, ballPhysics,
  getActiveClub: () => activeClub,
  syncLaunchDebugInputs: (ld) => launchDebugController.syncLaunchDebugInputs(ld),
});

const clubSelectionController = createClubSelectionController({
  dom, hud,
  clubSet: ACTIVE_CLUB_SET,
  getActiveClub: () => activeClub,
  onSelectClub: (next) => setActiveClub(next),
});

const viewHudController = createViewHudController({
  viewerScene, hud,
  resolveHoleWorldPosition: (t) => aimingPreviewController.resolveHoleWorldPosition(t),
  getPlayerState: () => playerState,
  updateLaunchDebugUiState: (m) => launchDebugController.updateLaunchDebugUiState(m),
});

const aimingModel = createAimingModel({
  viewerScene, ballPhysics, aimingPreviewController, hud,
  canUseAimingControls: () => canUseAimingControls(),
  getGameplayCameraStatusMessage: () => getGameplayCameraStatusMessage(),
  usesLaunchAimingPreview: () => usesLaunchAimingPreview()
});

const swingSimulation = createSwingSimulation({
  character, hud, viewHudController, ballPhysics, shotImpactAudio,
  getActiveClub: () => activeClub,
  getPlayerState: () => playerState,
  detectClubBallImpact: (tele, time) => detectClubBallImpact(tele, time)
});

const launchDebugController = createLaunchDebugController({
  dom, hud, ballPhysics,
  actions: {
    canLaunchDebugShot: () => canLaunchDebugShot(),
    launchDebugBallFromInput: () => launchDebugBallFromInput()
  }
});

const inputController = createInputController({
  viewerScene, dom, hud, ballPhysics, aimingPreviewController, clubSelectionController, viewHudController,
  actions: {
    warpBallToMousePosition: () => warpBallToMousePosition(),
    warpBallToTee: () => warpBallToTee(),
    resetCharacterRotationAcceleration: () => aimingModel.resetCharacterRotationAcceleration(),
    resetAimingPreviewHeadSpeedAcceleration: () => aimingModel.resetAimingPreviewHeadSpeedAcceleration(),
    getGameplayCameraStatusMessage: () => getGameplayCameraStatusMessage(),
    toggleAimingCamera: () => toggleAimingCamera(),
    canUseAimingControls: () => canUseAimingControls(),
    launchDebugBallFromInput: () => launchDebugBallFromInput(),
    resetShotFlow: () => resetShotFlow(),
    togglePracticeSwingMode: () => togglePracticeSwingMode()
  }
});

const remoteController = createRemoteController({
  hud,
  roomCodeLabel: document.querySelector('#viewer-room-code'),
  roomQrImage: document.querySelector('#viewer-room-qr-image'),
  viewerPairingPanel: document.querySelector('#viewer-pairing-panel'),
  onSwingPacket: (p) => swingSimulation.handleIncomingSwingPacket(p, incomingQuaternion),
  onDisconnect: () => {
    aimingModel.resetRemoteJoystickInput();
    aimingModel.resetCharacterRotationAcceleration();
    aimingModel.resetAimingPreviewHeadSpeedAcceleration();
    inputController.clearKeyboardInputs();
  },
  applyRemoteJoystickInput: (x, y) => aimingModel.applyRemoteJoystickInput(x, y),
  applyRemoteControl: (a, act, v) => applyRemoteControl(a, act, v),
  hasIncomingOrientation: () => swingSimulation.hasIncomingOrientation(),
  resetSwingSimulation: () => swingSimulation.reset()
});

loadViewerModels(viewerScene, (m) => hud.setStatus(m));
hud.initialize(viewerScene.camera.position, incomingQuaternion);
hud.updateClubDebug(ACTIVE_CLUB_SET, activeClub);
aimingPreviewController.syncPuttAimDistanceToHole();
aimingPreviewController.syncSwingPreviewTarget();
launchDebugController.initialize();
clubSelectionController.initializeClubDebugUi();
inputController.initialize();

window.addEventListener('beforeunload', () => {
  void remoteController.close({ preserveDisconnectCleanup: true });
});
window.addEventListener('resize', () => {
  viewerScene.resize();
  hud.updateCameraPosition(viewerScene.camera.position);
});

void remoteController.startSession();
animate();

function animate() {
  requestAnimationFrame(animate);
  const delta = animationClock.getDelta();
  viewHudController.recordFrame();
  aimingModel.updateRemoteInput(delta);
  aimingModel.updateCharacterRotation(delta, inputController.getKeyboardRotationInputDirection());
  aimingModel.updateAimingPreview(delta, inputController.getKeyboardAimingPreviewHeadSpeedInputDirection());
  swingSimulation.stepSwingSimulation(delta);
  swingSimulation.updateClubWhooshAudio();

  ballPhysics.update(delta);
  for (const ev of ballPhysics.consumeSurfaceImpactEvents()) {
    shotImpactAudio.playSurfaceImpact(ev.surfaceType, ev.impactSpeedMetersPerSecond);
  }

  aimingPreviewController.updateIfNeeded(playerState);
  aimingPreviewController.updatePresentation(delta);

  let ballTele = ballPhysics.getDebugTelemetry();
  if (playerState === 'waiting' && ballPhysics.consumeShotSettled()) {
    viewerScene.positionCharacterForBall(ballTele.position);
    if (!viewerScene.isFreeCameraEnabled()) {
      viewerScene.setAimingCameraEnabled(false);
      viewHudController.faceCameraTowardHole(ballTele.position);
    }
    ballPhysics.prepareForNextShot();
    playerState = 'control';
    clubBallContactLatched = true;
    ballTele = ballPhysics.getDebugTelemetry();
    aimingPreviewController.syncPuttAimDistanceToHole(ballTele.position);
    hud.updateSwingPreviewCapture(null, aimingPreviewController.getCurrentAimingPreviewHeadSpeed(ballTele.position));
    aimingPreviewController.invalidate();
  }

  viewerScene.ballRoot.position.copy(ballPhysics.getPosition());
  viewerScene.ballRoot.quaternion.copy(ballPhysics.getOrientation());
  syncPracticeSwingBallVisualState();
  ballTrail.update(ballPhysics.getPosition(), ballTele, delta);
  viewerScene.updateFreeCamera(delta, inputController.getFreeCameraMovement());
  viewerScene.updateBallFollowCamera(delta, aimingPreviewController.getBallFollowPreviewState());

  viewHudController.updateCharacterDebugTelemetry(character.getDebugTelemetry());
  viewHudController.updateBallDebugTelemetry(ballTele);
  viewHudController.updateFpsIfNeeded();
  viewHudController.updatePacketRateIfNeeded();
  viewerScene.updateControls();
  viewerScene.applyCameraTilt();
  viewHudController.updateHoleMarker(ballTele);
  aimingPreviewController.updateMarker(ballTele);
  viewHudController.updateCameraPositionLabelIfNeeded();
  viewerScene.updateShadows();
  viewerScene.renderer.render(viewerScene.scene, viewerScene.camera);
}

function canUseAimingControls() {
  return playerState === 'control' && ballPhysics.getStateSnapshot().phase === 'ready';
}

function usesLaunchAimingPreview() {
  return activeClub?.category !== 'putter';
}

function getGameplayCameraStatusMessage() {
  return viewerScene.isAimingCameraEnabled() ? 'Aiming camera enabled.' : 'Normal camera enabled.';
}

function toggleAimingCamera() {
  if (!viewerScene.isAimingCameraEnabled() && !canUseAimingControls()) return false;
  viewerScene.setAimingCameraEnabled(!viewerScene.isAimingCameraEnabled());
  aimingPreviewController.invalidate();
  aimingModel.resetCharacterRotationAcceleration();
  if (!viewerScene.isAimingCameraEnabled()) {
    aimingModel.resetAimingPreviewHeadSpeedAcceleration();
    inputController.clearKeyboardInputs();
  }
  hud.setStatus(getGameplayCameraStatusMessage());
  return true;
}

function togglePracticeSwingMode() {
  return setPracticeSwingMode(!practiceSwingMode);
}

function setPracticeSwingMode(enabled) {
  if (enabled && !canUseAimingControls()) {
    hud.setStatus('Practice swing mode is available only while the ball is ready.');
    return false;
  }
  practiceSwingMode = Boolean(enabled);
  practiceSwingBallVisualDirty = true;
  syncPracticeSwingBallVisualState();
  hud.setStatus(practiceSwingMode ? 'Practice swing mode enabled.' : 'Actual swing mode enabled.');
  return true;
}

function syncPracticeSwingBallVisualState() {
  const childCount = viewerScene.ballRoot.children.length;
  if (!practiceSwingBallVisualDirty && childCount === practiceSwingBallVisualChildCount) return;
  practiceSwingBallVisualDirty = false;
  practiceSwingBallVisualChildCount = childCount;
  viewerScene.ballRoot.traverse((node) => {
    if (!node.isMesh || !node.material) return;
    const mats = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of mats) {
      if (!material) continue;
      if (!ballMaterialVisualState.has(material)) {
        ballMaterialVisualState.set(material, {
          wireframe: Boolean(material.wireframe),
          transparent: Boolean(material.transparent),
          opacity: Number.isFinite(material.opacity) ? material.opacity : 1,
          color: material.color?.clone?.() ?? null,
        });
      }
      const vs = ballMaterialVisualState.get(material);
      material.wireframe = vs.wireframe;
      material.transparent = practiceSwingMode ? true : vs.transparent;
      material.opacity = practiceSwingMode ? PRACTICE_SWING_BALL_OPACITY : vs.opacity;
      if (vs.color && material.color) material.color.copy(practiceSwingMode ? practiceSwingBallColor : vs.color);
      material.needsUpdate = true;
    }
  });
}

function setActiveClub(next) {
  if (!next) return;
  const prev = activeClub;
  if (prev?.id === next.id) return;
  activeClub = next;
  aimingPreviewController.onClubChanged(prev, activeClub);
  hud.updateClubDebug(ACTIVE_CLUB_SET, activeClub);
  shotImpactAudio.playClubChange();
}

function applyRemoteControl(action, active, value = null) {
  const analog = active ? Math.max(0, Math.min(1, value ?? 1)) : 0;
  switch (action) {
    case CONTROL_ACTIONS.clubPrevious: if (active) clubSelectionController.selectPreviousClub(); break;
    case CONTROL_ACTIONS.clubNext: if (active) clubSelectionController.selectNextClub(); break;
    case CONTROL_ACTIONS.practiceSwingEnable: if (active) setPracticeSwingMode(true); break;
    case CONTROL_ACTIONS.actualSwingEnable: if (active) setPracticeSwingMode(false); break;
    case CONTROL_ACTIONS.rotateLeft:
      aimingModel.applyRemoteJoystickInput(active ? -analog : Math.max(aimingModel.getRemoteJoystick().targetX, 0), aimingModel.getRemoteJoystick().targetY);
      break;
    case CONTROL_ACTIONS.rotateRight:
      aimingModel.applyRemoteJoystickInput(active ? analog : Math.min(aimingModel.getRemoteJoystick().targetX, 0), aimingModel.getRemoteJoystick().targetY);
      break;
    case CONTROL_ACTIONS.aimIncrease:
      aimingModel.applyRemoteJoystickInput(aimingModel.getRemoteJoystick().targetX, active ? analog : Math.min(aimingModel.getRemoteJoystick().targetY, 0));
      break;
    case CONTROL_ACTIONS.aimDecrease:
      aimingModel.applyRemoteJoystickInput(aimingModel.getRemoteJoystick().targetX, active ? -analog : Math.max(aimingModel.getRemoteJoystick().targetY, 0));
      break;
    case CONTROL_ACTIONS.aimCameraToggle: if (active) toggleAimingCamera(); break;
  }
}

function detectClubBallImpact(characterTelemetry, simulationTimeMs) {
  if (clubBallContactLatched) {
    if (characterTelemetry.clubHeadPosition.distanceTo(ballPhysics.getPosition()) > CLUB_HEAD_CONTACT_RELEASE_DISTANCE) {
      clubBallContactLatched = false;
    }
  }

  const ballTele = ballPhysics.getDebugTelemetry();
  if (playerState !== 'control' || ballTele.phase !== 'ready' || !characterTelemetry.hasClubHeadSample || clubBallContactLatched) return;

  const speed = swingSimulation.getIncomingClubHeadSpeedMetersPerSecond(undefined, simulationTimeMs);
  if (speed < aimingPreviewController.getCurrentAimingPreviewHeadSpeed() * CLUB_HEAD_AIMING_PREVIEW_LAUNCH_MIN_SPEED_RATIO) return;

  const impact = resolveClubBallImpact(characterTelemetry, ballTele.position, speed, activeClub, DEBUG_SWING_LOGGING ? {} : null);
  if (!impact) return;

  hud.updateLaunchPreview(impact.launchPreview);
  aimingPreviewController.updateSwingPreviewCaptureFromImpact(impact);
  if (practiceSwingMode) {
    shotImpactAudio.playPractice();
    window.dispatchEvent(new CustomEvent('practiceLaunch', { detail: { ...impact, timestampMs: performance.now() } }));
    hud.setStatus(`Practice launch captured at ${formatMetersPerSecond(impact.launchPreview?.ballSpeed ?? 0)} ball speed.`);
  } else {
    launchBall(impact.launchData, impact.referenceForward, impact.impactSpeedMetersPerSecond);
  }
  clubBallContactLatched = true;
}

function launchBall(launchData, referenceForward, impactSpeed = null) {
  if (!viewerScene.isFreeCameraEnabled()) viewerScene.setAimingCameraEnabled(false);
  if (Math.abs(launchData.horizontalLaunchAngle) <= SHOT_AUDIO_PANGYA_MAX_HORIZONTAL_ANGLE_DEGREES) shotImpactAudio.playPangya();
  const smash = activeClub?.smashFactor ?? 1.35;
  const s = impactSpeed ?? (launchData.ballSpeed / smash);
  shotImpactAudio.playForImpactSpeed(s);
  playerState = 'waiting';
  ballTrail.reset();
  ballPhysics.launch(launchData, referenceForward);
  aimingPreviewController.invalidate();
}

function launchDebugBallFromInput() {
  if (!canLaunchDebugShot()) {
    launchDebugController.updateLaunchDebugUiState();
    return;
  }
  const state = launchDebugController.getLaunchDebugInputState();
  if (!state.launchData) {
    launchDebugController.updateLaunchDebugUiState(state.errorMessage);
    return;
  }
  launchBall(state.launchData);
  launchDebugController.updateLaunchDebugUiState('Debug shot launched.');
}

function canLaunchDebugShot() {
  return playerState === 'control' && ballPhysics.getStateSnapshot().phase === 'ready';
}

function resetShotFlow(surfacePoint = null, surfaceNormal = null) {
  if (surfacePoint) ballPhysics.teleportToSurface(surfacePoint, surfaceNormal); else ballPhysics.reset();
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
  playerState = 'control';
  clubBallContactLatched = true;
  aimingPreviewController.syncPuttAimDistanceToHole(ballPhysics.getPosition());
  aimingPreviewController.syncSwingPreviewTarget();
  hud.updateSwingPreviewCapture(null, aimingPreviewController.getCurrentAimingPreviewHeadSpeed(ballPhysics.getPosition()));
  launchDebugController.updateLaunchDebugUiState();
  aimingPreviewController.invalidate();
}

function warpBallToTee() {
  resetShotFlow();
  hud.setStatus('Ball warped to tee.');
}

function warpBallToMousePosition() {
  if (!viewerScene.courseCollision?.root) {
    hud.setStatus('Ball warp unavailable.');
    return;
  }
  const target = resolveCursorWarpTarget();
  if (!target) {
    hud.setStatus('Ball warp failed.');
    return;
  }
  resetShotFlow(target.point, target.normal);
  hud.setStatus('Ball warped to cursor.');
}

function resolveCursorWarpTarget() {
  const cursor = inputController.getCursorPosition();
  if (!cursor.hasPosition) return null;
  const rect = dom.canvas.getBoundingClientRect();
  const px = cursor.clientX - rect.left;
  const py = cursor.clientY - rect.top;
  if (px < 0 || px > rect.width || py < 0 || py > rect.height) return null;
  cursorRayNdc.set((px / rect.width) * 2 - 1, -((py / rect.height) * 2 - 1));
  cursorRaycaster.setFromCamera(cursorRayNdc, viewerScene.camera);
  const hit = raycastCourseSurface(viewerScene.courseCollision, cursorRaycaster.ray, viewerScene.camera.far);
  if (!hit) return null;
  const grounded = sampleCourseSurface(viewerScene.courseCollision, hit.point, 2, 40) ?? hit;
  if (!grounded || grounded.normal.y < BALL_GROUNDED_NORMAL_MIN_Y) return null;
  return { point: grounded.point.clone(), normal: grounded.normal.clone() };
}