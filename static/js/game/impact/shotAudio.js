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

export function createShotImpactAudio() {
  const clips = {
    light: createClipState(SHOT_AUDIO_PATHS.light),
    medium: createClipState(SHOT_AUDIO_PATHS.medium),
    practice: createClipState(SHOT_AUDIO_PATHS.practice),
    strong: createClipState(SHOT_AUDIO_PATHS.strong),
    pangya: createClipState(SHOT_AUDIO_PATHS.pangya),
    clubChange: createClipState(SHOT_AUDIO_PATHS.clubChange),
    whoosh: createClipState(SHOT_AUDIO_PATHS.whoosh),
  };
  const surfaceClips = Object.fromEntries(
    Object.entries(SURFACE_HIT_AUDIO_PATHS).map(([surfaceType, src]) => [surfaceType, createClipState(src)]),
  );

  const unlockAudio = () => {
    removeUnlockListeners(unlockAudio);
    primeClip(clips.light.base);
    primeClip(clips.medium.base);
    primeClip(clips.practice.base);
    primeClip(clips.strong.base);
    primeClip(clips.pangya.base);
    primeClip(clips.clubChange.base);
    primeClip(clips.whoosh.base);
    for (const clipState of Object.values(surfaceClips)) {
      primeClip(clipState.base);
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

function createClipState(src) {
  const base = new Audio(src);
  base.preload = 'auto';
  base.volume = SHOT_AUDIO_VOLUME;
  base.load();

  return {
    base,
    activeClones: new Set(),
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

function playClip(clipState, volume = clipState.base.volume) {
  const resolvedVolume = Math.max(0, Math.min(volume, 1));

  if (isClipAvailable(clipState.base)) {
    clipState.base.currentTime = 0;
    clipState.base.volume = resolvedVolume;
    const playPromise = clipState.base.play();
    if (playPromise?.catch) {
      playPromise.catch(() => {});
    }
    return;
  }

  const playbackClip = clipState.base.cloneNode();
  playbackClip.volume = resolvedVolume;
  playbackClip.preload = 'auto';
  playbackClip.currentTime = 0;
  clipState.activeClones.add(playbackClip);

  const releaseClip = () => {
    playbackClip.pause();
    playbackClip.currentTime = 0;
    clipState.activeClones.delete(playbackClip);
  };

  playbackClip.addEventListener('ended', releaseClip, { once: true });
  playbackClip.addEventListener('error', releaseClip, { once: true });

  const playPromise = playbackClip.play();
  if (playPromise?.catch) {
    playPromise.catch(() => {
      clipState.activeClones.delete(playbackClip);
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

function primeClip(clip) {
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