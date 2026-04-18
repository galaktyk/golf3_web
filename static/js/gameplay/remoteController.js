import {
  decodeControlMessage,
  decodeJoystickMessage,
  CONTROL_ACTIONS
} from '../protocol.js';
import { createViewerRtcSession } from '../session/firebaseRtcSession.js';
import { loadStoredViewerCode, saveStoredViewerCode, buildControllerUrl } from '../session/roomCode.js';

const REMOTE_DEBUG_PREFIX = '[golf3 remote]';

export function createRemoteController(params) {
  const {
    hud,
    onSwingPacket,
    onControlPayload,
    onDisconnect,
    roomCodeLabel,
    roomQrImage,
    viewerPairingPanel
  } = params;

  let viewerSession = null;
  let viewerSessionGeneration = 0;
  let lastViewerTransportState = null;
  let viewerSessionRestartPromise = null;

  const handleIncomingControlPayload = (payloadText) => {
    const payload = JSON.parse(payloadText);
    const joystick = decodeJoystickMessage(payload);
    if (joystick) {
      params.applyRemoteJoystickInput(joystick.x, joystick.y);
      return;
    }
    const ctrl = decodeControlMessage(payload);
    if (ctrl) {
      params.applyRemoteControl(ctrl.action, ctrl.active, ctrl.value);
    }
  };

  const updateViewerPairingUi = (roomCode, transportState) => {
    const connected = transportState?.controlChannelState === 'open';
    if (viewerPairingPanel) viewerPairingPanel.hidden = connected;
    if (!roomQrImage) return;

    const code = String(roomCode ?? '').trim();
    if (!/^\d{4}$/.test(code)) {
      roomQrImage.hidden = true;
      delete roomQrImage.dataset.qrValue;
      roomQrImage.removeAttribute('src');
      return;
    }

    const url = buildControllerUrl(code);
    const qr = `https://api.qrserver.com/v1/create-qr-code/?size=176x176&margin=0&data=${encodeURIComponent(url)}`;
    if (roomQrImage.dataset.qrValue !== url || !roomQrImage.getAttribute('src')) {
      roomQrImage.dataset.qrValue = url;
      roomQrImage.src = qr;
      roomQrImage.alt = `QR code linking to ${url}`;
    }
    roomQrImage.hidden = connected;
  };

  const updateViewerTransportState = (state) => {
    const previous = lastViewerTransportState;
    lastViewerTransportState = state;
    updateViewerPairingUi(roomCodeLabel?.textContent ?? '', state);

    if (previous?.controlChannelState === 'open' && state.controlChannelState !== 'open') {
      onDisconnect();
      scheduleRestart();
    }
    if ((previous?.remoteUid && !state.remoteUid) || (state.remoteUid && (state.connectionState === 'failed' || state.connectionState === 'closed'))) {
      scheduleRestart();
    }

    if (state.errorMessage) {
      hud.updateSocketState('Error');
      hud.setStatus(state.errorMessage);
      return;
    }

    if (!state.remoteUid) {
      hud.updateSocketState('Waiting');
      if (!params.hasIncomingOrientation()) hud.setStatus('Viewer ready. Waiting for phone connection.');
      return;
    }

    const fully = state.swingChannelState === 'open' && state.controlChannelState === 'open';
    if (!fully) {
      hud.updateSocketState('Connecting');
      if (!params.hasIncomingOrientation()) hud.setStatus('Phone joined. Establishing direct link.');
      return;
    }

    hud.updateSocketState('Connected');
    if (!params.hasIncomingOrientation()) hud.setStatus('Phone connected. Waiting for swing data.');
  };

  const startSession = async () => {
    viewerSessionGeneration += 1;
    const gen = viewerSessionGeneration;
    const code = /^\d{4}$/.test(roomCodeLabel?.textContent ?? '') ? roomCodeLabel.textContent.trim() : loadStoredViewerCode();
    console.info(REMOTE_DEBUG_PREFIX, 'starting viewer session', {
      generation: gen,
      displayedCode: roomCodeLabel?.textContent ?? '',
      storedCode: loadStoredViewerCode(),
      startupCode: code,
    });

    await viewerSession?.close();
    viewerSession = null;
    lastViewerTransportState = null;
    params.resetSwingSimulation();

    if (roomCodeLabel && code) roomCodeLabel.textContent = code;
    updateViewerPairingUi(code || '----', null);
    hud.updateSocketState('Connecting');
    hud.updatePacketRate(0);
    onDisconnect();

    try {
      const session = await createViewerRtcSession({
        preferredRoomId: loadStoredViewerCode(),
        onSwingPacket,
        onControlMessage: handleIncomingControlPayload,
        onStateChange: (s) => {
          if (gen === viewerSessionGeneration) updateViewerTransportState(s);
        },
      });

      if (gen !== viewerSessionGeneration) {
        console.info(REMOTE_DEBUG_PREFIX, 'discarding superseded viewer session', {
          generation: gen,
          roomId: session.roomId,
        });
        await session.close();
        return;
      }
      viewerSession = session;
      if (roomCodeLabel) roomCodeLabel.textContent = session.roomId;
      updateViewerPairingUi(session.roomId, session.getState());
      saveStoredViewerCode(session.roomId);
      console.info(REMOTE_DEBUG_PREFIX, 'viewer session ready', {
        generation: gen,
        roomId: session.roomId,
      });
      updateViewerTransportState(session.getState());
    } catch (e) {
      console.info(REMOTE_DEBUG_PREFIX, 'viewer session failed', {
        generation: gen,
        error: e instanceof Error ? e.message : String(e),
      });
      hud.updateSocketState('Error');
      hud.setStatus(e instanceof Error ? e.message : 'Unable to create room.');
    }
  };

  const scheduleRestart = () => {
    if (viewerSessionRestartPromise) return;
    viewerSessionRestartPromise = Promise.resolve().then(() => startSession()).finally(() => { viewerSessionRestartPromise = null; });
  };

  return {
    startSession,
    close: (options) => viewerSession?.close(options)
  };
}
