import * as THREE from 'three';
import {
  BALL_COLLISION_SKIN,
  BALL_FIXED_STEP_SECONDS,
  BALL_GROUNDED_NORMAL_MIN_Y,
  BALL_MAX_COLLISION_ITERATIONS,
  BALL_RADIUS,
} from '/static/js/game/constants.js';
import {
  buildLaunchAngularVelocity,
  buildLaunchVelocity,
  integrateAirborneState,
} from '/static/js/game/ballFlightModel.js';
import { findGroundSupport, sampleCourseSurface, sweepSphereBVH } from '/static/js/game/collision.js';
import { SURFACE_TYPES } from '/static/js/game/surfaceData.js';

const PREVIEW_MAX_SIMULATION_SECONDS = 22;
const PREVIEW_MAX_STEPS = Math.ceil(PREVIEW_MAX_SIMULATION_SECONDS / BALL_FIXED_STEP_SECONDS);
const PREVIEW_VELOCITY = new THREE.Vector3();
const PREVIEW_ANGULAR_VELOCITY = new THREE.Vector3();
const PREVIEW_POSITION = new THREE.Vector3();
const PREVIEW_DISPLACEMENT = new THREE.Vector3();
const PREVIEW_FALLBACK_POINT = new THREE.Vector3();
const PREVIEW_SUPPORT_FALLBACK = new THREE.Vector3();
const PREVIEW_START_POSITION = new THREE.Vector3();
const PREVIEW_CLEARANCE_HEIGHT_METERS = BALL_RADIUS * 0.35;
const PREVIEW_MIN_LANDING_TRAVEL_METERS = Math.max(BALL_RADIUS * 6, 0.24);
const PREVIEW_FALLBACK_GROUND_SNAP_DISTANCE = 12;
const PUTT_PREVIEW_GRID_BASE_ROWS = 8;
const PUTT_PREVIEW_GRID_DEFAULT_ROWS = 8;
const PUTT_PREVIEW_GRID_MAX_ROWS = 16;
const PUTT_PREVIEW_GRID_COLUMNS = 9;
const PREVIEW_GRID_CELL_SIZE_YARDS = 2;
const PUTT_PREVIEW_YARDS_TO_METERS = 0.9144;
const PUTT_PREVIEW_GRID_DEPTH_METERS = PREVIEW_GRID_CELL_SIZE_YARDS * PUTT_PREVIEW_GRID_BASE_ROWS * PUTT_PREVIEW_YARDS_TO_METERS;
const PUTT_PREVIEW_GRID_WIDTH_METERS = PREVIEW_GRID_CELL_SIZE_YARDS * PUTT_PREVIEW_GRID_COLUMNS * PUTT_PREVIEW_YARDS_TO_METERS;
const PUTT_PREVIEW_CELL_DEPTH_METERS = PUTT_PREVIEW_GRID_DEPTH_METERS / PUTT_PREVIEW_GRID_BASE_ROWS;
const PUTT_PREVIEW_CELL_WIDTH_METERS = PUTT_PREVIEW_GRID_WIDTH_METERS / PUTT_PREVIEW_GRID_COLUMNS;
const PUTT_PREVIEW_SURFACE_SAMPLE_UP_DISTANCE = 3;
const PUTT_PREVIEW_SURFACE_SAMPLE_DOWN_DISTANCE = 18;
const PUTT_PREVIEW_FORWARD = new THREE.Vector3();
const PUTT_PREVIEW_RIGHT = new THREE.Vector3();
const PUTT_PREVIEW_SAMPLE_POINT = new THREE.Vector3();
const PUTT_PREVIEW_VERTEX_SAMPLE_POINT = new THREE.Vector3();
const PUTT_PREVIEW_FALLBACK_NORMAL = new THREE.Vector3(0, 1, 0);
const PUTT_PREVIEW_SUPPORT_SAMPLE = new THREE.Vector3();
const PREVIEW_CUP_PLANE_POINT = new THREE.Vector3();
const PREVIEW_CUP_PLANE_NORMAL = new THREE.Vector3();
const PREVIEW_CUP_SURFACE_POINT = new THREE.Vector3();
const PREVIEW_CUP_RING_SAMPLE_POINT = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const PREVIEW_IGNORED_SURFACE_TYPES = [SURFACE_TYPES.LEAF];

