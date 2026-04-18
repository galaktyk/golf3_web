import * as THREE from 'three';

export function configureUnlitMaterials(root) {
  root.traverse((node) => {
    if (!node.isMesh) {
      return;
    }

    const materials = Array.isArray(node.material) ? node.material : [node.material];
    const unlitMaterials = materials.map((material) => createUnlitMaterial(material, node));

    node.material = Array.isArray(node.material) ? unlitMaterials : unlitMaterials[0];
  });
}

export function configureFlatShadedMaterials(root) {
  root.traverse((node) => {
    if (!node.isMesh) {
      return;
    }

    const materials = Array.isArray(node.material) ? node.material : [node.material];
    const flatShadedMaterials = materials.map((material) => createFlatShadedMaterial(material, node));

    node.material = Array.isArray(node.material) ? flatShadedMaterials : flatShadedMaterials[0];
  });
}

/**
 * Applies anisotropic filtering to all textures referenced by mesh materials under a scene subtree.
 */
export function configureMaterialTextureAnisotropy(root, anisotropy) {
  if (!root || !Number.isFinite(anisotropy) || anisotropy < 1) {
    return;
  }

  root.traverse((node) => {
    if (!node.isMesh) {
      return;
    }

    const materials = Array.isArray(node.material) ? node.material : [node.material];
    materials.forEach((material) => applyTextureAnisotropy(material, anisotropy));
  });
}

function createUnlitMaterial(sourceMaterial, sourceNode) {
  if (!sourceMaterial) {
    return applyAnimationMaterialFlags(new THREE.MeshBasicMaterial({ color: '#ffffff' }), sourceNode, null);
  }

  const hasAlphaTexture = Boolean(sourceMaterial.map || sourceMaterial.alphaMap);
  const isTransparent = sourceMaterial.transparent || sourceMaterial.opacity < 1;
  const alphaTest = hasAlphaTexture && !isTransparent
    ? Math.max(sourceMaterial.alphaTest ?? 0, 0.01)
    : 0;

  return applyAnimationMaterialFlags(new THREE.MeshBasicMaterial({
    name: sourceMaterial.name,
    color: sourceMaterial.color?.clone() ?? new THREE.Color('#ffffff'),
    map: sourceMaterial.map ?? null,
    alphaMap: sourceMaterial.alphaMap ?? null,
    side: sourceMaterial.side,
    transparent: isTransparent,
    opacity: sourceMaterial.opacity,
    alphaTest,
    depthWrite: !isTransparent,
  }), sourceNode, sourceMaterial);
}

function createFlatShadedMaterial(sourceMaterial, sourceNode) {
  if (!sourceMaterial) {
    return applyAnimationMaterialFlags(new THREE.MeshLambertMaterial({ color: '#ffffff', flatShading: true }), sourceNode, null);
  }

  const hasAlphaTexture = Boolean(sourceMaterial.map || sourceMaterial.alphaMap);
  const isTransparent = sourceMaterial.transparent || sourceMaterial.opacity < 1;
  const alphaTest = hasAlphaTexture && !isTransparent
    ? Math.max(sourceMaterial.alphaTest ?? 0, 0.01)
    : 0;

  return applyAnimationMaterialFlags(new THREE.MeshLambertMaterial({
    name: sourceMaterial.name,
    color: sourceMaterial.color?.clone() ?? new THREE.Color('#ffffff'),
    map: sourceMaterial.map ?? null,
    alphaMap: sourceMaterial.alphaMap ?? null,
    side: sourceMaterial.side,
    transparent: isTransparent,
    opacity: sourceMaterial.opacity,
    alphaTest,
    depthWrite: !isTransparent,
    flatShading: true,
  }), sourceNode, sourceMaterial);
}

function applyAnimationMaterialFlags(material, sourceNode, sourceMaterial) {
  if (sourceNode?.isSkinnedMesh) {
    material.skinning = true;
  }

  if (sourceMaterial?.morphTargets) {
    material.morphTargets = true;
  }

  if (sourceMaterial?.morphNormals) {
    material.morphNormals = true;
  }

  material.needsUpdate = true;
  return material;
}

function applyTextureAnisotropy(material, anisotropy) {
  if (!material) {
    return;
  }

  for (const key of ['map', 'alphaMap']) {
    const texture = material[key];
    if (texture) {
      texture.anisotropy = anisotropy;
      texture.needsUpdate = true;
    }
  }
}