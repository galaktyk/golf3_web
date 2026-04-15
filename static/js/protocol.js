const INT16_MAX = 32767;
const UINT16_MAX = 65535;

export const SWING_PACKET_VERSION = 1;
export const SWING_PACKET_KIND = 1;
export const SWING_PACKET_SIZE_BYTES = 16;

export const CONTROL_ACTIONS = Object.freeze({
  clubPrevious: 'club.previous',
  clubNext: 'club.next',
  practiceSwingEnable: 'swing.practice.enable',
  actualSwingEnable: 'swing.actual.enable',
  rotateLeft: 'character.rotateLeft',
  rotateRight: 'character.rotateRight',
  aimIncrease: 'aim.preview.increase',
  aimDecrease: 'aim.preview.decrease',
  aimCameraToggle: 'camera.aim.toggle',
});

export const REMOTE_INPUT_TYPES = Object.freeze({
  control: 'control',
  joystick: 'joystick',
});

export function encodeSwingStatePacket({
  quaternion,
  perpendicularAngularSpeedRadiansPerSecond = 0,
  motionAgeMilliseconds = 0,
  sequence = 0,
}) {
  const normalized = quaternion.clone().normalize();
  const buffer = new ArrayBuffer(SWING_PACKET_SIZE_BYTES);
  const view = new DataView(buffer);

  view.setUint8(0, SWING_PACKET_VERSION);
  view.setUint8(1, SWING_PACKET_KIND);
  view.setUint16(2, clampToUint16(sequence), true);
  view.setInt16(4, clampToInt16(normalized.x), true);
  view.setInt16(6, clampToInt16(normalized.y), true);
  view.setInt16(8, clampToInt16(normalized.z), true);
  view.setInt16(10, clampToInt16(normalized.w), true);
  view.setUint16(12, encodeHundredths(perpendicularAngularSpeedRadiansPerSecond), true);
  view.setUint16(14, clampToUint16(motionAgeMilliseconds), true);

  return buffer;
}

export function decodeSwingStatePacket(buffer, targetQuaternion, targetState = {}) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== SWING_PACKET_SIZE_BYTES) {
    return null;
  }

  const view = new DataView(buffer);
  const version = view.getUint8(0);
  const kind = view.getUint8(1);
  if (version !== SWING_PACKET_VERSION || kind !== SWING_PACKET_KIND) {
    return null;
  }

  targetQuaternion.set(
    decodeInt16(view.getInt16(4, true)),
    decodeInt16(view.getInt16(6, true)),
    decodeInt16(view.getInt16(8, true)),
    decodeInt16(view.getInt16(10, true)),
  );

  targetQuaternion.normalize();

  targetState.version = version;
  targetState.kind = kind;
  targetState.sequence = view.getUint16(2, true);
  targetState.perpendicularAngularSpeedRadiansPerSecond = decodeHundredths(view.getUint16(12, true));
  targetState.motionAgeMilliseconds = view.getUint16(14, true);
  return targetState;
}

export function encodeControlMessage(action, active = true, value = null) {
  const payload = {
    type: REMOTE_INPUT_TYPES.control,
    action,
    active,
  };

  if (Number.isFinite(value)) {
    payload.value = Math.max(0, Math.min(1, value));
  }

  return JSON.stringify(payload);
}

export function encodeJoystickMessage(x = 0, y = 0) {
  return JSON.stringify({
    type: REMOTE_INPUT_TYPES.joystick,
    x: clampToUnitAxis(x),
    y: clampToUnitAxis(y),
  });
}

export function decodeControlMessage(payload) {
  if (!payload || payload.type !== REMOTE_INPUT_TYPES.control || typeof payload.action !== 'string') {
    return null;
  }

  return {
    type: payload.type,
    action: payload.action,
    active: payload.active !== false,
    value: Number.isFinite(payload.value) ? Math.max(0, Math.min(1, payload.value)) : null,
  };
}

export function decodeJoystickMessage(payload) {
  if (!payload || payload.type !== REMOTE_INPUT_TYPES.joystick) {
    return null;
  }

  return {
    type: payload.type,
    x: clampToUnitAxis(payload.x),
    y: clampToUnitAxis(payload.y),
  };
}

function clampToInt16(value) {
  const clamped = Math.max(-1, Math.min(1, value));
  return Math.round(clamped * INT16_MAX);
}

function clampToUint16(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(UINT16_MAX, Math.round(value)));
}

function decodeInt16(value) {
  return Math.max(-1, Math.min(1, value / INT16_MAX));
}

function encodeHundredths(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return clampToUint16(value * 100);
}

function decodeHundredths(value) {
  return value / 100;
}

function clampToUnitAxis(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(-1, Math.min(1, value));
}