import * as THREE from 'three';
import {
  CAMERA_LABEL_UPDATE_INTERVAL_MS,
  FPS_LABEL_UPDATE_INTERVAL_MS,
  HOLE_MARKER_LABEL_DEPTH,
  HOLE_MARKER_LABEL_EDGE_PADDING_PX,
  HOLE_MARKER_LABEL_TOP_OFFSET_RATIO,
} from '/static/js/game/constants.js';
import { formatDistanceYards, formatHeightDeltaMeters } from '/static/js/game/formatting.js';

/**
 * Owns view-facing HUD updates such as hole labels, packet/FPS counters, and telemetry text.
 */
export function createViewHudController({ viewerScene, hud, resolveHoleWorldPosition, getPlayerState, updateLaunchDebugUiState }) {
  const holeProjection = new THREE.Vector3();
  const holeCameraSpace = new THREE.Vector3();
  const holeWorldPosition = new THREE.Vector3();

  let lastCameraLabelUpdateTime = 0;
  let lastFpsSampleTime = performance.now();
  let lastPacketSampleTime = performance.now();
  let packetsSinceLastSample = 0;
  let framesSinceLastSample = 0;

  const recordFrame = () => {
    framesSinceLastSample += 1;
  };

  const recordPacket = () => {
    packetsSinceLastSample += 1;
  };

  const updateCharacterDebugTelemetry = (telemetry) => {
    hud.updateBoneQuaternion(telemetry.boneQuaternion);
    hud.updateMatchFrame(
      telemetry.currentMatchFrameIndex,
      telemetry.sampleCount,
      telemetry.targetAnimationTimeSeconds,
    );
  };

  const updateBallDebugTelemetry = (telemetry) => {
    hud.updateBallState(telemetry.phase, telemetry.movementState, telemetry.speedMetersPerSecond);
    hud.updateGroundTransitionDebug(telemetry.groundTransitionDebug);
    hud.updateShotStates(getPlayerState(), telemetry.phase, telemetry.movementState);
    updateLaunchDebugUiState();
  };

  const updatePacketRateIfNeeded = () => {
    const now = performance.now();
    const elapsedMs = now - lastPacketSampleTime;
    if (elapsedMs < 250) {
      return;
    }

    const packetsPerSecond = packetsSinceLastSample / (elapsedMs / 1000);
    hud.updatePacketRate(packetsPerSecond);
    packetsSinceLastSample = 0;
    lastPacketSampleTime = now;
  };

  const updateFpsIfNeeded = () => {
    const now = performance.now();
    const elapsedMs = now - lastFpsSampleTime;
    if (elapsedMs < FPS_LABEL_UPDATE_INTERVAL_MS) {
      return;
    }

    const framesPerSecond = framesSinceLastSample / (elapsedMs / 1000);
    hud.updateFps(framesPerSecond);
    framesSinceLastSample = 0;
    lastFpsSampleTime = now;
  };

  const updateHoleMarker = (ballTelemetry) => {
    const holeMarker = viewerScene.getHoleMarker();
    if (!holeMarker) {
      return;
    }

    resolveHoleWorldPosition(holeWorldPosition);

    const ballPosition = ballTelemetry.position;
    const horizontalDistanceMeters = Math.hypot(
      holeWorldPosition.x - ballPosition.x,
      holeWorldPosition.z - ballPosition.z,
    );
    const heightDeltaMeters = holeWorldPosition.y - ballPosition.y;

    if (ballTelemetry.phase === 'moving') {
      holeMarker.setMoveModeLabelText(
        formatDistanceYards(ballTelemetry.shotTravelDistanceMeters),
        formatDistanceYards(horizontalDistanceMeters),
      );
      holeMarker.setMoveModeLabelVisible(true);
      holeMarker.setLabelVisible(false);
      return;
    }

    holeMarker.setMoveModeLabelVisible(false);

    holeMarker.setLabelText(
      formatHeightDeltaMeters(heightDeltaMeters),
      formatDistanceYards(horizontalDistanceMeters),
    );

    holeCameraSpace.copy(holeWorldPosition).applyMatrix4(viewerScene.camera.matrixWorldInverse);
    if (holeCameraSpace.z >= 0) {
      holeMarker.setLabelVisible(false);
      return;
    }

    holeProjection.copy(holeWorldPosition).project(viewerScene.camera);
    const horizontalPaddingNdc = (HOLE_MARKER_LABEL_EDGE_PADDING_PX / window.innerWidth) * 2;
    const clampedProjectionX = THREE.MathUtils.clamp(
      holeProjection.x,
      -1 + horizontalPaddingNdc,
      1 - horizontalPaddingNdc,
    );
    const overlayHeightAtDepth = 2 * Math.tan(THREE.MathUtils.degToRad(viewerScene.camera.fov * 0.5)) * HOLE_MARKER_LABEL_DEPTH;
    const overlayWidthAtDepth = overlayHeightAtDepth * viewerScene.camera.aspect;
    const overlayY = (1 - (HOLE_MARKER_LABEL_TOP_OFFSET_RATIO * 2)) * overlayHeightAtDepth * 0.5;

    holeMarker.setLabelOverlayPosition(
      clampedProjectionX * overlayWidthAtDepth * 0.5,
      overlayY,
      -HOLE_MARKER_LABEL_DEPTH,
    );
    holeMarker.setLabelVisible(true);
  };

  const updateCameraPositionLabelIfNeeded = () => {
    const now = performance.now();
    if (now - lastCameraLabelUpdateTime < CAMERA_LABEL_UPDATE_INTERVAL_MS) {
      return;
    }

    hud.updateCameraPosition(viewerScene.camera.position);
    lastCameraLabelUpdateTime = now;
  };

  const faceCameraTowardHole = (ballPosition) => {
    viewerScene.faceViewToward(ballPosition, resolveHoleWorldPosition());
  };

  return {
    faceCameraTowardHole,
    recordFrame,
    recordPacket,
    updateBallDebugTelemetry,
    updateCameraPositionLabelIfNeeded,
    updateCharacterDebugTelemetry,
    updateFpsIfNeeded,
    updateHoleMarker,
    updatePacketRateIfNeeded,
  };
}