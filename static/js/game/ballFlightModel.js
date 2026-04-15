import * as THREE from 'three';
import {
  BALL_AIR_DRAG_COEFFICIENT,
  BALL_AIR_INDUCED_DRAG_COEFFICIENT,
  BALL_AIR_LIFT_COEFFICIENT,
  BALL_AIR_LIFT_MAX_ACCELERATION,
  BALL_AIR_LIFT_MAX_UPWARD_ACCELERATION,
  BALL_GRAVITY_ACCELERATION,
  BALL_LEAF_DOWNWARD_BEND_METERS_PER_SECOND,
  BALL_LEAF_SPEED_MULTIPLIER,
  BALL_LEAF_SPIN_MULTIPLIER,
  BALL_RADIUS,
  BALL_SPIN_AIR_DAMPING,
} from '/static/js/game/constants.js';

const GRAVITY = new THREE.Vector3(0, -BALL_GRAVITY_ACCELERATION, 0);
const CAMERA_FORWARD = new THREE.Vector3();
const HORIZONTAL_FORWARD = new THREE.Vector3();
const LAUNCH_DIRECTION = new THREE.Vector3();
const LAUNCH_VELOCITY = new THREE.Vector3();
const LAUNCH_RIGHT = new THREE.Vector3();
const LAUNCH_AXIS = new THREE.Vector3();
const AIR_DRAG_ACCELERATION = new THREE.Vector3();
const AIR_INDUCED_DRAG_ACCELERATION = new THREE.Vector3();
const AIR_LIFT_ACCELERATION = new THREE.Vector3();
const AIR_CURVE_ACCELERATION = new THREE.Vector3();
const AIR_TOTAL_ACCELERATION = new THREE.Vector3();
const AIR_VELOCITY_DIRECTION = new THREE.Vector3();
const AIR_RIGHT_AXIS = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const LEAF_RESPONSE_DIRECTION = new THREE.Vector3();
const MAX_AIR_SPIN_RATIO = 1.2;
const SIDE_SPIN_CURVE_RATIO = 0.35;
const MIN_AIR_LIFT_REFERENCE_SPEED = 14;
const AIR_LIFT_LOW_SPEED_BIAS = 22;
const SOFT_SPIN_RATIO_REFERENCE = 0.55;

/**
 * Resolves the forward direction used by launch and preview math into the ground plane.
 */
function resolveHorizontalForward(viewerScene, referenceForward = null) {
  if (referenceForward && referenceForward.lengthSq() > 1e-8) {
    HORIZONTAL_FORWARD.copy(referenceForward);
  } else {
    viewerScene.camera.getWorldDirection(CAMERA_FORWARD);
    HORIZONTAL_FORWARD.copy(CAMERA_FORWARD);
  }

  HORIZONTAL_FORWARD.y = 0;
  if (HORIZONTAL_FORWARD.lengthSq() <= 1e-8) {
    HORIZONTAL_FORWARD.set(0, 0, -1);
  } else {
    HORIZONTAL_FORWARD.normalize();
  }

  return HORIZONTAL_FORWARD;
}

/**
 * Builds the launch velocity from the shared launch-data contract.
 * Positive horizontal launch values move the ball to the golfer's right.
 */
export function buildLaunchVelocity(launchData, viewerScene, referenceForward = null, target = new THREE.Vector3()) {
  const horizontalForward = resolveHorizontalForward(viewerScene, referenceForward);
  const speedMetersPerSecond = Number.isFinite(launchData?.ballSpeed)
    ? Math.max(launchData.ballSpeed, 0)
    : 0;
  const verticalAngleRadians = THREE.MathUtils.degToRad(launchData?.verticalLaunchAngle ?? 0);
  const horizontalAngleRadians = THREE.MathUtils.degToRad(-(launchData?.horizontalLaunchAngle ?? 0));
  const forwardSpeed = speedMetersPerSecond * Math.cos(verticalAngleRadians);
  const upwardSpeed = speedMetersPerSecond * Math.sin(verticalAngleRadians);

  LAUNCH_DIRECTION.copy(horizontalForward).applyAxisAngle(WORLD_UP, horizontalAngleRadians);
  return target.copy(LAUNCH_DIRECTION)
    .multiplyScalar(forwardSpeed)
    .addScaledVector(WORLD_UP, upwardSpeed);
}

/**
 * Builds an angular velocity vector where the default axis is backspin around the launch-right axis.
 */
