import {
  formatDegrees,
  formatMeters,
  formatMetersPerSecond,
  formatQuaternion,
  formatScalar,
  formatVector3,
} from '/static/js/game/formatting.js';
import { SHOT_AUDIO_PANGYA_MAX_HORIZONTAL_ANGLE_DEGREES } from '/static/js/game/constants.js';

function formatGroundTransitionDebug(transitionDebug) {
  if (!transitionDebug?.captureAttempted) {
    return '-';
  }

  const stateLabel = transitionDebug.snappedToGround
    ? transitionDebug.movementState ?? 'ground'
    : 'capture-missed';

  return `pre ${transitionDebug.preImpactSpeedMetersPerSecond.toFixed(2)} | `
    + `post ${transitionDebug.postImpactSpeedMetersPerSecond.toFixed(2)} | `
    + `snap ${transitionDebug.postSnapSpeedMetersPerSecond.toFixed(2)} | `
    + `loss ${transitionDebug.snapLossMetersPerSecond.toFixed(2)} | `
    + stateLabel;
}

function formatGroundTransitionNormals(transitionDebug) {
  if (!transitionDebug?.captureAttempted || !transitionDebug.impactNormal) {
    return '-';
  }

  const impactLabel = `impact ${formatVector3(transitionDebug.impactNormal)}`;
  if (!transitionDebug.supportNormal) {
    return impactLabel;
  }

  return `${impactLabel} | support ${formatVector3(transitionDebug.supportNormal)}`;
}

function formatGroundTransitionComponents(transitionDebug) {
  if (!transitionDebug?.captureAttempted) {
    return '-';
  }

  return `n ${transitionDebug.preImpactNormalSpeedMetersPerSecond.toFixed(2)} -> ${transitionDebug.postImpactNormalSpeedMetersPerSecond.toFixed(2)} | `
    + `t ${transitionDebug.preImpactTangentSpeedMetersPerSecond.toFixed(2)} -> ${transitionDebug.postImpactTangentSpeedMetersPerSecond.toFixed(2)} | `
    + `drop ${formatDegrees(transitionDebug.preImpactDescentAngleDegrees)}`;
}

const SWING_PREVIEW_TARGET_PERCENT = 80;
const SWING_PREVIEW_MAX_PERCENT = 100;
const SWING_PREVIEW_HORIZONTAL_BAR_WIDTH_UNITS = 90;
const SWING_PREVIEW_HORIZONTAL_MIN_ANGLE_DEGREES = -45;
const SWING_PREVIEW_HORIZONTAL_MAX_ANGLE_DEGREES = 45;
const SWING_PREVIEW_HORIZONTAL_ANGLE_RANGE_DEGREES = SWING_PREVIEW_HORIZONTAL_MAX_ANGLE_DEGREES
  - SWING_PREVIEW_HORIZONTAL_MIN_ANGLE_DEGREES;

function clampSwingPreviewPercent(percent) {
  return Math.max(0, Math.min(SWING_PREVIEW_MAX_PERCENT, percent));
}

/**
 * Limits the preview marker to the visible Pangya-style bar range.
 */
function clampSwingPreviewHorizontalAngleDegrees(horizontalLaunchAngleDegrees) {
  return Math.max(
    SWING_PREVIEW_HORIZONTAL_MIN_ANGLE_DEGREES,
    Math.min(SWING_PREVIEW_HORIZONTAL_MAX_ANGLE_DEGREES, horizontalLaunchAngleDegrees),
  );
}

/**
 * Converts the clamped horizontal launch angle to a left offset across the 90-unit bar.
 * Positive angles should render on the right side of the preview.
 */
function getSwingPreviewHorizontalMarkerPercent(horizontalLaunchAngleDegrees) {
  if (!Number.isFinite(horizontalLaunchAngleDegrees)) {
    return 50;
  }

  const clampedAngleDegrees = clampSwingPreviewHorizontalAngleDegrees(horizontalLaunchAngleDegrees);
  return ((clampedAngleDegrees - SWING_PREVIEW_HORIZONTAL_MIN_ANGLE_DEGREES)
    / SWING_PREVIEW_HORIZONTAL_ANGLE_RANGE_DEGREES) * 100;
}

