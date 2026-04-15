import * as THREE from 'three';
import {
  BALL_COLLISION_SKIN,
  BALL_CONTACT_MAX_ROLLING_SPEED,
  BALL_CONTACT_MIN_DURATION_SECONDS,
  BALL_CONTACT_ROLLING_SLIP_SPEED,
  BALL_FIXED_STEP_SECONDS,
  BALL_GROUND_SNAP_DISTANCE,
  BALL_GROUNDED_NORMAL_MIN_Y,
  BALL_GRAVITY_ACCELERATION,
  BALL_IMPACT_REFERENCE_NORMAL_SPEED,
  BALL_LANDING_CAPTURE_NORMAL_SPEED,
  BALL_LANDING_CAPTURE_SPEED,
  BALL_LANDING_CONTACT_ENTRY_NORMAL_SPEED,
  BALL_MAX_COLLISION_ITERATIONS,
  BALL_MAX_FIXED_STEPS_PER_FRAME,
  BALL_RADIUS,
  BALL_SPIN_GROUND_DAMPING,
  BALL_START_POSITION,
  BALL_STOP_SPEED,
  BALL_DEFAULT_LAUNCH_DATA,
} from '/static/js/game/constants.js';
import { getSurfaceProperties } from '/static/js/game/surfacePhysics.js';
import {
  buildLaunchAngularVelocity,
  buildLaunchVelocity,
  applyLeafCanopyResponse,
  getSpinRpm,
  integrateAirborneState,
} from '/static/js/game/ballFlightModel.js';
import { SURFACE_TYPES } from '/static/js/game/surfaceData.js';
import { findGroundSupport, resolveSphereOverlapBVH, sweepSphereBVH } from '/static/js/game/collision.js';

const DEBUG_PARAMS = new URLSearchParams(window.location.search);
const DEBUG_AUTO_LAUNCH = DEBUG_PARAMS.get('debugBallLaunch') === '1';
const GRAVITY = new THREE.Vector3(0, -BALL_GRAVITY_ACCELERATION, 0);
const PROJECTED_GRAVITY = new THREE.Vector3();
const DISPLACEMENT = new THREE.Vector3();
const WORKING_NORMAL_COMPONENT = new THREE.Vector3();
const SUPPORT_PROJECTED_GRAVITY = new THREE.Vector3();
const DELTA_ROTATION = new THREE.Quaternion();
const ZERO_VECTOR = new THREE.Vector3();
const CONTACT_OFFSET = new THREE.Vector3();
const CONTACT_POINT_VELOCITY = new THREE.Vector3();
const CONTACT_TANGENT_VELOCITY = new THREE.Vector3();
const CONTACT_IMPULSE_DELTA = new THREE.Vector3();
const CONTACT_SPIN_VELOCITY = new THREE.Vector3();
const TARGET_ANGULAR_VELOCITY = new THREE.Vector3();
const ANGULAR_STEP_AXIS = new THREE.Vector3();
const ANGULAR_NORMAL_COMPONENT = new THREE.Vector3();
const TANGENT_VELOCITY = new THREE.Vector3();
const TELEPORT_SURFACE_NORMAL = new THREE.Vector3(0, 1, 0);
const LEAF_PASS_THROUGH_DIRECTION = new THREE.Vector3();

function createGroundTransitionDebug() {
  return {
    captureAttempted: false,
    snappedToGround: false,
    preImpactSpeedMetersPerSecond: 0,
    postImpactSpeedMetersPerSecond: 0,
    postSnapSpeedMetersPerSecond: 0,
    preImpactNormalSpeedMetersPerSecond: 0,
    preImpactTangentSpeedMetersPerSecond: 0,
    preImpactDescentAngleDegrees: 0,
    postImpactNormalSpeedMetersPerSecond: 0,
    postImpactTangentSpeedMetersPerSecond: 0,
    snapLossMetersPerSecond: 0,
    preImpactSpinRpm: 0,
    postImpactSpinRpm: 0,
    postSnapSpinRpm: 0,
    impactNormal: null,
    supportNormal: null,
    movementState: null,
  };
}

/**
 * Creates a discrete surface-hit event payload for one runtime ball contact.
 */
function createSurfaceImpactEvent(surfaceType, impactSpeedMetersPerSecond, source) {
  return {
    impactSpeedMetersPerSecond,
    source,
    surfaceType: surfaceType ?? SURFACE_TYPES.DEFAULT,
    timestampMs: performance.now(),
  };
}

