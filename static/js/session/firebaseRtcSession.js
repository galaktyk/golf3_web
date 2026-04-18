import { initializeApp, getApp, getApps } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import {
  get,
  getDatabase,
  onChildAdded,
  onDisconnect,
  onValue,
  push,
  ref,
  remove,
  runTransaction,
  serverTimestamp,
  set,
  update,
} from 'firebase/database';

import { defaultIceServers, firebaseConfig } from '/static/js/session/firebaseConfig.js';
import {
  ensureStoredViewerHostId,
  generateRoomCode,
  isCompleteRoomCode,
  normalizeRoomCode,
} from '/static/js/session/roomCode.js';

const SWING_CHANNEL_LABEL = 'swing';
const CONTROL_CHANNEL_LABEL = 'control';
const ROOM_RECLAIM_WAIT_MS = 2500;
const ROOM_RECLAIM_POLL_INTERVAL_MS = 100;
const RTC_DEBUG_PREFIX = '[golf3 rtc]';

let cachedApp = null;
let cachedAuthPromise = null;

/**
 * Lazily initializes Firebase so both pages can share the same singleton app instance.
 */
function getFirebaseApp() {
  if (cachedApp) {
    return cachedApp;
  }

  cachedApp = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
  return cachedApp;
}

/**
 * Guarantees that the current browser tab has an anonymous Firebase identity before signaling.
 */
async function ensureAnonymousUser() {
  const app = getFirebaseApp();
  const auth = getAuth(app);
  if (auth.currentUser) {
    logRtcDebug('reusing anonymous auth user', { uid: auth.currentUser.uid });
    return auth.currentUser;
  }

  if (!cachedAuthPromise) {
    logRtcDebug('signing in anonymously');
    cachedAuthPromise = signInAnonymously(auth)
      .then((credential) => {
        logRtcDebug('anonymous sign-in completed', { uid: credential.user.uid });
        return credential.user;
      })
      .finally(() => {
        cachedAuthPromise = null;
      });
  }

  return cachedAuthPromise;
}

/**
 * Creates a room atomically so short-code collisions do not clobber an active session.
 */
async function createUniqueRoom(database, hostUid, preferredRoomId = '', hostClientId = '') {
  const attemptedRoomIds = new Set();
  const normalizedPreferredRoomId = normalizeRoomCode(preferredRoomId);
  logRtcDebug('creating viewer room', {
    hostUid,
    hostClientId,
    preferredRoomId: normalizedPreferredRoomId,
  });

  if (isCompleteRoomCode(normalizedPreferredRoomId)) {
    attemptedRoomIds.add(normalizedPreferredRoomId);
    const preferredReservation = await tryReserveRoom(database, normalizedPreferredRoomId, hostUid, hostClientId);
    if (preferredReservation.committed) {
      logRtcDebug('reserved preferred room', { roomId: normalizedPreferredRoomId });
      return normalizedPreferredRoomId;
    }

    const preferredRoom = preferredReservation.snapshot.val();
    logRtcDebug('preferred room already occupied', {
      roomId: normalizedPreferredRoomId,
      ownedBySameHost: isRoomOwnedByHost(preferredRoom, hostUid, hostClientId),
      room: summarizeRoom(preferredRoom),
    });

    if (isRoomOwnedByHost(preferredRoom, hostUid, hostClientId)) {
      const reclaimedReservation = await reclaimRoomForHost(database, normalizedPreferredRoomId, hostUid, hostClientId);
      if (reclaimedReservation.committed) {
        logRtcDebug('reclaimed preferred room for same host', { roomId: normalizedPreferredRoomId });
        return normalizedPreferredRoomId;
      }

      const released = await waitForRoomRelease(database, normalizedPreferredRoomId, hostUid, hostClientId);
      if (released) {
        const retriedReservation = await tryReserveRoom(database, normalizedPreferredRoomId, hostUid, hostClientId);
        if (retriedReservation.committed) {
          logRtcDebug('reserved preferred room after waiting for release', { roomId: normalizedPreferredRoomId });
          return normalizedPreferredRoomId;
        }
      }
    }
  }

  for (let attempt = 0; attempt < 12; attempt += 1) {
    let roomId = generateRoomCode();
    while (attemptedRoomIds.has(roomId)) {
      roomId = generateRoomCode();
    }

    attemptedRoomIds.add(roomId);
    const transactionResult = await tryReserveRoom(database, roomId, hostUid, hostClientId);
    if (transactionResult.committed) {
      logRtcDebug('reserved fallback room', { roomId, attempt: attempt + 1 });
      return roomId;
    }

    logRtcDebug('fallback room collision', {
      roomId,
      attempt: attempt + 1,
      room: summarizeRoom(transactionResult.snapshot.val()),
    });
  }

  throw new Error('Unable to reserve a game client code. Try again.');
}

