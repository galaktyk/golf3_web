import * as THREE from 'three';
import {
  CHARACTER_ROTATION_SPEED_DEGREES,
  CHARACTER_ROTATION_ACCELERATION_RAMP_SECONDS,
  CHARACTER_ROTATION_ACCELERATION_MIN_MULTIPLIER,
  CHARACTER_ROTATION_ACCELERATION_MAX_MULTIPLIER,
  CHARACTER_ROTATION_ANALOG_RESPONSE_EXPONENT,
  AIMING_ROTATION_DISTANCE_REFERENCE_METERS,
  AIMING_ROTATION_DISTANCE_MIN_MULTIPLIER,
  AIMING_ROTATION_DISTANCE_MAX_MULTIPLIER,
  AIMING_PREVIEW_HEAD_SPEED_ADJUST_RAMP_SECONDS,
  AIMING_PREVIEW_HEAD_SPEED_ADJUST_MIN_RATE_METERS_PER_SECOND,
  AIMING_PREVIEW_HEAD_SPEED_ADJUST_MAX_RATE_METERS_PER_SECOND,
  AIMING_PREVIEW_HEAD_SPEED_ANALOG_RAMP_SECONDS,
  AIMING_PREVIEW_HEAD_SPEED_ANALOG_RESPONSE_EXPONENT,
  REMOTE_CONTROL_INPUT_SMOOTHING,
  REMOTE_CONTROL_INPUT_SNAP_EPSILON,
  AIMING_CAMERA_ENTRY_MIN_MAGNITUDE,
  AIMING_CAMERA_ENTRY_VERTICAL_TOLERANCE_DEGREES
} from '../game/constants.js';

const CHARACTER_ROTATION_SPEED_RADIANS = THREE.MathUtils.degToRad(CHARACTER_ROTATION_SPEED_DEGREES);
const AIMING_CAMERA_ENTRY_VERTICAL_TOLERANCE_RADIANS = THREE.MathUtils.degToRad(AIMING_CAMERA_ENTRY_VERTICAL_TOLERANCE_DEGREES);
const PUTT_AIM_DISTANCE_ADJUST_MIN_RATE_METERS_PER_SECOND = 0.25;
const PUTT_AIM_DISTANCE_ADJUST_MAX_RATE_METERS_PER_SECOND = 18;

/**
 * Handles character and camera aiming logic.
 */
