const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LENGTH = 6;
const VIEWER_CODE_STORAGE_KEY = 'golf3.viewerGameClientCode';
const CONTROLLER_CODE_STORAGE_KEY = 'golf3.controllerGameClientId';

/**
 * Creates a short room code without ambiguous characters so phone entry stays practical.
 */
export function generateRoomCode(length = ROOM_CODE_LENGTH) {
  let roomCode = '';
  for (let index = 0; index < length; index += 1) {
    const randomIndex = Math.floor(Math.random() * ROOM_CODE_ALPHABET.length);
    roomCode += ROOM_CODE_ALPHABET[randomIndex];
  }

  return roomCode;
}

/**
 * Normalizes user-entered room codes to the canonical uppercase, alphanumeric format.
 */
export function normalizeRoomCode(value) {
  return String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, ROOM_CODE_LENGTH);
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