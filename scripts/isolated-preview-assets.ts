import { assertPreviewAssetTarget, type PreviewOptions } from './preview-options';
import { createScopedAssetFetcher } from '../src/main/scoped-assets';

/** Isolated copied fixtures are at most 1 MB/file. No redirect is ever followed,
 * so an allowed initial loopback URL cannot forward a request to the primary. */
export function createIsolatedPreviewAssetFetcher(options: PreviewOptions) {
  if (!options.isolation) throw new Error('An explicit isolated asset scope is required.');
  return createScopedAssetFetcher(input => assertPreviewAssetTarget(input, options));
}
