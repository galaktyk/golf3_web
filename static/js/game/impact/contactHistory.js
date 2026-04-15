import * as THREE from 'three';

const INTERPOLATED_POSITION = new THREE.Vector3();
const INTERPOLATED_QUATERNION = new THREE.Quaternion();
const INTERPOLATED_FACING_FORWARD = new THREE.Vector3();

export function interpolateClubHeadSample(startSample, endSample, alpha) {
  const clampedAlpha = THREE.MathUtils.clamp(alpha, 0, 1);

  INTERPOLATED_POSITION.lerpVectors(startSample.position, endSample.position, clampedAlpha);
  INTERPOLATED_QUATERNION.slerpQuaternions(startSample.quaternion, endSample.quaternion, clampedAlpha).normalize();
  INTERPOLATED_FACING_FORWARD.lerpVectors(
    startSample.characterFacingForward,
    endSample.characterFacingForward,
    clampedAlpha,
  );
  INTERPOLATED_FACING_FORWARD.y = 0;

  if (INTERPOLATED_FACING_FORWARD.lengthSq() <= 1e-8) {
    INTERPOLATED_FACING_FORWARD.copy(startSample.characterFacingForward);
    INTERPOLATED_FACING_FORWARD.y = 0;
  }

  if (INTERPOLATED_FACING_FORWARD.lengthSq() <= 1e-8) {
    INTERPOLATED_FACING_FORWARD.set(0, 0, -1);
  } else {
    INTERPOLATED_FACING_FORWARD.normalize();
  }

  return {
    timeSeconds: THREE.MathUtils.lerp(startSample.timeSeconds, endSample.timeSeconds, clampedAlpha),
    position: INTERPOLATED_POSITION.clone(),
    quaternion: INTERPOLATED_QUATERNION.clone(),
    characterFacingForward: INTERPOLATED_FACING_FORWARD.clone(),
  };
}
