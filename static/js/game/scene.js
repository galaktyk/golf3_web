import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { findGroundSupport, sampleCourseSurface } from '/static/js/game/collision.js';
import {
  AIMING_CAMERA_DISTANCE,
  AIMING_CAMERA_FOLLOW_STIFFNESS,
  AIMING_CAMERA_HEIGHT,
  AIMING_CAMERA_LOCAL_UP_OFFSET,
  BALL_RADIUS,
  BALL_START_POSITION,
  CAMERA_FOLLOW_STIFFNESS,
  CAMERA_LOOK_AHEAD_DISTANCE,
  CAMERA_START_DISTANCE,
  CAMERA_TILT_OFFSET_DEGREES,
  CHARACTER_SETUP_OFFSET,
  CHARACTER_VISUAL_YAW_OFFSET_DEGREES,
  FREE_CAMERA_LOOK_SENSITIVITY,
  FREE_CAMERA_MOVE_SPEED,
  FREE_CAMERA_PITCH_LIMIT_DEGREES,
  WORLD_FORWARD,
  MAX_RENDER_PIXEL_RATIO,
} from '/static/js/game/constants.js';

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const CAMERA_TILT_OFFSET_RADIANS = THREE.MathUtils.degToRad(CAMERA_TILT_OFFSET_DEGREES);
const FREE_CAMERA_PITCH_LIMIT_RADIANS = THREE.MathUtils.degToRad(FREE_CAMERA_PITCH_LIMIT_DEGREES);
const CHARACTER_GROUND_MIN_NORMAL_Y = 0.35;
const CHARACTER_GROUND_PROBE_DISTANCE = 3;
const CHARACTER_GROUND_PROBE_RADIUS = 0;
const CAMERA_MODE_NORMAL = 'normal';
const CAMERA_MODE_AIMING = 'aiming';
const CAMERA_MODE_FREE = 'free';
let sharedShadowTexture = null;

function getSharedShadowTexture() {
  if (sharedShadowTexture) return sharedShadowTexture;
  const shadowCanvas = document.createElement('canvas');
  shadowCanvas.width = 128;
  shadowCanvas.height = 128;
  const context = shadowCanvas.getContext('2d');
  const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(0, 0, 0, 0.8)');
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);
  sharedShadowTexture = new THREE.CanvasTexture(shadowCanvas);
  return sharedShadowTexture;
}

