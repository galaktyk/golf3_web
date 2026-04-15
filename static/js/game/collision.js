import * as THREE from 'three';
import { SURFACE_TYPES } from '/static/js/game/surfaceData.js';
import { getSurfaceTypeFromTextureName } from '/static/js/game/surfacePhysics.js';

const LEAF_TRIANGLE_COUNT = 12;
const MAX_BUILD_DEPTH = 32;
const LEAF_OPACITY_COLLISION_THRESHOLD = 0.3;
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const WORLD_DOWN = new THREE.Vector3(0, -1, 0);
const WORKING_CENTROID_SIZE = new THREE.Vector3();
const WORKING_CLOSEST_POINT = new THREE.Vector3();
const WORKING_LEFT_CENTER = new THREE.Vector3();
const WORKING_RIGHT_CENTER = new THREE.Vector3();
const WORKING_RAY_POINT = new THREE.Vector3();
const WORKING_ALPHA_SAMPLE_POINT = new THREE.Vector3();
const WORKING_BARYCOORD = new THREE.Vector3();
const WORKING_UV = new THREE.Vector2();
const RAYCAST_NORMAL = new THREE.Vector3();
const SURFACE_SAMPLE_ORIGIN = new THREE.Vector3();
const SURFACE_SAMPLE_DIRECTION = new THREE.Vector3(0, -1, 0);
const OPACITY_IMAGE_DATA_CACHE = new WeakMap();

export function buildCourseCollision(mapRoot) {
  mapRoot.updateWorldMatrix(true, true);

  const triangles = [];
  let meshCount = 0;

  mapRoot.traverse((node) => {
    if (!node.isMesh || !node.geometry || node.isSkinnedMesh || node.userData.excludeCourseCollision) {
      return;
    }

    const positionAttribute = node.geometry.getAttribute('position');
    if (!positionAttribute) {
      return;
    }

    const index = node.geometry.getIndex();
    const uvAttribute = node.geometry.getAttribute('uv');
    const triangleCount = index ? index.count / 3 : positionAttribute.count / 3;

    if (!triangleCount) {
      return;
    }

    meshCount += 1;

    for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
      // Find material and texture info
      let materialIndex = 0;
      if (node.geometry.groups && node.geometry.groups.length > 0) {
        const elementIndex = triangleIndex * 3;
        for (const group of node.geometry.groups) {
          if (elementIndex >= group.start && elementIndex < group.start + group.count) {
            materialIndex = group.materialIndex ?? 0;
            break;
          }
        }
      }

      let textureName = null;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      const triangleMaterial = materials[materialIndex];
      if (triangleMaterial) {
        textureName = triangleMaterial.map?.name
          || triangleMaterial.map?.image?.currentSrc
          || triangleMaterial.map?.image?.src
          || triangleMaterial.name;
      }
      const surfaceType = getSurfaceTypeFromTextureName(textureName);
      const opacityTexture = surfaceType === SURFACE_TYPES.LEAF
        ? (triangleMaterial?.alphaMap ?? triangleMaterial?.map ?? null)
        : null;
      const opacityChannel = triangleMaterial?.alphaMap ? 'green' : 'alpha';
      const opacityThreshold = surfaceType === SURFACE_TYPES.LEAF
        ? Math.max(triangleMaterial?.alphaTest ?? 0, LEAF_OPACITY_COLLISION_THRESHOLD)
        : 0;

      const aIndex = index ? index.getX(triangleIndex * 3) : triangleIndex * 3;
      const bIndex = index ? index.getX(triangleIndex * 3 + 1) : triangleIndex * 3 + 1;
      const cIndex = index ? index.getX(triangleIndex * 3 + 2) : triangleIndex * 3 + 2;

      const a = new THREE.Vector3().fromBufferAttribute(positionAttribute, aIndex).applyMatrix4(node.matrixWorld);
      const b = new THREE.Vector3().fromBufferAttribute(positionAttribute, bIndex).applyMatrix4(node.matrixWorld);
      const c = new THREE.Vector3().fromBufferAttribute(positionAttribute, cIndex).applyMatrix4(node.matrixWorld);
      const triangle = new THREE.Triangle(a, b, c);

      if (triangle.getArea() <= Number.EPSILON) {
        continue;
      }

      const normal = triangle.getNormal(new THREE.Vector3());
      const bounds = new THREE.Box3().setFromPoints([a, b, c]);
      const centroid = a.clone().add(b).add(c).multiplyScalar(1 / 3);
      const uvA = uvAttribute ? new THREE.Vector2().fromBufferAttribute(uvAttribute, aIndex) : null;
      const uvB = uvAttribute ? new THREE.Vector2().fromBufferAttribute(uvAttribute, bIndex) : null;
      const uvC = uvAttribute ? new THREE.Vector2().fromBufferAttribute(uvAttribute, cIndex) : null;

      triangles.push({
        bounds,
        centroid,
        normal,
        opacityChannel,
        opacityTexture,
        opacityThreshold,
        surfaceType,
        triangle,
        uvA,
        uvB,
        uvC,
      });
    }
  });

  const root = triangles.length > 0 ? buildNode(triangles, 0) : null;

  return {
    bounds: root ? root.bounds.clone() : new THREE.Box3(),
    meshCount,
    root,
    triangleCount: triangles.length,
  };
}