export function createBallPhysics(viewerScene) {
  const position = BALL_START_POSITION.clone();
  const velocity = new THREE.Vector3();
  const angularVelocity = new THREE.Vector3();
  const orientation = new THREE.Quaternion();
  const previousPosition = position.clone();
  const previousOrientation = orientation.clone();
  const renderPosition = position.clone();
  const renderOrientation = orientation.clone();
  const shotStartPosition = position.clone();
  const supportNormal = new THREE.Vector3(0, 1, 0);
  let supportSurfaceType = 'default';
  let accumulatorSeconds = 0;
  let phase = 'ready';
  let movementState = 'waiting';
  let hasCourseContact = false;
  let debugAutoLaunchConsumed = false;
  let shotSettled = false;
  let contactAgeSeconds = 0;
  let lastGroundTransitionDebug = createGroundTransitionDebug();
  let pendingSurfaceImpactEvents = [];

  const queueSurfaceImpactEvent = (surfaceType, impactSpeedMetersPerSecond, source) => {
    pendingSurfaceImpactEvents.push(createSurfaceImpactEvent(surfaceType, impactSpeedMetersPerSecond, source));
  };

  const snapToGround = (maxSnapDistance, groundedMovementState = movementState) => {
    const support = findGroundSupport(viewerScene.courseCollision, position, BALL_RADIUS, maxSnapDistance);
    if (!support || support.normal.y < BALL_GROUNDED_NORMAL_MIN_Y) {
      return false;
    }

    supportNormal.copy(support.normal);
    supportSurfaceType = support.surfaceType ?? 'default';
    position.copy(support.point).addScaledVector(support.normal, BALL_RADIUS + BALL_COLLISION_SKIN);
    const overlapResolution = resolveSphereOverlapBVH(viewerScene.courseCollision, position, BALL_RADIUS, {
      maxIterations: BALL_MAX_COLLISION_ITERATIONS,
      skin: BALL_COLLISION_SKIN,
    });
    position.copy(overlapResolution.position);
    if (overlapResolution.collided && overlapResolution.hitNormal.y >= BALL_GROUNDED_NORMAL_MIN_Y) {
      supportNormal.copy(overlapResolution.hitNormal);
      if (overlapResolution.surfaceType) {
        supportSurfaceType = overlapResolution.surfaceType;
      }
    }
    projectOntoPlane(velocity, support.normal);

    if (velocity.lengthSq() < BALL_STOP_SPEED * BALL_STOP_SPEED) {
      velocity.set(0, 0, 0);
      angularVelocity.set(0, 0, 0);
    }

    SUPPORT_PROJECTED_GRAVITY.copy(GRAVITY);
    SUPPORT_PROJECTED_GRAVITY.addScaledVector(supportNormal, -SUPPORT_PROJECTED_GRAVITY.dot(supportNormal));
    movementState = shouldHoldAgainstSlope(velocity, SUPPORT_PROJECTED_GRAVITY, supportSurfaceType) ? 'rest' : groundedMovementState;
    if (phase === 'moving' && movementState === 'rest') {
      shotSettled = true;
    }
    return true;
  };

  const ensureCourseContact = () => {
    if (!viewerScene.courseCollision || hasCourseContact) {
      return;
    }

    if (!snapToGround(BALL_GROUND_SNAP_DISTANCE * 2, 'ground')) {
      movementState = velocity.lengthSq() > 0 ? 'air' : 'waiting';
    }

    hasCourseContact = true;

    if (DEBUG_AUTO_LAUNCH && !debugAutoLaunchConsumed) {
      debugAutoLaunchConsumed = true;
      launch();
    }
  };

  const stepAir = (deltaSeconds) => {
    integrateAirborneState(velocity, angularVelocity, deltaSeconds);
    let remainingFraction = 1;
    let ignoreLeafForStep = false;

    for (let impactIndex = 0; impactIndex < 3 && remainingFraction > 1e-4; impactIndex += 1) {
      DISPLACEMENT.copy(velocity).multiplyScalar(deltaSeconds * remainingFraction);

      const sweep = sweepSphereBVH(viewerScene.courseCollision, position, DISPLACEMENT, BALL_RADIUS, {
        ignoredSurfaceTypes: ignoreLeafForStep ? [SURFACE_TYPES.LEAF] : undefined,
        maxIterations: BALL_MAX_COLLISION_ITERATIONS,
        skin: BALL_COLLISION_SKIN,
      });

      position.copy(sweep.position);

      if (!sweep.collided) {
        movementState = 'air';
        integrateOrientationFromAngularVelocity(orientation, angularVelocity, deltaSeconds);
        return;
      }

      if (sweep.surfaceType === SURFACE_TYPES.LEAF) {
        // Let canopy hits sap speed and bend the shot down instead of behaving like a rigid wall.
        const preLeafSpeedMetersPerSecond = velocity.length();
        applyLeafCanopyResponse(velocity, angularVelocity, sweep.hitNormal);
        queueSurfaceImpactEvent(sweep.surfaceType, preLeafSpeedMetersPerSecond, 'leaf-pass');
        console.log('[BallLeafPassThrough]', {
          position: {
            x: position.x,
            y: position.y,
            z: position.z,
          },
          preLeafSpeedMetersPerSecond,
          postLeafSpeedMetersPerSecond: velocity.length(),
          spinRpm: getSpinRpm(angularVelocity),
          travelFraction: sweep.travelFraction,
        });
        remainingFraction *= Math.max(1 - sweep.travelFraction, 0);
        ignoreLeafForStep = true;

        LEAF_PASS_THROUGH_DIRECTION.copy(DISPLACEMENT);
        if (LEAF_PASS_THROUGH_DIRECTION.lengthSq() <= 1e-10) {
          LEAF_PASS_THROUGH_DIRECTION.copy(velocity);
        }
        if (LEAF_PASS_THROUGH_DIRECTION.lengthSq() > 1e-10) {
          LEAF_PASS_THROUGH_DIRECTION.normalize();
          position.addScaledVector(
            LEAF_PASS_THROUGH_DIRECTION,
            Math.max(BALL_RADIUS * 0.5, BALL_COLLISION_SKIN * 6),
          );
        }

        movementState = 'air';
        continue;
      }

      const preImpactSpeedMetersPerSecond = velocity.length();
      const preImpactNormalSpeedMetersPerSecond = Math.max(-velocity.dot(sweep.hitNormal), 0);
      const preImpactTangentSpeedMetersPerSecond = Math.sqrt(Math.max(
        preImpactSpeedMetersPerSecond * preImpactSpeedMetersPerSecond
          - preImpactNormalSpeedMetersPerSecond * preImpactNormalSpeedMetersPerSecond,
        0,
      ));
      const preImpactSpinRpm = getSpinRpm(angularVelocity);
      queueSurfaceImpactEvent(sweep.surfaceType, preImpactSpeedMetersPerSecond, 'bounce');
      resolveImpactVelocity(velocity, angularVelocity, sweep.hitNormal, sweep.surfaceType);
      console.log('[BallBounceSurface]', {
        surfaceType: sweep.surfaceType ?? 'default',
        preImpactSpeedMetersPerSecond,
        preImpactNormalSpeedMetersPerSecond,
      });
      const postImpactSpeedMetersPerSecond = velocity.length();
      const postImpactNormalSpeedMetersPerSecond = Math.max(velocity.dot(sweep.hitNormal), 0);
      const postImpactTangentSpeedMetersPerSecond = Math.sqrt(Math.max(
        postImpactSpeedMetersPerSecond * postImpactSpeedMetersPerSecond
          - postImpactNormalSpeedMetersPerSecond * postImpactNormalSpeedMetersPerSecond,
        0,
      ));
      remainingFraction *= Math.max(1 - sweep.travelFraction, 0);

      if (shouldEnterGroundMode(velocity, sweep.hitNormal)) {
        lastGroundTransitionDebug = {
          captureAttempted: true,
          snappedToGround: false,
          preImpactSpeedMetersPerSecond,
          postImpactSpeedMetersPerSecond,
          postSnapSpeedMetersPerSecond: 0,
          preImpactNormalSpeedMetersPerSecond,
          preImpactTangentSpeedMetersPerSecond,
          preImpactDescentAngleDegrees: getDescentAngleDegrees(
            preImpactNormalSpeedMetersPerSecond,
            preImpactTangentSpeedMetersPerSecond,
          ),
          postImpactNormalSpeedMetersPerSecond,
          postImpactTangentSpeedMetersPerSecond,
          snapLossMetersPerSecond: 0,
          preImpactSpinRpm,
          postImpactSpinRpm: getSpinRpm(angularVelocity),
          postSnapSpinRpm: 0,
          impactNormal: sweep.hitNormal.clone(),
          supportNormal: null,
          movementState: null,
        };
        supportNormal.copy(sweep.hitNormal);

        const enterContactState = preImpactNormalSpeedMetersPerSecond > BALL_LANDING_CONTACT_ENTRY_NORMAL_SPEED
          || postImpactSpeedMetersPerSecond > BALL_CONTACT_MAX_ROLLING_SPEED;
        const landingState = enterContactState ? 'contact' : 'ground';
        if (snapToGround(BALL_GROUND_SNAP_DISTANCE, landingState)) {
          if (enterContactState) {
            contactAgeSeconds = 0;
          }
          lastGroundTransitionDebug.snappedToGround = true;
          lastGroundTransitionDebug.postSnapSpeedMetersPerSecond = velocity.length();
          lastGroundTransitionDebug.snapLossMetersPerSecond = Math.max(
            postImpactSpeedMetersPerSecond - lastGroundTransitionDebug.postSnapSpeedMetersPerSecond,
            0,
          );
          lastGroundTransitionDebug.postSnapSpinRpm = getSpinRpm(angularVelocity);
          lastGroundTransitionDebug.supportNormal = supportNormal.clone();
          lastGroundTransitionDebug.movementState = movementState;
          integrateOrientationFromAngularVelocity(orientation, angularVelocity, deltaSeconds);
          return;
        }
      }

      const separationPush = sweep.hitNormal.y >= BALL_GROUNDED_NORMAL_MIN_Y
        ? BALL_COLLISION_SKIN * 2
        : BALL_COLLISION_SKIN * 0.1;
      position.addScaledVector(sweep.hitNormal, separationPush);
      movementState = 'air';
    }
    integrateOrientationFromAngularVelocity(orientation, angularVelocity, deltaSeconds);
  };

  const stepGround = (deltaSeconds) => {
    PROJECTED_GRAVITY.copy(GRAVITY);
    PROJECTED_GRAVITY.addScaledVector(supportNormal, -PROJECTED_GRAVITY.dot(supportNormal));

    velocity.addScaledVector(PROJECTED_GRAVITY, deltaSeconds);
    applyRollingResistance(velocity, deltaSeconds);
    syncRollingAngularVelocity(angularVelocity, velocity, supportNormal);
    DISPLACEMENT.copy(velocity).multiplyScalar(deltaSeconds);

    const groundSweepRadius = Math.max(BALL_RADIUS - BALL_COLLISION_SKIN, BALL_RADIUS * 0.5);
    const sweep = sweepSphereBVH(viewerScene.courseCollision, position, DISPLACEMENT, groundSweepRadius, {
      maxIterations: BALL_MAX_COLLISION_ITERATIONS,
      skin: BALL_COLLISION_SKIN,
    });

    position.copy(sweep.position);

    if (sweep.collided) {
      removeIntoNormalComponent(velocity, sweep.hitNormal);
      if (sweep.hitNormal.y >= BALL_GROUNDED_NORMAL_MIN_Y) {
        supportNormal.copy(sweep.hitNormal);
      }
    }

    if (!snapToGround(BALL_GROUND_SNAP_DISTANCE, 'ground')) {
      movementState = 'air';
      return;
    }

    if (shouldHoldAgainstSlope(velocity, PROJECTED_GRAVITY, supportSurfaceType)) {
      velocity.set(0, 0, 0);
      angularVelocity.set(0, 0, 0);
      movementState = 'rest';
      if (phase === 'moving') {
        shotSettled = true;
      }
    }

    applyGroundSpinDamping(angularVelocity, deltaSeconds);
    syncRollingAngularVelocity(angularVelocity, velocity, supportNormal);
    integrateOrientationFromAngularVelocity(orientation, angularVelocity, deltaSeconds);
  };

  const stepContact = (deltaSeconds) => {
    contactAgeSeconds += deltaSeconds;
    PROJECTED_GRAVITY.copy(GRAVITY);
    PROJECTED_GRAVITY.addScaledVector(supportNormal, -PROJECTED_GRAVITY.dot(supportNormal));

    velocity.addScaledVector(PROJECTED_GRAVITY, deltaSeconds);
    applyGroundContactForces(velocity, angularVelocity, supportNormal, deltaSeconds, supportSurfaceType);
    DISPLACEMENT.copy(velocity).multiplyScalar(deltaSeconds);

    const contactSweepRadius = Math.max(BALL_RADIUS - BALL_COLLISION_SKIN, BALL_RADIUS * 0.5);
    const sweep = sweepSphereBVH(viewerScene.courseCollision, position, DISPLACEMENT, contactSweepRadius, {
      maxIterations: BALL_MAX_COLLISION_ITERATIONS,
      skin: BALL_COLLISION_SKIN,
    });

    position.copy(sweep.position);

    if (sweep.collided) {
      removeIntoNormalComponent(velocity, sweep.hitNormal);
      if (sweep.hitNormal.y >= BALL_GROUNDED_NORMAL_MIN_Y) {
        supportNormal.copy(sweep.hitNormal);
      }
    }

    if (!snapToGround(BALL_GROUND_SNAP_DISTANCE, 'contact')) {
      movementState = 'air';
      contactAgeSeconds = 0;
      return;
    }

    if (shouldHoldAgainstSlope(velocity, PROJECTED_GRAVITY, supportSurfaceType)) {
      velocity.set(0, 0, 0);
      angularVelocity.set(0, 0, 0);
      movementState = 'rest';
      if (phase === 'moving') {
        shotSettled = true;
      }
      return;
    }

    if (shouldTransitionToRolling(velocity, angularVelocity, supportNormal, contactAgeSeconds)) {
      movementState = 'ground';
      contactAgeSeconds = 0;
      syncRollingAngularVelocity(angularVelocity, velocity, supportNormal);
    }

    applyGroundSpinDamping(angularVelocity, deltaSeconds);
    if (movementState === 'ground') {
      syncRollingAngularVelocity(angularVelocity, velocity, supportNormal);
    }
    integrateOrientationFromAngularVelocity(orientation, angularVelocity, deltaSeconds);
  };

  const stepRest = () => {
    const support = findGroundSupport(viewerScene.courseCollision, position, BALL_RADIUS, BALL_GROUND_SNAP_DISTANCE);
    if (!support || support.normal.y < BALL_GROUNDED_NORMAL_MIN_Y) {
      movementState = 'air';
      return;
    }

    supportNormal.copy(support.normal);
    supportSurfaceType = support.surfaceType ?? supportSurfaceType;
    SUPPORT_PROJECTED_GRAVITY.copy(GRAVITY);
    SUPPORT_PROJECTED_GRAVITY.addScaledVector(supportNormal, -SUPPORT_PROJECTED_GRAVITY.dot(supportNormal));

    if (!shouldHoldAgainstSlope(velocity, SUPPORT_PROJECTED_GRAVITY, supportSurfaceType)) {
      movementState = 'ground';
      contactAgeSeconds = 0;
      return;
    }

    if (Math.abs(support.separation) > BALL_COLLISION_SKIN * 2) {
      position.copy(support.point).addScaledVector(support.normal, BALL_RADIUS + BALL_COLLISION_SKIN);
      const overlapResolution = resolveSphereOverlapBVH(viewerScene.courseCollision, position, BALL_RADIUS, {
        maxIterations: BALL_MAX_COLLISION_ITERATIONS,
        skin: BALL_COLLISION_SKIN,
      });
      position.copy(overlapResolution.position);
      if (overlapResolution.surfaceType) {
        supportSurfaceType = overlapResolution.surfaceType;
      }
    }

    velocity.set(0, 0, 0);
    angularVelocity.set(0, 0, 0);
    movementState = 'rest';
    if (phase === 'moving') {
      shotSettled = true;
    }
  };

  const step = (deltaSeconds) => {
    if (!viewerScene.courseCollision) {
      if (velocity.lengthSq() === 0) {
        movementState = 'waiting';
        return;
      }

      integrateAirborneState(velocity, angularVelocity, deltaSeconds);
      position.addScaledVector(velocity, deltaSeconds);
      movementState = 'air';
      return;
    }

    if (movementState === 'ground') {
      stepGround(deltaSeconds);
      return;
    }

    if (movementState === 'contact') {
      stepContact(deltaSeconds);
      return;
    }

    if (movementState === 'rest') {
      stepRest();
      return;
    }

    stepAir(deltaSeconds);
  };

  const launch = (launchData = BALL_DEFAULT_LAUNCH_DATA, referenceForward = null) => {


    ensureCourseContact();
    shotStartPosition.copy(position);
    buildLaunchVelocity(launchData, viewerScene, referenceForward, velocity);
    buildLaunchAngularVelocity(launchData, viewerScene, referenceForward, angularVelocity);
    phase = 'moving';
    movementState = 'air';
    contactAgeSeconds = 0;
    shotSettled = false;
    pendingSurfaceImpactEvents = [];
  };

  const resetReadyState = () => {
    velocity.set(0, 0, 0);
    angularVelocity.set(0, 0, 0);
    orientation.identity();
    supportNormal.set(0, 1, 0);
    accumulatorSeconds = 0;
    hasCourseContact = false;
    phase = 'ready';
    movementState = 'waiting';
    contactAgeSeconds = 0;
    shotSettled = false;
    lastGroundTransitionDebug = createGroundTransitionDebug();
    ensureCourseContact();
    shotStartPosition.copy(position);
    previousPosition.copy(position);
    previousOrientation.copy(orientation);
    renderPosition.copy(position);
    renderOrientation.copy(orientation);
  };

  const reset = () => {
    position.copy(BALL_START_POSITION);
    resetReadyState();
  };

  /**
   * Places the ball on a course surface hit and restores the ready state for the next shot.
   */
  const teleportToSurface = (surfacePoint, surfaceNormal = null) => {
    if (!surfacePoint) {
      reset();
      return;
    }

    TELEPORT_SURFACE_NORMAL.set(0, 1, 0);
    if (surfaceNormal?.lengthSq?.() > 1e-8) {
      TELEPORT_SURFACE_NORMAL.copy(surfaceNormal).normalize();
    }

    position.copy(surfacePoint).addScaledVector(TELEPORT_SURFACE_NORMAL, BALL_RADIUS + BALL_COLLISION_SKIN + 1e-3);
    resetReadyState();
  };

  const prepareForNextShot = () => {
    if (velocity.lengthSq() < BALL_STOP_SPEED * BALL_STOP_SPEED) {
      velocity.set(0, 0, 0);
      angularVelocity.set(0, 0, 0);
    }

    phase = 'ready';
    contactAgeSeconds = 0;
    shotSettled = false;
  };

  ensureCourseContact();

  return {
    consumeShotSettled() {
      if (!shotSettled) {
        return false;
      }

      shotSettled = false;
      return true;
    },

    consumeSurfaceImpactEvents() {
      const events = pendingSurfaceImpactEvents;
      pendingSurfaceImpactEvents = [];
      return events;
    },

    getDebugTelemetry() {
      return {
        mode: phase === 'moving' ? `moving/${movementState}` : 'ready',
        movementState: phase === 'moving' ? movementState : null,
        phase,
        position,
        shotTravelDistanceMeters: Math.hypot(
          position.x - shotStartPosition.x,
          position.z - shotStartPosition.z,
        ),
        descentAngleDegrees: getVelocityDescentAngleDegrees(velocity),
        speedMetersPerSecond: velocity.length(),
        spinRpm: getSpinRpm(angularVelocity),
        angularVelocity,
        velocity,
        groundTransitionDebug: lastGroundTransitionDebug,
      };
    },

    getStateSnapshot() {
      return {
        movementState: phase === 'moving' ? movementState : null,
        phase,
      };
    },

    getPosition() {
      return renderPosition;
    },

    getOrientation() {
      return renderOrientation;
    },

    launch(launchData = BALL_DEFAULT_LAUNCH_DATA, referenceForward = null) {
      launch(launchData, referenceForward);
    },

    prepareForNextShot() {
      prepareForNextShot();
    },

    reset() {
      reset();
    },

    teleportToSurface(surfacePoint, surfaceNormal = null) {
      teleportToSurface(surfacePoint, surfaceNormal);
    },

    update(deltaSeconds) {
      ensureCourseContact();
      accumulatorSeconds = Math.min(
        accumulatorSeconds + deltaSeconds,
        BALL_FIXED_STEP_SECONDS * BALL_MAX_FIXED_STEPS_PER_FRAME,
      );

      while (accumulatorSeconds >= BALL_FIXED_STEP_SECONDS) {
        previousPosition.copy(position);
        previousOrientation.copy(orientation);
        step(BALL_FIXED_STEP_SECONDS);
        accumulatorSeconds -= BALL_FIXED_STEP_SECONDS;
      }

      const alpha = accumulatorSeconds / BALL_FIXED_STEP_SECONDS;
      renderPosition.lerpVectors(previousPosition, position, alpha);
      renderOrientation.slerpQuaternions(previousOrientation, orientation, alpha);
    },
  };
}