function createFakeShadow(radius) {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(radius * 2, radius * 2),
    new THREE.MeshBasicMaterial({
      map: getSharedShadowTexture(),
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    })
  );
  mesh.visible = false;
  return mesh;
}
export function createViewerScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, canvas, powerPreference: 'high-performance' });
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#050d18');

  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.01, 2000);
  camera.position.copy(BALL_START_POSITION).add(new THREE.Vector3(2.6, 1.8, 4.4));
  scene.add(camera);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.enableRotate = false;
  controls.enableZoom = false;
  controls.enabled = false;
  controls.target.copy(BALL_START_POSITION);
  controls.minDistance = 0.01;
  controls.maxDistance = 500;
  controls.update();

  const ambientLight = new THREE.HemisphereLight('#d8f8ff', '#18304c', 1.5);
  scene.add(ambientLight);

  const keyLight = new THREE.DirectionalLight('#ffffff', 2.4);
  keyLight.position.set(4, 5, 3);
  scene.add(keyLight);




  const mapRoot = new THREE.Group();
  const ballRoot = new THREE.Group();
  const clubRoot = new THREE.Group();
  const characterRoot = new THREE.Group();
  const characterVisualRoot = new THREE.Group();
  const overlayRoot = new THREE.Group();
  const ballShadow = createFakeShadow(BALL_RADIUS * 1.5);
  const characterShadow = createFakeShadow(0.4);
  const rotatedCharacterSetupOffset = new THREE.Vector3();
  const characterGroundProbePosition = new THREE.Vector3();
  const characterGroundNormal = new THREE.Vector3(0, 1, 0);
  const characterForward = new THREE.Vector3();
  const desiredFacingDirection = new THREE.Vector3();
  const currentFacingDirection = new THREE.Vector3();
  const freeCameraForward = new THREE.Vector3();
  const freeCameraRight = new THREE.Vector3();
  const freeCameraTranslation = new THREE.Vector3();
  const freeCameraEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  const cameraOrientationForward = new THREE.Vector3();
  const characterOrientationForward = new THREE.Vector3();
  const characterOrientationRight = new THREE.Vector3();
  const characterOrientationBackward = new THREE.Vector3();
  const characterOrientationMatrix = new THREE.Matrix4();
  const aimingCameraDirection = new THREE.Vector3();
  const normalCameraTargetOffset = new THREE.Vector3();
  const aimingCameraFocusPoint = new THREE.Vector3();
  const aimingCameraLookAtMatrix = new THREE.Matrix4();
  const aimingCameraLocalUp = new THREE.Vector3();
  const desiredAimingCameraQuaternion = new THREE.Quaternion();

  scene.add(mapRoot);
  scene.add(ballRoot);
  scene.add(ballShadow);
  scene.add(clubRoot);
  scene.add(characterRoot);
  scene.add(characterShadow);
  characterRoot.add(characterVisualRoot);
  camera.add(overlayRoot);

  characterVisualRoot.rotation.y = THREE.MathUtils.degToRad(CHARACTER_VISUAL_YAW_OFFSET_DEGREES);

  let mapBounds = null;
  let courseCollision = null;
  let clubHeadCollider = null;
  let holeMarker = null;
  let aimingMarker = null;
  let cameraMode = CAMERA_MODE_NORMAL;
  let lastGameplayCameraMode = CAMERA_MODE_NORMAL;
  let aimingCameraNeedsSnap = false;
  let freeCameraYaw = 0;
  let freeCameraPitch = 0;
  let characterYawRadians = 0;
  const normalCameraOffset = new THREE.Vector3().subVectors(camera.position, BALL_START_POSITION);
  const desiredCameraPosition = new THREE.Vector3();
  const desiredCameraTarget = new THREE.Vector3();
  const tiltedCameraTarget = new THREE.Vector3();
  const cameraTiltAxis = new THREE.Vector3();
  const cameraTiltDirection = new THREE.Vector3();

  const applyTiltedCameraTarget = (cameraPosition, focusPoint, target) => {
    cameraTiltDirection.subVectors(focusPoint, cameraPosition);
    const focusDistance = cameraTiltDirection.length();
    if (focusDistance <= 1e-6) {
      target.copy(focusPoint);
      return target;
    }

    cameraTiltDirection.multiplyScalar(1 / focusDistance);
    cameraTiltAxis.crossVectors(cameraTiltDirection, WORLD_UP);
    if (cameraTiltAxis.lengthSq() <= 1e-8) {
      target.copy(focusPoint);
      return target;
    }

    cameraTiltAxis.normalize();
    cameraTiltDirection.applyAxisAngle(cameraTiltAxis, CAMERA_TILT_OFFSET_RADIANS);
    target.copy(cameraPosition).addScaledVector(cameraTiltDirection, focusDistance);
    return target;
  };

  const syncFreeCameraAnglesFromCamera = () => {
    freeCameraEuler.setFromQuaternion(camera.quaternion, 'YXZ');
    freeCameraPitch = freeCameraEuler.x;
    freeCameraYaw = freeCameraEuler.y;
  };

  const applyFreeCameraRotation = () => {
    camera.rotation.order = 'YXZ';
    camera.rotation.y = freeCameraYaw;
    camera.rotation.x = freeCameraPitch;
    camera.rotation.z = 0;
    camera.updateMatrixWorld(true);
  };

  const restoreNormalCameraPose = () => {
    const followTarget = ballRoot.position.lengthSq() > 0 ? ballRoot.position : BALL_START_POSITION;
    controls.target.copy(followTarget);
    camera.position.copy(controls.target).add(normalCameraOffset);
    controls.update();
    applyTiltedCameraTarget(camera.position, controls.target, tiltedCameraTarget);
    camera.lookAt(tiltedCameraTarget);
  };

  const syncNormalCameraPoseFromCurrentView = () => {
    normalCameraOffset.copy(camera.position).sub(controls.target);
    normalCameraTargetOffset.set(0, 0, 0);
  };

  const composeAimingCameraPose = (previewPoint, targetPosition) => {
    targetPosition.copy(previewPoint);
    aimingCameraDirection.copy(normalCameraOffset);
    aimingCameraDirection.y = 0;
    if (aimingCameraDirection.lengthSq() <= 1e-8) {
      getCharacterForward(aimingCameraDirection).multiplyScalar(-1);
    } else {
      aimingCameraDirection.normalize();
    }

    desiredCameraPosition.copy(previewPoint)
      .addScaledVector(aimingCameraDirection, AIMING_CAMERA_DISTANCE)
      .addScaledVector(WORLD_UP, AIMING_CAMERA_HEIGHT);
  };

  const updateCharacterOrientation = (groundNormal) => {
    characterGroundNormal.copy(groundNormal).normalize();
    characterOrientationForward.copy(WORLD_FORWARD);
    characterOrientationForward.addScaledVector(
      characterGroundNormal,
      -characterOrientationForward.dot(characterGroundNormal),
    );
    if (characterOrientationForward.lengthSq() <= 1e-8) {
      characterOrientationForward.set(1, 0, 0);
      characterOrientationForward.addScaledVector(
        characterGroundNormal,
        -characterOrientationForward.dot(characterGroundNormal),
      );
    }

    characterOrientationForward.normalize();
    characterOrientationForward.applyAxisAngle(characterGroundNormal, characterYawRadians).normalize();
    characterOrientationBackward.copy(characterOrientationForward).negate();
    characterOrientationRight.crossVectors(characterGroundNormal, characterOrientationBackward);
    if (characterOrientationRight.lengthSq() <= 1e-8) {
      characterOrientationRight.set(1, 0, 0);
    } else {
      characterOrientationRight.normalize();
    }

    characterOrientationBackward.crossVectors(characterOrientationRight, characterGroundNormal).normalize();
    characterOrientationMatrix.makeBasis(
      characterOrientationRight,
      characterGroundNormal,
      characterOrientationBackward,
    );
    characterRoot.quaternion.setFromRotationMatrix(characterOrientationMatrix).normalize();
  };

  const snapCharacterToGround = (ballPosition) => {
    if (!courseCollision?.root) {
      return false;
    }

    const support = findGroundSupport(
      courseCollision,
      characterGroundProbePosition.copy(characterRoot.position),
      CHARACTER_GROUND_PROBE_RADIUS,
      CHARACTER_GROUND_PROBE_DISTANCE,
    );
    if (!support || support.normal.y < CHARACTER_GROUND_MIN_NORMAL_Y) {
      return false;
    }

    updateCharacterOrientation(support.normal);
    rotatedCharacterSetupOffset.copy(CHARACTER_SETUP_OFFSET).applyQuaternion(characterRoot.quaternion);
    characterRoot.position.copy(ballPosition).add(rotatedCharacterSetupOffset);

    const refinedSupport = findGroundSupport(
      courseCollision,
      characterGroundProbePosition.copy(characterRoot.position),
      CHARACTER_GROUND_PROBE_RADIUS,
      CHARACTER_GROUND_PROBE_DISTANCE,
    );
    if (!refinedSupport || refinedSupport.normal.y < CHARACTER_GROUND_MIN_NORMAL_Y) {
      return false;
    }

    updateCharacterOrientation(refinedSupport.normal);
    characterRoot.position.copy(refinedSupport.point);
    characterRoot.updateMatrixWorld(true);
    return true;
  };

  const setCharacterAddressPosition = (ballPosition) => {
    updateCharacterOrientation(characterGroundNormal);
    rotatedCharacterSetupOffset.copy(CHARACTER_SETUP_OFFSET).applyQuaternion(characterRoot.quaternion);
    characterRoot.position.copy(ballPosition).add(rotatedCharacterSetupOffset);
    snapCharacterToGround(ballPosition);
  };

  const getCharacterForward = (target) => {
    target.copy(WORLD_FORWARD).applyQuaternion(characterRoot.quaternion);
    target.y = 0;
    if (target.lengthSq() <= 1e-8) {
      target.copy(WORLD_FORWARD);
      return target;
    }

    return target.normalize();
  };



  setCharacterAddressPosition(BALL_START_POSITION);

  controls.addEventListener('change', () => {
    if (cameraMode !== CAMERA_MODE_NORMAL) {
      return;
    }

    syncNormalCameraPoseFromCurrentView();
  });

  updateRendererSize(renderer);
  const updateEntityShadow = (entityRoot, shadowMesh, raycastOffset = 0.5) => {
    if (!courseCollision) {
      shadowMesh.visible = false;
      return;
    }
    
    // Cast from slightly above the entity to support grounded models properly
    characterGroundProbePosition.copy(entityRoot.position);
    characterGroundProbePosition.y += raycastOffset;
    const support = sampleCourseSurface(
      courseCollision,
      characterGroundProbePosition,
      raycastOffset + 0.1, // look up
      200.0 // look down
    );

    if (support && support.point) {
      const dist = entityRoot.position.y - support.point.y;
      if (dist < 1.0 && dist > -0.5) {
        shadowMesh.visible = true;
        // Fade out as it reaches 1.0 distance
        const opacity = THREE.MathUtils.lerp(0.8, 0, Math.max(0, dist));
        shadowMesh.material.opacity = opacity;
        
        shadowMesh.position.copy(support.point);
        
        // Orient to ground normal (plane geometry normal is +Z)
        shadowMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), support.normal);
      } else {
        shadowMesh.visible = false;
      }
    } else {
      shadowMesh.visible = false;
    }
  };
  return {
    renderer,
    scene,
    camera,
    controls,
    keyLight,
    mapRoot,
    ballRoot,
    clubRoot,
    characterRoot,
    characterVisualRoot,
    overlayRoot,

    get mapBounds() {
      return mapBounds;
    },

    get courseCollision() {
      return courseCollision;
    },

    setMapBounds(bounds) {
      mapBounds = bounds;
    },

    setCourseCollision(nextCourseCollision) {
      courseCollision = nextCourseCollision;
      setCharacterAddressPosition(ballRoot.position.lengthSq() > 0 ? ballRoot.position : BALL_START_POSITION);
    },

    setClubHeadCollider(nextClubHeadCollider) {
      clubHeadCollider = nextClubHeadCollider;
    },

    getClubHeadCollider() {
      return clubHeadCollider;
    },

    setHoleMarker(nextHoleMarker) {
      holeMarker = nextHoleMarker;
    },

    getHoleMarker() {
      return holeMarker;
    },

    setAimingMarker(nextAimingMarker) {
      aimingMarker = nextAimingMarker;
    },

    getAimingMarker() {
      return aimingMarker;
    },

    applyCameraTilt() {
      if (cameraMode !== CAMERA_MODE_NORMAL) {
        return;
      }

      applyTiltedCameraTarget(camera.position, controls.target, tiltedCameraTarget);
      camera.lookAt(tiltedCameraTarget);
    },

    updateControls() {
      if (cameraMode !== CAMERA_MODE_NORMAL) {
        return;
      }

      controls.update();
    },

    getCharacterForward(target) {
      return getCharacterForward(target);
    },


    getCameraMode() {
      return cameraMode;
    },

    isFreeCameraEnabled() {
      return cameraMode === CAMERA_MODE_FREE;
    },

    isNormalCameraEnabled() {
      return cameraMode === CAMERA_MODE_NORMAL;
    },

    isAimingCameraEnabled() {
      return cameraMode === CAMERA_MODE_AIMING;
    },

    /**
     * Switches the viewer between gameplay camera modes and the free camera without sharing pose state.
     */
    setCameraMode(nextMode) {
      const resolvedMode = [CAMERA_MODE_NORMAL, CAMERA_MODE_AIMING, CAMERA_MODE_FREE].includes(nextMode)
        ? nextMode
        : CAMERA_MODE_NORMAL;
      if (cameraMode === resolvedMode) {
        return cameraMode;
      }

      const previousMode = cameraMode;
      if (resolvedMode === CAMERA_MODE_FREE) {
        if (previousMode !== CAMERA_MODE_FREE) {
          lastGameplayCameraMode = previousMode;
        }
        syncFreeCameraAnglesFromCamera();
      }

      cameraMode = resolvedMode;
      controls.enabled = false;
      if (resolvedMode === CAMERA_MODE_NORMAL) {
        restoreNormalCameraPose();
      }
      if (resolvedMode === CAMERA_MODE_AIMING) {
        aimingCameraNeedsSnap = true;
      }

      return cameraMode;
    },

    setFreeCameraEnabled(enabled) {
      const nextMode = enabled
        ? CAMERA_MODE_FREE
        : (lastGameplayCameraMode === CAMERA_MODE_AIMING ? CAMERA_MODE_AIMING : CAMERA_MODE_NORMAL);
      return this.setCameraMode(nextMode) === CAMERA_MODE_FREE;
    },

    setAimingCameraEnabled(enabled) {
      return this.setCameraMode(enabled ? CAMERA_MODE_AIMING : CAMERA_MODE_NORMAL) === CAMERA_MODE_AIMING;
    },

    rotateFreeCamera(deltaX, deltaY) {
      if (cameraMode !== CAMERA_MODE_FREE) {
        return;
      }

      freeCameraYaw -= deltaX * FREE_CAMERA_LOOK_SENSITIVITY;
      freeCameraPitch = THREE.MathUtils.clamp(
        freeCameraPitch - deltaY * FREE_CAMERA_LOOK_SENSITIVITY,
        -FREE_CAMERA_PITCH_LIMIT_RADIANS,
        FREE_CAMERA_PITCH_LIMIT_RADIANS,
      );
      applyFreeCameraRotation();
    },

    updateFreeCamera(deltaSeconds, movementInput) {
      if (cameraMode !== CAMERA_MODE_FREE) {
        return;
      }

      camera.getWorldDirection(freeCameraForward);
      freeCameraForward.normalize();
      freeCameraRight.crossVectors(freeCameraForward, WORLD_UP);
      if (freeCameraRight.lengthSq() <= 1e-8) {
        freeCameraRight.set(1, 0, 0);
      } else {
        freeCameraRight.normalize();
      }

      freeCameraTranslation.set(0, 0, 0);
      freeCameraTranslation.addScaledVector(freeCameraForward, movementInput.forward);
      freeCameraTranslation.addScaledVector(freeCameraRight, movementInput.right);
      if (freeCameraTranslation.lengthSq() <= 1e-8) {
        return;
      }

      freeCameraTranslation.normalize().multiplyScalar(FREE_CAMERA_MOVE_SPEED * deltaSeconds);
      camera.position.add(freeCameraTranslation);
      camera.updateMatrixWorld(true);
    },

    positionBallAtStart() {
      ballRoot.position.copy(BALL_START_POSITION);
      if (cameraMode === CAMERA_MODE_NORMAL) {
        restoreNormalCameraPose();
      }
    },

    positionCharacterForBall(ballPosition) {
      setCharacterAddressPosition(ballPosition);
    },

    faceViewToward(ballPosition, targetPosition) {
      desiredFacingDirection.subVectors(targetPosition, ballPosition);
      desiredFacingDirection.y = 0;
      if (desiredFacingDirection.lengthSq() <= 1e-8) {
        return;
      }

      desiredFacingDirection.normalize();
      currentFacingDirection.subVectors(ballPosition, camera.position);
      currentFacingDirection.y = 0;
      if (currentFacingDirection.lengthSq() <= 1e-8) {
        getCharacterForward(currentFacingDirection);
      } else {
        currentFacingDirection.normalize();
      }

      const rotationDelta = Math.atan2(
        (currentFacingDirection.z * desiredFacingDirection.x) - (currentFacingDirection.x * desiredFacingDirection.z),
        THREE.MathUtils.clamp(currentFacingDirection.dot(desiredFacingDirection), -1, 1),
      );
      if (Math.abs(rotationDelta) <= 1e-5) {
        return;
      }

      this.rotateCharacterAroundBall(ballPosition, rotationDelta);
      if (cameraMode === CAMERA_MODE_NORMAL) {
        this.orbitNormalCameraAroundBall(ballPosition, rotationDelta);
      }
    },

    rotateCharacterAroundBall(ballPosition, angleRadians) {
      characterYawRadians += angleRadians;
      setCharacterAddressPosition(ballPosition);
      characterRoot.updateMatrixWorld(true);
    },

    /**
     * Rotates the stored normal gameplay camera pose around the current ball position.
     */
    orbitNormalCameraAroundBall(ballPosition, angleRadians) {
      normalCameraOffset.applyAxisAngle(WORLD_UP, angleRadians);
      if (cameraMode !== CAMERA_MODE_NORMAL) {
        return;
      }

      controls.target.copy(ballPosition);
      camera.position.copy(controls.target).add(normalCameraOffset);
      controls.update();
      this.applyCameraTilt();
    },



    setInitialCameraPose() {
      const forward = WORLD_FORWARD.clone().normalize();
      const startPosition = BALL_START_POSITION.clone().addScaledVector(forward, -CAMERA_START_DISTANCE);
      startPosition.y = clubRoot.position.y;
      const lookFocusPoint = BALL_START_POSITION.clone().addScaledVector(forward, CAMERA_LOOK_AHEAD_DISTANCE);

      camera.position.copy(startPosition);
      camera.near = 0.01;
      camera.far = mapBounds && !mapBounds.isEmpty()
        ? Math.max(mapBounds.getSize(new THREE.Vector3()).length() * 4, 2000)
        : 2000;
      controls.target.copy(lookFocusPoint);
      controls.maxDistance = mapBounds && !mapBounds.isEmpty()
        ? Math.max(mapBounds.getSize(new THREE.Vector3()).length() * 2, 20)
        : 500;
      normalCameraOffset.copy(camera.position).sub(lookFocusPoint);
      normalCameraTargetOffset.set(0, 0, 0);
      controls.update();
      this.applyCameraTilt();
      camera.updateProjectionMatrix();
    },

    resetBallCameraFollow() {
      restoreNormalCameraPose();
    },

    /**
     * Updates the active gameplay camera pose from either the ball follow target or the aiming preview target.
     */
    updateBallFollowCamera(deltaSeconds, aimingPreviewState = null) {
      if (cameraMode === CAMERA_MODE_FREE) {
        return;
      }

      if (cameraMode === CAMERA_MODE_AIMING) {
        if (!aimingPreviewState?.isVisible) {
          return;
        }

        aimingCameraFocusPoint.copy(aimingPreviewState.point);
        composeAimingCameraPose(aimingCameraFocusPoint, desiredCameraTarget);

        aimingCameraLookAtMatrix.lookAt(desiredCameraPosition, desiredCameraTarget, WORLD_UP);
        aimingCameraLocalUp.setFromMatrixColumn(aimingCameraLookAtMatrix, 1);

        // Move camera and focus together in camera-local up so aim mode keeps its higher over-the-shoulder framing.
        desiredCameraPosition.addScaledVector(aimingCameraLocalUp, AIMING_CAMERA_LOCAL_UP_OFFSET);
        desiredCameraTarget.addScaledVector(aimingCameraLocalUp, AIMING_CAMERA_LOCAL_UP_OFFSET);

        const aimingFollowAlpha = aimingCameraNeedsSnap
          ? 1
          : 1 - Math.exp(-AIMING_CAMERA_FOLLOW_STIFFNESS * deltaSeconds);
        aimingCameraLookAtMatrix.lookAt(desiredCameraPosition, desiredCameraTarget, WORLD_UP);
        desiredAimingCameraQuaternion.setFromRotationMatrix(aimingCameraLookAtMatrix);

        if (aimingCameraNeedsSnap) {
          camera.position.copy(desiredCameraPosition);
          controls.target.copy(desiredCameraTarget);
          camera.quaternion.copy(desiredAimingCameraQuaternion);
        } else {
          camera.position.lerp(desiredCameraPosition, aimingFollowAlpha);
          controls.target.lerp(desiredCameraTarget, aimingFollowAlpha);
          camera.quaternion.slerp(desiredAimingCameraQuaternion, aimingFollowAlpha);
        }
        camera.updateMatrixWorld(true);
        aimingCameraNeedsSnap = false;
        return;
      }

      const followAlpha = 1 - Math.exp(-CAMERA_FOLLOW_STIFFNESS * deltaSeconds);
      desiredCameraTarget.copy(ballRoot.position);
      desiredCameraPosition.copy(desiredCameraTarget).add(normalCameraOffset);
      controls.target.lerp(desiredCameraTarget, followAlpha);
      camera.position.lerp(desiredCameraPosition, followAlpha);
    },

    positionLightsForMap() {
      if (!mapBounds || mapBounds.isEmpty()) {
        return;
      }

      const size = mapBounds.getSize(new THREE.Vector3());
      const maxDimension = Math.max(size.x, size.y, size.z, 1);
      keyLight.position.set(maxDimension * 0.35, maxDimension * 0.6, maxDimension * 0.3);
    },

    resize() {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      if (cameraMode === CAMERA_MODE_FREE) {
        applyFreeCameraRotation();
      }
      updateRendererSize(renderer);
    },

    updateShadows() {
      updateEntityShadow(ballRoot, ballShadow, 0.05);
      updateEntityShadow(characterRoot, characterShadow, 0.5);
    },
  };
}

function updateRendererSize(renderer) {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_RENDER_PIXEL_RATIO));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
}