export function sweepSphereBVH(courseCollision, start, displacement, radius, options = {}) {
  const nextPosition = start.clone();
  const hitNormal = new THREE.Vector3(0, 1, 0);
  const root = courseCollision?.root;
  const skin = options.skin ?? 0.001;
  const maxIterations = options.maxIterations ?? 4;
  const ignoredSurfaceTypes = options.ignoredSurfaceTypes ?? null;

  if (!root) {
    nextPosition.add(displacement);
    return {
      collided: false,
      hitNormal,
      position: nextPosition,
      surfaceType: null,
      travelFraction: 1,
    };
  }

  resolveSpherePenetration(root, nextPosition, radius, skin, maxIterations, ignoredSurfaceTypes);

  if (displacement.lengthSq() === 0) {
    return {
      collided: false,
      hitNormal,
      position: nextPosition,
      surfaceType: null,
      travelFraction: 1,
    };
  }

  const sweepRadius = radius + skin;
  const sweepEnd = nextPosition.clone().add(displacement);
  const sweptBounds = new THREE.Box3().setFromPoints([nextPosition, sweepEnd]).expandByScalar(sweepRadius);
  const hit = sweepSphereNode(root, nextPosition, displacement, sweepRadius, sweptBounds, null, ignoredSurfaceTypes);

  if (!hit) {
    nextPosition.copy(sweepEnd);
    return {
      collided: false,
      hitNormal,
      position: nextPosition,
      surfaceType: null,
      travelFraction: 1,
    };
  }

  nextPosition.addScaledVector(displacement, hit.time);
  hitNormal.copy(hit.normal);

  return {
    collided: true,
    hitNormal,
    position: nextPosition,
    surfaceType: hit.surfaceType,
    travelFraction: hit.time,
  };
}

export function resolveSphereOverlapBVH(courseCollision, center, radius, options = {}) {
  const root = courseCollision?.root;
  const position = center.clone();
  const hitNormal = new THREE.Vector3(0, 1, 0);

  if (!root) {
    return {
      collided: false,
      hitNormal,
      position,
    };
  }

  const skin = options.skin ?? 0.001;
  const maxIterations = options.maxIterations ?? 4;
  const resolution = resolveSpherePenetration(root, position, radius, skin, maxIterations);

  if (resolution.collided) {
    hitNormal.copy(resolution.hitNormal);
  }

  return {
    collided: resolution.collided,
    hitNormal,
    position,
    surfaceType: resolution.surfaceType ?? null,
  };
}

export function findGroundSupport(courseCollision, center, radius, maxSnapDistance, options = {}) {
  const root = courseCollision?.root;
  if (!root) {
    return null;
  }

  const ignoredSurfaceTypes = options.ignoredSurfaceTypes ?? null;
  const rayOrigin = center.clone().addScaledVector(WORLD_UP, maxSnapDistance);
  const maxDistance = radius + maxSnapDistance * 2;
  const ray = new THREE.Ray(rayOrigin, WORLD_DOWN);
  const hit = raycastNode(root, ray, maxDistance, null, ignoredSurfaceTypes);

  if (!hit) {
    return null;
  }

  const normal = hit.normal.clone();
  if (normal.y < 0) {
    normal.negate();
  }

  return {
    distance: hit.distance,
    normal,
    point: hit.point.clone(),
    separation: hit.distance - maxSnapDistance - radius,
    surfaceType: hit.surfaceType,
  };
}