function tryReserveRoom(database, roomId, hostUid, hostClientId) {
  const roomRef = ref(database, `rooms/${roomId}`);
  return runTransaction(roomRef, (currentRoom) => {
    if (currentRoom !== null) {
      return undefined;
    }

    return {
      hostUid,
      hostClientId,
      guestUid: null,
      state: 'waiting',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  });
}

/**
 * Resets an existing room in place when it already belongs to the same viewer browser.
 */
function reclaimRoomForHost(database, roomId, hostUid, hostClientId) {
  const roomRef = ref(database, `rooms/${roomId}`);
  return runTransaction(roomRef, (currentRoom) => {
    if (!isRoomOwnedByHost(currentRoom, hostUid, hostClientId)) {
      return undefined;
    }

    return createFreshRoomState(hostUid, hostClientId, currentRoom?.createdAt);
  });
}

/**
 * Matches an occupied room to the same viewer browser so refreshes can reclaim its code.
 */
function isRoomOwnedByHost(room, hostUid, hostClientId) {
  if (!room?.hostUid) {
    return false;
  }

  if (hostClientId && room.hostClientId) {
    return room.hostClientId === hostClientId;
  }

  return room.hostUid === hostUid;
}

/**
 * Waits briefly for the previous tab's disconnect cleanup to release the saved room code.
 */
async function waitForRoomRelease(database, roomId, hostUid, hostClientId) {
  const roomRef = ref(database, `rooms/${roomId}`);
  const deadline = Date.now() + ROOM_RECLAIM_WAIT_MS;
  logRtcDebug('waiting for preferred room to release', {
    roomId,
    waitMs: ROOM_RECLAIM_WAIT_MS,
  });

  while (Date.now() < deadline) {
    const snapshot = await get(roomRef);
    const room = snapshot.val();
    if (!room) {
      logRtcDebug('preferred room released', { roomId });
      return true;
    }

    if (!isRoomOwnedByHost(room, hostUid, hostClientId)) {
      logRtcDebug('preferred room is owned by another host', {
        roomId,
        room: summarizeRoom(room),
      });
      return false;
    }

    // Refresh creates a new tab before the old tab's disconnect cleanup finishes.
    await delay(ROOM_RECLAIM_POLL_INTERVAL_MS);
  }

  const finalSnapshot = await get(roomRef);
  const released = !finalSnapshot.exists();
  logRtcDebug('finished waiting for preferred room release', {
    roomId,
    released,
    room: summarizeRoom(finalSnapshot.val()),
  });
  return released;
}

function delay(timeoutMs) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, timeoutMs);
  });
}

function createStateStore(initialState, onStateChange) {
  let currentState = { ...initialState };

  function emit(patch) {
    currentState = { ...currentState, ...patch };
    onStateChange?.({ ...currentState });
  }

  return {
    emit,
    getState() {
      return { ...currentState };
    },
  };
}

function createBaseSession({ role, roomId, localUid, onStateChange }) {
  const stateStore = createStateStore(
    {
      role,
      roomId,
      localUid,
      remoteUid: null,
      signalingState: 'initializing',
      connectionState: 'new',
      swingChannelState: 'closed',
      controlChannelState: 'closed',
      errorMessage: null,
    },
    onStateChange,
  );
  const cleanupCallbacks = [];

  return {
    addCleanup(callback) {
      cleanupCallbacks.push(callback);
    },
    closeCleanup() {
      while (cleanupCallbacks.length > 0) {
        const callback = cleanupCallbacks.pop();
        try {
          callback?.();
        } catch (_error) {
          // Best-effort cleanup; teardown should not throw during unload/reset.
        }
      }
    },
    emitState(patch) {
      stateStore.emit(patch);
    },
    getState() {
      return stateStore.getState();
    },
  };
}

