import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { resolveAssetUrl } from '../assets.js';
import { buildCourseCollision } from '/static/js/game/collision.js';
import {
  AIMING_MARKER_CANVAS_HEIGHT,
  AIMING_MARKER_CANVAS_WIDTH,
  AIMING_MARKER_PIXEL_HEIGHT,
  AIMING_MARKER_WORLD_Y_OFFSET,
  BALL_RADIUS,
  CLUB_HEAD_COLLIDER_RADIUS,
  CLUB_HEAD_HISTORY_DURATION_SECONDS,
  CLUB_HEAD_HISTORY_MAX_SAMPLES,
  CLUB_HEAD_COLLIDER_TIP_BACKOFF,
  CLUB_HEAD_COLLIDER_SIDE_OFFSET,
  COURSE_HOLE_POSITION,
  HOLE_MARKER_BEAM_CORE_COLOR,
  HOLE_MARKER_BEAM_CORE_RADIUS,
  HOLE_MARKER_BEAM_GLOW_COLOR,
  HOLE_MARKER_BEAM_GLOW_RADIUS,
  HOLE_MARKER_BEAM_HEIGHT,
  HOLE_MARKER_LABEL_CANVAS_HEIGHT,
  HOLE_MARKER_LABEL_CANVAS_WIDTH,
  HOLE_MARKER_LABEL_FONT_FAMILY,
  HOLE_MARKER_LABEL_HEIGHT,
  MAP_MODEL_PATH,
  MOVE_MODE_LABEL_BOTTOM_OFFSET_RATIO,
  MOVE_MODE_LABEL_CANVAS_HEIGHT,
  MOVE_MODE_LABEL_CANVAS_WIDTH,
  MOVE_MODE_LABEL_DEPTH,
  MOVE_MODE_LABEL_HEIGHT,
  WORLD_FORWARD,
} from '/static/js/game/constants.js';
import {
  configureFlatShadedMaterials,
  configureMaterialTextureAnisotropy,
  configureUnlitMaterials,
} from '/static/js/game/materials.js';
import { createSwingMatcher } from '/static/js/game/swingMatcher.js';

const DEBUG_PARAMS = new URLSearchParams(window.location.search);
const DEBUG_SHOW_SKELETON = DEBUG_PARAMS.get('debugSkeleton') === '1';
const DEBUG_SHOW_AXES = DEBUG_PARAMS.get('debugAxes') === '1';

export function loadViewerModels(viewerScene, onStatus) {
  const loader = new GLTFLoader();
  const clubAxesHelper = new THREE.AxesHelper(0.35);
  const ballBounds = new THREE.Box3();
  const ballSize = new THREE.Vector3();
  const ballCenter = new THREE.Vector3();
  const holeMarker = createHoleMarker();
  const aimingMarker = createAimingMarker();
  clubAxesHelper.visible = DEBUG_SHOW_AXES;
  viewerScene.clubAxesHelper = clubAxesHelper;
  viewerScene.overlayRoot.add(holeMarker.labelSprite);
  viewerScene.overlayRoot.add(holeMarker.moveModeLabelSprite);
  viewerScene.scene.add(aimingMarker.sprite);
  viewerScene.scene.add(aimingMarker.debugSphere);
  viewerScene.scene.add(aimingMarker.puttAimTarget);
  viewerScene.scene.add(aimingMarker.puttGridRoot);
  viewerScene.scene.add(aimingMarker.slopeGridRoot);
  viewerScene.setHoleMarker(holeMarker);
  viewerScene.setAimingMarker(aimingMarker);

  loader.load(
    MAP_MODEL_PATH,
    (gltf) => {
      const supportedAnisotropy = viewerScene.renderer.capabilities.getMaxAnisotropy();
      configureMaterialTextureAnisotropy(gltf.scene, Math.min(16, supportedAnisotropy));
      configureUnlitMaterials(gltf.scene);
      viewerScene.mapRoot.add(gltf.scene);
      viewerScene.setMapBounds(new THREE.Box3().setFromObject(viewerScene.mapRoot));
      viewerScene.setCourseCollision(buildCourseCollision(viewerScene.mapRoot));
      viewerScene.mapRoot.add(holeMarker.beamRoot);
      viewerScene.positionLightsForMap();
      viewerScene.setInitialCameraPose();
      if (viewerScene.courseCollision?.triangleCount) {
        console.info(
          `[collision] Built static course BVH with ${viewerScene.courseCollision.triangleCount} triangles from ${viewerScene.courseCollision.meshCount} meshes.`,
        );
      } else {
        onStatus('Course model loaded, but no collision triangles were found.');
      }
    },
    undefined,
    (error) => {
      onStatus('Failed to load course model.');
      console.error(error);
    },
  );

  loader.load(
    resolveAssetUrl('models/high_ball_low.glb'),
    (gltf) => {
      configureFlatShadedMaterials(gltf.scene);
      gltf.scene.updateMatrixWorld(true);
      ballBounds.setFromObject(gltf.scene);
      if (!ballBounds.isEmpty()) {
        ballBounds.getCenter(ballCenter);
        ballBounds.getSize(ballSize);
        const visualRadius = Math.max(ballSize.x, ballSize.y, ballSize.z) * 0.5;

        gltf.scene.position.sub(ballCenter);
        if (visualRadius > 1e-6) {
          gltf.scene.scale.multiplyScalar(BALL_RADIUS / visualRadius);
        }
      }

      viewerScene.positionBallAtStart();
      viewerScene.ballRoot.add(gltf.scene);
    },
    undefined,
    (error) => {
      onStatus('Failed to load ball model.');
      console.error(error);
    },
  );

  loader.load(
    resolveAssetUrl('models/golf_club.glb'),
    (gltf) => {
      configureUnlitMaterials(gltf.scene);
      gltf.scene.updateMatrixWorld(true);
      const clubBounds = new THREE.Box3().setFromObject(gltf.scene);
      const clubHeadCollider = createClubHeadColliderMesh(clubBounds);
      viewerScene.clubRoot.add(gltf.scene);
      viewerScene.clubRoot.add(clubHeadCollider);
      viewerScene.clubRoot.add(clubAxesHelper);
      viewerScene.setClubHeadCollider(clubHeadCollider);
      viewerScene.setInitialCameraPose();
    },
    undefined,
    (error) => {
      onStatus('Failed to load golf club model.');
      console.error(error);
    },
  );
}