/**
 * Samples the course directly beneath a world-space point by raycasting downward through the BVH.
 */
export function sampleCourseSurface(courseCollision, point, maxUpDistance = 2, maxDownDistance = 20, options = {}) {
  const root = courseCollision?.root;
  if (!root || !point) {
    return null;
  }

  const ignoredSurfaceTypes = options.ignoredSurfaceTypes ?? null;
  const upwardDistance = Math.max(maxUpDistance, 0);
  const downwardDistance = Math.max(maxDownDistance, 0);
  const maxDistance = upwardDistance + downwardDistance;
  if (maxDistance <= 1e-6) {
    return null;
  }

  SURFACE_SAMPLE_ORIGIN.copy(point).addScaledVector(WORLD_UP, upwardDistance);
  const ray = new THREE.Ray(SURFACE_SAMPLE_ORIGIN, SURFACE_SAMPLE_DIRECTION);
  const hit = raycastNode(root, ray, maxDistance, null, ignoredSurfaceTypes);
  if (!hit) {
    return null;
  }

  const normal = hit.normal.clone();
  if (normal.y < 0) {
    normal.negate();
  }

  return {
    distance: hit.distance,
    normal,
    point: hit.point.clone(),
    verticalOffset: upwardDistance - hit.distance,
    surfaceType: hit.surfaceType,
  };
}

/**
 * Raycasts the course BVH with a world-space ray and returns the nearest surface hit.
 */
export function raycastCourseSurface(courseCollision, ray, maxDistance = Infinity, options = {}) {
  const root = courseCollision?.root;
  if (!root || !ray) {
    return null;
  }

  const ignoredSurfaceTypes = options.ignoredSurfaceTypes ?? null;
  const resolvedMaxDistance = Number.isFinite(maxDistance) && maxDistance > 0
    ? maxDistance
    : Infinity;
  const hit = raycastNode(root, ray, resolvedMaxDistance, null, ignoredSurfaceTypes);
  if (!hit) {
    return null;
  }

  const normal = hit.normal.clone();
  if (normal.y < 0) {
    normal.negate();
  }

  return {
    distance: hit.distance,
    normal,
    point: hit.point.clone(),
    surfaceType: hit.surfaceType,
  };
}

function buildNode(triangles, depth) {
  const bounds = computeTriangleBounds(triangles);
  if (triangles.length <= LEAF_TRIANGLE_COUNT || depth >= MAX_BUILD_DEPTH) {
    return { bounds, triangles };
  }

  const centroidBounds = new THREE.Box3();
  for (const triangleRecord of triangles) {
    centroidBounds.expandByPoint(triangleRecord.centroid);
  }

  centroidBounds.getSize(WORKING_CENTROID_SIZE);
  const splitAxis = longestAxisIndex(WORKING_CENTROID_SIZE);

  if (WORKING_CENTROID_SIZE.getComponent(splitAxis) <= 1e-6) {
    return { bounds, triangles };
  }

  const sortedTriangles = triangles.slice().sort(
    (left, right) => left.centroid.getComponent(splitAxis) - right.centroid.getComponent(splitAxis),
  );
  const midpoint = Math.floor(sortedTriangles.length / 2);

  return {
    bounds,
    left: buildNode(sortedTriangles.slice(0, midpoint), depth + 1),
    right: buildNode(sortedTriangles.slice(midpoint), depth + 1),
  };
}

function computeTriangleBounds(triangles) {
  const bounds = new THREE.Box3();
  for (const triangleRecord of triangles) {
    bounds.union(triangleRecord.bounds);
  }
  return bounds;
}

function longestAxisIndex(vector) {
  if (vector.x >= vector.y && vector.x >= vector.z) {
    return 0;
  }

  if (vector.y >= vector.z) {
    return 1;
  }

  return 2;
}