// Avoid dropping the preview to the hole bottom 
const PREVIEW_CUP_EXCLUSION_RADIUS_METERS = 0.25;
const PREVIEW_CUP_MAX_DEPTH_METERS = 0.05;
const PREVIEW_CUP_SURFACE_SAMPLE_RADIUS_METERS = 0.5;
const PREVIEW_CUP_SURFACE_SAMPLE_COUNT = 6;

/**
 * Estimates the green surface across the cup opening so preview overlays do not drop to the hole bottom.
 */
function estimatePreviewCupSurface(courseCollision, holePosition) {
  if (!courseCollision?.root || !holePosition) {
    return null;
  }

  PREVIEW_CUP_PLANE_POINT.set(0, 0, 0);
  PREVIEW_CUP_PLANE_NORMAL.set(0, 0, 0);
  let sampleCount = 0;

  for (let sampleIndex = 0; sampleIndex < PREVIEW_CUP_SURFACE_SAMPLE_COUNT; sampleIndex += 1) {
    const angle = (sampleIndex / PREVIEW_CUP_SURFACE_SAMPLE_COUNT) * Math.PI * 2;
    PREVIEW_CUP_RING_SAMPLE_POINT.copy(holePosition);
    PREVIEW_CUP_RING_SAMPLE_POINT.x += Math.cos(angle) * PREVIEW_CUP_SURFACE_SAMPLE_RADIUS_METERS;
    PREVIEW_CUP_RING_SAMPLE_POINT.z += Math.sin(angle) * PREVIEW_CUP_SURFACE_SAMPLE_RADIUS_METERS;

    const surfaceSample = sampleCourseSurface(
      courseCollision,
      PREVIEW_CUP_RING_SAMPLE_POINT,
      PUTT_PREVIEW_SURFACE_SAMPLE_UP_DISTANCE,
      PUTT_PREVIEW_SURFACE_SAMPLE_DOWN_DISTANCE,
      { ignoredSurfaceTypes: PREVIEW_IGNORED_SURFACE_TYPES },
    );
    if (!surfaceSample) {
      continue;
    }

    PREVIEW_CUP_PLANE_POINT.add(surfaceSample.point);
    PREVIEW_CUP_PLANE_NORMAL.add(surfaceSample.normal);
    sampleCount += 1;
  }

  if (sampleCount < 3) {
    return null;
  }

  PREVIEW_CUP_PLANE_POINT.multiplyScalar(1 / sampleCount);
  if (PREVIEW_CUP_PLANE_NORMAL.lengthSq() <= 1e-8) {
    PREVIEW_CUP_PLANE_NORMAL.copy(PUTT_PREVIEW_FALLBACK_NORMAL);
  } else {
    PREVIEW_CUP_PLANE_NORMAL.normalize();
  }

  return {
    center: holePosition.clone(),
    exclusionRadiusMeters: PREVIEW_CUP_EXCLUSION_RADIUS_METERS,
    maxDepthMeters: PREVIEW_CUP_MAX_DEPTH_METERS,
    point: PREVIEW_CUP_PLANE_POINT.clone(),
    normal: PREVIEW_CUP_PLANE_NORMAL.clone(),
  };
}

/**
 * Projects a preview sample onto the estimated lip plane while preserving the original X/Z placement.
 */
function projectPreviewSampleOntoCupSurface(point, cupSurface, target) {
  target.copy(point);

  if (Math.abs(cupSurface.normal.y) <= 1e-6) {
    target.y = cupSurface.point.y;
    return target;
  }

  target.y = cupSurface.point.y - (
    (target.x - cupSurface.point.x) * cupSurface.normal.x
    + (target.z - cupSurface.point.z) * cupSurface.normal.z
  ) / cupSurface.normal.y;
  return target;
}

/**
 * Samples preview ground and suppresses cup-bottom hits near the hole.
 */