function createPeerConnection({
  mode,
  iceServers,
  onSwingPacket,
  onControlMessage,
  onStateChange,
}) {
  const peerConnection = new RTCPeerConnection({ iceServers });
  let swingChannel = null;
  let controlChannel = null;

  function emitTransportState() {
    onStateChange({
      connectionState: peerConnection.connectionState,
      swingChannelState: swingChannel?.readyState ?? 'closed',
      controlChannelState: controlChannel?.readyState ?? 'closed',
    });
  }

  function bindSwingChannel(channel) {
    swingChannel = channel;
    swingChannel.binaryType = 'arraybuffer';
    swingChannel.addEventListener('open', emitTransportState);
    swingChannel.addEventListener('close', emitTransportState);
    swingChannel.addEventListener('error', emitTransportState);
    swingChannel.addEventListener('message', (event) => {
      onSwingPacket?.(event.data);
    });
    emitTransportState();
  }

  function bindControlChannel(channel) {
    controlChannel = channel;
    controlChannel.addEventListener('open', emitTransportState);
    controlChannel.addEventListener('close', emitTransportState);
    controlChannel.addEventListener('error', emitTransportState);
    controlChannel.addEventListener('message', (event) => {
      if (typeof event.data === 'string') {
        onControlMessage?.(event.data);
      }
    });
    emitTransportState();
  }

  if (mode === 'host') {
    bindSwingChannel(peerConnection.createDataChannel(SWING_CHANNEL_LABEL, {
      ordered: false,
      maxRetransmits: 0,
    }));
    bindControlChannel(peerConnection.createDataChannel(CONTROL_CHANNEL_LABEL, {
      ordered: true,
    }));
  } else {
    peerConnection.addEventListener('datachannel', (event) => {
      if (event.channel.label === SWING_CHANNEL_LABEL) {
        bindSwingChannel(event.channel);
        return;
      }

      if (event.channel.label === CONTROL_CHANNEL_LABEL) {
        bindControlChannel(event.channel);
      }
    });
  }

  peerConnection.addEventListener('connectionstatechange', emitTransportState);
  peerConnection.addEventListener('iceconnectionstatechange', emitTransportState);
  peerConnection.addEventListener('signalingstatechange', emitTransportState);
  emitTransportState();

  return {
    peerConnection,
    sendSwingPacket(buffer) {
      if (swingChannel?.readyState !== 'open') {
        return false;
      }

      swingChannel.send(buffer);
      return true;
    },
    sendControlMessage(payload) {
      if (controlChannel?.readyState !== 'open') {
        return false;
      }

      controlChannel.send(payload);
      return true;
    },
    emitTransportState,
    close() {
      swingChannel?.close();
      controlChannel?.close();
      peerConnection.close();
      emitTransportState();
    },
  };
}

function serializeDescription(description, fromUid) {
  return {
    fromUid,
    type: description.type,
    sdp: description.sdp,
    updatedAt: serverTimestamp(),
  };
}

async function sendMailboxMessage(database, roomId, targetUid, message) {
  if (!targetUid) {
    return;
  }

  const mailboxRef = ref(database, `rooms/${roomId}/mailboxes/${targetUid}`);
  await set(push(mailboxRef), {
    ...message,
    createdAt: serverTimestamp(),
  });
}

function descriptionFromSnapshot(snapshotValue) {
  if (!snapshotValue?.type || !snapshotValue?.sdp) {
    return null;
  }

  return {
    type: snapshotValue.type,
    sdp: snapshotValue.sdp,
  };
}

/**
 * Registers server-side disconnect cleanup so abrupt tab closes still release the room.
 */
async function registerDisconnectCleanup(operations) {
  const disconnectHandles = [];

  for (const operation of operations) {
    const disconnectHandle = onDisconnect(operation.targetRef);
    disconnectHandles.push(disconnectHandle);

    if (operation.type === 'remove') {
      await disconnectHandle.remove();
      continue;
    }

    await disconnectHandle.update(operation.value);
  }

  return {
    async cancel() {
      await Promise.allSettled(disconnectHandles.map((disconnectHandle) => disconnectHandle.cancel()));
    },
  };
}

/**
 * Clears the current controller claim only when the room is still owned by the expected guest.
 */