function applyGroundContactForces(velocity, angularVelocity, surfaceNormal, deltaSeconds, surfaceType) {
  CONTACT_OFFSET.copy(surfaceNormal).multiplyScalar(-BALL_RADIUS);
  CONTACT_SPIN_VELOCITY.copy(angularVelocity).cross(CONTACT_OFFSET);
  CONTACT_POINT_VELOCITY.copy(velocity).add(CONTACT_SPIN_VELOCITY);
  CONTACT_TANGENT_VELOCITY.copy(CONTACT_POINT_VELOCITY);
  CONTACT_TANGENT_VELOCITY.addScaledVector(surfaceNormal, -CONTACT_TANGENT_VELOCITY.dot(surfaceNormal));

  const properties = getSurfaceProperties(surfaceType);

  const slipSpeed = CONTACT_TANGENT_VELOCITY.length();
  if (slipSpeed > 1e-6) {
    const slidingDeltaSpeed = Math.min(
      slipSpeed,
      properties.landingSlidingFriction * BALL_GRAVITY_ACCELERATION * deltaSeconds,
    );
    CONTACT_IMPULSE_DELTA.copy(CONTACT_TANGENT_VELOCITY).multiplyScalar(-slidingDeltaSpeed / slipSpeed);
    velocity.add(CONTACT_IMPULSE_DELTA);
    applySurfaceImpulseToAngularVelocity(angularVelocity, surfaceNormal, CONTACT_IMPULSE_DELTA);
  }

  // Landing contact should keep bleeding speed until the ball is slow enough to become a true roll.
  const speed = velocity.length();
  if (speed > BALL_CONTACT_MAX_ROLLING_SPEED) {
    const contactBrakeSpeed = Math.min(
      speed - BALL_CONTACT_MAX_ROLLING_SPEED,
      properties.landingBrakeFriction * BALL_GRAVITY_ACCELERATION * deltaSeconds,
    );
    if (contactBrakeSpeed > 0) {
      velocity.addScaledVector(velocity, -contactBrakeSpeed / speed);
    }
  }

  applyRollingResistance(velocity, deltaSeconds, surfaceType);
}