function samplePreviewSurface(courseCollision, point, maxUpDistance, maxDownDistance, cupSurface = null) {
  const surfaceSample = sampleCourseSurface(
    courseCollision,
    point,
    maxUpDistance,
    maxDownDistance,
    { ignoredSurfaceTypes: PREVIEW_IGNORED_SURFACE_TYPES },
  );
  if (!surfaceSample || !cupSurface) {
    return surfaceSample;
  }

  const deltaX = point.x - cupSurface.center.x;
  const deltaZ = point.z - cupSurface.center.z;
  const exclusionRadiusSq = cupSurface.exclusionRadiusMeters * cupSurface.exclusionRadiusMeters;
  if ((deltaX * deltaX) + (deltaZ * deltaZ) > exclusionRadiusSq) {
    return surfaceSample;
  }

  projectPreviewSampleOntoCupSurface(point, cupSurface, PREVIEW_CUP_SURFACE_POINT);
  if (surfaceSample.point.y >= PREVIEW_CUP_SURFACE_POINT.y - cupSurface.maxDepthMeters) {
    return surfaceSample;
  }

  return {
    distance: surfaceSample.distance,
    normal: cupSurface.normal.clone(),
    point: PREVIEW_CUP_SURFACE_POINT.clone(),
    verticalOffset: maxUpDistance - (PREVIEW_CUP_SURFACE_POINT.y - point.y),
  };
}

/**
 * Creates a reusable surface sampler for preview rendering that ignores the cup interior near the hole.
 */
export function createPreviewSurfaceSampler(viewerScene, holePosition = null) {
  const courseCollision = viewerScene?.courseCollision;
  const cupSurface = estimatePreviewCupSurface(courseCollision, holePosition);

  return (point, maxUpDistance = PUTT_PREVIEW_SURFACE_SAMPLE_UP_DISTANCE, maxDownDistance = PUTT_PREVIEW_SURFACE_SAMPLE_DOWN_DISTANCE) => (
    samplePreviewSurface(courseCollision, point, maxUpDistance, maxDownDistance, cupSurface)
  );
}

/**
 * Resolves a fixed putt-grid row count from a preview distance while keeping the same cell depth.
 */
export function resolvePuttPreviewRowCount(previewDistanceMeters) {
  if (!Number.isFinite(previewDistanceMeters) || previewDistanceMeters <= 0) {
    return PUTT_PREVIEW_GRID_DEFAULT_ROWS;
  }

  return THREE.MathUtils.clamp(
    Math.ceil(previewDistanceMeters / PUTT_PREVIEW_CELL_DEPTH_METERS),
    PUTT_PREVIEW_GRID_DEFAULT_ROWS,
    PUTT_PREVIEW_GRID_MAX_ROWS,
  );
}

/**
 * Resolves the putt-grid layout for a caller-provided row count.
 */
function resolvePuttPreviewLayout(rowCount = PUTT_PREVIEW_GRID_DEFAULT_ROWS) {
  const clampedRowCount = THREE.MathUtils.clamp(
    Math.round(rowCount),
    PUTT_PREVIEW_GRID_DEFAULT_ROWS,
    PUTT_PREVIEW_GRID_MAX_ROWS,
  );

  return {
    cellDepthMeters: PUTT_PREVIEW_CELL_DEPTH_METERS,
    rowCount: clampedRowCount,
  };
}

/**
 * Resolves orthogonal grid axes that preserve the gameplay aim direction while staying tangent to the surface.
 */
function resolvePreviewGridAxes(referenceForward, supportNormal, forwardTarget, rightTarget) {
  if (referenceForward && referenceForward.lengthSq() > 1e-8) {
    forwardTarget.copy(referenceForward);
  } else {
    forwardTarget.set(0, 0, -1);
  }

  forwardTarget.addScaledVector(supportNormal, -forwardTarget.dot(supportNormal));
  if (forwardTarget.lengthSq() <= 1e-8) {
    forwardTarget.set(0, 0, -1).addScaledVector(
      supportNormal,
      -new THREE.Vector3(0, 0, -1).dot(supportNormal),
    );
  }
  if (forwardTarget.lengthSq() <= 1e-8) {
    return false;
  }

  forwardTarget.normalize();
  rightTarget.crossVectors(forwardTarget, supportNormal);
  if (rightTarget.lengthSq() <= 1e-8) {
    rightTarget.set(1, 0, 0);
  } else {
    rightTarget.normalize();
  }

  return true;
}

