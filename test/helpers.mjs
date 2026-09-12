// Leitura direta dos .glb e .features.json gerados por `npm run convert`, para
// os testes trabalharem com a mesma coisa que o visualizador carrega.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const stepPath = (relative) => path.join(ROOT, 'vendor/PTFE-PETG-examples', relative);
export const readStep = (relative) => fs.readFileSync(stepPath(relative), 'latin1');

export const readFeatures = (slug) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, 'public/models', `${slug}.features.json`), 'utf8'));

/** Posições e índices da primeira malha de um .glb. */
export function readGlb(slug) {
  const buffer = fs.readFileSync(path.join(ROOT, 'public/models', `${slug}.glb`));
  const jsonLength = buffer.readUInt32LE(12);
  const json = JSON.parse(buffer.toString('utf8', 20, 20 + jsonLength));
  const binOffset = 20 + jsonLength + 8;

  const read = (accessorIndex, Type, perElement) => {
    const accessor = json.accessors[accessorIndex];
    const view = json.bufferViews[accessor.bufferView];
    return new Type(
      buffer.buffer,
      buffer.byteOffset + binOffset + (view.byteOffset ?? 0),
      accessor.count * perElement,
    );
  };

  const primitive = json.meshes[0].primitives[0];
  return {
    positions: read(primitive.attributes.POSITION, Float32Array, 3),
    indices: read(primitive.indices, Uint32Array, 1),
  };
}

export function boundingBox(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[i + axis];
      if (value < min[axis]) min[axis] = value;
      if (value > max[axis]) max[axis] = value;
    }
  }
  return { min, max, size: [0, 1, 2].map((a) => max[a] - min[a]) };
}

/** Erro relativo, para comparar volumes sem amarrar em casas decimais. */
export const relative = (value, reference) => Math.abs(value - reference) / Math.abs(reference);