function applyRollingResistance(velocity, deltaSeconds, surfaceType) {
  const speed = velocity.length();
  if (speed <= 1e-6) {
    velocity.set(0, 0, 0);
    return;
  }

  const rollingResistance = getSurfaceProperties(surfaceType).rollingResistance;

  const rollingDeltaSpeed = Math.min(
    speed,
    rollingResistance * BALL_GRAVITY_ACCELERATION * deltaSeconds,
  );
  velocity.addScaledVector(velocity, -rollingDeltaSpeed / speed);
}

function shouldTransitionToRolling(velocity, angularVelocity, surfaceNormal, contactAgeSeconds) {
  if (contactAgeSeconds < BALL_CONTACT_MIN_DURATION_SECONDS) {
    return false;
  }

  if (velocity.length() > BALL_CONTACT_MAX_ROLLING_SPEED) {
    return false;
  }

  return getContactSlipSpeed(velocity, angularVelocity, surfaceNormal) <= BALL_CONTACT_ROLLING_SLIP_SPEED;
}

function getContactSlipSpeed(velocity, angularVelocity, surfaceNormal) {
  CONTACT_OFFSET.copy(surfaceNormal).multiplyScalar(-BALL_RADIUS);
  CONTACT_SPIN_VELOCITY.copy(angularVelocity).cross(CONTACT_OFFSET);
  CONTACT_POINT_VELOCITY.copy(velocity).add(CONTACT_SPIN_VELOCITY);
  CONTACT_TANGENT_VELOCITY.copy(CONTACT_POINT_VELOCITY);
  CONTACT_TANGENT_VELOCITY.addScaledVector(surfaceNormal, -CONTACT_TANGENT_VELOCITY.dot(surfaceNormal));
  return CONTACT_TANGENT_VELOCITY.length();
}