function resolveSpherePenetration(root, center, radius, skin, maxIterations, ignoredSurfaceTypes = null) {
  const hitNormal = new THREE.Vector3();
  let collided = false;
  let lastSurfaceType = null;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const nearestHit = findNearestTrianglePoint(root, center, radius + skin, {
      distanceSq: Infinity,
      normal: null,
      point: null,
      surfaceType: null,
    }, ignoredSurfaceTypes);

    if (!nearestHit || nearestHit.point === null) {
      break;
    }

    const distance = Math.sqrt(nearestHit.distanceSq);
    if (distance >= radius - skin) {
      break;
    }

    const separationNormal = center.clone().sub(nearestHit.point);
    if (separationNormal.lengthSq() > 1e-10) {
      separationNormal.normalize();
    } else {
      separationNormal.copy(nearestHit.normal ?? WORLD_UP);
    }

    center.addScaledVector(separationNormal, radius - distance + skin);
    hitNormal.add(separationNormal);
    collided = true;
    lastSurfaceType = nearestHit.surfaceType;
  }

  if (!collided) {
    return { collided: false, hitNormal, surfaceType: null };
  }

  if (hitNormal.lengthSq() === 0) {
    hitNormal.copy(WORLD_UP);
  } else {
    hitNormal.normalize();
  }

  return { collided: true, hitNormal, surfaceType: lastSurfaceType };
}

function sweepSphereNode(node, start, displacement, radius, sweptBounds, bestHit, ignoredSurfaceTypes = null) {
  if (!node || !node.bounds.intersectsBox(sweptBounds)) {
    return bestHit;
  }

  if (node.triangles) {
    for (const triangleRecord of node.triangles) {
      if (shouldIgnoreSurfaceType(triangleRecord.surfaceType, ignoredSurfaceTypes)) {
        continue;
      }

      if (!triangleRecord.bounds.intersectsBox(sweptBounds)) {
        continue;
      }

      const triangleHit = sweepSphereTriangle(start, displacement, radius, triangleRecord, bestHit?.time ?? Infinity);
      if (!triangleHit || (bestHit && triangleHit.time >= bestHit.time)) {
        continue;
      }

      bestHit = triangleHit;
    }

    return bestHit;
  }

  const leftDistanceSq = distanceSqToBox(start, node.left.bounds);
  const rightDistanceSq = distanceSqToBox(start, node.right.bounds);
  const firstChild = leftDistanceSq <= rightDistanceSq ? node.left : node.right;
  const secondChild = firstChild === node.left ? node.right : node.left;

  bestHit = sweepSphereNode(firstChild, start, displacement, radius, sweptBounds, bestHit, ignoredSurfaceTypes);
  bestHit = sweepSphereNode(secondChild, start, displacement, radius, sweptBounds, bestHit, ignoredSurfaceTypes);
  return bestHit;
}

function sweepSphereTriangle(start, displacement, radius, triangleRecord, maxTime) {
  const triangle = triangleRecord.triangle;
  const directionLength = displacement.length();
  const closestPoint = triangle.closestPointToPoint(start, new THREE.Vector3());
  const startDistanceSq = start.distanceToSquared(closestPoint);

  if (startDistanceSq <= radius * radius) {
    if (!isTriangleCollisionPointOpaque(triangleRecord, closestPoint)) {
      return null;
    }

    const overlapNormal = start.clone().sub(closestPoint);
    if (overlapNormal.lengthSq() <= 1e-10) {
      overlapNormal.copy(orientNormalAgainstMotion(triangleRecord.normal, displacement));
    } else {
      overlapNormal.normalize();
    }

    if (displacement.dot(overlapNormal) < -1e-6) {
      return {
        normal: overlapNormal,
        surfaceType: triangleRecord.surfaceType,
        time: 0,
      };
    }
  }

  if (directionLength <= 1e-8) {
    return null;
  }

  const direction = displacement.clone().divideScalar(directionLength);
  const maxDistance = Math.min(maxTime * directionLength, directionLength);
  let bestDistance = Infinity;
  let bestNormal = null;

  const faceHit = intersectSweptSphereTriangleFace(start, direction, maxDistance, radius, triangleRecord);
  if (faceHit) {
    bestDistance = faceHit.distance;
    bestNormal = faceHit.normal;
  }

  const edgeHits = [
    intersectRayCapsule(start, direction, maxDistance, triangle.a, triangle.b, radius),
    intersectRayCapsule(start, direction, maxDistance, triangle.b, triangle.c, radius),
    intersectRayCapsule(start, direction, maxDistance, triangle.c, triangle.a, radius),
  ];

  for (const edgeHit of edgeHits) {
    if (!edgeHit || edgeHit.distance >= bestDistance) {
      continue;
    }

    triangle.closestPointToPoint(edgeHit.hitPoint, WORKING_ALPHA_SAMPLE_POINT);
    if (!isTriangleCollisionPointOpaque(triangleRecord, WORKING_ALPHA_SAMPLE_POINT)) {
      continue;
    }

    bestDistance = edgeHit.distance;
    bestNormal = edgeHit.normal;
  }

  if (bestNormal === null || bestDistance > maxDistance) {
    return null;
  }

  return {
    normal: bestNormal,
    time: bestDistance / directionLength,
    surfaceType: triangleRecord.surfaceType,
  };
}