export function buildLaunchAngularVelocity(launchData, viewerScene, referenceForward = null, target = new THREE.Vector3()) {
  const spinSpeedRpm = Number.isFinite(launchData?.spinSpeed)
    ? launchData.spinSpeed
    : 0;
  if (Math.abs(spinSpeedRpm) <= 1e-6) {
    return target.set(0, 0, 0);
  }

  buildLaunchVelocity(launchData, viewerScene, referenceForward, LAUNCH_VELOCITY);
  const launchSpeed = LAUNCH_VELOCITY.length();
  if (launchSpeed <= 1e-6) {
    return target.set(0, 0, 0);
  }

  LAUNCH_DIRECTION.copy(LAUNCH_VELOCITY).multiplyScalar(1 / launchSpeed);
  LAUNCH_RIGHT.crossVectors(LAUNCH_DIRECTION, WORLD_UP);
  if (LAUNCH_RIGHT.lengthSq() <= 1e-8) {
    LAUNCH_RIGHT.set(1, 0, 0);
  } else {
    LAUNCH_RIGHT.normalize();
  }

  if (typeof launchData?.spinAxis === 'object' && launchData.spinAxis) {
    const { x, y, z } = launchData.spinAxis;
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      LAUNCH_AXIS.set(x, y, z);
    } else {
      LAUNCH_AXIS.copy(LAUNCH_RIGHT);
    }
  } else {
    const spinAxisDegrees = Number.isFinite(launchData?.spinAxis)
      ? launchData.spinAxis
      : 0;
    LAUNCH_AXIS.copy(LAUNCH_RIGHT).applyAxisAngle(
      LAUNCH_DIRECTION,
      THREE.MathUtils.degToRad(spinAxisDegrees),
    );
  }

  if (LAUNCH_AXIS.lengthSq() <= 1e-8) {
    LAUNCH_AXIS.copy(LAUNCH_RIGHT);
  } else {
    LAUNCH_AXIS.normalize();
  }

  return target.copy(LAUNCH_AXIS).multiplyScalar(THREE.MathUtils.degToRad(spinSpeedRpm * 6));
}

/**
 * Applies the shared airborne force model used by both runtime physics and preview simulation.
 */