function getSwingPreviewFillPercent(capturedSpeedMetersPerSecond, targetSpeedMetersPerSecond) {
  if (!Number.isFinite(targetSpeedMetersPerSecond) || targetSpeedMetersPerSecond <= 1e-6) {
    return 0;
  }

  if (!Number.isFinite(capturedSpeedMetersPerSecond) || capturedSpeedMetersPerSecond <= 0) {
    return 0;
  }

  return clampSwingPreviewPercent((capturedSpeedMetersPerSecond / targetSpeedMetersPerSecond) * SWING_PREVIEW_TARGET_PERCENT);
}

/**
 * Syncs the direct-select club row with the currently active club.
 */
function updateClubButtonState(dom, clubSet, club) {
  if (!dom.clubButtonRow) {
    return;
  }

  const clubButtons = dom.clubButtonRow.querySelectorAll('[data-club-id]');
  for (const clubButton of clubButtons) {
    const isActive = Boolean(clubSet && club && clubButton.dataset.clubId === club.id);
    clubButton.classList.toggle('is-active', isActive);
    clubButton.setAttribute('aria-pressed', String(isActive));
  }
}

export function createViewerHud(dom) {
  const swingPreviewState = {
    targetSpeedMetersPerSecond: null,
    capturedSpeedMetersPerSecond: null,
    preview: null,
    playerState: 'control',
    ballPhase: 'ready',
    wasReadyForNextShot: true,
    isDetailExpanded: false,
    isDetailToggleBound: false,
  };

  /**
   * Keeps the detached launch-details card in sync with its manual slide state.
   */
  function updateSwingPreviewDetailUi() {
    if (!dom.swingPreviewDetailShell || !dom.swingPreviewDetailToggleButton || !dom.swingPreviewDetailsPanel) {
      return;
    }

    const isExpanded = swingPreviewState.isDetailExpanded;
    const isCollapsed = !isExpanded;

    dom.swingPreviewDetailShell.hidden = false;
    dom.swingPreviewDetailShell.classList.toggle('is-expanded', isExpanded);
    dom.swingPreviewDetailShell.classList.toggle('is-collapsed', isCollapsed);
    dom.swingPreviewDetailsPanel.setAttribute('aria-hidden', String(!isExpanded));
    dom.swingPreviewDetailToggleButton.setAttribute('aria-expanded', String(isExpanded));
    dom.swingPreviewDetailToggleButton.setAttribute(
      'aria-label',
      isExpanded ? 'Hide launch details' : 'Show launch details',
    );
    dom.swingPreviewDetailToggleButton.textContent = isExpanded ? '>' : '<';
  }

  /**
   * Binds the detached launch-details slide toggle once for the current HUD instance.
   */
  function bindSwingPreviewDetailInteractions() {
    if (swingPreviewState.isDetailToggleBound || !dom.swingPreviewDetailToggleButton) {
      return;
    }

    dom.swingPreviewDetailToggleButton.addEventListener('click', () => {
      swingPreviewState.isDetailExpanded = !swingPreviewState.isDetailExpanded;
      updateSwingPreviewDetailUi();
    });

    swingPreviewState.isDetailToggleBound = true;
  }

  /**
   * Updates preview-linked UI while keeping the right-side drawer fully manual.
   */
  function syncSwingPreviewTelemetryVisibility() {
    const isVisible = Boolean(swingPreviewState.preview);

    if (dom.swingPreviewHorizontalBar) {
      dom.swingPreviewHorizontalBar.hidden = !isVisible;
    }

    if (dom.swingPreviewHeadSpeedAnchor) {
      dom.swingPreviewHeadSpeedAnchor.hidden = !isVisible;
    }

    updateSwingPreviewDetailUi();
  }

  function updateSwingPreviewHorizontalAngle(horizontalLaunchAngleDegrees) {
    if (
      !dom.swingPreviewHorizontalBar
      || !dom.swingPreviewHorizontalPangyaZone
      || !dom.swingPreviewHorizontalMarker
    ) {
      return;
    }

    dom.swingPreviewHorizontalPangyaZone.style.width = `${SHOT_AUDIO_PANGYA_MAX_HORIZONTAL_ANGLE_DEGREES * 2}px`;

    if (!Number.isFinite(horizontalLaunchAngleDegrees)) {
      dom.swingPreviewHorizontalMarker.hidden = true;
      dom.swingPreviewHorizontalBar.setAttribute('aria-label', 'Horizontal launch angle preview, positive values shown to the right');
      return;
    }

    const markerPercent = getSwingPreviewHorizontalMarkerPercent(horizontalLaunchAngleDegrees);
    dom.swingPreviewHorizontalMarker.hidden = false;
    dom.swingPreviewHorizontalMarker.style.left = `${markerPercent}%`;

    const clampedAngleDegrees = clampSwingPreviewHorizontalAngleDegrees(horizontalLaunchAngleDegrees);
    dom.swingPreviewHorizontalBar.setAttribute(
      'aria-label',
      `Horizontal launch angle ${formatDegrees(horizontalLaunchAngleDegrees)} shown on a ${SWING_PREVIEW_HORIZONTAL_BAR_WIDTH_UNITS}-unit bar with positive values to the right and clamped to ${formatDegrees(clampedAngleDegrees)} for display`,
    );
  }

  return {
    initialize(cameraPosition, incomingQuaternion) {
      bindSwingPreviewDetailInteractions();
      this.updateSocketState('Connecting');
      this.updateFps(0);
      this.updatePacketRate(0);
      this.updateQuaternion(incomingQuaternion);
      this.updateBoneQuaternion(incomingQuaternion);
      this.updateMatchFrame(0, 0, 0);
      this.updateCameraPosition(cameraPosition);
      this.updateBallState('ready', null, 0);
      this.updateGroundTransitionDebug(null);
      this.updateShotStates('control', 'ready', null);
      this.updateClubDebug(null, null);
      this.updateSwingPreviewTarget(null);
      this.updateSwingPreviewCapture(null);
      this.updateLaunchPreview(null);
      this.updateLaunchPanelVisible(false);
      updateSwingPreviewDetailUi();
    },

    setStatus(message) {
      dom.statusLabel.textContent = message;
    },

    updateSocketState(state) {
      dom.socketStateLabel.textContent = state;
    },

    updatePacketRate(value) {
      dom.packetRateLabel.textContent = `${value.toFixed(1)} pkt/s`;
    },

    updateFps(value) {
      if (!dom.fpsLabel) {
        return;
      }

      dom.fpsLabel.textContent = String(Math.max(0, Math.round(value)));
      dom.fpsLabel.setAttribute('aria-label', `${value.toFixed(1)} frames per second`);
    },

    updateQuaternion(quaternion) {
      dom.quaternionLabel.textContent = formatQuaternion(quaternion);
    },

    updateBoneQuaternion(quaternion) {
      if (!dom.boneQuaternionLabel) {
        return;
      }

      dom.boneQuaternionLabel.textContent = formatQuaternion(quaternion);
    },

    updateMatchFrame(frameIndex, sampleCount, timeSeconds) {
      if (!dom.matchFrameLabel) {
        return;
      }

      dom.matchFrameLabel.textContent = `Frame ${frameIndex}/${Math.max(sampleCount - 1, 0)} @ ${timeSeconds.toFixed(3)}s`;
    },

    updateCameraPosition(position) {
      dom.cameraPositionLabel.textContent = formatVector3(position);
    },

    updateBallState(phase, movementState, speedMetersPerSecond) {
      if (!dom.ballStateLabel || !dom.ballSpeedLabel) {
        return;
      }

      dom.ballStateLabel.textContent = phase === 'moving' && movementState
        ? `moving/${movementState}`
        : phase;
      dom.ballSpeedLabel.textContent = `${speedMetersPerSecond.toFixed(1)} m/s`;
    },

    updateGroundTransitionDebug(transitionDebug) {
      if (!dom.ballLandingDebugLabel || !dom.ballLandingComponentsLabel || !dom.ballLandingNormalsLabel) {
        return;
      }

      dom.ballLandingDebugLabel.textContent = formatGroundTransitionDebug(transitionDebug);
      dom.ballLandingComponentsLabel.textContent = formatGroundTransitionComponents(transitionDebug);
      dom.ballLandingNormalsLabel.textContent = formatGroundTransitionNormals(transitionDebug);
    },

    updateClubDebug(clubSet, club) {
      if (
        !dom.clubSetLineLabel
        || !dom.clubIdLabel
        || !dom.clubLoftLabel
        || !dom.clubLaunchFactorLabel
        || !dom.clubOrientationLoftInfluenceLabel
        || !dom.clubMaxDynamicLoftDeltaLabel
        || !dom.clubEffectiveLengthLabel
        || !dom.clubSmashFactorLabel
      ) {
        return;
      }

      if (!clubSet || !club) {
        dom.clubSetLineLabel.textContent = '-';
        dom.clubIdLabel.textContent = '-';
        dom.clubLoftLabel.textContent = '-';
        dom.clubLaunchFactorLabel.textContent = '-';
        dom.clubOrientationLoftInfluenceLabel.textContent = '-';
        dom.clubMaxDynamicLoftDeltaLabel.textContent = '-';
        dom.clubEffectiveLengthLabel.textContent = '-';
        dom.clubSmashFactorLabel.textContent = '-';
        updateClubButtonState(dom, null, null);
        return;
      }

      dom.clubSetLineLabel.textContent = clubSet.name;
      dom.clubIdLabel.textContent = club.id;
      dom.clubLoftLabel.textContent = formatDegrees(club.loftDegrees);
      dom.clubLaunchFactorLabel.textContent = formatScalar(club.launchFactor);
      dom.clubOrientationLoftInfluenceLabel.textContent = formatScalar(club.orientationLoftInfluence);
      dom.clubMaxDynamicLoftDeltaLabel.textContent = formatDegrees(club.maxDynamicLoftDeltaDegrees);
      dom.clubEffectiveLengthLabel.textContent = formatMeters(club.effectiveLengthMeters);
      dom.clubSmashFactorLabel.textContent = formatScalar(club.smashFactor);
      updateClubButtonState(dom, clubSet, club);
    },

    updateLaunchPreview(preview) {
      updateSwingPreviewHorizontalAngle(preview?.horizontalLaunchAngle ?? null);
      swingPreviewState.preview = preview ?? null;

      if (

         !dom.previewClubSpeedLabel
        || !dom.previewBallSpeedLabel
        || !dom.previewSpinRpmLabel
        || !dom.previewHorizontalLaunchAngleLabel
        || !dom.previewFacePitchLabel
        || !dom.previewDynamicLoftLabel
        || !dom.previewLaunchAngleLabel
      ) {
        return;
      }

      if (!preview) {
        dom.previewClubSpeedLabel.textContent = '-';
        dom.previewBallSpeedLabel.textContent = '-';
        dom.previewSpinRpmLabel.textContent = '-';
        dom.previewHorizontalLaunchAngleLabel.textContent = '-';
        dom.previewFacePitchLabel.textContent = '-';
        dom.previewDynamicLoftLabel.textContent = '-';
        dom.previewLaunchAngleLabel.textContent = '-';
        syncSwingPreviewTelemetryVisibility();
        return;
      }

      dom.previewClubSpeedLabel.textContent = formatMetersPerSecond(preview.clubHeadSpeedMetersPerSecond);
      dom.previewBallSpeedLabel.textContent = formatMetersPerSecond(preview.ballSpeed);
      dom.previewSpinRpmLabel.textContent = Number.isFinite(preview.spinSpeed)
        ? `${formatScalar(preview.spinSpeed, 0)} rpm`
        : '-';
      dom.previewHorizontalLaunchAngleLabel.textContent = formatDegrees(preview.horizontalLaunchAngle);
      dom.previewFacePitchLabel.textContent = formatDegrees(preview.measuredFacePitchDegrees);
      dom.previewDynamicLoftLabel.textContent = formatDegrees(preview.dynamicLoftDegrees);
      dom.previewLaunchAngleLabel.textContent = formatDegrees(preview.verticalLaunchAngle);
      syncSwingPreviewTelemetryVisibility();

      if (dom.swingPreviewFill) {
        dom.swingPreviewFill.classList.remove('is-flashing');
        // Trigger reflow
        void dom.swingPreviewFill.offsetWidth;
        dom.swingPreviewFill.classList.add('is-flashing');
      }
    },

    updateSwingPreviewTarget(targetSpeedMetersPerSecond) {
      if (
     
       !dom.swingPreviewBar
        || !dom.swingPreviewTargetLine
        || !dom.swingPreviewTargetSpeedLabel
      ) {
        return;
      }

      swingPreviewState.targetSpeedMetersPerSecond = targetSpeedMetersPerSecond;
      dom.swingPreviewTargetLine.style.bottom = `${SWING_PREVIEW_TARGET_PERCENT}%`;
      dom.swingPreviewTargetSpeedLabel.textContent = formatMetersPerSecond(targetSpeedMetersPerSecond);
      if (Number.isFinite(swingPreviewState.capturedSpeedMetersPerSecond) && swingPreviewState.capturedSpeedMetersPerSecond >= 0) {
        this.updateSwingPreviewCapture(
          swingPreviewState.capturedSpeedMetersPerSecond,
          targetSpeedMetersPerSecond,
        );
        return;
      }


    },

    updateSwingPreviewCapture(capturedSpeedMetersPerSecond, targetSpeedMetersPerSecond = null) {
      if (
  
       !dom.swingPreviewBar
        || !dom.swingPreviewFill
      ) {
        return;
      }

      swingPreviewState.capturedSpeedMetersPerSecond = capturedSpeedMetersPerSecond;
      swingPreviewState.targetSpeedMetersPerSecond = targetSpeedMetersPerSecond
        ?? swingPreviewState.targetSpeedMetersPerSecond;

      if (!Number.isFinite(capturedSpeedMetersPerSecond) || capturedSpeedMetersPerSecond < 0) {
        dom.swingPreviewFill.style.height = '0%';
        dom.swingPreviewBar.setAttribute('aria-label', 'Last swing speed compared to target speed');
        if (dom.swingPreviewHeadSpeedAnchor) {
          dom.swingPreviewHeadSpeedAnchor.style.setProperty('--swing-preview-capture-percent', '0%');
        }

        return;
      }

      const fillPercent = getSwingPreviewFillPercent(
        capturedSpeedMetersPerSecond,
        targetSpeedMetersPerSecond ?? swingPreviewState.targetSpeedMetersPerSecond,
      );
      dom.swingPreviewFill.style.height = `${fillPercent}%`;
      if (dom.swingPreviewHeadSpeedAnchor) {
        dom.swingPreviewHeadSpeedAnchor.style.setProperty('--swing-preview-capture-percent', `${fillPercent}%`);
      }
      dom.swingPreviewBar.setAttribute(
        'aria-label',
        `Last swing speed ${formatMetersPerSecond(capturedSpeedMetersPerSecond)} against target ${formatMetersPerSecond(targetSpeedMetersPerSecond ?? swingPreviewState.targetSpeedMetersPerSecond)}`,
      );
    
    },

    updateLaunchPanelVisible(visible) {
      if (!dom.launchPanel) {
        return;
      }

      dom.launchPanel.hidden = !visible;
    },

    updateShotStates(playerState, ballPhase, movementState) {
      if (!dom.playerStateLabel || !dom.ballPhaseLabel || !dom.ballMovementLabel) {
        return;
      }

      const isReadyForNextShot = playerState === 'control' && ballPhase === 'ready';
      if (isReadyForNextShot && !swingPreviewState.wasReadyForNextShot && swingPreviewState.preview) {
        this.updateLaunchPreview(null);
      }

      swingPreviewState.playerState = playerState;
      swingPreviewState.ballPhase = ballPhase;
      swingPreviewState.wasReadyForNextShot = isReadyForNextShot;
      dom.playerStateLabel.textContent = playerState;
      dom.ballPhaseLabel.textContent = ballPhase;
      dom.ballMovementLabel.textContent = movementState ?? '-';
      syncSwingPreviewTelemetryVisibility();
    },
  };
}