export function loadCharacter(viewerScene, onStatus) {
  const loader = new GLTFLoader();
  const swingMatcher = createSwingMatcher({ onStatus });
  const characterAxesHelper = new THREE.AxesHelper(0.75);
  const characterWorldQuaternion = new THREE.Quaternion();
  const inverseCharacterWorldQuaternion = new THREE.Quaternion();
  const clubSocketPosition = new THREE.Vector3();
  const clubHeadWorldPosition = new THREE.Vector3();
  const clubHeadWorldQuaternion = new THREE.Quaternion();
  const clubHeadPreviousWorldPosition = new THREE.Vector3();
  const lastClubHeadWorldPosition = new THREE.Vector3();
  const clubHeadWorldVelocity = new THREE.Vector3();
  const characterFacingForward = WORLD_FORWARD.clone();
  const worldClubQuaternion = new THREE.Quaternion();
  const liveSocketWorldQuaternion = new THREE.Quaternion();
  const animatedBoneWorldPosition = new THREE.Vector3();
  const skinnedMeshBoneWorldPosition = new THREE.Vector3();
  const socketAxesHelper = new THREE.AxesHelper(0.9);
  characterAxesHelper.visible = DEBUG_SHOW_AXES;
  socketAxesHelper.visible = DEBUG_SHOW_AXES;
  let characterMixer = null;
  let characterAction = null;
  let characterAnimationClip = null;
  let characterSocketBone = null;
  let characterSceneRoot = null;
  let characterSkinnedMeshes = [];
  let skeletonHelper = null;
  let swingDurationSeconds = 0;
  let currentAnimationTimeSeconds = 0;
  let clubHeadSampleTimeSeconds = 0;
  let hasClubHeadSample = false;
  const clubHeadSampleHistory = [];

  const trimClubHeadSampleHistory = () => {
    while (clubHeadSampleHistory.length > CLUB_HEAD_HISTORY_MAX_SAMPLES) {
      clubHeadSampleHistory.shift();
    }

    while (
      clubHeadSampleHistory.length > 1
      && clubHeadSampleTimeSeconds - clubHeadSampleHistory[0].timeSeconds > CLUB_HEAD_HISTORY_DURATION_SECONDS
    ) {
      clubHeadSampleHistory.shift();
    }
  };

  const pushClubHeadSample = () => {
    clubHeadSampleHistory.push({
      timeSeconds: clubHeadSampleTimeSeconds,
      position: clubHeadWorldPosition.clone(),
      quaternion: clubHeadWorldQuaternion.clone(),
      characterFacingForward: characterFacingForward.clone(),
    });
    trimClubHeadSampleHistory();
  };

  const initializeCharacterControllerIfReady = () => {
    if (!characterAnimationClip || !characterSceneRoot || !characterSocketBone || characterMixer) {
      return;
    }

    characterMixer = new THREE.AnimationMixer(characterSceneRoot);
    characterAction = characterMixer.clipAction(characterAnimationClip, characterSceneRoot);
    characterAction.clampWhenFinished = false;
    characterAction.setLoop(THREE.LoopRepeat, Infinity);
    characterAction.enabled = true;
    characterAction.setEffectiveWeight(1);
    characterAction.setEffectiveTimeScale(1);
    characterAction.play();
    swingDurationSeconds = characterAnimationClip.duration;
    swingMatcher.initialize({
      durationSeconds: swingDurationSeconds,
      clipName: characterAnimationClip.name,
      trackNames: characterAnimationClip.tracks.map((track) => track.name),
      sampleSocketQuaternionAtTime(sampleTime, targetQuaternion) {
        setCharacterAnimationTime(sampleTime);
        viewerScene.characterVisualRoot.getWorldQuaternion(characterWorldQuaternion);
        inverseCharacterWorldQuaternion.copy(characterWorldQuaternion).invert();
        characterSocketBone.getWorldQuaternion(targetQuaternion);
        targetQuaternion.premultiply(inverseCharacterWorldQuaternion).normalize();
      },
    });
    characterAction.reset();
    characterAction.play();
    setCharacterAnimationTime(0);
  };

  const logCharacterMeshDiagnostics = () => {
    if (!characterSceneRoot) {
      return;
    }

    const meshes = [];
    characterSceneRoot.traverse((node) => {
      if (node.isSkinnedMesh) {
        meshes.push({
          name: node.name || '(unnamed skinned mesh)',
          materialType: Array.isArray(node.material)
            ? node.material.map((material) => material.type)
            : [node.material?.type ?? '(missing material)'],
          boneCount: node.skeleton?.bones?.length ?? 0,
          hasBone01: Boolean(node.skeleton?.getBoneByName('Bone01')),
        });
      }
    });

    console.groupCollapsed('[swing-debug] character mesh diagnostics');
    console.log('skinned mesh count:', meshes.length);
    console.table(meshes);
    console.groupEnd();

    if (meshes.length === 0) {
      onStatus('Character scene has no SkinnedMesh nodes. Check browser console.');
      console.warn('[swing-debug] No SkinnedMesh nodes were found under the loaded character scene.');
    }
  };

  const logBoneBindingDiagnostics = () => {
    if (characterSkinnedMeshes.length === 0 || !characterSocketBone) {
      return;
    }

    characterSocketBone.getWorldPosition(animatedBoneWorldPosition);
    const firstSkinnedMeshBone = characterSkinnedMeshes[0].skeleton?.getBoneByName('Bone01');
    firstSkinnedMeshBone?.getWorldPosition(skinnedMeshBoneWorldPosition);

    console.groupCollapsed('[swing-debug] bone binding diagnostics');
    console.log('controller Bone01 position:', animatedBoneWorldPosition.toArray());
    console.log('skinned mesh Bone01 position:', firstSkinnedMeshBone ? skinnedMeshBoneWorldPosition.toArray() : '(missing Bone01 in skeleton)');
    console.log('same bone instance:', firstSkinnedMeshBone === characterSocketBone);
    console.groupEnd();
  };

  const setCharacterAnimationTime = (nextTimeSeconds) => {
    if (!characterMixer || !characterAction) {
      return;
    }

    currentAnimationTimeSeconds = THREE.MathUtils.clamp(nextTimeSeconds, 0, swingDurationSeconds);
    characterAction.time = currentAnimationTimeSeconds;
    characterMixer.setTime(currentAnimationTimeSeconds);
    viewerScene.characterRoot.updateMatrixWorld(true);
  };

  loader.load(
    resolveAssetUrl('models/chara/nuri/nuri_base.glb'),
    (gltf) => {
      configureUnlitMaterials(gltf.scene);
      characterSceneRoot = gltf.scene;
      viewerScene.characterVisualRoot.add(gltf.scene);
      viewerScene.characterRoot.add(characterAxesHelper);
      characterSkinnedMeshes = [];
      gltf.scene.traverse((node) => {
        if (node.isSkinnedMesh) {
          characterSkinnedMeshes.push(node);
        }
      });
      characterSocketBone = gltf.scene.getObjectByName('Bone01');
      if (!characterSocketBone) {
        onStatus('Character loaded, but Bone01 socket was not found.');
      }
      if (socketAxesHelper && characterSocketBone) {
        characterSocketBone.add(socketAxesHelper);
      }
      if (DEBUG_SHOW_SKELETON) {
        skeletonHelper = new THREE.SkeletonHelper(gltf.scene);
        viewerScene.scene.add(skeletonHelper);
      }
      logCharacterMeshDiagnostics();
      initializeCharacterControllerIfReady();
      logBoneBindingDiagnostics();
    },
    undefined,
    (error) => {
      onStatus('Failed to load character model.');
      console.error(error);
    },
  );

  loader.load(
    resolveAssetUrl('models/chara/nuri/nuri_swing.glb'),
    (gltf) => {
      characterAnimationClip = gltf.animations[0] ?? null;
      initializeCharacterControllerIfReady();
    },
    undefined,
    (error) => {
      onStatus('Failed to load character animation.');
      console.error(error);
    },
  );

  return {
    update(deltaSeconds, clubQuaternion) {
      clubHeadSampleTimeSeconds += Math.max(deltaSeconds, 0);

      if (clubQuaternion) {
        viewerScene.characterVisualRoot.getWorldQuaternion(characterWorldQuaternion);
        worldClubQuaternion.copy(characterWorldQuaternion).multiply(clubQuaternion).normalize();
      }

      const nextAnimationTimeSeconds = swingMatcher.update(
        deltaSeconds,
        clubQuaternion,
        currentAnimationTimeSeconds,
      );
      if (nextAnimationTimeSeconds !== currentAnimationTimeSeconds) {
        setCharacterAnimationTime(nextAnimationTimeSeconds);
      }

      if (clubQuaternion) {
        viewerScene.clubRoot.quaternion.copy(worldClubQuaternion);
      }

      if (!characterSocketBone) {
        hasClubHeadSample = false;
        clubHeadSampleHistory.length = 0;
        return;
      }

      viewerScene.characterRoot.updateMatrixWorld(true);
      characterSocketBone.getWorldPosition(clubSocketPosition);
      characterSocketBone.getWorldQuaternion(liveSocketWorldQuaternion);
      viewerScene.clubRoot.position.copy(clubSocketPosition);
      viewerScene.clubRoot.updateMatrixWorld(true);
      viewerScene.getCharacterForward(characterFacingForward);

      const clubHeadCollider = viewerScene.getClubHeadCollider();
      if (!clubHeadCollider) {
        clubHeadWorldVelocity.set(0, 0, 0);
        hasClubHeadSample = false;
        clubHeadSampleHistory.length = 0;
        return;
      }

      clubHeadCollider.getWorldPosition(clubHeadWorldPosition);
      clubHeadCollider.getWorldQuaternion(clubHeadWorldQuaternion);
      if (!hasClubHeadSample || deltaSeconds <= 1e-6) {
        clubHeadPreviousWorldPosition.copy(clubHeadWorldPosition);
        clubHeadWorldVelocity.set(0, 0, 0);
      } else {
        clubHeadPreviousWorldPosition.copy(lastClubHeadWorldPosition);
        clubHeadWorldVelocity.subVectors(clubHeadWorldPosition, lastClubHeadWorldPosition)
          .multiplyScalar(1 / deltaSeconds);
      }

      lastClubHeadWorldPosition.copy(clubHeadWorldPosition);
      hasClubHeadSample = true;
      pushClubHeadSample();
    },

    getDebugTelemetry() {
      return {
        boneQuaternion: liveSocketWorldQuaternion,
        clubHeadPreviousPosition: clubHeadPreviousWorldPosition,
        clubHeadPosition: clubHeadWorldPosition,
        clubHeadQuaternion: clubHeadWorldQuaternion,
        clubHeadSampleHistory,
        clubHeadVelocity: clubHeadWorldVelocity,
        clubHeadSpeedMetersPerSecond: clubHeadWorldVelocity.length(),
        characterFacingForward,
        currentAnimationTimeSeconds,
        hasClubHeadSample,
        ...swingMatcher.getDebugTelemetry(),
      };
    },
  };
}

