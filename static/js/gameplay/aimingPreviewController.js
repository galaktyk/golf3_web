import * as THREE from 'three';
import {
  AIMING_MARKER_PIXEL_HEIGHT,
  AIMING_PREVIEW_HEAD_SPEED_MAX_METERS_PER_SECOND,
  AIMING_PREVIEW_HEAD_SPEED_MIN_METERS_PER_SECOND,
  AIMING_PREVIEW_HEAD_SPEED_METERS_PER_SECOND,
  BALL_FIXED_STEP_SECONDS,
  BALL_LANDING_SLIDING_FRICTION,
  BALL_LANDING_BRAKE_FRICTION,
  BALL_CONTACT_MAX_ROLLING_SPEED,
  BALL_RADIUS,
  BALL_ROLLING_RESISTANCE,
  COURSE_HOLE_POSITION,
} from '/static/js/game/constants.js';
import {
  buildPuttGridPreview,
  createPreviewSurfaceSampler,
  predictFirstContactPoint,
  resolvePuttPreviewRowCount,
} from '/static/js/game/aimPreview.js';
import { formatDistanceYards, formatMetersPerSecond } from '/static/js/game/formatting.js';
import { getNeutralClubLaunchPreview } from '/static/js/game/impact/clubImpact.js';

const AIMING_TARGET_DISTANCE_MIN_METERS = 0.25;
const AIMING_TARGET_DISTANCE_MAX_METERS = 999;
const AIMING_TARGET_RESET_HOLE_DISTANCE_SCALE = 0.95;
const PUTT_AIM_DISTANCE_ADJUST_MIN_RATE_METERS_PER_SECOND = 0.25;
const PUTT_AIM_DISTANCE_ADJUST_MAX_RATE_METERS_PER_SECOND = 18;
const PUTT_PREVIEW_SPEED_BIAS_METERS_PER_SECOND = 0.15;
const PUTT_PREVIEW_MIN_BALL_SPEED_METERS_PER_SECOND = 0.05;
const PUTT_PREVIEW_GRAVITY_ACCELERATION = 9.81;

const PUTT_AIM_HOLE_CLAMP_MARGIN_METERS = Math.max(BALL_RADIUS * 2, 0.08);
const PUTT_AIM_HOLE_ALIGNMENT_TOLERANCE_METERS = Math.max(BALL_RADIUS * 3.5, 0.14);
const PUTT_PREVIEW_HOLE_LENGTH_SCALE = 1.25;
const AIMING_PREVIEW_POINT_FOLLOW_STIFFNESS = 100;

/**
 * Owns aiming-preview state, hole-relative target solving, and aiming-marker presentation.
 */
