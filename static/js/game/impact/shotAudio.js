import {
  CLUB_SWING_WHOOSH_MAX_SPEED,
  SHOT_AUDIO_LIGHT_MAX_IMPACT_SPEED,
  SHOT_AUDIO_MEDIUM_MAX_IMPACT_SPEED,
  SHOT_AUDIO_VOLUME,
} from '/static/js/game/constants.js';
import { resolveAssetUrl } from '../../assets.js';
import { SURFACE_TYPES } from '/static/js/game/surfaceData.js';

const SHOT_AUDIO_PATHS = {
  light: resolveAssetUrl('audio_clip/shot/shot_light_normal.wav'),
  medium: resolveAssetUrl('audio_clip/shot/shot_medium_normal.wav'),
  practice: resolveAssetUrl('audio_clip/shot/shot_practice.wav'),
  strong: resolveAssetUrl('audio_clip/shot/shot_strong_normal.wav'),
  pangya: resolveAssetUrl('audio_clip/shot/pangya.wav'),
  clubChange: resolveAssetUrl('audio_clip/ui_club_change.wav'),
  whoosh: resolveAssetUrl('audio_clip/whoosh/whoosh_foley1.wav'),
};

const SURFACE_HIT_AUDIO_PATHS = {
  [SURFACE_TYPES.FAIRWAY]: resolveAssetUrl('audio_clip/hit/ball_fairway.wav'),
  [SURFACE_TYPES.GREEN]: resolveAssetUrl('audio_clip/hit/ball_green.wav'),
  [SURFACE_TYPES.HOLE]: resolveAssetUrl('audio_clip/hit/ball_holecup.wav'),
  [SURFACE_TYPES.ROUGH]: resolveAssetUrl('audio_clip/hit/ball_rough.wav'),
  [SURFACE_TYPES.SAND]: resolveAssetUrl('audio_clip/hit/ball_sand.wav'),
  [SURFACE_TYPES.WATER]: resolveAssetUrl('audio_clip/hit/ball_water.wav'),
  [SURFACE_TYPES.WOOD]: resolveAssetUrl('audio_clip/hit/ball_wood.wav'),
  [SURFACE_TYPES.ROCK]: resolveAssetUrl('audio_clip/hit/ball_rock.wav'),
  [SURFACE_TYPES.LEAF]: resolveAssetUrl('audio_clip/hit/ball_leaf.wav'),
  [SURFACE_TYPES.ROAD]: resolveAssetUrl('audio_clip/hit/ball_road.wav'),
  [SURFACE_TYPES.OB]: resolveAssetUrl('audio_clip/hit/ball_rock.wav'),
  [SURFACE_TYPES.DEFAULT]: resolveAssetUrl('audio_clip/hit/ball_rock.wav'),
  ice: resolveAssetUrl('audio_clip/hit/ball_ice.wav'),
};

const AUDIO_UNLOCK_EVENTS = ['pointerdown', 'keydown', 'touchstart'];
const AudioContextCtor = window.AudioContext ?? window.webkitAudioContext ?? null;

export function createShotImpactAudio() {
  const audioEngine = createAudioEngine();
  const clips = {
    light: createClipState(SHOT_AUDIO_PATHS.light, audioEngine),
    medium: createClipState(SHOT_AUDIO_PATHS.medium, audioEngine),
    practice: createClipState(SHOT_AUDIO_PATHS.practice, audioEngine),
    strong: createClipState(SHOT_AUDIO_PATHS.strong, audioEngine),
    pangya: createClipState(SHOT_AUDIO_PATHS.pangya, audioEngine),
    clubChange: createClipState(SHOT_AUDIO_PATHS.clubChange, audioEngine),
    whoosh: createClipState(SHOT_AUDIO_PATHS.whoosh, audioEngine),
  };
  const surfaceClips = Object.fromEntries(
    Object.entries(SURFACE_HIT_AUDIO_PATHS).map(([surfaceType, src]) => [surfaceType, createClipState(src, audioEngine)]),
  );

  const unlockAudio = () => {
    removeUnlockListeners(unlockAudio);
    audioEngine.resume();
    warmClip(clips.light);
    warmClip(clips.medium);
    warmClip(clips.practice);
    warmClip(clips.strong);
    warmClip(clips.pangya);
    warmClip(clips.clubChange);
    warmClip(clips.whoosh);
    for (const clipState of Object.values(surfaceClips)) {
      warmClip(clipState);
    }
  };

  addUnlockListeners(unlockAudio);

  return {
    playForImpactSpeed(impactSpeedMetersPerSecond) {
      if (!Number.isFinite(impactSpeedMetersPerSecond) || impactSpeedMetersPerSecond <= 0) {
        return;
      }

      const clip = selectClip(clips, impactSpeedMetersPerSecond);
      playClip(clip, getLaunchImpactVolume(impactSpeedMetersPerSecond));
    },
    playPangya() {
      playClip(clips.pangya);
    },
    playClubChange() {
      playClip(clips.clubChange);
    },
    playPractice() {
      playClip(clips.practice);
    },
    playSurfaceImpact(surfaceType, impactSpeedMetersPerSecond = null) {
      const clip = resolveSurfaceImpactClip(surfaceClips, surfaceType);
      if (!clip) {
        return;
      }

      playClip(clip, getSurfaceImpactVolume(impactSpeedMetersPerSecond));
    },
    playWhoosh(clubHeadSpeedMetersPerSecond) {
      const volume = getWhooshVolume(clubHeadSpeedMetersPerSecond);
      playClip(clips.whoosh, volume);
    },
  };
}