export function predictFirstContactPoint(viewerScene, startPosition, launchData, referenceForward = null) {
  if (!viewerScene?.courseCollision?.root || !startPosition || !launchData) {
    return null;
  }

  if (!Number.isFinite(launchData.ballSpeed) || launchData.ballSpeed <= 0) {
    return null;
  }

  PREVIEW_START_POSITION.copy(startPosition);
  PREVIEW_POSITION.copy(startPosition);
  buildLaunchVelocity(launchData, viewerScene, referenceForward, PREVIEW_VELOCITY);
  buildLaunchAngularVelocity(launchData, viewerScene, referenceForward, PREVIEW_ANGULAR_VELOCITY);
  let hasClearedLaunch = false;

  for (let stepIndex = 0; stepIndex < PREVIEW_MAX_STEPS; stepIndex += 1) {
    integrateAirborneState(PREVIEW_VELOCITY, PREVIEW_ANGULAR_VELOCITY, BALL_FIXED_STEP_SECONDS);
    PREVIEW_DISPLACEMENT.copy(PREVIEW_VELOCITY).multiplyScalar(BALL_FIXED_STEP_SECONDS);

    const sweep = sweepSphereBVH(viewerScene.courseCollision, PREVIEW_POSITION, PREVIEW_DISPLACEMENT, BALL_RADIUS, {
      ignoredSurfaceTypes: PREVIEW_IGNORED_SURFACE_TYPES,
      maxIterations: BALL_MAX_COLLISION_ITERATIONS,
      skin: BALL_COLLISION_SKIN,
    });
    PREVIEW_POSITION.copy(sweep.position);

    const isGroundLikeContact = sweep.collided && sweep.hitNormal.y >= BALL_GROUNDED_NORMAL_MIN_Y;
    if (sweep.collided && !hasClearedLaunch && isGroundLikeContact) {
      PREVIEW_POSITION.addScaledVector(PREVIEW_DISPLACEMENT, 1 - sweep.travelFraction);
    }

    const horizontalTravelMeters = Math.hypot(
      PREVIEW_POSITION.x - PREVIEW_START_POSITION.x,
      PREVIEW_POSITION.z - PREVIEW_START_POSITION.z,
    );
    if (
      !hasClearedLaunch
      && (
        PREVIEW_POSITION.y > PREVIEW_START_POSITION.y + PREVIEW_CLEARANCE_HEIGHT_METERS
        || horizontalTravelMeters >= PREVIEW_MIN_LANDING_TRAVEL_METERS
      )
    ) {
      hasClearedLaunch = true;
    }

    if (!sweep.collided) {
      continue;
    }

    if (!hasClearedLaunch && isGroundLikeContact) {
      continue;
    }

    const landingPoint = PREVIEW_FALLBACK_POINT
      .copy(PREVIEW_POSITION)
      .addScaledVector(sweep.hitNormal, -(BALL_RADIUS + BALL_COLLISION_SKIN))
      .clone();

    return {
      point: landingPoint,
      carryDistanceMeters: Math.hypot(landingPoint.x - startPosition.x, landingPoint.z - startPosition.z),
    };
  }

  const fallbackSupport = findGroundSupport(
    viewerScene.courseCollision,
    PREVIEW_POSITION,
    BALL_RADIUS,
    PREVIEW_FALLBACK_GROUND_SNAP_DISTANCE,
    { ignoredSurfaceTypes: PREVIEW_IGNORED_SURFACE_TYPES },
  );
  if (!fallbackSupport || fallbackSupport.normal.y < BALL_GROUNDED_NORMAL_MIN_Y) {
    return null;
  }

  PREVIEW_SUPPORT_FALLBACK.copy(fallbackSupport.point)
    .addScaledVector(fallbackSupport.normal, -(BALL_RADIUS + BALL_COLLISION_SKIN));
  return {
    point: PREVIEW_SUPPORT_FALLBACK.clone(),
    carryDistanceMeters: Math.hypot(
      PREVIEW_SUPPORT_FALLBACK.x - startPosition.x,
      PREVIEW_SUPPORT_FALLBACK.z - startPosition.z,
    ),
  };
}

/**
 * Samples a putt grid in front of the ball, keeping the largest fully sampled row prefix.
 */
