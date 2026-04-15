import * as THREE from 'three';


const TRAIL_SAMPLE_LIFETIME_SECONDS = 20.5;
const TRAIL_MIN_SAMPLE_DISTANCE = 0.018;
const TRAIL_MAX_SAMPLE_INTERVAL_SECONDS = 1 / 120;
const TRAIL_BASE_OPACITY = 0.68;
const TRAIL_RADIUS_SCALE = 0.74;
const TRAIL_MIN_POINT_DISTANCE = 0.001;
const TRAIL_TUBULAR_SEGMENTS_PER_SPAN = 3;
const TRAIL_RADIAL_SEGMENTS = 10;
const TRAIL_FADE_TEXTURE_WIDTH = 256;
const POINT_DISTANCE = new THREE.Vector3();

export function createBallTrail(ballRadius) {
  const root = new THREE.Group();
  const sampleDistanceSquared = TRAIL_MIN_SAMPLE_DISTANCE * TRAIL_MIN_SAMPLE_DISTANCE;
  const samples = [];
  const curvePoints = [];
  const lastSamplePosition = new THREE.Vector3();
  const currentPosition = new THREE.Vector3();
  const tailFadeTexture = createTailFadeTexture();
  const trailMaterial = new THREE.MeshBasicMaterial({
    color: '#ffffff',
    transparent: true,
    opacity: 0,
    depthWrite: false,
    alphaMap: tailFadeTexture,
    toneMapped: false,
    blending: THREE.NormalBlending,
    premultipliedAlpha: true,
  });
  const trailMesh = new THREE.Mesh(new THREE.BufferGeometry(), trailMaterial);
  let hasLastSample = false;
  let hasCurrentPosition = false;
  let timeSinceLastSample = 0;

  root.name = 'ball-trail';
  trailMesh.visible = false;
  root.add(trailMesh);

  return {
    root,

    reset() {
      samples.length = 0;
      curvePoints.length = 0;
      timeSinceLastSample = 0;
      hasLastSample = false;
      hasCurrentPosition = false;
      updateMesh();
    },

    update(position, telemetry, deltaSeconds) {
      currentPosition.copy(position);
      hasCurrentPosition = true;
      timeSinceLastSample += deltaSeconds;
      ageSamples(deltaSeconds);

      const isBallInShot = telemetry.phase === 'moving';
      const shouldForceRestSample = telemetry.movementState === 'rest' && hasLastSample
        && lastSamplePosition.distanceToSquared(position) > 1e-8;

      if (isBallInShot && (shouldCaptureSample(position) || shouldForceRestSample)) {
        captureSample(position);
      }

      updateMesh();
    },
  };

  function shouldCaptureSample(position) {
    if (!hasLastSample) {
      return true;
    }

    return lastSamplePosition.distanceToSquared(position) >= sampleDistanceSquared
      || timeSinceLastSample >= TRAIL_MAX_SAMPLE_INTERVAL_SECONDS;
  }

  function captureSample(position) {
    samples.unshift({
      age: 0,
      position: position.clone(),
    });


    lastSamplePosition.copy(position);
    hasLastSample = true;
    timeSinceLastSample = 0;
  }

  function ageSamples(deltaSeconds) {
    for (let index = samples.length - 1; index >= 0; index -= 1) {
      const sample = samples[index];
      sample.age += deltaSeconds;
      if (sample.age >= TRAIL_SAMPLE_LIFETIME_SECONDS) {
        samples.splice(index, 1);
      }
    }
  }

  function updateMesh() {
    if (!hasCurrentPosition) {
      trailMesh.visible = false;
      return;
    }

    rebuildCurvePoints();

    if (curvePoints.length < 2) {
      trailMesh.visible = false;
      return;
    }

    const oldestSample = samples[samples.length - 1] ?? null;
    const oldestAgeAlpha = oldestSample
      ? Math.max(1 - (oldestSample.age / TRAIL_SAMPLE_LIFETIME_SECONDS), 0)
      : 1;
    const opacity = TRAIL_BASE_OPACITY * oldestAgeAlpha;
    const tubularSegments = Math.max((curvePoints.length - 1) * TRAIL_TUBULAR_SEGMENTS_PER_SPAN, 6);
    const nextGeometry = new THREE.TubeGeometry(
      new THREE.CatmullRomCurve3(curvePoints, false, 'centripetal'),
      tubularSegments,
      ballRadius * TRAIL_RADIUS_SCALE,
      TRAIL_RADIAL_SEGMENTS,
      false,
    );

    trailMesh.geometry.dispose();
    trailMesh.geometry = nextGeometry;
    trailMesh.material.opacity = opacity;
    trailMesh.visible = opacity > 0.01;
  }

  function rebuildCurvePoints() {
    curvePoints.length = 0;

    for (let index = samples.length - 1; index >= 0; index -= 1) {
      pushCurvePoint(samples[index].position);
    }

    pushCurvePoint(currentPosition);
  }

  function pushCurvePoint(position) {
    const lastPoint = curvePoints[curvePoints.length - 1];
    if (lastPoint) {
      POINT_DISTANCE.subVectors(position, lastPoint);
      if (POINT_DISTANCE.lengthSq() <= TRAIL_MIN_POINT_DISTANCE * TRAIL_MIN_POINT_DISTANCE) {
        return;
      }
    }

    curvePoints.push(position.clone());
  }
}

function createTailFadeTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = TRAIL_FADE_TEXTURE_WIDTH;
  canvas.height = 1;

  const context = canvas.getContext('2d');
  const gradient = context.createLinearGradient(0, 0, canvas.width, 0);
  gradient.addColorStop(0, 'rgb(0, 0, 0)');
  gradient.addColorStop(0.18, 'rgb(20, 20, 20)');
  gradient.addColorStop(0.45, 'rgb(115, 115, 115)');
  gradient.addColorStop(1, 'rgb(255, 255, 255)');
  context.fillStyle = gradient;

  context.fillRect(0, 0, canvas.width, canvas.height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}