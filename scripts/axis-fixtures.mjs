import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './axis-common.mjs';

// Original low-poly fixture geometry. Coordinates here are metres; RWX is 10m/unit.
function box(x, y, z, width, height, depth, color) {
  const vertices = [
    [x-width/2,y,z-depth/2],[x+width/2,y,z-depth/2],[x+width/2,y+height,z-depth/2],[x-width/2,y+height,z-depth/2],
    [x-width/2,y,z+depth/2],[x+width/2,y,z+depth/2],[x+width/2,y+height,z+depth/2],[x-width/2,y+height,z+depth/2],
  ];
  return `ClumpBegin\nColor ${color.join(' ')}\nSurface 0.5 0.7 0.05\n` + vertices.map(p => `Vertex ${p.map(v => (v / 10).toFixed(5)).join(' ')}`).join('\n') + '\nQuad 1 4 3 2\nQuad 5 6 7 8\nQuad 1 5 8 4\nQuad 2 3 7 6\nQuad 4 8 7 3\nQuad 1 2 6 5\nClumpEnd\n';
}
function diamond(x, y, z, width, height, color) {
  const vertices = [[x,y,z],[x-width/2,y+height/2,z],[x,y+height/2,z-width/2],[x+width/2,y+height/2,z],[x,y+height/2,z+width/2],[x,y+height,z]];
  return `ClumpBegin\nColor ${color.join(' ')}\n` + vertices.map(p => `Vertex ${p.map(v => v / 10).join(' ')}`).join('\n') + '\nTriangle 1 2 3\nTriangle 1 3 4\nTriangle 1 4 5\nTriangle 1 5 2\nTriangle 6 3 2\nTriangle 6 4 3\nTriangle 6 5 4\nTriangle 6 2 5\nClumpEnd\n';
}

export function ensureAssets() {
  const assetRoot = join(root, 'public', 'assets');
  mkdirSync(join(assetRoot, 'models'), { recursive: true });
  const stone = [.78,.74,.64], wood = [.37,.24,.16], green = [.23,.43,.31], gold = [.8,.56,.27];
  const models = {
    ground: box(0,-.08,0,100,.08,100,[.51,.65,.47]),
    plaza: box(0,0,0,36,.1,50,stone) + box(0,.1,0,2,.02,50,[.6,.59,.52]),
    column: box(0,0,0,1.8,.4,1.8,stone) + box(0,.4,0,1,5,1,stone) + box(0,5.4,0,1.8,.4,1.8,stone),
    arch: box(-5,0,0,1.5,7,2,stone)+box(5,0,0,1.5,7,2,stone)+box(0,7,0,12,1.2,2,stone),
    tree: box(0,0,0,.55,3.5,.55,wood)+diamond(0,2,0,6,7,green)+diamond(0,4,0,4,6,[.29,.5,.36]),
    bench: box(0,.5,0,3,.3,.8,wood)+box(0,.8,.3,3,.9,.2,wood)+box(-1,0,0,.2,.5,.6,stone)+box(1,0,0,.2,.5,.6,stone),
    sculpture: box(0,0,0,4,.4,4,stone)+box(0,.4,0,2,1,2,stone)+diamond(0,1.4,0,2.5,5.8,gold),
    lamp: box(0,0,0,.3,4.5,.3,[.18,.24,.25])+diamond(0,4.2,0,.9,1.1,[1,.87,.57]),
  };
  for (const [name, geometry] of Object.entries(models)) {
    const path = join(assetRoot, 'models', `${name}.rwx`);
    if (!existsSync(path)) writeFileSync(path, `# Original Wayfarer fixture asset; CC0-1.0\nModelBegin\n${geometry}ModelEnd\n`);
  }
  const objects = [];
  const add = (model, x, z, yaw = 0, description = '') => objects.push({ model: `${model}.rwx`, x: x * 100, y: 0, z: z * 100, yaw: yaw * 10, description, action: '' });
  add('ground',0,0); add('plaza',0,2); add('sculpture',0,8,0,'The beginning — an original Wayfarer sculpture'); add('arch',0,31,0,'Haven gateway');
  for (const x of [-22,22]) for (const z of [-20,-8,4,16,28,40]) add('tree',x,z);
  for (const x of [-15,15]) for (const z of [-12,4,20]) add('bench',x,z,x < 0 ? 90 : -90);
  for (const x of [-17,17]) for (const z of [-19,-3,13,29]) add('lamp',x,z);
  for (const x of [-9,9]) add('column',x,31);
  const manifest = join(assetRoot, 'haven.json');
  if (!existsSync(manifest)) writeFileSync(manifest, JSON.stringify({ license: 'CC0-1.0', units: 'centimetres; angles tenths of degrees', objects }, null, 2));
  const notice = join(assetRoot, 'LICENSE.txt');
  if (!existsSync(notice)) writeFileSync(notice, 'The original Wayfarer fixture models and haven.json in this directory are dedicated to the public domain under CC0 1.0 Universal: https://creativecommons.org/publicdomain/zero/1.0/\nNo Active Worlds assets are included.\n');
}