function shouldHoldAgainstSlope(velocity, projectedGravity, surfaceType) {
  if (velocity.lengthSq() > BALL_STOP_SPEED * BALL_STOP_SPEED) {
    return false;
  }

  const staticFriction = getSurfaceProperties(surfaceType).staticFriction;
  return projectedGravity.lengthSq() <= (staticFriction * BALL_GRAVITY_ACCELERATION) ** 2;
}

function shouldEnterGroundMode(velocity, hitNormal) {
  if (hitNormal.y < BALL_GROUNDED_NORMAL_MIN_Y) {
    return false;
  }

  const reboundNormalSpeed = Math.max(velocity.dot(hitNormal), 0);
  if (reboundNormalSpeed <= BALL_LANDING_CAPTURE_NORMAL_SPEED) {
    return true;
  }

  return velocity.lengthSq() <= BALL_LANDING_CAPTURE_SPEED * BALL_LANDING_CAPTURE_SPEED;
}

function resolveImpactVelocity(velocity, angularVelocity, hitNormal, surfaceType) {
  const normalSpeed = velocity.dot(hitNormal);
  if (normalSpeed >= 0) {
    return;
  }

  const incomingSpeed = velocity.length();
  const incomingNormalSpeed = Math.max(-normalSpeed, 0);
  WORKING_NORMAL_COMPONENT.copy(hitNormal).multiplyScalar(normalSpeed);
  TANGENT_VELOCITY.copy(velocity).sub(WORKING_NORMAL_COMPONENT);

  CONTACT_OFFSET.copy(hitNormal).multiplyScalar(-BALL_RADIUS);
  CONTACT_SPIN_VELOCITY.copy(angularVelocity).cross(CONTACT_OFFSET);
  CONTACT_POINT_VELOCITY.copy(TANGENT_VELOCITY).add(CONTACT_SPIN_VELOCITY);
  CONTACT_TANGENT_VELOCITY.copy(CONTACT_POINT_VELOCITY);
  CONTACT_TANGENT_VELOCITY.addScaledVector(hitNormal, -CONTACT_TANGENT_VELOCITY.dot(hitNormal));
  const incomingTangentSpeed = CONTACT_TANGENT_VELOCITY.length();

  const properties = getSurfaceProperties(surfaceType);

  const impactSeverity = incomingSpeed > 1e-6
    ? THREE.MathUtils.clamp(
      incomingNormalSpeed / Math.max(incomingNormalSpeed + incomingTangentSpeed, 1e-6),
      0,
      1,
    )
    : 0;
  const impactStrength = THREE.MathUtils.clamp(
    incomingNormalSpeed / BALL_IMPACT_REFERENCE_NORMAL_SPEED,
    0,
    1,
  );
  
  // Calculate max friction based on base impact friction config
  const impactMaxFriction = properties.impactFriction * 2.0;

  const baseFriction = hitNormal.y >= 0.5 ? properties.impactFriction : properties.impactFriction * 0.2;
  const maxFriction = hitNormal.y >= 0.5 ? impactMaxFriction : impactMaxFriction * 0.25;
  const friction = THREE.MathUtils.lerp(baseFriction, maxFriction, impactSeverity * impactStrength);
  
  // A solid sphere's moment of inertia means only 2/7ths of the contact point's speed
  // can be resolved entirely through a change in linear velocity before the slip stops.
  const MAX_LINEAR_DELTA_RATIO = 2 / 7;
  let tangentDeltaSpeed = Math.min(incomingTangentSpeed * MAX_LINEAR_DELTA_RATIO, friction * incomingNormalSpeed);
  
  if (incomingTangentSpeed > 1e-6 && tangentDeltaSpeed > 0) {
    CONTACT_IMPULSE_DELTA.copy(CONTACT_TANGENT_VELOCITY).multiplyScalar(-tangentDeltaSpeed / incomingTangentSpeed);
    
    // Prevent the initial bounce from instantly ripping the ball entirely backward under extreme spin.
    // Grass yields to spin initially; it only firmly grips once the ball settles into a continuous slide/contact.
    const linearForward = TANGENT_VELOCITY.length();
    if (linearForward > 0.5) {
      const linearDir = TANGENT_VELOCITY.clone().normalize();
      const dot = CONTACT_IMPULSE_DELTA.dot(linearDir);
      
      // If the impulse opposes our travel direction strongly enough to completely reverse us backward
      // Allow more backroll on initial bites by turning up the spin pull limit depending on how steep we land.
      const maxReversal = linearForward + (friction * incomingNormalSpeed * 1.5);
      if (dot < -maxReversal) {
         const scaling = maxReversal / -dot;
         tangentDeltaSpeed *= scaling;
         CONTACT_IMPULSE_DELTA.copy(CONTACT_TANGENT_VELOCITY).multiplyScalar(-tangentDeltaSpeed / incomingTangentSpeed);
      }
    }

    TANGENT_VELOCITY.add(CONTACT_IMPULSE_DELTA);
    applySurfaceImpulseToAngularVelocity(angularVelocity, hitNormal, CONTACT_IMPULSE_DELTA);
  }

  const restitution = THREE.MathUtils.lerp(
    0,
    properties.bounceRestitution,
    THREE.MathUtils.clamp(
      (incomingNormalSpeed - BALL_LANDING_CAPTURE_NORMAL_SPEED)
        / Math.max(BALL_IMPACT_REFERENCE_NORMAL_SPEED - BALL_LANDING_CAPTURE_NORMAL_SPEED, 1e-6),
      0,
      1,
    ),
  );

  velocity.copy(TANGENT_VELOCITY).addScaledVector(hitNormal, incomingNormalSpeed * restitution);
}