export function integrateAirborneState(velocity, angularVelocity, deltaSeconds) {
  AIR_TOTAL_ACCELERATION.copy(GRAVITY);

  const speedMetersPerSecond = velocity.length();
  const horizontalSpeedMetersPerSecond = Math.hypot(velocity.x, velocity.z);
  if (speedMetersPerSecond > 1e-6) {
    AIR_DRAG_ACCELERATION.copy(velocity)
      .multiplyScalar(-BALL_AIR_DRAG_COEFFICIENT * speedMetersPerSecond);
    AIR_TOTAL_ACCELERATION.add(AIR_DRAG_ACCELERATION);
  }

  if (angularVelocity.lengthSq() > 1e-8 && speedMetersPerSecond > 1e-6) {
    AIR_VELOCITY_DIRECTION.copy(velocity).multiplyScalar(1 / speedMetersPerSecond);
    AIR_RIGHT_AXIS.crossVectors(AIR_VELOCITY_DIRECTION, WORLD_UP);
    if (AIR_RIGHT_AXIS.lengthSq() <= 1e-8) {
      AIR_RIGHT_AXIS.set(1, 0, 0);
    } else {
      AIR_RIGHT_AXIS.normalize();
    }

    const rawBackspinRatio = THREE.MathUtils.clamp(
      (BALL_RADIUS * angularVelocity.dot(AIR_RIGHT_AXIS))
        / Math.max(horizontalSpeedMetersPerSecond, MIN_AIR_LIFT_REFERENCE_SPEED),
      -MAX_AIR_SPIN_RATIO,
      MAX_AIR_SPIN_RATIO,
    );
    const backspinRatio = getSoftSpinRatio(rawBackspinRatio);
    const liftSpeedFactor = Math.max(horizontalSpeedMetersPerSecond, MIN_AIR_LIFT_REFERENCE_SPEED)
      * (speedMetersPerSecond + AIR_LIFT_LOW_SPEED_BIAS);
    AIR_LIFT_ACCELERATION.copy(WORLD_UP).multiplyScalar(
      BALL_AIR_LIFT_COEFFICIENT * liftSpeedFactor * backspinRatio,
    );
    AIR_LIFT_ACCELERATION.y = THREE.MathUtils.clamp(
      AIR_LIFT_ACCELERATION.y,
      -BALL_AIR_LIFT_MAX_UPWARD_ACCELERATION,
      BALL_AIR_LIFT_MAX_UPWARD_ACCELERATION,
    );

    AIR_CURVE_ACCELERATION.copy(angularVelocity)
      .cross(velocity)
      .setY(0);
    if (AIR_CURVE_ACCELERATION.lengthSq() > 1e-8) {
      AIR_CURVE_ACCELERATION.normalize();
      const rawSpinRatio = THREE.MathUtils.clamp(
        (BALL_RADIUS * angularVelocity.length())
          / Math.max(horizontalSpeedMetersPerSecond, MIN_AIR_LIFT_REFERENCE_SPEED),
        0,
        MAX_AIR_SPIN_RATIO,
      );
      const spinRatio = getSoftSpinRatio(rawSpinRatio);
      AIR_CURVE_ACCELERATION.multiplyScalar(
        BALL_AIR_LIFT_COEFFICIENT
          * Math.max(horizontalSpeedMetersPerSecond, MIN_AIR_LIFT_REFERENCE_SPEED)
          * (speedMetersPerSecond + AIR_LIFT_LOW_SPEED_BIAS)
          * spinRatio
          * SIDE_SPIN_CURVE_RATIO,
      );
      AIR_LIFT_ACCELERATION.add(AIR_CURVE_ACCELERATION);
    }

    const liftAccelerationMagnitude = AIR_LIFT_ACCELERATION.length();
    if (liftAccelerationMagnitude > BALL_AIR_LIFT_MAX_ACCELERATION) {
      AIR_LIFT_ACCELERATION.multiplyScalar(BALL_AIR_LIFT_MAX_ACCELERATION / liftAccelerationMagnitude);
    }

    AIR_TOTAL_ACCELERATION.add(AIR_LIFT_ACCELERATION);

    if (liftAccelerationMagnitude > 1e-6) {
      AIR_INDUCED_DRAG_ACCELERATION.copy(AIR_VELOCITY_DIRECTION).multiplyScalar(
        -liftAccelerationMagnitude * BALL_AIR_INDUCED_DRAG_COEFFICIENT,
      );
      AIR_TOTAL_ACCELERATION.add(AIR_INDUCED_DRAG_ACCELERATION);
    }
  }

  velocity.addScaledVector(AIR_TOTAL_ACCELERATION, deltaSeconds);
  angularVelocity.multiplyScalar(Math.exp(-BALL_SPIN_AIR_DAMPING * deltaSeconds));
}

/**
 * Treats leaf hits as canopy drag instead of a rigid bounce.
 */
export function applyLeafCanopyResponse(velocity, angularVelocity, hitNormal) {
  const speedMetersPerSecond = velocity.length();
  if (speedMetersPerSecond <= 1e-6) {
    return;
  }

  const canopyFactor = hitNormal
    ? THREE.MathUtils.clamp(Math.abs(hitNormal.y), 0.55, 1)
    : 0.85;
  const canopySpeedMultiplier = THREE.MathUtils.lerp(
    BALL_LEAF_SPEED_MULTIPLIER,
    BALL_LEAF_SPEED_MULTIPLIER * 0.82,
    canopyFactor,
  );

  velocity.multiplyScalar(canopySpeedMultiplier);
  velocity.y -= BALL_LEAF_DOWNWARD_BEND_METERS_PER_SECOND * canopyFactor;

  LEAF_RESPONSE_DIRECTION.copy(velocity);
  if (LEAF_RESPONSE_DIRECTION.lengthSq() > 1e-8) {
    LEAF_RESPONSE_DIRECTION.normalize();
    const upwardSpeed = Math.max(velocity.dot(WORLD_UP), 0);
    if (upwardSpeed > 0) {
      velocity.addScaledVector(WORLD_UP, -Math.min(upwardSpeed, BALL_LEAF_DOWNWARD_BEND_METERS_PER_SECOND));
    }
  }

  angularVelocity.multiplyScalar(BALL_LEAF_SPIN_MULTIPLIER);
}

export function getSpinRpm(angularVelocity) {
  return angularVelocity.length() * 30 / Math.PI;
}

function getSoftSpinRatio(rawSpinRatio) {
  if (!Number.isFinite(rawSpinRatio)) {
    return 0;
  }

  return Math.tanh(rawSpinRatio / SOFT_SPIN_RATIO_REFERENCE) * SOFT_SPIN_RATIO_REFERENCE;
}