export function buildPuttGridPreview(
  viewerScene,
  ballPosition,
  rowCount = PUTT_PREVIEW_GRID_DEFAULT_ROWS,
  referenceForward = null,
  holePosition = null,
) {
  if (!viewerScene?.courseCollision?.root || !ballPosition) {
    return null;
  }

  const { cellDepthMeters, rowCount: resolvedRowCount } = resolvePuttPreviewLayout(rowCount);
  const previewSurfaceSampler = createPreviewSurfaceSampler(viewerScene, holePosition);

  const groundSample = previewSurfaceSampler(
    PUTT_PREVIEW_SUPPORT_SAMPLE.copy(ballPosition),
    PUTT_PREVIEW_SURFACE_SAMPLE_UP_DISTANCE,
    PUTT_PREVIEW_SURFACE_SAMPLE_DOWN_DISTANCE,
  );
  const supportNormal = groundSample?.normal ?? PUTT_PREVIEW_FALLBACK_NORMAL;

  // Keep the grid aligned with gameplay aim while staying tangent to the sampled surface near the ball.
  if (!resolvePreviewGridAxes(referenceForward, supportNormal, PUTT_PREVIEW_FORWARD, PUTT_PREVIEW_RIGHT)) {
    return null;
  }

  const vertices = [];
  let completedRowCount = 0;
  for (let rowIndex = 0; rowIndex <= resolvedRowCount; rowIndex += 1) {
    const forwardOffset = rowIndex * cellDepthMeters;
    const rowVertices = [];
    for (let columnIndex = 0; columnIndex <= PUTT_PREVIEW_GRID_COLUMNS; columnIndex += 1) {
      const lateralOffset = (
        columnIndex - (PUTT_PREVIEW_GRID_COLUMNS * 0.5)
      ) * PUTT_PREVIEW_CELL_WIDTH_METERS;

      PUTT_PREVIEW_VERTEX_SAMPLE_POINT.copy(ballPosition)
        .addScaledVector(PUTT_PREVIEW_FORWARD, forwardOffset)
        .addScaledVector(PUTT_PREVIEW_RIGHT, lateralOffset);

      const surfaceSample = previewSurfaceSampler(
        PUTT_PREVIEW_VERTEX_SAMPLE_POINT,
        PUTT_PREVIEW_SURFACE_SAMPLE_UP_DISTANCE,
        PUTT_PREVIEW_SURFACE_SAMPLE_DOWN_DISTANCE,
      );
      if (!surfaceSample) {
        if (rowIndex === 0) {
          return null;
        }

        rowVertices.length = 0;
        break;
      }

      rowVertices.push({
        columnIndex,
        rowIndex,
        normal: surfaceSample.normal.clone(),
        point: surfaceSample.point.clone(),
      });
    }

    if (rowVertices.length !== PUTT_PREVIEW_GRID_COLUMNS + 1) {
      break;
    }

    vertices.push(...rowVertices);
    if (rowIndex > 0) {
      completedRowCount = rowIndex;
    }
  }

  const cells = [];
  for (let rowIndex = 0; rowIndex < completedRowCount; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < PUTT_PREVIEW_GRID_COLUMNS; columnIndex += 1) {
      const v00 = vertices[rowIndex * (PUTT_PREVIEW_GRID_COLUMNS + 1) + columnIndex];
      const v01 = vertices[rowIndex * (PUTT_PREVIEW_GRID_COLUMNS + 1) + columnIndex + 1];
      const v10 = vertices[(rowIndex + 1) * (PUTT_PREVIEW_GRID_COLUMNS + 1) + columnIndex];
      const v11 = vertices[(rowIndex + 1) * (PUTT_PREVIEW_GRID_COLUMNS + 1) + columnIndex + 1];

      const avgNormal = new THREE.Vector3()
        .add(v00.normal)
        .add(v01.normal)
        .add(v10.normal)
        .add(v11.normal)
        .normalize();

      const avgPoint = new THREE.Vector3()
        .add(v00.point)
        .add(v01.point)
        .add(v10.point)
        .add(v11.point)
        .multiplyScalar(0.25);

      cells.push({
        columnIndex,
        rowIndex,
        normal: avgNormal,
        point: avgPoint,
      });
    }
  }

  if (cells.length === 0) {
    return null;
  }

  return {
    cellDepthMeters,
    cellWidthMeters: PUTT_PREVIEW_CELL_WIDTH_METERS,
    columns: PUTT_PREVIEW_GRID_COLUMNS,
    vertices,
    forward: PUTT_PREVIEW_FORWARD.clone(),
    rows: completedRowCount,
    cells,
  };
}