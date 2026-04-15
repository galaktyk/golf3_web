/**
 * Resolves an asset path against the repository root so the app works both at `/`
 * and when published under a GitHub Pages project path such as `/golf3_web/`.
 */
export function resolveAssetUrl(assetPath) {
  const normalizedAssetPath = String(assetPath).replace(/^\/+/, '');
  return new URL(`../../assets/${normalizedAssetPath}`, import.meta.url).href;
}