function intersectSweptSphereTriangleFace(start, direction, maxDistance, radius, triangleRecord) {
  const triangle = triangleRecord.triangle;
  const planeNormal = triangleRecord.normal;
  const startDistance = planeNormal.dot(start) - planeNormal.dot(triangle.a);
  const directionDotNormal = planeNormal.dot(direction);

  if (Math.abs(directionDotNormal) <= 1e-8) {
    return null;
  }

  // Do not collide if moving away from the front/back face respectively
  if (startDistance >= 0 && directionDotNormal >= 0) {
    return null;
  }
  
  if (startDistance < 0 && directionDotNormal <= 0) {
    return null;
  }

  const targetDistance = startDistance >= 0 ? radius : -radius;
  const hitDistance = (targetDistance - startDistance) / directionDotNormal;

  if (hitDistance < 0 || hitDistance > maxDistance) {
    return null;
  }

  const hitCenter = start.clone().addScaledVector(direction, hitDistance);
  const contactPoint = hitCenter.clone().addScaledVector(planeNormal, -targetDistance);
  if (!triangle.containsPoint(contactPoint)) {
    return null;
  }

  if (!isTriangleCollisionPointOpaque(triangleRecord, contactPoint)) {
    return null;
  }

  return {
    distance: hitDistance,
    normal: orientNormalAgainstMotion(planeNormal.clone().multiplyScalar(Math.sign(targetDistance) || 1), direction),
  };
}

function intersectRayCapsule(origin, direction, maxDistance, start, end, radius) {
  const axis = end.clone().sub(start);
  if (axis.lengthSq() <= 1e-10) {
    return intersectRaySphere(origin, direction, maxDistance, start, radius);
  }

  const offset = origin.clone().sub(start);
  const axisLengthSq = axis.lengthSq();
  const axisDotDirection = axis.dot(direction);
  const axisDotOffset = axis.dot(offset);
  const directionDotOffset = direction.dot(offset);
  const offsetLengthSq = offset.lengthSq();
  const quadraticA = axisLengthSq - axisDotDirection * axisDotDirection;
  const quadraticB = axisLengthSq * directionDotOffset - axisDotOffset * axisDotDirection;
  const quadraticC = axisLengthSq * offsetLengthSq - axisDotOffset * axisDotOffset - radius * radius * axisLengthSq;

  let bestHit = null;

  if (Math.abs(quadraticA) > 1e-8) {
    const discriminant = quadraticB * quadraticB - quadraticA * quadraticC;
    if (discriminant >= 0) {
      const hitDistance = (-quadraticB - Math.sqrt(discriminant)) / quadraticA;
      const axisPosition = axisDotOffset + hitDistance * axisDotDirection;
      if (hitDistance >= 0 && hitDistance <= maxDistance && axisPosition > 0 && axisPosition < axisLengthSq) {
        const hitPoint = origin.clone().addScaledVector(direction, hitDistance);
        const closestPoint = start.clone().addScaledVector(axis, axisPosition / axisLengthSq);
        bestHit = {
          distance: hitDistance,
          hitPoint: hitPoint.clone(),
          normal: hitPoint.sub(closestPoint).normalize(),
        };
      }
    }
  }

  const sphereHits = [
    intersectRaySphere(origin, direction, maxDistance, start, radius),
    intersectRaySphere(origin, direction, maxDistance, end, radius),
  ];

  for (const sphereHit of sphereHits) {
    if (!sphereHit || (bestHit && sphereHit.distance >= bestHit.distance)) {
      continue;
    }

    bestHit = sphereHit;
  }

  return bestHit;
}

function intersectRaySphere(origin, direction, maxDistance, center, radius) {
  const offset = origin.clone().sub(center);
  const b = offset.dot(direction);
  const c = offset.lengthSq() - radius * radius;
  const discriminant = b * b - c;

  if (discriminant < 0) {
    return null;
  }

  const hitDistance = -b - Math.sqrt(discriminant);
  if (hitDistance < 0 || hitDistance > maxDistance) {
    return null;
  }

  const hitPoint = origin.clone().addScaledVector(direction, hitDistance);
  return {
    distance: hitDistance,
    hitPoint,
    normal: hitPoint.clone().sub(center).normalize(),
  };
}