async function releaseGuestClaim(database, roomId, expectedGuestUid) {
  if (!expectedGuestUid) {
    return false;
  }

  const roomRef = ref(database, `rooms/${roomId}`);
  const answerRef = ref(database, `rooms/${roomId}/descriptions/answer`);
  const guestMailboxRef = ref(database, `rooms/${roomId}/mailboxes/${expectedGuestUid}`);
  let released = false;

  await runTransaction(roomRef, (currentRoom) => {
    if (!currentRoom?.hostUid || currentRoom.guestUid !== expectedGuestUid) {
      return currentRoom;
    }

    released = true;
    return {
      ...currentRoom,
      guestUid: null,
      state: 'waiting',
      updatedAt: Date.now(),
    };
  });

  if (!released) {
    return false;
  }

  await Promise.allSettled([
    remove(answerRef),
    remove(guestMailboxRef),
  ]);
  return true;
}

/**
 * Allows reconnect takeover whenever the viewer has not marked the current guest as fully connected.
 */
async function prepareControllerJoin(database, roomId, userUid) {
  const roomRef = ref(database, `rooms/${roomId}`);
  const roomSnapshot = await get(roomRef);

  const room = roomSnapshot.val();
  if (!room?.hostUid) {
    throw new Error('Game client not found.');
  }

  if (room.guestUid && room.guestUid !== userUid) {
    if (room.state === 'connected') {
      throw new Error('Game client already in use.');
    }

    await releaseGuestClaim(database, roomId, room.guestUid);
  }

  const claimResult = await runTransaction(roomRef, (currentRoom) => {
    if (!currentRoom?.hostUid) {
      return currentRoom;
    }

    if (currentRoom.guestUid && currentRoom.guestUid !== userUid) {
      return undefined;
    }

    return {
      ...currentRoom,
      guestUid: userUid,
      state: 'join-requested',
      updatedAt: Date.now(),
    };
  });

  if (!claimResult.snapshot.val()?.hostUid) {
    throw new Error('Game client not found.');
  }

  if (!claimResult.committed) {
    throw new Error('Game client already in use.');
  }

  return claimResult.snapshot.val();
}

/**
 * Hosts a room, publishes the offer, and opens the two WebRTC data channels used by the viewer.
 */
