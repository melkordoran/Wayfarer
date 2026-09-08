import data from './studio-avatar-data.json';
import directXData from './studio-directx-data.json';
import directXAnimationData from './studio-directx-animation-data.json';
import type { AssetFetcher } from './assets';

/** A virtual object path used only with the explicitly supplied local adapter.
 * Nothing at this address is fetched from the network or the protocol bridge. */
export const STUDIO_AVATAR_PATH = 'https://studio.wayfarer.invalid/';

const bundled = new Map<string, { bytes: Uint8Array; contentType: string }>();
const directXAllowlist = new Set(['avatars/wf-x-voyager.x', 'avatars/wf-x-voyager.zip', 'textures/wf-x-corners.png', 'avatars/avatars.dat', 'avatars/avatars.zip', 'avatars/directx-LICENSE.txt']);
if (Object.keys(directXData).length !== directXAllowlist.size || Object.keys(directXData).some(name => !directXAllowlist.has(name)))
  throw new Error('Invalid original DirectX studio asset allowlist.');
const directXAnimationAllowlist = new Set([
  'avatars/avatars.dat', 'avatars/avatars.zip', 'seqs/directx-animation-LICENSE.txt', 'seqs/wf-x-salute-seq.seq',
  ...['', '-binary32', '-binary64', '-tzip', '-bzip'].flatMap(suffix => ['x', 'zip'].map(extension => `seqs/wf-x-salute${suffix}.${extension}`)),
]);
if (Object.keys(directXAnimationData).length !== directXAnimationAllowlist.size || Object.keys(directXAnimationData).some(name => !directXAnimationAllowlist.has(name)))
  throw new Error('Invalid original DirectX animation studio asset allowlist.');
for (const [name, encoded] of Object.entries({ ...data, ...directXData, ...directXAnimationData })) {
  const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
  const contentType = name.endsWith('.zip') ? 'application/zip'
    : name.endsWith('.seq') || name.endsWith('.x') ? 'application/octet-stream'
    : name.endsWith('.png') ? 'image/png'
    : 'text/plain; charset=utf-8';
  bundled.set(STUDIO_AVATAR_PATH + name, { bytes, contentType });
}

/** Exact generated URL allowlist; each caller receives its own mutable copy. */
export const fetchStudioAvatarAsset: AssetFetcher = async url => {
  const asset = bundled.get(url);
  if (!asset) throw new Error('That asset is not part of the original studio avatar collection.');
  return { bytes: asset.bytes.slice(), contentType: asset.contentType };
};