export function createAimingPreviewController({ viewerScene, hud, ballPhysics, getActiveClub, syncLaunchDebugInputs }) {
  const aimingMarkerCameraSpace = new THREE.Vector3();
  const aimingPreviewLandingPoint = new THREE.Vector3();
  const aimingPreviewDisplayPoint = new THREE.Vector3();
  const aimingPreviewTargetProbePoint = new THREE.Vector3();
  const aimingPreviewTargetForward = new THREE.Vector3();
  const aimingPreviewTargetLateralOffset = new THREE.Vector3();
  const characterForwardForPreview = new THREE.Vector3();
  const holeWorldPosition = new THREE.Vector3();
  const puttHoleOffset = new THREE.Vector3();

  const aimingPreview = {
    dirty: true,
    isVisible: false,
    carryDistanceMeters: 0,
    hasTargetPoint: false,
    mode: 'landing',
    puttGrid: null,
    slopeGrid: null,
  };

  let aimingPreviewHeadSpeedMetersPerSecond = AIMING_PREVIEW_HEAD_SPEED_METERS_PER_SECOND;
  let aimingTargetDistanceMeters = 5;
  let puttAimDistanceMeters = 5;
  let puttPreviewPinnedRowCount = null;
  let aimingPreviewDisplayPointNeedsSnap = true;
  let aimingPreviewDisplayMode = 'landing';

  /**
   * Keeps club-category checks consistent anywhere the controller needs to detect putt-mode transitions.
   */
  const isPutterClub = (club) => club?.category === 'putter';

  const usesLaunchAimingPreview = () => getActiveClub()?.category !== 'putter';

  /**
   * Resolves the cup position in world space so gameplay code does not depend on scene-graph transforms directly.
   */
  const resolveHoleWorldPosition = (target = holeWorldPosition) => {
    const holeMarker = viewerScene.getHoleMarker();
    if (holeMarker?.holePosition) {
      return target.copy(holeMarker.holePosition);
    }

    return target.copy(COURSE_HOLE_POSITION);
  };

  const setAimingTargetDistanceMeters = (distanceMeters) => {
    const clampedDistanceMeters = THREE.MathUtils.clamp(
      distanceMeters,
      AIMING_TARGET_DISTANCE_MIN_METERS,
      AIMING_TARGET_DISTANCE_MAX_METERS,
    );
    aimingTargetDistanceMeters = clampedDistanceMeters;
    puttAimDistanceMeters = clampedDistanceMeters;
    return clampedDistanceMeters;
  };

  /**
   * Returns the hole distance along the current putt line when the cup is effectively on that line.
   */
  const resolveAlignedHoleClampDistance = (ballPosition = ballPhysics.getPosition()) => {
    if (!ballPosition) {
      return null;
    }

    aimingPreviewTargetForward.copy(viewerScene.getCharacterForward(characterForwardForPreview));
    if (aimingPreviewTargetForward.lengthSq() <= 1e-8) {
      aimingPreviewTargetForward.set(0, 0, -1);
    } else {
      aimingPreviewTargetForward.normalize();
    }

    puttHoleOffset.subVectors(resolveHoleWorldPosition(), ballPosition);
    puttHoleOffset.y = 0;
    const holeDistanceAlongAimMeters = puttHoleOffset.dot(aimingPreviewTargetForward);
    if (holeDistanceAlongAimMeters <= 0) {
      return null;
    }

    aimingPreviewTargetLateralOffset.copy(puttHoleOffset).addScaledVector(
      aimingPreviewTargetForward,
      -holeDistanceAlongAimMeters,
    );
    if (aimingPreviewTargetLateralOffset.length() > PUTT_AIM_HOLE_ALIGNMENT_TOLERANCE_METERS) {
      return null;
    }

    return Math.max(holeDistanceAlongAimMeters - PUTT_AIM_HOLE_CLAMP_MARGIN_METERS, 0);
  };

  const clampPuttDistanceToAlignedHole = (distanceMeters, ballPosition = ballPhysics.getPosition()) => {
    const alignedHoleClampDistance = resolveAlignedHoleClampDistance(ballPosition);
    if (!Number.isFinite(alignedHoleClampDistance)) {
      return distanceMeters;
    }

    return Math.min(distanceMeters, alignedHoleClampDistance);
  };

  const resolvePuttAimTargetPoint = (ballPosition = ballPhysics.getPosition(), target = aimingPreviewTargetProbePoint) => {
    if (!ballPosition) {
      return target.set(0, 0, 0);
    }

    aimingPreviewTargetForward.copy(viewerScene.getCharacterForward(characterForwardForPreview));
    if (aimingPreviewTargetForward.lengthSq() <= 1e-8) {
      aimingPreviewTargetForward.set(0, 0, -1);
    } else {
      aimingPreviewTargetForward.normalize();
    }

    target.copy(ballPosition)
      .addScaledVector(aimingPreviewTargetForward, puttAimDistanceMeters);

    if (!viewerScene.courseCollision?.root) {
      return target;
    }

    const surfaceSample = createPreviewSurfaceSampler(viewerScene, resolveHoleWorldPosition())(target, 3, 18);

    return target.copy(surfaceSample?.point ?? target);
  };

  const simulatePuttDistanceMeters = (initialBallSpeed, targetDistanceMeters, heightDeltaMeters) => {
    let velocity = initialBallSpeed;
    let spinVelocity = 0;
    let distance = 0;
    let contactAge = 0;
    const dt = BALL_FIXED_STEP_SECONDS;
    const g = PUTT_PREVIEW_GRAVITY_ACCELERATION;
    const slopeGravity = -(heightDeltaMeters / Math.max(targetDistanceMeters, 0.01)) * g;

    for (let i = 0; i < 900; i++) {
      if (velocity <= 1e-6 && slopeGravity <= 0) break;

      let movementState = 'ground';
      if (initialBallSpeed > BALL_CONTACT_MAX_ROLLING_SPEED) {
        if (contactAge < 0.04 || velocity > BALL_CONTACT_MAX_ROLLING_SPEED || Math.abs(velocity - spinVelocity) > 0.6) {
          movementState = 'contact';
        }
      }

      velocity += slopeGravity * dt;

      if (movementState === 'contact') {
        contactAge += dt;
        let slipSpeed = velocity - spinVelocity;
        let sign = Math.sign(slipSpeed);
        let absSlip = Math.abs(slipSpeed);
        if (absSlip > 1e-6) {
          let slidingDelta = Math.min(absSlip, BALL_LANDING_SLIDING_FRICTION * g * dt);
          velocity -= sign * slidingDelta;
          spinVelocity += sign * slidingDelta * 2.5;
        }

        if (velocity > BALL_CONTACT_MAX_ROLLING_SPEED) {
          let brakeDelta = Math.min(velocity - BALL_CONTACT_MAX_ROLLING_SPEED, BALL_LANDING_BRAKE_FRICTION * g * dt);
          velocity -= brakeDelta;
        }
        let rollDelta = Math.min(velocity, BALL_ROLLING_RESISTANCE * g * dt);
        velocity -= rollDelta;
      } else {
        spinVelocity = velocity;
        let rollDelta = Math.min(velocity, BALL_ROLLING_RESISTANCE * g * dt);
        velocity -= rollDelta;
      }

      if (velocity < 1e-6) {
        if (slopeGravity < Math.min(BALL_ROLLING_RESISTANCE, 0.28) * g) {
           break;
        }
      }

      distance += Math.max(velocity, 0) * dt;
    }
    return distance;
  };

  const getPuttPreviewHeadSpeed = (ballPosition = ballPhysics.getPosition()) => {
    const aimedDistanceMeters = THREE.MathUtils.clamp(
      puttAimDistanceMeters,
      AIMING_TARGET_DISTANCE_MIN_METERS,
      AIMING_TARGET_DISTANCE_MAX_METERS,
    );
    const aimTargetPoint = resolvePuttAimTargetPoint(ballPosition, aimingPreviewTargetProbePoint);
    const heightDeltaMeters = Number.isFinite(ballPosition?.y)
      ? aimTargetPoint.y - ballPosition.y
      : 0;

    let lowSpeed = PUTT_PREVIEW_MIN_BALL_SPEED_METERS_PER_SECOND;
    let highSpeed = AIMING_PREVIEW_HEAD_SPEED_MAX_METERS_PER_SECOND * 2;
    let bestBallSpeed = (lowSpeed + highSpeed) * 0.5;

    for (let iter = 0; iter < 18; iter++) {
      bestBallSpeed = (lowSpeed + highSpeed) * 0.5;
      let d = simulatePuttDistanceMeters(bestBallSpeed, aimedDistanceMeters, heightDeltaMeters);
      if (d < aimedDistanceMeters) {
        lowSpeed = bestBallSpeed;
      } else {
        highSpeed = bestBallSpeed;
      }
    }

    const targetBallSpeedMetersPerSecond = Math.max(
      PUTT_PREVIEW_MIN_BALL_SPEED_METERS_PER_SECOND,
      bestBallSpeed + PUTT_PREVIEW_SPEED_BIAS_METERS_PER_SECOND,
    );
    const smashFactor = Number.isFinite(getActiveClub()?.smashFactor)
      ? Math.max(getActiveClub().smashFactor, 1e-6)
      : 1;

    return THREE.MathUtils.clamp(
      targetBallSpeedMetersPerSecond / smashFactor,
      AIMING_PREVIEW_HEAD_SPEED_MIN_METERS_PER_SECOND,
      AIMING_PREVIEW_HEAD_SPEED_MAX_METERS_PER_SECOND,
    );
  };

  const getCurrentAimingPreviewHeadSpeed = (ballPosition = ballPhysics.getPosition()) => {
    if (usesLaunchAimingPreview()) {
      return aimingPreviewHeadSpeedMetersPerSecond;
    }

    return getPuttPreviewHeadSpeed(ballPosition);
  };

  const syncSwingPreviewTarget = () => {
    hud.updateSwingPreviewTarget(getCurrentAimingPreviewHeadSpeed());
  };

  const invalidate = () => {
    aimingPreview.dirty = true;
    if (!usesLaunchAimingPreview()) {
      syncSwingPreviewTarget();
    }
  };

  /**
   * Returns the point presentation systems should follow so preview smoothing does not feed back into shot solving.
   */
  const getRenderedPreviewPoint = () => (
    aimingPreview.mode === 'landing'
      ? aimingPreviewDisplayPoint
      : aimingPreviewLandingPoint
  );

  /**
   * Smooths only the rendered landing marker for launch previews while keeping simulation results exact.
   */
  const updatePresentation = (deltaSeconds) => {
    if (!aimingPreview.isVisible || !aimingPreview.hasTargetPoint) {
      aimingPreviewDisplayPointNeedsSnap = true;
      return;
    }

    const shouldSmoothLaunchPoint = aimingPreview.mode === 'landing';
    if (!shouldSmoothLaunchPoint) {
      aimingPreviewDisplayPoint.copy(aimingPreviewLandingPoint);
      aimingPreviewDisplayPointNeedsSnap = true;
      aimingPreviewDisplayMode = aimingPreview.mode;
      return;
    }

    if (aimingPreviewDisplayPointNeedsSnap || aimingPreviewDisplayMode !== aimingPreview.mode) {
      aimingPreviewDisplayPoint.copy(aimingPreviewLandingPoint);
      aimingPreviewDisplayPointNeedsSnap = false;
      aimingPreviewDisplayMode = aimingPreview.mode;
      return;
    }

    const followAlpha = Number.isFinite(deltaSeconds) && deltaSeconds > 0
      ? 1 - Math.exp(-AIMING_PREVIEW_POINT_FOLLOW_STIFFNESS * deltaSeconds)
      : 1;
    aimingPreviewDisplayPoint.lerp(aimingPreviewLandingPoint, followAlpha);
  };

  /**
   * Pins the putt grid depth from the current hole distance so aim tweaks do not keep extending the preview.
   */
  const pinPuttPreviewRowCount = (ballPosition = ballPhysics.getPosition()) => {
    if (!ballPosition) {
      puttPreviewPinnedRowCount = resolvePuttPreviewRowCount(0);
      return puttPreviewPinnedRowCount;
    }

    puttHoleOffset.subVectors(resolveHoleWorldPosition(), ballPosition);
    puttHoleOffset.y = 0;
    puttPreviewPinnedRowCount = resolvePuttPreviewRowCount(
      puttHoleOffset.length() * PUTT_PREVIEW_HOLE_LENGTH_SCALE,
    );
    return puttPreviewPinnedRowCount;
  };

  const ensurePuttPreviewRowCount = (ballPosition = ballPhysics.getPosition()) => {
    if (Number.isFinite(puttPreviewPinnedRowCount)) {
      return puttPreviewPinnedRowCount;
    }

    return pinPuttPreviewRowCount(ballPosition);
  };

  const syncPuttAimDistanceToHole = (ballPosition = ballPhysics.getPosition()) => {
    if (!ballPosition) {
      return;
    }

    puttHoleOffset.subVectors(resolveHoleWorldPosition(), ballPosition);
    puttHoleOffset.y = 0;
    const holeDistanceMeters = puttHoleOffset.length();
    const previousAimDistanceMeters = aimingTargetDistanceMeters;
    let nextAimDistanceMeters = previousAimDistanceMeters;

    if (!Number.isFinite(nextAimDistanceMeters) || nextAimDistanceMeters <= 0) {
      nextAimDistanceMeters = holeDistanceMeters;
    }

    if (nextAimDistanceMeters > holeDistanceMeters) {
      nextAimDistanceMeters = holeDistanceMeters * AIMING_TARGET_RESET_HOLE_DISTANCE_SCALE;
    }

    setAimingTargetDistanceMeters(nextAimDistanceMeters);

    if (usesLaunchAimingPreview()) {
      puttPreviewPinnedRowCount = null;
      syncLaunchPreviewHeadSpeedToAimingTarget(ballPosition);
      return;
    }

    syncPuttAimDistanceToAimingTarget();
    pinPuttPreviewRowCount(ballPosition);
  };

  const syncPuttAimDistanceToAimingTarget = () => {
    puttAimDistanceMeters = THREE.MathUtils.clamp(
      aimingTargetDistanceMeters,
      AIMING_TARGET_DISTANCE_MIN_METERS,
      AIMING_TARGET_DISTANCE_MAX_METERS,
    );
  };

  const solveLaunchPreviewHeadSpeedForDistance = (targetDistanceMeters, ballPosition = ballPhysics.getPosition()) => {
    if (!ballPosition || !viewerScene.courseCollision?.root) {
      return aimingPreviewHeadSpeedMetersPerSecond;
    }

    const desiredDistanceMeters = Math.max(targetDistanceMeters, AIMING_TARGET_DISTANCE_MIN_METERS);
    const referenceForward = viewerScene.getCharacterForward(characterForwardForPreview);
    let lowHeadSpeedMetersPerSecond = AIMING_PREVIEW_HEAD_SPEED_MIN_METERS_PER_SECOND;
    let highHeadSpeedMetersPerSecond = AIMING_PREVIEW_HEAD_SPEED_MAX_METERS_PER_SECOND;
    let bestHeadSpeedMetersPerSecond = aimingPreviewHeadSpeedMetersPerSecond;
    let bestDistanceErrorMeters = Infinity;
    let foundValidCandidate = false;

    for (let iteration = 0; iteration < 14; iteration += 1) {
      const candidateHeadSpeedMetersPerSecond = (lowHeadSpeedMetersPerSecond + highHeadSpeedMetersPerSecond) * 0.5;
      const launchPreview = getNeutralClubLaunchPreview(candidateHeadSpeedMetersPerSecond, getActiveClub());
      if (!launchPreview?.isReady) {
        lowHeadSpeedMetersPerSecond = candidateHeadSpeedMetersPerSecond;
        continue;
      }

      const firstContactPreview = predictFirstContactPoint(
        viewerScene,
        ballPosition,
        {
          ballSpeed: launchPreview.ballSpeed,
          verticalLaunchAngle: launchPreview.verticalLaunchAngle,
          horizontalLaunchAngle: 0,
          spinSpeed: launchPreview.spinSpeed,
          spinAxis: launchPreview.spinAxis,
        },
        referenceForward,
      );
      if (!firstContactPreview || !Number.isFinite(firstContactPreview.carryDistanceMeters)) {
        // Missing ground contact usually means this candidate flew beyond reliable preview bounds,
        // so search lower speeds instead of incorrectly treating it as too short.
        highHeadSpeedMetersPerSecond = candidateHeadSpeedMetersPerSecond;
        continue;
      }

      const candidateDistanceMeters = firstContactPreview?.carryDistanceMeters ?? 0;
      const distanceErrorMeters = Math.abs(candidateDistanceMeters - desiredDistanceMeters);
      if (distanceErrorMeters < bestDistanceErrorMeters) {
        bestDistanceErrorMeters = distanceErrorMeters;
        bestHeadSpeedMetersPerSecond = candidateHeadSpeedMetersPerSecond;
        foundValidCandidate = true;
      }

      if (candidateDistanceMeters < desiredDistanceMeters) {
        lowHeadSpeedMetersPerSecond = candidateHeadSpeedMetersPerSecond;
      } else {
        highHeadSpeedMetersPerSecond = candidateHeadSpeedMetersPerSecond;
      }
    }

    if (!foundValidCandidate) {
      return THREE.MathUtils.clamp(
        aimingPreviewHeadSpeedMetersPerSecond,
        AIMING_PREVIEW_HEAD_SPEED_MIN_METERS_PER_SECOND,
        AIMING_PREVIEW_HEAD_SPEED_MAX_METERS_PER_SECOND,
      );
    }

    return THREE.MathUtils.clamp(
      bestHeadSpeedMetersPerSecond,
      AIMING_PREVIEW_HEAD_SPEED_MIN_METERS_PER_SECOND,
      AIMING_PREVIEW_HEAD_SPEED_MAX_METERS_PER_SECOND,
    );
  };

  const syncLaunchPreviewHeadSpeedToAimingTarget = (ballPosition = ballPhysics.getPosition()) => {
    const solvedHeadSpeedMetersPerSecond = solveLaunchPreviewHeadSpeedForDistance(
      aimingTargetDistanceMeters,
      ballPosition,
    );
    if (Number.isFinite(solvedHeadSpeedMetersPerSecond)) {
      aimingPreviewHeadSpeedMetersPerSecond = solvedHeadSpeedMetersPerSecond;
    }
  };

  const adjustAimingPreviewHeadSpeed = (deltaMetersPerSecond) => {
    const nextHeadSpeedMetersPerSecond = THREE.MathUtils.clamp(
      aimingPreviewHeadSpeedMetersPerSecond + deltaMetersPerSecond,
      AIMING_PREVIEW_HEAD_SPEED_MIN_METERS_PER_SECOND,
      AIMING_PREVIEW_HEAD_SPEED_MAX_METERS_PER_SECOND,
    );
    if (Math.abs(nextHeadSpeedMetersPerSecond - aimingPreviewHeadSpeedMetersPerSecond) <= 1e-8) {
      return;
    }

    aimingPreviewHeadSpeedMetersPerSecond = nextHeadSpeedMetersPerSecond;
    syncSwingPreviewTarget();
    invalidate();
    hud.setStatus(`Aim preview head speed: ${formatMetersPerSecond(aimingPreviewHeadSpeedMetersPerSecond)}`);
  };

  const adjustPuttAimDistance = (deltaMeters) => {
    const nextPuttAimDistanceMeters = THREE.MathUtils.clamp(
      puttAimDistanceMeters + deltaMeters,
      AIMING_TARGET_DISTANCE_MIN_METERS,
      AIMING_TARGET_DISTANCE_MAX_METERS,
    );
    if (Math.abs(nextPuttAimDistanceMeters - puttAimDistanceMeters) <= 1e-8) {
      return;
    }

    setAimingTargetDistanceMeters(nextPuttAimDistanceMeters);
    syncSwingPreviewTarget();
    invalidate();
    hud.setStatus(
      `Putt aim: ${formatDistanceYards(puttAimDistanceMeters)} (${formatMetersPerSecond(getCurrentAimingPreviewHeadSpeed())})`,
    );
  };

  const updateSwingPreviewCaptureFromImpact = (impact) => {
    const capturedHeadSpeedMetersPerSecond = Number.isFinite(impact?.launchPreview?.clubHeadSpeedMetersPerSecond)
      ? impact.launchPreview.clubHeadSpeedMetersPerSecond
      : impact?.impactSpeedMetersPerSecond;
    hud.updateSwingPreviewCapture(
      capturedHeadSpeedMetersPerSecond,
      getCurrentAimingPreviewHeadSpeed(),
    );
  };

  const preserveCurrentTargetDistance = () => {
    if (Number.isFinite(aimingTargetDistanceMeters) && aimingTargetDistanceMeters > 0) {
      setAimingTargetDistanceMeters(aimingTargetDistanceMeters);
      return;
    }

    if (aimingPreview.hasTargetPoint && Number.isFinite(aimingPreview.carryDistanceMeters)) {
      setAimingTargetDistanceMeters(aimingPreview.carryDistanceMeters);
    }
  };

  /**
   * Refreshes preview state after a club switch and re-pins putt-grid depth when entering putt mode.
   */
  const onClubChanged = (previousClub = null, nextClub = getActiveClub()) => {
    const enteredPuttMode = !isPutterClub(previousClub) && isPutterClub(nextClub);

    preserveCurrentTargetDistance();
    if (isPutterClub(nextClub)) {
      syncPuttAimDistanceToAimingTarget();
      if (enteredPuttMode) {
        puttPreviewPinnedRowCount = null;
      }
      pinPuttPreviewRowCount();
    } else {
      puttPreviewPinnedRowCount = null;
      syncLaunchPreviewHeadSpeedToAimingTarget();
    }
    syncSwingPreviewTarget();
    invalidate();
  };

  const updateIfNeeded = (playerState) => {
    if (!aimingPreview.dirty) {
      return;
    }
    aimingPreview.isVisible = false;
    aimingPreview.hasTargetPoint = false;
    aimingPreview.puttGrid = null;
    aimingPreview.slopeGrid = null;

    if (playerState !== 'control' || ballPhysics.getStateSnapshot().phase !== 'ready') {
      aimingPreview.mode = usesLaunchAimingPreview() ? 'landing' : 'putt-grid';
      aimingPreview.dirty = false;
      return;
    }

    if (!viewerScene.courseCollision?.root) {
      return;
    }

    if (!usesLaunchAimingPreview()) {
      const puttAimForward = viewerScene.getCharacterForward(characterForwardForPreview);
      const puttPreviewHeadSpeedMetersPerSecond = getCurrentAimingPreviewHeadSpeed(ballPhysics.getPosition());
      const launchPreview = getNeutralClubLaunchPreview(
        puttPreviewHeadSpeedMetersPerSecond,
        getActiveClub(),
      );
      if (!launchPreview?.isReady) {
        return;
      }

      const aimingPreviewLaunchData = {
        ballSpeed: launchPreview.ballSpeed,
        verticalLaunchAngle: launchPreview.verticalLaunchAngle,
        horizontalLaunchAngle: 0,
        spinSpeed: launchPreview.spinSpeed,
        spinAxis: launchPreview.spinAxis,
      };
      syncLaunchDebugInputs(aimingPreviewLaunchData);
      resolvePuttAimTargetPoint(ballPhysics.getPosition(), aimingPreviewLandingPoint);
      const puttGridPreview = buildPuttGridPreview(
        viewerScene,
        ballPhysics.getPosition(),
        ensurePuttPreviewRowCount(ballPhysics.getPosition()),
        puttAimForward,
        resolveHoleWorldPosition(),
      );
      aimingPreview.mode = 'putt-grid';
      aimingPreview.puttGrid = puttGridPreview;
      aimingPreview.isVisible = Boolean(puttGridPreview?.cells?.length || puttAimDistanceMeters > 0);
      aimingPreview.hasTargetPoint = true;
      aimingPreview.carryDistanceMeters = Math.hypot(
        aimingPreviewLandingPoint.x - ballPhysics.getPosition().x,
        aimingPreviewLandingPoint.z - ballPhysics.getPosition().z,
      );
      aimingPreview.dirty = false;
      return;
    }

    const launchPreview = getNeutralClubLaunchPreview(
      getCurrentAimingPreviewHeadSpeed(ballPhysics.getPosition()),
      getActiveClub(),
    );
    if (!launchPreview?.isReady) {
      return;
    }

    const aimingPreviewLaunchData = {
      ballSpeed: launchPreview.ballSpeed,
      verticalLaunchAngle: launchPreview.verticalLaunchAngle,
      horizontalLaunchAngle: 0,
      spinSpeed: launchPreview.spinSpeed,
      spinAxis: launchPreview.spinAxis,
    };
    syncLaunchDebugInputs(aimingPreviewLaunchData);

    const firstContactPreview = predictFirstContactPoint(
      viewerScene,
      ballPhysics.getPosition(),
      aimingPreviewLaunchData,
      viewerScene.getCharacterForward(characterForwardForPreview),
    );
    aimingPreview.mode = 'landing';
    if (!firstContactPreview) {
      aimingPreview.slopeGrid = null;
      aimingPreview.isVisible = Boolean(aimingPreview.slopeGrid?.cells?.length);
      aimingPreview.dirty = false;
      return;
    }

    aimingPreviewLandingPoint.copy(firstContactPreview.point);
    aimingPreview.slopeGrid = null;

    aimingPreview.carryDistanceMeters = setAimingTargetDistanceMeters(firstContactPreview.carryDistanceMeters);
    aimingPreview.isVisible = true;
    aimingPreview.hasTargetPoint = true;
    aimingPreview.dirty = false;
  };

  const updateMarker = (ballTelemetry) => {
    const aimingMarker = viewerScene.getAimingMarker();
    if (!aimingMarker) {
      return;
    }

    const renderedPreviewPoint = getRenderedPreviewPoint();

    const hasSlopeGrid = Boolean(aimingPreview.slopeGrid?.cells?.length);

    if (ballTelemetry.phase === 'moving' || (!aimingPreview.isVisible && !hasSlopeGrid)) {
      aimingMarker.setVisible(false);
      aimingMarker.setPuttGrid(null);
      aimingMarker.setSlopeGrid(null);
      aimingMarker.setPuttAimTarget(null);
      return;
    }

    if (aimingPreview.mode === 'putt-grid') {
      aimingMarker.setPuttGrid(aimingPreview.puttGrid);
      aimingMarker.setSlopeGrid(null);
      aimingMarker.setPuttAimTarget(null);
      if (!aimingPreview.hasTargetPoint) {
        aimingMarker.setVisible(false);
        return;
      }
      aimingMarkerCameraSpace.copy(renderedPreviewPoint).applyMatrix4(viewerScene.camera.matrixWorldInverse);
      if (aimingMarkerCameraSpace.z >= 0) {
        aimingMarker.setVisible(false);
        return;
      }

      const distanceToCamera = viewerScene.camera.position.distanceTo(renderedPreviewPoint);
      const worldHeight = 2
        * Math.tan(THREE.MathUtils.degToRad(viewerScene.camera.fov * 0.5))
        * Math.max(distanceToCamera, 0.01)
        * (AIMING_MARKER_PIXEL_HEIGHT / window.innerHeight);

      aimingMarker.setDistanceLabel(formatDistanceYards(aimingPreview.carryDistanceMeters));
      aimingMarker.setWorldPosition(renderedPreviewPoint);
      aimingMarker.setWorldHeight(worldHeight);
      aimingMarker.setVisible(true);
      return;
    }

    aimingMarker.setPuttGrid(null);
    aimingMarker.setSlopeGrid(aimingPreview.slopeGrid);
    aimingMarker.setPuttAimTarget(null);

    if (!aimingPreview.hasTargetPoint) {
      aimingMarker.setVisible(false);
      return;
    }

    aimingMarkerCameraSpace.copy(renderedPreviewPoint).applyMatrix4(viewerScene.camera.matrixWorldInverse);
    if (aimingMarkerCameraSpace.z >= 0) {
      aimingMarker.setVisible(false);
      return;
    }

    const distanceToCamera = viewerScene.camera.position.distanceTo(renderedPreviewPoint);
    const worldHeight = 2
      * Math.tan(THREE.MathUtils.degToRad(viewerScene.camera.fov * 0.5))
      * Math.max(distanceToCamera, 0.01)
      * (AIMING_MARKER_PIXEL_HEIGHT / window.innerHeight);

    aimingMarker.setDistanceLabel(formatDistanceYards(aimingPreview.carryDistanceMeters));
    aimingMarker.setWorldPosition(renderedPreviewPoint);
    aimingMarker.setWorldHeight(worldHeight);
    aimingMarker.setVisible(true);
  };

  const getBallFollowPreviewState = () => ({
    isVisible: aimingPreview.isVisible,
    hasTargetPoint: aimingPreview.hasTargetPoint,
    point: aimingPreview.hasTargetPoint ? getRenderedPreviewPoint() : null,
  });

  return {
    adjustAimingPreviewHeadSpeed,
    adjustPuttAimDistance,
    getBallFollowPreviewState,
    getCurrentAimingPreviewHeadSpeed,
    getState: () => aimingPreview,
    invalidate,
    onClubChanged,
    resolveHoleWorldPosition,
    syncPuttAimDistanceToAimingTarget,
    syncPuttAimDistanceToHole,
    syncSwingPreviewTarget,
    syncLaunchPreviewHeadSpeedToAimingTarget,
    updatePresentation,
    updateIfNeeded,
    updateMarker,
    updateSwingPreviewCaptureFromImpact,
  };
}