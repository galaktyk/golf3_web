const ROOM_CODE_DIGITS = '0123456789';
const ROOM_CODE_LEADING_DIGITS = '123456789';
const ROOM_CODE_LENGTH = 4;
const VIEWER_CODE_STORAGE_KEY = 'golf3.viewerGameClientCode';
const VIEWER_HOST_ID_STORAGE_KEY = 'golf3.viewerHostClientId';
const CONTROLLER_CODE_STORAGE_KEY = 'golf3.controllerGameClientId';
const CLIENT_ID_QUERY_PARAM = 'clientId';

/**
 * Creates a short numeric room code so phone entry stays fast on a number keypad.
 */
export function generateRoomCode(length = ROOM_CODE_LENGTH) {
  if (length <= 0) {
    return '';
  }

  let roomCode = '';
  for (let index = 0; index < length; index += 1) {
    const digitAlphabet = index === 0 ? ROOM_CODE_LEADING_DIGITS : ROOM_CODE_DIGITS;
    const randomIndex = Math.floor(Math.random() * digitAlphabet.length);
    roomCode += digitAlphabet[randomIndex];
  }

  return roomCode;
}

/**
 * Normalizes user-entered room codes to the canonical numeric format.
 */
export function normalizeRoomCode(value) {
  return String(value ?? '')
    .replace(/\D/g, '')
    .slice(0, ROOM_CODE_LENGTH);
}

/**
 * Returns true when a room code contains exactly the required number of digits.
 */
export function isCompleteRoomCode(value) {
  return normalizeRoomCode(value).length === ROOM_CODE_LENGTH;
}

/**
 * Reads a previously used game client code from local storage when available.
 */
export function loadStoredViewerCode() {
  return loadStoredCode(VIEWER_CODE_STORAGE_KEY);
}

/**
 * Persists the current viewer game client code so refreshes can reuse it when possible.
 */
export function saveStoredViewerCode(value) {
  saveStoredCode(VIEWER_CODE_STORAGE_KEY, value);
}

/**
 * Returns a stable browser-local viewer host id so refreshes can recognize the same host.
 */
export function ensureStoredViewerHostId() {
  try {
    const existingHostId = normalizeStoredIdentifier(window.localStorage.getItem(VIEWER_HOST_ID_STORAGE_KEY));
    if (existingHostId) {
      return existingHostId;
    }

    const createdHostId = createStoredIdentifier();
    window.localStorage.setItem(VIEWER_HOST_ID_STORAGE_KEY, createdHostId);
    return createdHostId;
  } catch (_error) {
    return createStoredIdentifier();
  }
}

/**
 * Reads the last game client id entered on the phone controller.
 */
export function loadStoredControllerCode() {
  return loadStoredCode(CONTROLLER_CODE_STORAGE_KEY);
}

/**
 * Persists the last game client id entered on the phone controller.
 */
export function saveStoredControllerCode(value) {
  saveStoredCode(CONTROLLER_CODE_STORAGE_KEY, value);
}

/**
 * Reads a controller client id from the current URL so shared pairing links can prefill the phone page.
 */
export function loadControllerCodeFromUrl(location = window.location) {
  try {
    const search = typeof location?.search === 'string' ? location.search : '';
    return normalizeRoomCode(new URLSearchParams(search).get(CLIENT_ID_QUERY_PARAM));
  } catch (_error) {
    return '';
  }
}

/**
 * Builds the controller deep link used by the viewer QR code and manual sharing flows.
 */
export function buildControllerUrl(clientId, location = window.location) {
  const controllerUrl = new URL('../golf_club', location.href);
  const normalizedClientId = normalizeRoomCode(clientId);

  if (normalizedClientId) {
    controllerUrl.searchParams.set(CLIENT_ID_QUERY_PARAM, normalizedClientId);
  } else {
    controllerUrl.searchParams.delete(CLIENT_ID_QUERY_PARAM);
  }

  return controllerUrl.toString();
}

function loadStoredCode(storageKey) {
  try {
    return normalizeRoomCode(window.localStorage.getItem(storageKey));
  } catch (_error) {
    return '';
  }
}

function saveStoredCode(storageKey, value) {
  try {
    const normalizedValue = normalizeRoomCode(value);
    if (!normalizedValue) {
      window.localStorage.removeItem(storageKey);
      return;
    }

    window.localStorage.setItem(storageKey, normalizedValue);
  } catch (_error) {
    // Storage access is best-effort because some browsers block it in private contexts.
  }
}

function normalizeStoredIdentifier(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
}

function createStoredIdentifier() {
  const randomUuid = typeof window.crypto?.randomUUID === 'function'
    ? window.crypto.randomUUID()
    : `viewer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  return normalizeStoredIdentifier(randomUuid);
}