function applySurfaceImpulseToAngularVelocity(angularVelocity, surfaceNormal, linearVelocityDelta) {
  if (linearVelocityDelta.lengthSq() <= 1e-12) {
    return;
  }

  TARGET_ANGULAR_VELOCITY.copy(surfaceNormal).cross(linearVelocityDelta).multiplyScalar(-5 / (2 * BALL_RADIUS));
  angularVelocity.add(TARGET_ANGULAR_VELOCITY);
}

function applyGroundSpinDamping(angularVelocity, deltaSeconds) {
  angularVelocity.multiplyScalar(Math.exp(-BALL_SPIN_GROUND_DAMPING * deltaSeconds));
}

function syncRollingAngularVelocity(angularVelocity, velocity, surfaceNormal) {
  TARGET_ANGULAR_VELOCITY.copy(surfaceNormal).cross(velocity).multiplyScalar(1 / BALL_RADIUS);
  ANGULAR_NORMAL_COMPONENT.copy(surfaceNormal).multiplyScalar(angularVelocity.dot(surfaceNormal));
  angularVelocity.copy(TARGET_ANGULAR_VELOCITY).add(ANGULAR_NORMAL_COMPONENT);
}

function integrateOrientationFromAngularVelocity(orientation, angularVelocity, deltaSeconds) {
  const angularSpeed = angularVelocity.length();
  if (angularSpeed <= 1e-6) {
    return;
  }

  ANGULAR_STEP_AXIS.copy(angularVelocity).multiplyScalar(1 / angularSpeed);
  DELTA_ROTATION.setFromAxisAngle(ANGULAR_STEP_AXIS, angularSpeed * deltaSeconds);
  orientation.premultiply(DELTA_ROTATION).normalize();
}

function getVelocityDescentAngleDegrees(velocity) {
  const downwardSpeed = Math.max(-velocity.y, 0);
  const horizontalSpeed = Math.hypot(velocity.x, velocity.z);
  return getDescentAngleDegrees(downwardSpeed, horizontalSpeed);
}

function getDescentAngleDegrees(normalSpeed, tangentSpeed) {
  if (normalSpeed <= 1e-6 && tangentSpeed <= 1e-6) {
    return 0;
  }

  return THREE.MathUtils.radToDeg(Math.atan2(normalSpeed, Math.max(tangentSpeed, 1e-6)));
}

function removeIntoNormalComponent(vector, normal) {
  const normalSpeed = vector.dot(normal);
  if (normalSpeed >= 0) {
    return;
  }

  vector.addScaledVector(normal, -normalSpeed);
}

function projectOntoPlane(vector, normal) {
  vector.addScaledVector(normal, -vector.dot(normal));
  if (vector.distanceToSquared(ZERO_VECTOR) < BALL_STOP_SPEED * BALL_STOP_SPEED) {
    vector.set(0, 0, 0);
  }
}