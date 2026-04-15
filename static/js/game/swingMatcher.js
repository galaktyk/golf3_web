import * as THREE from 'three';

const SWING_LOOKUP_SAMPLE_RATE = 240;
const SWING_LOOKUP_RESAMPLED_COUNT = 180;
const SWING_MATCH_CONTINUITY_WEIGHT = 0.3;
const SWING_MATCH_SWITCH_MARGIN = 0.035;
const SWING_MATCH_DISTANCE_MARGIN = 0.18;
const SWING_MATCH_BLEND_RADIUS = 4;
const SWING_MATCH_BLEND_SIGMA = 1.75;
const SWING_MATCH_BLEND_SCORE_SCALE = 18;
const SWING_MATCH_POSITION_SMOOTHING = 42;
const SWING_TIME_SMOOTHING = 14;
const SWING_SAMPLE_END_EPSILON = 1e-3;
const QUATERNION_MATCH_WEIGHT = 0;
const PRIMARY_AXIS_MATCH_WEIGHT = 0.85;
const SECONDARY_AXIS_MATCH_WEIGHT = 0.05;
const SAMPLE_VARIATION_EPSILON = 1e-4;
const DEBUG_PARAMS = new URLSearchParams(window.location.search);
const DEBUG_SWING_MODE = DEBUG_PARAMS.get('debugSwing');
const DEBUG_SWING_SWEEP_RATE = 0.35;
const SOCKET_AXIS_NAME = '+x';
const CLUB_AXIS_NAME = '-y';
const SOCKET_REF_AXIS_NAME = '+y';
const CLUB_REF_AXIS_NAME = '+x';
const SOCKET_SHAFT_AXIS_LOCAL = new THREE.Vector3(1, 0, 0);
const SOCKET_REFERENCE_AXIS_LOCAL = new THREE.Vector3(0, 1, 0);
const CLUB_SHAFT_AXIS_LOCAL = new THREE.Vector3(0, -1, 0);
const CLUB_REFERENCE_AXIS_LOCAL = new THREE.Vector3(1, 0, 0);