export async function createViewerRtcSession({
  preferredRoomId = '',
  iceServers = defaultIceServers,
  onSwingPacket,
  onControlMessage,
  onStateChange,
}) {
  const user = await ensureAnonymousUser();
  const database = getDatabase(getFirebaseApp());
  const hostClientId = ensureStoredViewerHostId();
  logRtcDebug('starting viewer session', {
    preferredRoomId: normalizeRoomCode(preferredRoomId),
    hostUid: user.uid,
    hostClientId,
  });
  const roomId = await createUniqueRoom(database, user.uid, preferredRoomId, hostClientId);
  const session = createBaseSession({
    role: 'viewer',
    roomId,
    localUid: user.uid,
    onStateChange,
  });
  const roomRef = ref(database, `rooms/${roomId}`);
  const mailboxRef = ref(database, `rooms/${roomId}/mailboxes/${user.uid}`);
  const offerRef = ref(database, `rooms/${roomId}/descriptions/offer`);
  const answerRef = ref(database, `rooms/${roomId}/descriptions/answer`);
  let remoteUid = null;
  let remoteDescriptionApplied = false;
  const queuedCandidates = [];
  let viewerDisconnectCleanup = null;
  let remoteFailureCleanupPromise = null;
  let lastPublishedRoomState = null;

  const publishRoomState = (nextState) => {
    if (lastPublishedRoomState === nextState) {
      return;
    }

    lastPublishedRoomState = nextState;
    void update(roomRef, {
      state: nextState,
      updatedAt: serverTimestamp(),
    });
  };

  const transport = createPeerConnection({
    mode: 'host',
    iceServers,
    onSwingPacket,
    onControlMessage,
    onStateChange: (transportState) => {
      const fullyConnected = transportState.swingChannelState === 'open'
        && transportState.controlChannelState === 'open';

      if (remoteUid) {
        publishRoomState(fullyConnected ? 'connected' : 'connecting');
      }

      if (
        remoteUid
        && !remoteFailureCleanupPromise
        && (transportState.connectionState === 'failed' || transportState.connectionState === 'closed')
      ) {
        remoteFailureCleanupPromise = releaseGuestClaim(database, roomId, remoteUid)
          .finally(() => {
            remoteFailureCleanupPromise = null;
          });
      }

      session.emitState(transportState);
    },
  });

  viewerDisconnectCleanup = await registerDisconnectCleanup([
    {
      type: 'remove',
      targetRef: roomRef,
    },
  ]);
  logRtcDebug('registered viewer disconnect cleanup', { roomId });

  transport.peerConnection.addEventListener('icecandidate', (event) => {
    if (!event.candidate) {
      return;
    }

    const candidatePayload = event.candidate.toJSON();
    if (!remoteUid) {
      queuedCandidates.push(candidatePayload);
      return;
    }

    void sendMailboxMessage(database, roomId, remoteUid, {
      type: 'ice-candidate',
      fromUid: user.uid,
      candidate: candidatePayload,
    });
  });

  session.emitState({ signalingState: 'creating-room' });

  const unsubscribeRoom = onValue(roomRef, (snapshot) => {
    const room = snapshot.val();
    remoteUid = room?.guestUid ?? null;
    logRtcDebug('viewer room updated', {
      roomId,
      room: summarizeRoom(room),
    });

    if (!remoteUid) {
      publishRoomState('offer-ready');
      remoteDescriptionApplied = false;
    }

    session.emitState({
      remoteUid,
      signalingState: remoteUid ? 'negotiating' : 'waiting-for-joiner',
    });

    if (remoteUid && queuedCandidates.length > 0) {
      while (queuedCandidates.length > 0) {
        const candidate = queuedCandidates.shift();
        void sendMailboxMessage(database, roomId, remoteUid, {
          type: 'ice-candidate',
          fromUid: user.uid,
          candidate,
        });
      }
    }
  });
  session.addCleanup(unsubscribeRoom);

  const unsubscribeAnswer = onValue(answerRef, async (snapshot) => {
    const answer = descriptionFromSnapshot(snapshot.val());
    if (!answer || remoteDescriptionApplied || transport.peerConnection.currentRemoteDescription) {
      return;
    }

    remoteDescriptionApplied = true;
    await transport.peerConnection.setRemoteDescription(answer);
    await update(roomRef, {
      state: 'connecting',
      updatedAt: serverTimestamp(),
    });
    session.emitState({ signalingState: 'connecting' });
  });
  session.addCleanup(unsubscribeAnswer);

  const unsubscribeMailbox = onChildAdded(mailboxRef, async (snapshot) => {
    const message = snapshot.val();
    if (message?.type === 'ice-candidate' && message.candidate) {
      try {
        await transport.peerConnection.addIceCandidate(message.candidate);
      } catch (_error) {
        session.emitState({ errorMessage: 'Remote ICE candidate rejected.' });
      }
    }

    await remove(snapshot.ref);
  });
  session.addCleanup(unsubscribeMailbox);

  const offer = await transport.peerConnection.createOffer();
  await transport.peerConnection.setLocalDescription(offer);
  await set(offerRef, serializeDescription(transport.peerConnection.localDescription, user.uid));
  publishRoomState('offer-ready');
  session.emitState({ signalingState: 'waiting-for-joiner' });
  logRtcDebug('viewer offer published', { roomId });

  return {
    roomId,
    getState() {
      return session.getState();
    },
    sendSwingPacket(buffer) {
      return transport.sendSwingPacket(buffer);
    },
    sendControlMessage(payload) {
      return transport.sendControlMessage(payload);
    },
    /**
     * Closes the viewer session. Unload closes keep disconnect cleanup armed because the page may die before explicit deletes finish.
     */
    async close({ preserveDisconnectCleanup = false } = {}) {
      logRtcDebug('closing viewer session', {
        roomId,
        preserveDisconnectCleanup,
      });
      session.closeCleanup();
      transport.close();

      if (preserveDisconnectCleanup) {
        return;
      }

      await viewerDisconnectCleanup?.cancel();
      await remove(roomRef);
      logRtcDebug('viewer room removed explicitly', { roomId });
    },
  };
}

function createFreshRoomState(hostUid, hostClientId, createdAt = Date.now()) {
  return {
    hostUid,
    hostClientId,
    guestUid: null,
    state: 'waiting',
    createdAt,
    updatedAt: Date.now(),
  };
}

function summarizeRoom(room) {
  if (!room) {
    return null;
  }

  return {
    hostUid: room.hostUid ?? null,
    hostClientId: room.hostClientId ?? null,
    guestUid: room.guestUid ?? null,
    state: room.state ?? null,
    hasDescriptions: Boolean(room.descriptions),
    mailboxKeys: room.mailboxes ? Object.keys(room.mailboxes) : [],
  };
}

function logRtcDebug(message, details) {
  if (details === undefined) {
    console.info(RTC_DEBUG_PREFIX, message);
    return;
  }

  console.info(RTC_DEBUG_PREFIX, message, details);
}

