import { SURFACE_TYPES, SURFACE_TEXTURE_MAP, SURFACE_PHYSICS_PROPERTIES } from '/static/js/game/surfaceData.js';

let textureToSurfaceTypeCache = null;

function buildTextureToSurfaceCache() {
  textureToSurfaceTypeCache = new Map();
  for (const [surfaceType, textures] of Object.entries(SURFACE_TEXTURE_MAP)) {
    for (const textureName of textures) {
      // Assuming texture names can be mapped back just by strict equality of base string part
      // We will normalize names below just in case.
      textureToSurfaceTypeCache.set(textureName.toLowerCase(), surfaceType);
    }
  }
}

export function getSurfaceTypeFromTextureName(textureName) {
  if (!textureName) {
    return SURFACE_TYPES.DEFAULT;
  }

  if (!textureToSurfaceTypeCache) {
    buildTextureToSurfaceCache();
  }

  // E.g. textureName might be a bare asset id, a filename, or a full URL/path.
  let lookupName = textureName.toLowerCase();
  const slashIndex = Math.max(lookupName.lastIndexOf('/'), lookupName.lastIndexOf('\\'));
  if (slashIndex !== -1) {
    lookupName = lookupName.substring(slashIndex + 1);
  }

  const extMatch = lookupName.lastIndexOf('.');
  if (extMatch !== -1) {
    lookupName = lookupName.substring(0, extMatch);
  }

  return textureToSurfaceTypeCache.get(lookupName) || SURFACE_TYPES.DEFAULT;
}

export function getSurfaceProperties(surfaceType) {
  const finalType = SURFACE_PHYSICS_PROPERTIES[surfaceType] ? surfaceType : SURFACE_TYPES.DEFAULT;
  return SURFACE_PHYSICS_PROPERTIES[finalType];
}