function createClubHeadColliderMesh(clubBounds) {
  const collider = new THREE.Mesh(
    new THREE.SphereGeometry(CLUB_HEAD_COLLIDER_RADIUS, 16, 12),
    new THREE.MeshBasicMaterial({
      color: '#ec146e',
      transparent: true,
      opacity: 0.24,
      wireframe: true,
    }),
  );

  const tipY = clubBounds.isEmpty() ? 0 : clubBounds.max.y;
  collider.position.set(CLUB_HEAD_COLLIDER_SIDE_OFFSET, tipY - CLUB_HEAD_COLLIDER_TIP_BACKOFF, 0);
  return collider;
}

function createHoleMarker() {
  const beamRoot = new THREE.Group();
  const labelCanvas = document.createElement('canvas');
  const labelContext = labelCanvas.getContext('2d');
  if (!labelContext) {
    throw new Error('Failed to create a 2D canvas context for the hole marker label.');
  }
  const beamGlow = new THREE.Mesh(
    new THREE.CylinderGeometry(HOLE_MARKER_BEAM_GLOW_RADIUS, HOLE_MARKER_BEAM_GLOW_RADIUS, HOLE_MARKER_BEAM_HEIGHT, 16, 1, true),
    new THREE.MeshBasicMaterial({
      color: HOLE_MARKER_BEAM_GLOW_COLOR,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      toneMapped: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  const beamCore = new THREE.Mesh(
    new THREE.CylinderGeometry(HOLE_MARKER_BEAM_CORE_RADIUS, HOLE_MARKER_BEAM_CORE_RADIUS, HOLE_MARKER_BEAM_HEIGHT, 12, 1, true),
    new THREE.MeshBasicMaterial({
      color: HOLE_MARKER_BEAM_CORE_COLOR,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      toneMapped: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  const labelTexture = new THREE.CanvasTexture(labelCanvas);
  const labelSprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: labelTexture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  const moveModeLabelCanvas = document.createElement('canvas');
  const moveModeLabelContext = moveModeLabelCanvas.getContext('2d');
  if (!moveModeLabelContext) {
    throw new Error('Failed to create a 2D canvas context for the move mode distance label.');
  }
  const moveModeLabelTexture = new THREE.CanvasTexture(moveModeLabelCanvas);
  const moveModeLabelSprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: moveModeLabelTexture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  const labelAspect = HOLE_MARKER_LABEL_CANVAS_WIDTH / HOLE_MARKER_LABEL_CANVAS_HEIGHT;
  const moveModeLabelAspect = MOVE_MODE_LABEL_CANVAS_WIDTH / MOVE_MODE_LABEL_CANVAS_HEIGHT;
  let lastHeightLabel = '';
  let lastDistanceLabel = '';
  let lastMoveModeTravelLabel = '';
  let lastMoveModeHoleLabel = '';

  beamRoot.name = 'hole-marker-beam';
  beamRoot.position.copy(COURSE_HOLE_POSITION);
  beamRoot.userData.excludeCourseCollision = true;
  beamGlow.position.y = HOLE_MARKER_BEAM_HEIGHT * 0.5;
  beamCore.position.y = HOLE_MARKER_BEAM_HEIGHT * 0.5;
  beamGlow.userData.excludeCourseCollision = true;
  beamCore.userData.excludeCourseCollision = true;
  beamRoot.add(beamGlow);
  beamRoot.add(beamCore);

  labelCanvas.width = HOLE_MARKER_LABEL_CANVAS_WIDTH;
  labelCanvas.height = HOLE_MARKER_LABEL_CANVAS_HEIGHT;
  labelTexture.generateMipmaps = false;
  labelTexture.minFilter = THREE.LinearFilter;
  labelTexture.magFilter = THREE.LinearFilter;
  labelSprite.name = 'hole-marker-label';
  labelSprite.visible = false;
  labelSprite.frustumCulled = false;
  labelSprite.renderOrder = 999;
  labelSprite.scale.set(HOLE_MARKER_LABEL_HEIGHT * labelAspect, HOLE_MARKER_LABEL_HEIGHT, 1);

  moveModeLabelCanvas.width = MOVE_MODE_LABEL_CANVAS_WIDTH;
  moveModeLabelCanvas.height = MOVE_MODE_LABEL_CANVAS_HEIGHT;
  moveModeLabelTexture.generateMipmaps = false;
  moveModeLabelTexture.minFilter = THREE.LinearFilter;
  moveModeLabelTexture.magFilter = THREE.LinearFilter;
  moveModeLabelSprite.name = 'move-mode-distance-label';
  moveModeLabelSprite.visible = false;
  moveModeLabelSprite.frustumCulled = false;
  moveModeLabelSprite.renderOrder = 999;
  moveModeLabelSprite.scale.set(MOVE_MODE_LABEL_HEIGHT * moveModeLabelAspect, MOVE_MODE_LABEL_HEIGHT, 1);

  const redrawLabel = () => {
    labelContext.clearRect(0, 0, labelCanvas.width, labelCanvas.height);
    labelContext.textAlign = 'center';
    labelContext.textBaseline = 'middle';
    labelContext.lineJoin = 'round';
    labelContext.shadowBlur = 12;
    labelContext.shadowColor = 'rgba(0, 0, 0, 0.45)';

    labelContext.font = `700 62px ${HOLE_MARKER_LABEL_FONT_FAMILY}`;
    labelContext.lineWidth = 12;
    labelContext.strokeStyle = 'rgba(0, 0, 0, 0.95)';
    labelContext.fillStyle = '#ffffff';
    labelContext.strokeText(lastHeightLabel, labelCanvas.width * 0.5, 86);
    labelContext.fillText(lastHeightLabel, labelCanvas.width * 0.5, 86);

    labelContext.font = `700 86px ${HOLE_MARKER_LABEL_FONT_FAMILY}`;
    labelContext.lineWidth = 14;
    labelContext.fillStyle = '#ffffff';
    labelContext.strokeText(lastDistanceLabel, labelCanvas.width * 0.5, 170);
    labelContext.fillText(lastDistanceLabel, labelCanvas.width * 0.5, 170);

    labelTexture.needsUpdate = true;
  };

  const redrawMoveModeLabel = () => {
    moveModeLabelContext.clearRect(0, 0, moveModeLabelCanvas.width, moveModeLabelCanvas.height);
    moveModeLabelContext.textAlign = 'center';
    moveModeLabelContext.textBaseline = 'middle';
    moveModeLabelContext.lineJoin = 'round';
    moveModeLabelContext.shadowBlur = 12;
    moveModeLabelContext.shadowColor = 'rgba(0, 0, 0, 0.4)';

    moveModeLabelContext.font = `700 90px ${HOLE_MARKER_LABEL_FONT_FAMILY}`;
    moveModeLabelContext.lineWidth = 16;
    moveModeLabelContext.strokeStyle = 'rgba(0, 0, 0, 0.95)';
    moveModeLabelContext.fillStyle = '#ffffff';
    moveModeLabelContext.strokeText(lastMoveModeTravelLabel, moveModeLabelCanvas.width * 0.5, 72);
    moveModeLabelContext.fillText(lastMoveModeTravelLabel, moveModeLabelCanvas.width * 0.5, 72);

    moveModeLabelContext.fillStyle = '#ff0000';
    moveModeLabelContext.strokeText(lastMoveModeHoleLabel, moveModeLabelCanvas.width * 0.5, 158);
    moveModeLabelContext.fillText(lastMoveModeHoleLabel, moveModeLabelCanvas.width * 0.5, 158);

    moveModeLabelTexture.needsUpdate = true;
  };

  if (document.fonts?.load) {
    document.fonts.load(`700 62px ${HOLE_MARKER_LABEL_FONT_FAMILY}`).then(() => {
      if (lastHeightLabel || lastDistanceLabel) {
        redrawLabel();
      }
      if (lastMoveModeTravelLabel || lastMoveModeHoleLabel) {
        redrawMoveModeLabel();
      }
    }).catch(() => {});
  }

  const moveModeOverlayHeightAtDepth = 2 * Math.tan(THREE.MathUtils.degToRad(50 * 0.5)) * MOVE_MODE_LABEL_DEPTH;
  const moveModeOverlayY = (-0.5 + MOVE_MODE_LABEL_BOTTOM_OFFSET_RATIO) * moveModeOverlayHeightAtDepth;
  moveModeLabelSprite.position.set(0, moveModeOverlayY, -MOVE_MODE_LABEL_DEPTH);

  return {
    beamRoot,
    holePosition: COURSE_HOLE_POSITION.clone(),
    labelSprite,
    moveModeLabelSprite,

    setLabelText(heightLabel, distanceLabel) {
      if (heightLabel === lastHeightLabel && distanceLabel === lastDistanceLabel) {
        return;
      }

      lastHeightLabel = heightLabel;
      lastDistanceLabel = distanceLabel;
      redrawLabel();
    },

    setLabelOverlayPosition(x, y, z) {
      labelSprite.position.set(x, y, z);
    },

    setLabelVisible(visible) {
      labelSprite.visible = visible;
    },

    setMoveModeLabelText(travelLabel, holeLabel) {
      if (travelLabel === lastMoveModeTravelLabel && holeLabel === lastMoveModeHoleLabel) {
        return;
      }

      lastMoveModeTravelLabel = travelLabel;
      lastMoveModeHoleLabel = holeLabel;
      redrawMoveModeLabel();
    },

    setMoveModeLabelVisible(visible) {
      moveModeLabelSprite.visible = visible;
    },
  };
}

function createAimingMarker() {
  const SLOPE_GRID_ROWS = 9;
  const SLOPE_GRID_COLUMNS = 9;
  const SLOPE_GRID_MAX_CELLS = SLOPE_GRID_ROWS * SLOPE_GRID_COLUMNS;
  const PUTT_GRID_CIRCLE_RADIUS_METERS = 0.08;
  const PUTT_GRID_SURFACE_OFFSET_METERS = 0.012;
  const PUTT_GRID_CIRCLE_OFFSET_LIMIT = 0.8;
  const PUTT_GRID_CIRCLE_REFERENCE_HORIZONTAL_SLOPE = 0.6;
  const PUTT_GRID_CIRCLE_MAX_SCALE = 1;
  const PUTT_GRID_COLOR = '#173c25';
  const PUTT_GRID_OPACITY = 0.65;
  const markerCanvas = document.createElement('canvas');
  const markerContext = markerCanvas.getContext('2d');
  if (!markerContext) {
    throw new Error('Failed to create a 2D canvas context for the aiming marker label.');
  }

  const debugSphere = new THREE.Mesh(
    new THREE.SphereGeometry(Math.max(BALL_RADIUS * 0.95, 0.03), 16, 12),
    new THREE.MeshBasicMaterial({
      color: '#ff2d2d',
      wireframe: true,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  const puttAimTarget = new THREE.Mesh(
    new THREE.SphereGeometry(Math.max(BALL_RADIUS * 1.05, 0.05), 16, 12),
    new THREE.MeshBasicMaterial({
      color: '#ff2d2d',
      wireframe: true,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  const markerTexture = new THREE.CanvasTexture(markerCanvas);
  const markerSprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: markerTexture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  const markerAspect = AIMING_MARKER_CANVAS_WIDTH / AIMING_MARKER_CANVAS_HEIGHT;
  const puttGridRoot = new THREE.Group();
  const slopeGridRoot = new THREE.Group();
  const puttGridCircles = [];
  const slopeGridCircles = [];
  const puttGridBaseForward = new THREE.Vector3();
  const slopeGridBaseForward = new THREE.Vector3();
  const cellForward = new THREE.Vector3();
  const cellRight = new THREE.Vector3();
  const horizontalNormal = new THREE.Vector3();
  const liftedCellPosition = new THREE.Vector3();
  const cellMatrix = new THREE.Matrix4();
  const gridVertexA = new THREE.Vector3();
  const gridVertexB = new THREE.Vector3();
  const puttGridLineGeometry = new THREE.BufferGeometry();
  const slopeGridLineGeometry = new THREE.BufferGeometry();
  let puttGridPositions = new Float32Array(0);
  let slopeGridPositions = new Float32Array(0);
  let lastDistanceLabel = '';

  markerCanvas.width = AIMING_MARKER_CANVAS_WIDTH;
  markerCanvas.height = AIMING_MARKER_CANVAS_HEIGHT;
  markerTexture.generateMipmaps = false;
  markerTexture.minFilter = THREE.LinearFilter;
  markerTexture.magFilter = THREE.LinearFilter;
  debugSphere.name = 'aiming-marker-debug-sphere';
  debugSphere.visible = false;
  debugSphere.renderOrder = 994;
  puttAimTarget.name = 'aiming-putt-fake-target';
  puttAimTarget.visible = false;
  puttAimTarget.renderOrder = 996;
  markerSprite.name = 'aiming-marker';
  markerSprite.visible = false;
  markerSprite.frustumCulled = false;
  markerSprite.renderOrder = 995;
  markerSprite.center.set(0.5, 0);
  markerSprite.scale.set(1 * markerAspect, 1, 1);
  puttGridRoot.name = 'aiming-putt-grid';
  puttGridRoot.visible = false;
  slopeGridRoot.name = 'aiming-hole-slope-grid';
  slopeGridRoot.visible = false;

  puttGridLineGeometry.setAttribute('position', new THREE.BufferAttribute(puttGridPositions, 3));
  puttGridLineGeometry.setDrawRange(0, 0);
  slopeGridLineGeometry.setAttribute('position', new THREE.BufferAttribute(slopeGridPositions, 3));
  slopeGridLineGeometry.setDrawRange(0, 0);

  const puttGridLines = new THREE.LineSegments(puttGridLineGeometry, new THREE.LineBasicMaterial({
    color: PUTT_GRID_COLOR,
    transparent: true,
    opacity: PUTT_GRID_OPACITY,
    depthWrite: false,
    toneMapped: false,
  }));
  puttGridLines.renderOrder = 991;
  puttGridRoot.add(puttGridLines);

  const slopeGridLines = new THREE.LineSegments(slopeGridLineGeometry, new THREE.LineBasicMaterial({
    color: PUTT_GRID_COLOR,
    transparent: true,
    opacity: PUTT_GRID_OPACITY,
    depthWrite: false,
    toneMapped: false,
  }));
  slopeGridLines.renderOrder = 991;
  slopeGridRoot.add(slopeGridLines);

  const puttGridCircleGeometry = new THREE.CircleGeometry(PUTT_GRID_CIRCLE_RADIUS_METERS, 20);
  const puttGridCircleMaterial = new THREE.MeshBasicMaterial({
    color: PUTT_GRID_COLOR,
    transparent: true,
    opacity: PUTT_GRID_OPACITY,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });

  for (let cellIndex = 0; cellIndex < SLOPE_GRID_MAX_CELLS; cellIndex += 1) {
    const circle = new THREE.Mesh(puttGridCircleGeometry, puttGridCircleMaterial);
    circle.renderOrder = 992;
    circle.visible = false;
    puttGridRoot.add(circle);
    puttGridCircles.push(circle);
  }

  for (let cellIndex = 0; cellIndex < SLOPE_GRID_MAX_CELLS; cellIndex += 1) {
    const circle = new THREE.Mesh(puttGridCircleGeometry, puttGridCircleMaterial);
    circle.renderOrder = 992;
    circle.visible = false;
    slopeGridRoot.add(circle);
    slopeGridCircles.push(circle);
  }

  const writeGridSegment = (positions, maxSegments, segmentIndex, start, end) => {
    if (segmentIndex >= maxSegments) {
      return segmentIndex;
    }

    const baseIndex = segmentIndex * 6;
    positions[baseIndex] = start.x;
    positions[baseIndex + 1] = start.y;
    positions[baseIndex + 2] = start.z;
    positions[baseIndex + 3] = end.x;
    positions[baseIndex + 4] = end.y;
    positions[baseIndex + 5] = end.z;
    return segmentIndex + 1;
  };

  const getGridLineSegmentCount = (rowCount, columnCount) => (
    ((rowCount + 1) * columnCount) + ((columnCount + 1) * rowCount)
  );

  const ensureGridOverlayCapacity = (gridLineGeometry, gridCircles, gridRoot, rowCount, columnCount, positions) => {
    const requiredCellCount = rowCount * columnCount;
    while (gridCircles.length < requiredCellCount) {
      const circle = new THREE.Mesh(puttGridCircleGeometry, puttGridCircleMaterial);
      circle.renderOrder = 992;
      circle.visible = false;
      gridRoot.add(circle);
      gridCircles.push(circle);
    }

    const requiredSegmentCount = getGridLineSegmentCount(rowCount, columnCount);
    const requiredPositionCount = requiredSegmentCount * 2 * 3;
    if (positions.length !== requiredPositionCount) {
      const nextPositions = new Float32Array(requiredPositionCount);
      gridLineGeometry.setAttribute('position', new THREE.BufferAttribute(nextPositions, 3));
      return {
        maxSegments: requiredSegmentCount,
        positions: nextPositions,
      };
    }

    return {
      maxSegments: requiredSegmentCount,
      positions,
    };
  };

  const getVertexRecord = (preview, rowIndex, columnIndex) => preview.vertices[
    rowIndex * (preview.columns + 1) + columnIndex
  ];

  const copyLiftedVertex = (vertexRecord, target) => {
    target.copy(vertexRecord.point).addScaledVector(
      vertexRecord.normal,
      PUTT_GRID_SURFACE_OFFSET_METERS,
    );
  };

  const clearGridOverlay = (gridRoot, gridLineGeometry, gridCircles) => {
    gridRoot.visible = false;
    gridLineGeometry.setDrawRange(0, 0);
    for (const circle of gridCircles) {
      circle.visible = false;
    }
  };

  const renderGridOverlay = (preview, gridRoot, gridLineGeometry, gridCircles, gridBaseForward, positions) => {
    if (!preview?.cells?.length || !preview?.vertices?.length) {
      clearGridOverlay(gridRoot, gridLineGeometry, gridCircles);
      return positions;
    }

    const previewRowCount = Math.max(Math.floor(preview.rows ?? 0), 0);
    const previewColumnCount = Math.max(Math.floor(preview.columns ?? 0), 0);
    if (previewRowCount <= 0 || previewColumnCount <= 0) {
      clearGridOverlay(gridRoot, gridLineGeometry, gridCircles);
      return positions;
    }

    const ensuredCapacity = ensureGridOverlayCapacity(
      gridLineGeometry,
      gridCircles,
      gridRoot,
      previewRowCount,
      previewColumnCount,
      positions,
    );
    const gridPositionsTarget = ensuredCapacity.positions;
    const maxSegments = ensuredCapacity.maxSegments;

    gridBaseForward.copy(preview.forward ?? WORLD_FORWARD);
    gridBaseForward.y = 0;
    if (gridBaseForward.lengthSq() <= 1e-8) {
      gridBaseForward.copy(WORLD_FORWARD);
    }
    gridBaseForward.normalize();

    let segmentCount = 0;
    for (let rowIndex = 0; rowIndex <= previewRowCount; rowIndex += 1) {
      for (let columnIndex = 0; columnIndex < previewColumnCount; columnIndex += 1) {
        copyLiftedVertex(getVertexRecord(preview, rowIndex, columnIndex), gridVertexA);
        copyLiftedVertex(getVertexRecord(preview, rowIndex, columnIndex + 1), gridVertexB);
        segmentCount = writeGridSegment(gridPositionsTarget, maxSegments, segmentCount, gridVertexA, gridVertexB);
      }
    }

    for (let columnIndex = 0; columnIndex <= previewColumnCount; columnIndex += 1) {
      for (let rowIndex = 0; rowIndex < previewRowCount; rowIndex += 1) {
        copyLiftedVertex(getVertexRecord(preview, rowIndex, columnIndex), gridVertexA);
        copyLiftedVertex(getVertexRecord(preview, rowIndex + 1, columnIndex), gridVertexB);
        segmentCount = writeGridSegment(gridPositionsTarget, maxSegments, segmentCount, gridVertexA, gridVertexB);
      }
    }

    gridLineGeometry.attributes.position.needsUpdate = true;
    gridLineGeometry.computeBoundingSphere();
    gridLineGeometry.setDrawRange(0, segmentCount * 2);

    const maxCircleOffsetMeters = Math.min(preview.cellWidthMeters, preview.cellDepthMeters) * PUTT_GRID_CIRCLE_OFFSET_LIMIT;
    for (let cellIndex = 0; cellIndex < gridCircles.length; cellIndex += 1) {
      const circle = gridCircles[cellIndex];
      const cellPreview = preview.cells[cellIndex];
      if (!cellPreview) {
        circle.visible = false;
        continue;
      }

      cellForward.copy(gridBaseForward).addScaledVector(
        cellPreview.normal,
        -gridBaseForward.dot(cellPreview.normal),
      );
      if (cellForward.lengthSq() <= 1e-8) {
        cellForward.copy(WORLD_FORWARD).addScaledVector(
          cellPreview.normal,
          -WORLD_FORWARD.dot(cellPreview.normal),
        );
      }
      if (cellForward.lengthSq() <= 1e-8) {
        circle.visible = false;
        continue;
      }
      cellForward.normalize();
      cellRight.crossVectors(cellForward, cellPreview.normal);
      if (cellRight.lengthSq() <= 1e-8) {
        circle.visible = false;
        continue;
      }
      cellRight.normalize();

      liftedCellPosition.copy(cellPreview.point).addScaledVector(
        cellPreview.normal,
        PUTT_GRID_SURFACE_OFFSET_METERS,
      );
      cellMatrix.makeBasis(cellRight, cellForward, cellPreview.normal);
      circle.position.copy(liftedCellPosition);
      circle.quaternion.setFromRotationMatrix(cellMatrix).normalize();

      horizontalNormal.copy(cellPreview.normal);
      horizontalNormal.y = 0;
      const horizontalSlopeStrength = horizontalNormal.length();
      let circleOffsetScale = 0;
      if (horizontalSlopeStrength > 1e-8) {
        horizontalNormal.divideScalar(horizontalSlopeStrength);
        const slopeAlpha = THREE.MathUtils.clamp(
          horizontalSlopeStrength / PUTT_GRID_CIRCLE_REFERENCE_HORIZONTAL_SLOPE,
          0,
          1,
        );
        // Strongly bias gentle slopes upward so even subtle break stays legible.
        circleOffsetScale = Math.pow(slopeAlpha, 0.4);
      }

      const circleOffsetMeters = maxCircleOffsetMeters * circleOffsetScale;
      const targetRightOffset = horizontalNormal.dot(cellRight) * circleOffsetMeters;
      const targetForwardOffset = horizontalNormal.dot(cellForward) * circleOffsetMeters;

      if (circle.userData.rightOffset === undefined) {
        circle.userData.rightOffset = targetRightOffset;
        circle.userData.forwardOffset = targetForwardOffset;
        circle.userData.circleScale = circleOffsetScale;
      } else {
        circle.userData.rightOffset += (targetRightOffset - circle.userData.rightOffset) * 0.2;
        circle.userData.forwardOffset += (targetForwardOffset - circle.userData.forwardOffset) * 0.2;
        circle.userData.circleScale += (circleOffsetScale - circle.userData.circleScale) * 0.2;
      }

      circle.position.addScaledVector(cellRight, circle.userData.rightOffset);
      circle.position.addScaledVector(cellForward, circle.userData.forwardOffset);
      circle.position.addScaledVector(cellPreview.normal, 0.0015);
      circle.visible = true;
      const circleScale = THREE.MathUtils.lerp(1, PUTT_GRID_CIRCLE_MAX_SCALE, circle.userData.circleScale);
      circle.scale.set(circleScale, circleScale, 1);
      circle.updateMatrixWorld();
    }

    gridRoot.visible = true;
    return gridPositionsTarget;
  };

  const redrawMarker = () => {
    const centerX = markerCanvas.width * 0.5;
    const textY = 112;
    const triangleTopY = 176;
    const triangleBottomY = 284;
    const triangleHalfWidth = 50;

    markerContext.clearRect(0, 0, markerCanvas.width, markerCanvas.height);
    markerContext.textAlign = 'center';
    markerContext.textBaseline = 'middle';
    markerContext.lineJoin = 'round';
    markerContext.shadowBlur = 12;
    markerContext.shadowColor = 'rgba(0, 0, 0, 0.4)';

    markerContext.font = `700 58px ${HOLE_MARKER_LABEL_FONT_FAMILY}`;
    markerContext.lineWidth = 12;
    markerContext.strokeStyle = 'rgba(0, 0, 0, 0.95)';
    markerContext.fillStyle = '#ffffff';
    markerContext.strokeText(lastDistanceLabel, centerX, textY);
    markerContext.fillText(lastDistanceLabel, centerX, textY);

    markerContext.beginPath();
    markerContext.moveTo(centerX, triangleBottomY);
    markerContext.lineTo(centerX - triangleHalfWidth, triangleTopY);
    markerContext.lineTo(centerX + triangleHalfWidth, triangleTopY);
    markerContext.closePath();
    markerContext.lineWidth = 14;
    markerContext.strokeStyle = 'rgba(0, 0, 0, 0.98)';
    markerContext.fillStyle = '#ffffff';
    markerContext.stroke();
    markerContext.fill();

    markerTexture.needsUpdate = true;
  };

  if (document.fonts?.load) {
    document.fonts.load(`700 58px ${HOLE_MARKER_LABEL_FONT_FAMILY}`).then(() => {
      redrawMarker();
    }).catch(() => {});
  }

  redrawMarker();

  return {
    sprite: markerSprite,
    debugSphere,
    puttGridRoot,
    slopeGridRoot,
    puttAimTarget,

    setDistanceLabel(distanceLabel) {
      if (distanceLabel === lastDistanceLabel) {
        return;
      }

      lastDistanceLabel = distanceLabel;
      redrawMarker();
    },

    setWorldPosition(worldPosition) {
      markerSprite.position.copy(worldPosition);
      markerSprite.position.y += AIMING_MARKER_WORLD_Y_OFFSET;
      debugSphere.position.copy(worldPosition);
    },

    setWorldHeight(worldHeight) {
      markerSprite.scale.set(worldHeight * markerAspect, worldHeight, 1);
    },

    setVisible(visible) {
      markerSprite.visible = visible;
      debugSphere.visible = visible;
    },

    setPuttAimTarget(worldPosition) {
      if (!worldPosition) {
        puttAimTarget.visible = false;
        return;
      }

      puttAimTarget.position.copy(worldPosition);
      puttAimTarget.position.y += AIMING_MARKER_WORLD_Y_OFFSET;
      puttAimTarget.visible = true;
    },

    setPuttGrid(preview) {
      puttGridPositions = renderGridOverlay(
        preview,
        puttGridRoot,
        puttGridLineGeometry,
        puttGridCircles,
        puttGridBaseForward,
        puttGridPositions,
      );
    },

    setSlopeGrid(preview) {
      slopeGridPositions = renderGridOverlay(
        preview,
        slopeGridRoot,
        slopeGridLineGeometry,
        slopeGridCircles,
        slopeGridBaseForward,
        slopeGridPositions,
      );
    },
  };
}