/**
 * Stores both the decoded buffer state and a media-element fallback for browsers
 * where Web Audio is unavailable or a fetch/decode step fails.
 */
function createClipState(src, audioEngine) {
  const fallbackAudio = new Audio(src);
  fallbackAudio.preload = 'none';
  fallbackAudio.volume = SHOT_AUDIO_VOLUME;

  const clipState = {
    src,
    audioEngine,
    fallbackAudio,
    activeFallbackClones: new Set(),
    buffer: null,
    bufferPromise: null,
    bufferError: null,
  };

  primeClipBuffer(clipState);

  return clipState;
}

function createAudioEngine() {
  if (!AudioContextCtor) {
    return {
      context: null,
      masterGain: null,
      isSupported: false,
      resume() {
        return Promise.resolve();
      },
    };
  }

  const context = new AudioContextCtor();
  const masterGain = context.createGain();
  masterGain.gain.value = 1;
  masterGain.connect(context.destination);

  return {
    context,
    masterGain,
    isSupported: true,
    resume() {
      if (context.state === 'running') {
        return Promise.resolve();
      }

      return context.resume().catch(() => {});
    },
  };
}

function selectClip(clips, impactSpeedMetersPerSecond) {
  if (impactSpeedMetersPerSecond < SHOT_AUDIO_LIGHT_MAX_IMPACT_SPEED) {
    return clips.light;
  }

  if (impactSpeedMetersPerSecond < SHOT_AUDIO_MEDIUM_MAX_IMPACT_SPEED) {
    return clips.medium;
  }

  return clips.strong;
}

function addUnlockListeners(unlockAudio) {
  for (const eventName of AUDIO_UNLOCK_EVENTS) {
    window.addEventListener(eventName, unlockAudio, { passive: true });
  }
}

function removeUnlockListeners(unlockAudio) {
  for (const eventName of AUDIO_UNLOCK_EVENTS) {
    window.removeEventListener(eventName, unlockAudio);
  }
}

/**
 * Resolves the clip used for a surface hit, with a rocky fallback for unknown surfaces.
 */
function resolveSurfaceImpactClip(surfaceClips, surfaceType) {
  if (surfaceType && surfaceClips[surfaceType]) {
    return surfaceClips[surfaceType];
  }

  return surfaceClips[SURFACE_TYPES.DEFAULT] ?? null;
}

function playClip(clipState, volume = SHOT_AUDIO_VOLUME) {
  const resolvedVolume = Math.max(0, Math.min(volume, 1));

  if (playBufferedClip(clipState, resolvedVolume)) {
    return;
  }

  playFallbackClip(clipState, resolvedVolume);
}

function playBufferedClip(clipState, volume) {
  if (!clipState.audioEngine.isSupported || !clipState.buffer) {
    return false;
  }

  const { context, masterGain } = clipState.audioEngine;
  if (!context || context.state !== 'running') {
    return false;
  }

  const source = context.createBufferSource();
  source.buffer = clipState.buffer;

  const gainNode = context.createGain();
  gainNode.gain.value = volume;

  source.connect(gainNode);
  gainNode.connect(masterGain);
  source.start(0);
  return true;
}