export function createAimingModel(params) {
  const { viewerScene, ballPhysics, aimingPreviewController, hud } = params;

  let characterRotationHoldSeconds = 0;
  let characterRotationDirection = 0;
  let aimingPreviewHeadSpeedHoldSeconds = 0;
  let aimingPreviewHeadSpeedDirection = 0;
  let aimingPreviewHeadSpeedAnalogHoldSeconds = 0;
  let aimingPreviewHeadSpeedAnalogDirection = 0;

  let remoteJoystickX = 0;
  let remoteJoystickY = 0;
  let remoteJoystickTargetX = 0;
  let remoteJoystickTargetY = 0;

  const resetCharacterRotationAcceleration = () => {
    characterRotationHoldSeconds = 0;
    characterRotationDirection = 0;
  };

  const resetAimingPreviewHeadSpeedAcceleration = () => {
    aimingPreviewHeadSpeedHoldSeconds = 0;
    aimingPreviewHeadSpeedDirection = 0;
  };

  const resetAimingPreviewHeadSpeedAnalogAcceleration = () => {
    aimingPreviewHeadSpeedAnalogHoldSeconds = 0;
    aimingPreviewHeadSpeedAnalogDirection = 0;
  };

  const getCharacterRotationAccelerationMultiplier = (holdSeconds) => {
    const holdAlpha = CHARACTER_ROTATION_ACCELERATION_RAMP_SECONDS > 1e-8
      ? THREE.MathUtils.clamp(holdSeconds / CHARACTER_ROTATION_ACCELERATION_RAMP_SECONDS, 0, 1)
      : 1;
    return THREE.MathUtils.lerp(
      CHARACTER_ROTATION_ACCELERATION_MIN_MULTIPLIER,
      CHARACTER_ROTATION_ACCELERATION_MAX_MULTIPLIER,
      holdAlpha,
    );
  };

  const getAimingRotationDistanceMultiplier = () => {
    const aimingPreviewState = aimingPreviewController.getState();
    if (!viewerScene.isAimingCameraEnabled() || !aimingPreviewState.isVisible) return 1;
    const carryDistanceMeters = Math.max(aimingPreviewState.carryDistanceMeters, 1);
    return THREE.MathUtils.clamp(
      AIMING_ROTATION_DISTANCE_REFERENCE_METERS / carryDistanceMeters,
      AIMING_ROTATION_DISTANCE_MIN_MULTIPLIER,
      AIMING_ROTATION_DISTANCE_MAX_MULTIPLIER,
    );
  };

  const getAnalogResponseMagnitude = (magnitude, exponent) => Math.pow(THREE.MathUtils.clamp(magnitude, 0, 1), exponent);

  const getAdjustmentRate = (holdSeconds, minRate, maxRate) => {
    const holdAlpha = AIMING_PREVIEW_HEAD_SPEED_ADJUST_RAMP_SECONDS > 1e-8
      ? THREE.MathUtils.clamp(holdSeconds / AIMING_PREVIEW_HEAD_SPEED_ADJUST_RAMP_SECONDS, 0, 1)
      : 1;
    return THREE.MathUtils.lerp(minRate, maxRate, holdAlpha);
  };

  const getAnalogAdjustmentRate = (direction, deltaSeconds, minRate, maxRate, exponent, rampSeconds) => {
    const analogDirection = Math.sign(direction);
    if (analogDirection !== aimingPreviewHeadSpeedAnalogDirection) {
      aimingPreviewHeadSpeedAnalogDirection = analogDirection;
      aimingPreviewHeadSpeedAnalogHoldSeconds = 0;
    } else {
      aimingPreviewHeadSpeedAnalogHoldSeconds += deltaSeconds;
    }

    const targetRate = THREE.MathUtils.lerp(minRate, maxRate, getAnalogResponseMagnitude(Math.abs(direction), exponent));
    const rampAlpha = rampSeconds > 1e-8
      ? THREE.MathUtils.clamp(aimingPreviewHeadSpeedAnalogHoldSeconds / rampSeconds, 0, 1)
      : 1;
    return THREE.MathUtils.lerp(minRate, targetRate, rampAlpha);
  };

  const updateCharacterRotation = (deltaSeconds, kbDir) => {
    if (viewerScene.isFreeCameraEnabled() || !params.canUseAimingControls()) {
      resetCharacterRotationAcceleration();
      return;
    }

    const remoteDir = isRemoteAimEntryGestureActive() ? 0 : -remoteJoystickX;
    const rotationDirection = kbDir !== 0 ? kbDir : remoteDir;
    if (rotationDirection === 0) {
      resetCharacterRotationAcceleration();
      return;
    }

    let speedMultiplier = 1;
    if (kbDir !== 0) {
      if (rotationDirection !== characterRotationDirection) {
        characterRotationDirection = rotationDirection;
        characterRotationHoldSeconds = 0;
      } else {
        characterRotationHoldSeconds += deltaSeconds;
      }
      speedMultiplier = getCharacterRotationAccelerationMultiplier(characterRotationHoldSeconds);
    } else {
      characterRotationDirection = rotationDirection;
      characterRotationHoldSeconds = 0;
      speedMultiplier = getAnalogResponseMagnitude(Math.abs(rotationDirection), CHARACTER_ROTATION_ANALOG_RESPONSE_EXPONENT);
    }

    const rotationRadians = rotationDirection * CHARACTER_ROTATION_SPEED_RADIANS * speedMultiplier * getAimingRotationDistanceMultiplier() * deltaSeconds;
    viewerScene.rotateCharacterAroundBall(ballPhysics.getPosition(), rotationRadians);
    viewerScene.orbitNormalCameraAroundBall(ballPhysics.getPosition(), rotationRadians);
    aimingPreviewController.invalidate();
  };

  const updateAimingPreview = (deltaSeconds, kbDir) => {
    if (viewerScene.isFreeCameraEnabled() || !params.canUseAimingControls()) {
      resetAimingPreviewHeadSpeedAcceleration();
      resetAimingPreviewHeadSpeedAnalogAcceleration();
      return;
    }

    const isKeyboardActive = kbDir !== 0;
    const remoteDir = remoteJoystickY;
    const isRemoteAimActive = !isKeyboardActive && isRemoteAimEntryGestureActive();
    const headSpeedDirection = isKeyboardActive ? kbDir : remoteDir;

    if (headSpeedDirection === 0) {
      resetAimingPreviewHeadSpeedAcceleration();
      resetAimingPreviewHeadSpeedAnalogAcceleration();
      return;
    }

    if (!viewerScene.isAimingCameraEnabled()) {
      if (!isKeyboardActive && !isRemoteAimActive) {
        resetAimingPreviewHeadSpeedAnalogAcceleration();
        return;
      }
      viewerScene.setAimingCameraEnabled(true);
      hud.setStatus(params.getGameplayCameraStatusMessage());
    }

    const useLaunchPreview = params.usesLaunchAimingPreview();
    let adjRate;
    if (isKeyboardActive) {
      resetAimingPreviewHeadSpeedAnalogAcceleration();
      if (headSpeedDirection !== aimingPreviewHeadSpeedDirection) {
        aimingPreviewHeadSpeedDirection = headSpeedDirection;
        aimingPreviewHeadSpeedHoldSeconds = 0;
      } else {
        aimingPreviewHeadSpeedHoldSeconds += deltaSeconds;
      }
      adjRate = useLaunchPreview
        ? getAdjustmentRate(aimingPreviewHeadSpeedHoldSeconds, AIMING_PREVIEW_HEAD_SPEED_ADJUST_MIN_RATE_METERS_PER_SECOND, AIMING_PREVIEW_HEAD_SPEED_ADJUST_MAX_RATE_METERS_PER_SECOND)
        : getAdjustmentRate(aimingPreviewHeadSpeedHoldSeconds, PUTT_AIM_DISTANCE_ADJUST_MIN_RATE_METERS_PER_SECOND, PUTT_AIM_DISTANCE_ADJUST_MAX_RATE_METERS_PER_SECOND);
    } else {
      resetAimingPreviewHeadSpeedAcceleration();
      adjRate = useLaunchPreview
        ? getAnalogAdjustmentRate(headSpeedDirection, deltaSeconds, AIMING_PREVIEW_HEAD_SPEED_ADJUST_MIN_RATE_METERS_PER_SECOND, AIMING_PREVIEW_HEAD_SPEED_ADJUST_MAX_RATE_METERS_PER_SECOND, AIMING_PREVIEW_HEAD_SPEED_ANALOG_RESPONSE_EXPONENT, AIMING_PREVIEW_HEAD_SPEED_ANALOG_RAMP_SECONDS)
        : getAnalogAdjustmentRate(headSpeedDirection, deltaSeconds, PUTT_AIM_DISTANCE_ADJUST_MIN_RATE_METERS_PER_SECOND, PUTT_AIM_DISTANCE_ADJUST_MAX_RATE_METERS_PER_SECOND, AIMING_PREVIEW_HEAD_SPEED_ANALOG_RESPONSE_EXPONENT, AIMING_PREVIEW_HEAD_SPEED_ANALOG_RAMP_SECONDS);
    }

    const delta = headSpeedDirection * adjRate * deltaSeconds;
    if (useLaunchPreview) {
      aimingPreviewController.adjustAimingPreviewHeadSpeed(delta);
    } else {
      aimingPreviewController.adjustPuttAimDistance(delta);
    }
  };

  const isRemoteAimEntryGestureActive = () => {
    const verticalDirection = remoteJoystickTargetY;
    if (verticalDirection === 0) return false;
    const radialMagnitude = Math.hypot(remoteJoystickTargetX, verticalDirection);
    if (radialMagnitude < AIMING_CAMERA_ENTRY_MIN_MAGNITUDE) return false;
    const verticalMagnitude = Math.abs(verticalDirection);
    const horizontalMagnitude = Math.abs(remoteJoystickTargetX);
    if (horizontalMagnitude <= 1e-6) return true;
    const angleFromVerticalRadians = Math.atan2(horizontalMagnitude, verticalMagnitude);
    return angleFromVerticalRadians <= AIMING_CAMERA_ENTRY_VERTICAL_TOLERANCE_RADIANS;
  };

  const updateRemoteInput = (deltaSeconds) => {
    const smoothingAlpha = 1 - Math.exp(-REMOTE_CONTROL_INPUT_SMOOTHING * deltaSeconds);
    const smooth = (curr, target) => {
      const next = THREE.MathUtils.lerp(curr, target, smoothingAlpha);
      return Math.abs(next - target) <= REMOTE_CONTROL_INPUT_SNAP_EPSILON ? target : next;
    };
    remoteJoystickX = smooth(remoteJoystickX, remoteJoystickTargetX);
    remoteJoystickY = smooth(remoteJoystickY, remoteJoystickTargetY);
  };

  return {
    updateCharacterRotation,
    updateAimingPreview,
    updateRemoteInput,
    resetCharacterRotationAcceleration,
    resetAimingPreviewHeadSpeedAcceleration,
    applyRemoteJoystickInput: (x, y) => {
      remoteJoystickTargetX = THREE.MathUtils.clamp(x, -1, 1);
      remoteJoystickTargetY = THREE.MathUtils.clamp(y, -1, 1);
    },
    resetRemoteJoystickInput: () => {
      remoteJoystickX = 0; remoteJoystickY = 0; remoteJoystickTargetX = 0; remoteJoystickTargetY = 0;
    },
    getRemoteJoystick: () => ({ x: remoteJoystickX, y: remoteJoystickY, targetX: remoteJoystickTargetX, targetY: remoteJoystickTargetY })
  };
}