export function createSwingMatcher({ onStatus }) {
  const socketWorldQuaternion = new THREE.Quaternion();
  const mappedImuQuaternion = new THREE.Quaternion();
  const referencePrimaryAxis = new THREE.Vector3();
  const referenceSecondaryAxis = new THREE.Vector3();
  let swingSamples = [];
  let swingDurationSeconds = 0;
  let currentMatchSamplePosition = 0;
  let currentMatchFrameIndex = 0;
  let targetAnimationTimeSeconds = 0;
  let hasPoseMatch = false;
  let hasLoggedFrozenSamples = false;

  const initialize = ({ durationSeconds, clipName, trackNames, sampleSocketQuaternionAtTime }) => {
    swingDurationSeconds = durationSeconds;
    currentMatchSamplePosition = 0;
    currentMatchFrameIndex = 0;
    targetAnimationTimeSeconds = 0;
    hasPoseMatch = false;
    hasLoggedFrozenSamples = false;
    swingSamples = buildSwingSamples(sampleSocketQuaternionAtTime);
    logSwingDiagnostics(clipName, trackNames);
  };

  const buildSwingSamples = (sampleSocketQuaternionAtTime) => {
    const denseSamples = [];
    const sampleCount = Math.max(2, Math.ceil(swingDurationSeconds * SWING_LOOKUP_SAMPLE_RATE) + 1);
    const sampleDurationSeconds = Math.max(0, swingDurationSeconds - SWING_SAMPLE_END_EPSILON);
    const sampleStepSeconds = sampleDurationSeconds / (sampleCount - 1);

    for (let index = 0; index < sampleCount; index += 1) {
      const sampleTime = sampleStepSeconds * index;
      sampleSocketQuaternionAtTime(sampleTime, socketWorldQuaternion);
      denseSamples.push({
        index,
        time: sampleTime,
        quaternion: socketWorldQuaternion.clone(),
        primaryAxis: SOCKET_SHAFT_AXIS_LOCAL.clone().applyQuaternion(socketWorldQuaternion),
        secondaryAxis: SOCKET_REFERENCE_AXIS_LOCAL.clone().applyQuaternion(socketWorldQuaternion),
      });
    }

    return resampleSwingSamplesByPoseDistance(denseSamples);
  };

  const resampleSwingSamplesByPoseDistance = (denseSamples) => {
    if (denseSamples.length <= 2) {
      return denseSamples;
    }

    const cumulativeDistances = [0];
    for (let index = 1; index < denseSamples.length; index += 1) {
      const previousSample = denseSamples[index - 1];
      const currentSample = denseSamples[index];
      cumulativeDistances.push(
        cumulativeDistances[index - 1] + getPoseDistance(previousSample, currentSample),
      );
    }

    const totalDistance = cumulativeDistances[cumulativeDistances.length - 1];
    if (totalDistance <= 0) {
      return denseSamples;
    }

    const lookupSamples = [];
    const lookupCount = Math.max(2, SWING_LOOKUP_RESAMPLED_COUNT);
    let denseIndex = 1;

    for (let lookupIndex = 0; lookupIndex < lookupCount; lookupIndex += 1) {
      const targetDistance = totalDistance * (lookupIndex / (lookupCount - 1));
      while (denseIndex < cumulativeDistances.length - 1 && cumulativeDistances[denseIndex] < targetDistance) {
        denseIndex += 1;
      }

      const previousIndex = Math.max(0, denseIndex - 1);
      const nextIndex = denseIndex;
      const distanceStart = cumulativeDistances[previousIndex];
      const distanceEnd = cumulativeDistances[nextIndex];
      const distanceSpan = Math.max(distanceEnd - distanceStart, Number.EPSILON);
      const interpolationAlpha = THREE.MathUtils.clamp(
        (targetDistance - distanceStart) / distanceSpan,
        0,
        1,
      );

      const previousSample = denseSamples[previousIndex];
      const nextSample = denseSamples[nextIndex];
      const interpolatedQuaternion = new THREE.Quaternion().slerpQuaternions(
        previousSample.quaternion,
        nextSample.quaternion,
        interpolationAlpha,
      );

      lookupSamples.push({
        index: lookupIndex,
        time: THREE.MathUtils.lerp(previousSample.time, nextSample.time, interpolationAlpha),
        quaternion: interpolatedQuaternion,
        primaryAxis: SOCKET_SHAFT_AXIS_LOCAL.clone().applyQuaternion(interpolatedQuaternion),
        secondaryAxis: SOCKET_REFERENCE_AXIS_LOCAL.clone().applyQuaternion(interpolatedQuaternion),
      });
    }

    return lookupSamples;
  };

  const getPoseDistance = (previousSample, currentSample) => {
    const quaternionDistance = 1 - Math.abs(previousSample.quaternion.dot(currentSample.quaternion));
    const primaryDistance = 1 - previousSample.primaryAxis.dot(currentSample.primaryAxis);
    const secondaryDistance = 1 - previousSample.secondaryAxis.dot(currentSample.secondaryAxis);
    return (quaternionDistance * Math.max(QUATERNION_MATCH_WEIGHT, 0.1))
      + (primaryDistance * PRIMARY_AXIS_MATCH_WEIGHT)
      + (secondaryDistance * SECONDARY_AXIS_MATCH_WEIGHT);
  };

  const logSwingDiagnostics = (clipName, trackNames) => {
    if (swingSamples.length === 0) {
      return;
    }

    const firstQuaternion = swingSamples[0].quaternion;
    const hasSampleVariation = swingSamples.some((sample) => (
      1 - Math.abs(firstQuaternion.dot(sample.quaternion)) > SAMPLE_VARIATION_EPSILON
    ));

    console.groupCollapsed('[swing-debug] character animation diagnostics');
    console.log('clip name:', clipName || '(unnamed)');
    console.log('duration:', swingDurationSeconds);
    console.log('track count:', trackNames.length);
    console.log('sample count:', swingSamples.length);
    console.log('lookup sample rate:', SWING_LOOKUP_SAMPLE_RATE);
    console.log('lookup resampled count:', SWING_LOOKUP_RESAMPLED_COUNT);
    console.log('Bone01 sampled variation:', hasSampleVariation);
    console.log('first track names:', trackNames.slice(0, 12));
    console.log('socketAxis:', SOCKET_AXIS_NAME, SOCKET_SHAFT_AXIS_LOCAL.toArray());
    console.log('socketRefAxis:', SOCKET_REF_AXIS_NAME, SOCKET_REFERENCE_AXIS_LOCAL.toArray());
    console.log('clubAxis:', CLUB_AXIS_NAME, CLUB_SHAFT_AXIS_LOCAL.toArray());
    console.log('clubRefAxis:', CLUB_REF_AXIS_NAME, CLUB_REFERENCE_AXIS_LOCAL.toArray());
    console.groupEnd();

    if (!hasSampleVariation && !hasLoggedFrozenSamples) {
      hasLoggedFrozenSamples = true;
      onStatus('Swing clip loaded, but Bone01 does not change across sampled frames. Check browser console.');
      console.warn('[swing-debug] Bone01 stayed effectively unchanged across sampled frames. The clip may not be bound to this rig, or Bone01 may not be animated in the source clip.');
    }
  };

  const findTargetAnimationSample = (referenceQuaternion) => {
    if (swingSamples.length === 0) {
      return null;
    }

    referencePrimaryAxis.copy(CLUB_SHAFT_AXIS_LOCAL).applyQuaternion(referenceQuaternion);
    referenceSecondaryAxis.copy(CLUB_REFERENCE_AXIS_LOCAL).applyQuaternion(referenceQuaternion);

    const sampleScores = new Array(swingSamples.length);
    let bestSample = null;
    let bestScore = -Infinity;
    let currentSampleScore = -Infinity;

    for (const sample of swingSamples) {
      const quaternionScore = Math.abs(referenceQuaternion.dot(sample.quaternion));
      const primaryScore = referencePrimaryAxis.dot(sample.primaryAxis);
      const secondaryScore = referenceSecondaryAxis.dot(sample.secondaryAxis);
      const continuityPenalty = hasPoseMatch
        ? (Math.abs(sample.index - currentMatchSamplePosition) / Math.max(swingSamples.length - 1, 1)) * SWING_MATCH_CONTINUITY_WEIGHT
        : 0;
      const score = (quaternionScore * QUATERNION_MATCH_WEIGHT)
        + (primaryScore * PRIMARY_AXIS_MATCH_WEIGHT)
        + (secondaryScore * SECONDARY_AXIS_MATCH_WEIGHT)
        - continuityPenalty;
      sampleScores[sample.index] = score;

      if (score > bestScore) {
        bestScore = score;
        bestSample = sample;
      }

      if (hasPoseMatch) {
        const sampleDistanceFromCurrent = Math.abs(sample.index - currentMatchSamplePosition);
        if (sampleDistanceFromCurrent < 0.5 && score > currentSampleScore) {
          currentSampleScore = score;
        }
      }
    }

    if (hasPoseMatch && currentSampleScore === -Infinity) {
      const nearestSample = swingSamples[Math.round(currentMatchSamplePosition)];
      if (nearestSample) {
        const quaternionScore = Math.abs(referenceQuaternion.dot(nearestSample.quaternion));
        const primaryScore = referencePrimaryAxis.dot(nearestSample.primaryAxis);
        const secondaryScore = referenceSecondaryAxis.dot(nearestSample.secondaryAxis);
        currentSampleScore = (quaternionScore * QUATERNION_MATCH_WEIGHT)
          + (primaryScore * PRIMARY_AXIS_MATCH_WEIGHT)
          + (secondaryScore * SECONDARY_AXIS_MATCH_WEIGHT);
      }
    }

    if (hasPoseMatch && bestSample) {
      const jumpDistance = Math.abs(bestSample.index - currentMatchSamplePosition) / Math.max(swingSamples.length - 1, 1);
      const requiredScoreGain = SWING_MATCH_SWITCH_MARGIN + (jumpDistance * SWING_MATCH_DISTANCE_MARGIN);
      if (bestScore < currentSampleScore + requiredScoreGain) {
        const heldPosition = THREE.MathUtils.clamp(currentMatchSamplePosition, 0, Math.max(swingSamples.length - 1, 0));
        return {
          ...(swingSamples[Math.round(heldPosition)] ?? bestSample),
          index: Math.round(heldPosition),
          position: heldPosition,
          time: getSampleTimeAtPosition(heldPosition),
        };
      }
    }

    return blendMatchedSample(bestSample, bestScore, sampleScores);
  };

  const getSampleTimeAtPosition = (samplePosition) => {
    if (swingSamples.length === 0) {
      return 0;
    }

    const clampedPosition = THREE.MathUtils.clamp(samplePosition, 0, Math.max(swingSamples.length - 1, 0));
    const lowerIndex = Math.floor(clampedPosition);
    const upperIndex = Math.min(swingSamples.length - 1, Math.ceil(clampedPosition));
    if (lowerIndex === upperIndex) {
      return swingSamples[lowerIndex].time;
    }

    const interpolationAlpha = clampedPosition - lowerIndex;
    return THREE.MathUtils.lerp(
      swingSamples[lowerIndex].time,
      swingSamples[upperIndex].time,
      interpolationAlpha,
    );
  };

  const blendMatchedSample = (bestSample, bestScore, sampleScores) => {
    if (!bestSample) {
      return null;
    }

    const startIndex = Math.max(0, bestSample.index - SWING_MATCH_BLEND_RADIUS);
    const endIndex = Math.min(swingSamples.length - 1, bestSample.index + SWING_MATCH_BLEND_RADIUS);
    let totalWeight = 0;
    let blendedTime = 0;
    let blendedPosition = 0;

    for (let sampleIndex = startIndex; sampleIndex <= endIndex; sampleIndex += 1) {
      const sample = swingSamples[sampleIndex];
      const distance = sampleIndex - bestSample.index;
      const gaussianWeight = Math.exp(-(distance * distance) / (2 * SWING_MATCH_BLEND_SIGMA * SWING_MATCH_BLEND_SIGMA));
      const scoreWeight = Math.exp((sampleScores[sampleIndex] - bestScore) * SWING_MATCH_BLEND_SCORE_SCALE);
      const weight = gaussianWeight * scoreWeight;

      totalWeight += weight;
      blendedTime += sample.time * weight;
      blendedPosition += sampleIndex * weight;
    }

    const position = totalWeight > 0 ? blendedPosition / totalWeight : bestSample.index;

    return {
      ...bestSample,
      position,
      time: totalWeight > 0 ? blendedTime / totalWeight : bestSample.time,
    };
  };

  const updateTargetMatchFrame = (matchedSample, deltaSeconds) => {
    if (!matchedSample) {
      return;
    }

    const targetPosition = THREE.MathUtils.clamp(
      matchedSample.position ?? matchedSample.index,
      0,
      Math.max(swingSamples.length - 1, 0),
    );

    currentMatchSamplePosition = hasPoseMatch
      ? THREE.MathUtils.damp(
        currentMatchSamplePosition,
        targetPosition,
        SWING_MATCH_POSITION_SMOOTHING,
        deltaSeconds,
      )
      : targetPosition;
    currentMatchFrameIndex = Math.round(currentMatchSamplePosition);
    targetAnimationTimeSeconds = getSampleTimeAtPosition(currentMatchSamplePosition);
    hasPoseMatch = true;
  };

  return {
    update(deltaSeconds, clubQuaternion, currentAnimationTimeSeconds) {
      if (DEBUG_SWING_MODE === 'sweep' && swingDurationSeconds > 0) {
        targetAnimationTimeSeconds = ((performance.now() / 1000) * DEBUG_SWING_SWEEP_RATE) % swingDurationSeconds;
        return targetAnimationTimeSeconds;
      }

      if (!clubQuaternion || swingSamples.length === 0) {
        return currentAnimationTimeSeconds;
      }

      mappedImuQuaternion.copy(clubQuaternion).normalize();
      const matchedSample = findTargetAnimationSample(mappedImuQuaternion);
      updateTargetMatchFrame(matchedSample, deltaSeconds);
      return THREE.MathUtils.damp(
        currentAnimationTimeSeconds,
        targetAnimationTimeSeconds,
        SWING_TIME_SMOOTHING,
        deltaSeconds,
      );
    },

    initialize,

    getDebugTelemetry() {
      return {
        targetAnimationTimeSeconds,
        currentMatchFrameIndex,
        sampleCount: swingSamples.length,
      };
    },
  };
}