function playFallbackClip(clipState, volume) {
  const baseClip = clipState.fallbackAudio;

  if (baseClip.preload !== 'auto') {
    baseClip.preload = 'auto';
    baseClip.load();
  }

  if (isClipAvailable(baseClip)) {
    baseClip.currentTime = 0;
    baseClip.volume = volume;
    const playPromise = baseClip.play();
    if (playPromise?.catch) {
      playPromise.catch(() => {});
    }
    return;
  }

  const playbackClip = baseClip.cloneNode();
  playbackClip.volume = volume;
  playbackClip.preload = 'auto';
  playbackClip.currentTime = 0;
  clipState.activeFallbackClones.add(playbackClip);

  const releaseClip = () => {
    playbackClip.pause();
    playbackClip.currentTime = 0;
    clipState.activeFallbackClones.delete(playbackClip);
  };

  playbackClip.addEventListener('ended', releaseClip, { once: true });
  playbackClip.addEventListener('error', releaseClip, { once: true });

  const playPromise = playbackClip.play();
  if (playPromise?.catch) {
    playPromise.catch(() => {
      clipState.activeFallbackClones.delete(playbackClip);
    });
  }
}

function isClipAvailable(clip) {
  return clip.paused || clip.ended || clip.currentTime <= 0;
}

function getWhooshVolume(clubHeadSpeedMetersPerSecond) {
  if (!Number.isFinite(clubHeadSpeedMetersPerSecond) || clubHeadSpeedMetersPerSecond <= 0) {
    return 0;
  }

  return SHOT_AUDIO_VOLUME * Math.min(clubHeadSpeedMetersPerSecond, CLUB_SWING_WHOOSH_MAX_SPEED) / CLUB_SWING_WHOOSH_MAX_SPEED;
}

/**
 * Scales launch-strike loudness with ball speed so soft shots no longer sound as rigid as full hits.
 */
function getLaunchImpactVolume(impactSpeedMetersPerSecond) {
  const normalizedImpact = normalizeImpactSpeed(impactSpeedMetersPerSecond, SHOT_AUDIO_MEDIUM_MAX_IMPACT_SPEED * 1.5);
  return SHOT_AUDIO_VOLUME * (0.28 + Math.pow(normalizedImpact, 0.7) * 0.72);
}

function getSurfaceImpactVolume(impactSpeedMetersPerSecond) {
  const normalizedImpact = normalizeImpactSpeed(impactSpeedMetersPerSecond, SHOT_AUDIO_MEDIUM_MAX_IMPACT_SPEED);
  return SHOT_AUDIO_VOLUME * (0.18 + Math.pow(normalizedImpact, 0.9) * 0.82);
}

function normalizeImpactSpeed(impactSpeedMetersPerSecond, referenceSpeedMetersPerSecond) {
  if (!Number.isFinite(impactSpeedMetersPerSecond) || impactSpeedMetersPerSecond <= 0) {
    return 0;
  }

  return Math.min(impactSpeedMetersPerSecond, referenceSpeedMetersPerSecond) / referenceSpeedMetersPerSecond;
}

function warmClip(clipState) {
  primeClipBuffer(clipState);
  if (!clipState.audioEngine.isSupported) {
    primeFallbackClip(clipState.fallbackAudio);
  }
}

/**
 * Fetches and decodes the clip once so later playback can reuse the in-memory buffer.
 */
function primeClipBuffer(clipState) {
  if (!clipState.audioEngine.isSupported || clipState.buffer || clipState.bufferPromise || clipState.bufferError) {
    return clipState.bufferPromise ?? Promise.resolve(clipState.buffer);
  }

  const { context } = clipState.audioEngine;
  clipState.bufferPromise = fetch(clipState.src)
    .then((response) => {
      if (!response.ok) {
        throw new Error(`Failed to load audio clip: ${clipState.src}`);
      }

      return response.arrayBuffer();
    })
    .then((arrayBuffer) => context.decodeAudioData(arrayBuffer.slice(0)))
    .then((buffer) => {
      clipState.buffer = buffer;
      return buffer;
    })
    .catch((error) => {
      clipState.bufferError = error;
      return null;
    })
    .finally(() => {
      clipState.bufferPromise = null;
    });

  return clipState.bufferPromise;
}

function primeFallbackClip(clip) {
  const previousMuted = clip.muted;
  clip.muted = true;
  clip.currentTime = 0;

  const playPromise = clip.play();
  if (!playPromise?.then) {
    clip.pause();
    clip.currentTime = 0;
    clip.muted = previousMuted;
    return;
  }

  playPromise
    .then(() => {
      clip.pause();
      clip.currentTime = 0;
      clip.muted = previousMuted;
    })
    .catch(() => {
      clip.muted = previousMuted;
    });
}