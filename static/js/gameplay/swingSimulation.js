import * as THREE from 'three';
import {
  SWING_SIMULATION_STEP_SECONDS,
  SWING_SIMULATION_MAX_CATCHUP_SECONDS,
  SWING_SIMULATION_MAX_STEPS_PER_FRAME,
  SWING_PACKET_BUFFER_LIMIT,
  PHONE_ANGULAR_SPEED_TO_CLUB_HEAD_SPEED_GAIN,
  CLUB_HEAD_AIMING_PREVIEW_LAUNCH_MIN_SPEED_RATIO,
  CLUB_SWING_WHOOSH_COOLDOWN_MS,
  CLUB_SWING_WHOOSH_MIN_SPEED,
  CLUB_SWING_WHOOSH_REARM_SPEED
} from '../game/constants.js';
import { decodeSwingStatePacket } from '../protocol.js';

export function createSwingSimulation(params) {
  const { character, detectClubBallImpact, hud, viewHudController, getActiveClub, getPlayerState, ballPhysics, shotImpactAudio } = params;

  const pendingSwingSamples = [];
  const simulatedIncomingQuaternion = new THREE.Quaternion();
  const simulatedSwingState = {
    perpendicularAngularSpeedRadiansPerSecond: 0,
    motionAgeMilliseconds: 65535,
    sequence: 0,
    receivedAtTimeMs: 0,
  };

  let hasIncomingOrientation = false;
  let latestAcceptedSwingSequence = null;
  let swingSimulationAccumulatorSeconds = 0;
  let swingSimulationTimeMs = performance.now();
  let clubWhooshLatched = false;
  let lastClubWhooshTimeMs = -Infinity;

  const enqueueIncomingSwingSample = (quaternion, swingState, receivedAtTimeMs) => {
    if (!Number.isFinite(swingState?.sequence)) return false;

    const isNewer = (seq, ref) => {
      if (!Number.isFinite(ref)) return true;
      const delta = (seq - ref + 65536) % 65536;
      return delta > 0 && delta < 32768;
    };

    if (!isNewer(swingState.sequence, latestAcceptedSwingSequence)) return false;

    latestAcceptedSwingSequence = swingState.sequence;
    pendingSwingSamples.push({
      quaternion: quaternion.clone(),
      perpendicularAngularSpeedRadiansPerSecond: Number.isFinite(swingState.perpendicularAngularSpeedRadiansPerSecond) ? swingState.perpendicularAngularSpeedRadiansPerSecond : 0,
      motionAgeMilliseconds: Number.isFinite(swingState.motionAgeMilliseconds) ? swingState.motionAgeMilliseconds : 65535,
      sequence: swingState.sequence,
      receivedAtTimeMs,
    });

    if (pendingSwingSamples.length > SWING_PACKET_BUFFER_LIMIT) {
      pendingSwingSamples.splice(0, pendingSwingSamples.length - SWING_PACKET_BUFFER_LIMIT);
    }
    return true;
  };

  const handleIncomingSwingPacket = (packet, incomingQuaternion) => {
    const decoded = decodeSwingStatePacket(packet, incomingQuaternion, {});
    if (!decoded) return;
    const receivedAtTimeMs = performance.now();
    if (enqueueIncomingSwingSample(incomingQuaternion, decoded, receivedAtTimeMs)) {
      viewHudController.recordPacket();
      hud.updateQuaternion(incomingQuaternion);
    }
  };

  const consumeSwingSamplesUpTo = (simulationTimeMs) => {
    let consumedAny = false;
    while (pendingSwingSamples.length > 0 && pendingSwingSamples[0].receivedAtTimeMs <= simulationTimeMs) {
      const sample = pendingSwingSamples.shift();
      simulatedIncomingQuaternion.copy(sample.quaternion);
      simulatedSwingState.perpendicularAngularSpeedRadiansPerSecond = sample.perpendicularAngularSpeedRadiansPerSecond;
      simulatedSwingState.motionAgeMilliseconds = sample.motionAgeMilliseconds;
      simulatedSwingState.sequence = sample.sequence;
      simulatedSwingState.receivedAtTimeMs = sample.receivedAtTimeMs;
      consumedAny = true;
    }
    if (consumedAny) hasIncomingOrientation = true;
  };

  const stepSwingSimulation = (deltaSeconds) => {
    const clampedDelta = Math.min(Math.max(deltaSeconds, 0), SWING_SIMULATION_MAX_CATCHUP_SECONDS);
    swingSimulationAccumulatorSeconds = Math.min(swingSimulationAccumulatorSeconds + clampedDelta, SWING_SIMULATION_MAX_CATCHUP_SECONDS);

    let stepCount = 0;
    while (swingSimulationAccumulatorSeconds >= SWING_SIMULATION_STEP_SECONDS && stepCount < SWING_SIMULATION_MAX_STEPS_PER_FRAME) {
      swingSimulationTimeMs += SWING_SIMULATION_STEP_SECONDS * 1000;
      consumeSwingSamplesUpTo(swingSimulationTimeMs);
      character.update(SWING_SIMULATION_STEP_SECONDS, hasIncomingOrientation ? simulatedIncomingQuaternion : null);
      detectClubBallImpact(character.getDebugTelemetry(), swingSimulationTimeMs);
      swingSimulationAccumulatorSeconds -= SWING_SIMULATION_STEP_SECONDS;
      stepCount += 1;
    }
    if (stepCount === 0 && pendingSwingSamples.length > 0) consumeSwingSamplesUpTo(swingSimulationTimeMs);
  };

  const getIncomingClubHeadSpeedMetersPerSecond = (swingState = simulatedSwingState, referenceTimeMs = performance.now()) => {
    if (!Number.isFinite(swingState.perpendicularAngularSpeedRadiansPerSecond) || swingState.perpendicularAngularSpeedRadiansPerSecond <= 0) return 0;
    const age = swingState.receivedAtTimeMs > 0 ? Math.max(referenceTimeMs - swingState.receivedAtTimeMs, 0) : 65535;
    if (swingState.motionAgeMilliseconds + age > 250) return 0;
    const club = getActiveClub();
    const len = club?.effectiveLengthMeters ?? 0.9;
    return swingState.perpendicularAngularSpeedRadiansPerSecond * len * PHONE_ANGULAR_SPEED_TO_CLUB_HEAD_SPEED_GAIN;
  };

  const updateClubWhooshAudio = () => {
    const ballTele = ballPhysics.getDebugTelemetry();
    if (getPlayerState() !== 'control' || ballTele.phase !== 'ready') {
      clubWhooshLatched = false;
      return;
    }
    const speed = getIncomingClubHeadSpeedMetersPerSecond(simulatedSwingState, swingSimulationTimeMs);
    const now = performance.now();
    if (clubWhooshLatched && speed < CLUB_SWING_WHOOSH_REARM_SPEED) clubWhooshLatched = false;
    if (speed > CLUB_SWING_WHOOSH_MIN_SPEED) {
      if (!clubWhooshLatched && now - lastClubWhooshTimeMs >= CLUB_SWING_WHOOSH_COOLDOWN_MS) {
        shotImpactAudio.playWhoosh(speed);
        clubWhooshLatched = true;
        lastClubWhooshTimeMs = now;
      }
    }
  };

  const reset = () => {
    hasIncomingOrientation = false;
    pendingSwingSamples.length = 0;
    swingSimulationAccumulatorSeconds = 0;
    swingSimulationTimeMs = performance.now();
    latestAcceptedSwingSequence = null;
    simulatedIncomingQuaternion.identity();
    simulatedSwingState.perpendicularAngularSpeedRadiansPerSecond = 0;
    simulatedSwingState.motionAgeMilliseconds = 65535;
    simulatedSwingState.sequence = 0;
    simulatedSwingState.receivedAtTimeMs = 0;
  };

  return {
    handleIncomingSwingPacket,
    stepSwingSimulation,
    updateClubWhooshAudio,
    getIncomingClubHeadSpeedMetersPerSecond,
    reset,
    getSimulatedSwingState: () => ({ ...simulatedSwingState }),
    hasIncomingOrientation: () => hasIncomingOrientation
  };
}