function orientNormalAgainstMotion(normal, motion) {
  const orientedNormal = normal.clone();
  if (orientedNormal.dot(motion) > 0) {
    orientedNormal.negate();
  }

  return orientedNormal;
}

function findNearestTrianglePoint(node, point, maxDistance, bestHit, ignoredSurfaceTypes = null) {
  if (!node) {
    return bestHit;
  }

  const maxDistanceSq = maxDistance * maxDistance;
  const nodeDistanceSq = distanceSqToBox(point, node.bounds);
  if (nodeDistanceSq > maxDistanceSq || nodeDistanceSq > bestHit.distanceSq) {
    return bestHit;
  }

  if (node.triangles) {
    for (const triangleRecord of node.triangles) {
      if (shouldIgnoreSurfaceType(triangleRecord.surfaceType, ignoredSurfaceTypes)) {
        continue;
      }

      triangleRecord.triangle.closestPointToPoint(point, WORKING_CLOSEST_POINT);
      if (!isTriangleCollisionPointOpaque(triangleRecord, WORKING_CLOSEST_POINT)) {
        continue;
      }

      const distanceSq = point.distanceToSquared(WORKING_CLOSEST_POINT);

      if (distanceSq >= bestHit.distanceSq || distanceSq > maxDistanceSq) {
        continue;
      }

      bestHit.distanceSq = distanceSq;
      bestHit.normal = triangleRecord.normal;
      bestHit.point = WORKING_CLOSEST_POINT.clone();
      bestHit.surfaceType = triangleRecord.surfaceType;
    }

    return bestHit;
  }

  const leftDistanceSq = distanceSqToBox(point, node.left.bounds);
  const rightDistanceSq = distanceSqToBox(point, node.right.bounds);
  const firstChild = leftDistanceSq <= rightDistanceSq ? node.left : node.right;
  const secondChild = firstChild === node.left ? node.right : node.left;

  findNearestTrianglePoint(firstChild, point, maxDistance, bestHit, ignoredSurfaceTypes);
  findNearestTrianglePoint(secondChild, point, maxDistance, bestHit, ignoredSurfaceTypes);
  return bestHit;
}

function shouldIgnoreSurfaceType(surfaceType, ignoredSurfaceTypes) {
  if (!ignoredSurfaceTypes || ignoredSurfaceTypes.length === 0) {
    return false;
  }

  return ignoredSurfaceTypes.includes(surfaceType);
}

function distanceSqToBox(point, bounds) {
  let distanceSq = 0;

  if (point.x < bounds.min.x) {
    const delta = bounds.min.x - point.x;
    distanceSq += delta * delta;
  } else if (point.x > bounds.max.x) {
    const delta = point.x - bounds.max.x;
    distanceSq += delta * delta;
  }

  if (point.y < bounds.min.y) {
    const delta = bounds.min.y - point.y;
    distanceSq += delta * delta;
  } else if (point.y > bounds.max.y) {
    const delta = point.y - bounds.max.y;
    distanceSq += delta * delta;
  }

  if (point.z < bounds.min.z) {
    const delta = bounds.min.z - point.z;
    distanceSq += delta * delta;
  } else if (point.z > bounds.max.z) {
    const delta = point.z - bounds.max.z;
    distanceSq += delta * delta;
  }

  return distanceSq;
}