/**
 * Joins an existing game client by code and answers the host's offer for the phone controller page.
 */
export async function createControllerRtcSession({
  roomId,
  iceServers = defaultIceServers,
  onSwingPacket,
  onControlMessage,
  onStateChange,
}) {
  const normalizedRoomId = normalizeRoomCode(roomId);
  if (!isCompleteRoomCode(normalizedRoomId)) {
    throw new Error('Enter the 4-digit game client id first.');
  }

  const user = await ensureAnonymousUser();
  const database = getDatabase(getFirebaseApp());
  const roomRef = ref(database, `rooms/${normalizedRoomId}`);
  const claimedRoom = await prepareControllerJoin(database, normalizedRoomId, user.uid);

  const session = createBaseSession({
    role: 'controller',
    roomId: normalizedRoomId,
    localUid: user.uid,
    onStateChange,
  });
  session.emitState({
    remoteUid: claimedRoom.hostUid,
    signalingState: 'joining-room',
  });

  const mailboxRef = ref(database, `rooms/${normalizedRoomId}/mailboxes/${user.uid}`);
  const offerRef = ref(database, `rooms/${normalizedRoomId}/descriptions/offer`);
  const answerRef = ref(database, `rooms/${normalizedRoomId}/descriptions/answer`);
  let localAnswerPublished = false;
  const controllerDisconnectCleanup = await registerDisconnectCleanup([
    {
      type: 'update',
      targetRef: roomRef,
      value: {
        guestUid: null,
        state: 'waiting',
      },
    },
    {
      type: 'remove',
      targetRef: answerRef,
    },
    {
      type: 'remove',
      targetRef: mailboxRef,
    },
  ]);

  const transport = createPeerConnection({
    mode: 'joiner',
    iceServers,
    onSwingPacket,
    onControlMessage,
    onStateChange: (transportState) => {
      session.emitState(transportState);
    },
  });

  transport.peerConnection.addEventListener('icecandidate', (event) => {
    if (!event.candidate) {
      return;
    }

    void sendMailboxMessage(database, normalizedRoomId, claimedRoom.hostUid, {
      type: 'ice-candidate',
      fromUid: user.uid,
      candidate: event.candidate.toJSON(),
    });
  });

  const unsubscribeOffer = onValue(offerRef, async (snapshot) => {
    const offer = descriptionFromSnapshot(snapshot.val());
    if (!offer || transport.peerConnection.currentRemoteDescription) {
      return;
    }

    await transport.peerConnection.setRemoteDescription(offer);
    const answer = await transport.peerConnection.createAnswer();
    await transport.peerConnection.setLocalDescription(answer);
    if (!localAnswerPublished) {
      localAnswerPublished = true;
      await set(answerRef, serializeDescription(transport.peerConnection.localDescription, user.uid));
      await update(roomRef, {
        state: 'connecting',
        updatedAt: serverTimestamp(),
      });
      session.emitState({ signalingState: 'connecting' });
    }
  });
  session.addCleanup(unsubscribeOffer);

  const unsubscribeMailbox = onChildAdded(mailboxRef, async (snapshot) => {
    const message = snapshot.val();
    if (message?.type === 'ice-candidate' && message.candidate) {
      try {
        await transport.peerConnection.addIceCandidate(message.candidate);
      } catch (_error) {
        session.emitState({ errorMessage: 'Remote ICE candidate rejected.' });
      }
    }

    await remove(snapshot.ref);
  });
  session.addCleanup(unsubscribeMailbox);

  return {
    roomId: normalizedRoomId,
    getState() {
      return session.getState();
    },
    sendSwingPacket(buffer) {
      return transport.sendSwingPacket(buffer);
    },
    sendControlMessage(payload) {
      return transport.sendControlMessage(payload);
    },
    /**
     * Closes the controller session. Unload closes rely on server-side disconnect cleanup instead of explicit writes.
     */
    async close({ preserveDisconnectCleanup = false } = {}) {
      session.closeCleanup();
      transport.close();

      if (preserveDisconnectCleanup) {
        return;
      }

      await controllerDisconnectCleanup.cancel();
      await update(roomRef, {
        guestUid: null,
        state: 'waiting',
        updatedAt: serverTimestamp(),
      });
      await Promise.allSettled([
        remove(answerRef),
        remove(mailboxRef),
      ]);
    },
  };
}