function raycastNode(node, ray, maxDistance, bestHit, ignoredSurfaceTypes = null) {
  if (!node || !ray.intersectsBox(node.bounds)) {
    return bestHit;
  }

  if (node.triangles) {
    for (const triangleRecord of node.triangles) {
      if (shouldIgnoreSurfaceType(triangleRecord.surfaceType, ignoredSurfaceTypes)) {
        continue;
      }

      const hitPoint = ray.intersectTriangle(
        triangleRecord.triangle.a,
        triangleRecord.triangle.b,
        triangleRecord.triangle.c,
        false,
        WORKING_RAY_POINT,
      );

      if (!hitPoint) {
        continue;
      }

      if (!isTriangleCollisionPointOpaque(triangleRecord, hitPoint)) {
        continue;
      }

      const hitDistance = ray.origin.distanceTo(hitPoint);
      if (hitDistance > maxDistance || (bestHit && hitDistance >= bestHit.distance)) {
        continue;
      }

      RAYCAST_NORMAL.copy(triangleRecord.normal);
      if (RAYCAST_NORMAL.dot(ray.direction) > 0) {
        RAYCAST_NORMAL.negate();
      }

      bestHit = {
        distance: hitDistance,
        normal: RAYCAST_NORMAL.clone(),
        point: hitPoint.clone(),
        surfaceType: triangleRecord.surfaceType,
      };
    }

    return bestHit;
  }

  const leftCenter = node.left.bounds.getCenter(WORKING_LEFT_CENTER);
  const rightCenter = node.right.bounds.getCenter(WORKING_RIGHT_CENTER);
  const leftDistance = leftCenter.distanceToSquared(ray.origin);
  const rightDistance = rightCenter.distanceToSquared(ray.origin);
  const firstChild = leftDistance <= rightDistance ? node.left : node.right;
  const secondChild = firstChild === node.left ? node.right : node.left;

  bestHit = raycastNode(firstChild, ray, maxDistance, bestHit, ignoredSurfaceTypes);
  bestHit = raycastNode(secondChild, ray, maxDistance, bestHit, ignoredSurfaceTypes);
  return bestHit;
}

/**
 * Rejects collision hits on transparent texels for alpha-cut leaf textures.
 */
function isTriangleCollisionPointOpaque(triangleRecord, point) {
  if (!triangleRecord || triangleRecord.surfaceType !== SURFACE_TYPES.LEAF) {
    return true;
  }

  if (!triangleRecord.opacityTexture || !triangleRecord.uvA || !triangleRecord.uvB || !triangleRecord.uvC) {
    return true;
  }

  const opacity = sampleTriangleOpacity(triangleRecord, point);
  if (opacity === null) {
    return true;
  }

  return opacity >= triangleRecord.opacityThreshold;
}

function sampleTriangleOpacity(triangleRecord, point) {
  triangleRecord.triangle.getBarycoord(point, WORKING_BARYCOORD);
  if (!Number.isFinite(WORKING_BARYCOORD.x) || !Number.isFinite(WORKING_BARYCOORD.y) || !Number.isFinite(WORKING_BARYCOORD.z)) {
    return null;
  }

  WORKING_UV.set(
    (triangleRecord.uvA.x * WORKING_BARYCOORD.x)
      + (triangleRecord.uvB.x * WORKING_BARYCOORD.y)
      + (triangleRecord.uvC.x * WORKING_BARYCOORD.z),
    (triangleRecord.uvA.y * WORKING_BARYCOORD.x)
      + (triangleRecord.uvB.y * WORKING_BARYCOORD.y)
      + (triangleRecord.uvC.y * WORKING_BARYCOORD.z),
  );

  const texture = triangleRecord.opacityTexture;
  texture.updateMatrix();
  texture.transformUv(WORKING_UV);

  const imageData = getTextureImageData(texture);
  if (!imageData) {
    return null;
  }

  const pixelX = THREE.MathUtils.clamp(Math.round(WORKING_UV.x * (imageData.width - 1)), 0, imageData.width - 1);
  const pixelY = THREE.MathUtils.clamp(Math.round(WORKING_UV.y * (imageData.height - 1)), 0, imageData.height - 1);
  const pixelIndex = ((pixelY * imageData.width) + pixelX) * 4;

  if (triangleRecord.opacityChannel === 'green') {
    return imageData.data[pixelIndex + 1] / 255;
  }

  return imageData.data[pixelIndex + 3] / 255;
}

function getTextureImageData(texture) {
  const image = texture?.image;
  if (!image) {
    return null;
  }

  const cachedImageData = OPACITY_IMAGE_DATA_CACHE.get(image);
  if (cachedImageData) {
    return cachedImageData;
  }

  const width = image.naturalWidth ?? image.videoWidth ?? image.width ?? 0;
  const height = image.naturalHeight ?? image.videoHeight ?? image.height ?? 0;
  if (!width || !height) {
    return null;
  }

  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      return null;
    }

    context.drawImage(image, 0, 0, width, height);
    const imageData = context.getImageData(0, 0, width, height);
    OPACITY_IMAGE_DATA_CACHE.set(image, imageData);
    return imageData;
  } catch (error) {
    console.warn('[collision] Failed to sample texture opacity for collision.', error);
    return null;
  }
}