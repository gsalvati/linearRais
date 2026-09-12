// Converte os .step do repositorio PTFE-PETG-examples em .glb tesselados.
// A leitura do B-rep e feita pelo OpenCascade compilado em WASM (occt-import-js);
// o GLB e escrito na mao para nao arrastar mais dependencias.
import occtimportjs from 'occt-import-js';
import fs from 'node:fs';
import path from 'node:path';
import { analyzeStep } from '../public/lib/step-features.js';

const SRC = process.argv[2];
const OUT = process.argv[3];

if (!SRC || !OUT) {
  console.error('uso: node tools/step2glb.mjs <dir-com-steps> <dir-de-saida>');
  process.exit(1);
}

const COMP = { f32: 5126, u32: 5125 };

function alignTo4(n) {
  return (n + 3) & ~3;
}

// Monta um GLB de uma malha por primitiva, cada uma com seu material opaco.
function buildGlb(meshes) {
  const bin = [];
  let binLength = 0;
  const bufferViews = [];
  const accessors = [];

  const pushView = (typedArray) => {
    const bytes = new Uint8Array(
      typedArray.buffer,
      typedArray.byteOffset,
      typedArray.byteLength,
    );
    const padded = alignTo4(binLength);
    if (padded > binLength) {
      bin.push(new Uint8Array(padded - binLength));
      binLength = padded;
    }
    bin.push(bytes);
    bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: bytes.byteLength });
    binLength += bytes.byteLength;
    return bufferViews.length - 1;
  };

  const pushAccessor = (typedArray, componentType, type, count, extra = {}) => {
    accessors.push({
      bufferView: pushView(typedArray),
      componentType,
      count,
      type,
      ...extra,
    });
    return accessors.length - 1;
  };

  const gltfMeshes = [];
  const materials = [];
  const nodes = [];
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  let triangles = 0;

  for (const mesh of meshes) {
    const position = Float32Array.from(mesh.attributes.position.array);
    const index = Uint32Array.from(mesh.index.array);
    const normal = mesh.attributes.normal
      ? Float32Array.from(mesh.attributes.normal.array)
      : null;

    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < position.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        const v = position[i + axis];
        if (v < min[axis]) min[axis] = v;
        if (v > max[axis]) max[axis] = v;
      }
    }
    for (let axis = 0; axis < 3; axis++) {
      bounds.min[axis] = Math.min(bounds.min[axis], min[axis]);
      bounds.max[axis] = Math.max(bounds.max[axis], max[axis]);
    }

    const attributes = {
      POSITION: pushAccessor(position, COMP.f32, 'VEC3', position.length / 3, { min, max }),
    };
    if (normal) {
      attributes.NORMAL = pushAccessor(normal, COMP.f32, 'VEC3', normal.length / 3);
    }
    const indicesAccessor = pushAccessor(index, COMP.u32, 'SCALAR', index.length);
    triangles += index.length / 3;

    const color = mesh.color || [0.72, 0.74, 0.78];
    materials.push({
      name: `${mesh.name || 'part'}_mat`,
      pbrMetallicRoughness: {
        baseColorFactor: [color[0], color[1], color[2], 1],
        metallicFactor: 0.05,
        roughnessFactor: 0.62,
      },
      doubleSided: false,
    });

    gltfMeshes.push({
      name: mesh.name || `mesh_${gltfMeshes.length}`,
      primitives: [{ attributes, indices: indicesAccessor, material: materials.length - 1 }],
    });
    nodes.push({ mesh: gltfMeshes.length - 1, name: mesh.name || `node_${nodes.length}` });
  }

  const json = {
    asset: { version: '2.0', generator: 'step2glb (occt-import-js)' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes: gltfMeshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: alignTo4(binLength) }],
  };

  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPadded = Buffer.alloc(alignTo4(jsonBytes.length), 0x20);
  jsonBytes.copy(jsonPadded);

  const binBuffer = Buffer.concat(bin.map((b) => Buffer.from(b)));
  const binPadded = Buffer.alloc(alignTo4(binLength), 0);
  binBuffer.copy(binPadded);

  const total = 12 + 8 + jsonPadded.length + 8 + binPadded.length;
  const glb = Buffer.alloc(total);
  let o = 0;
  glb.writeUInt32LE(0x46546c67, o); o += 4;   // "glTF"
  glb.writeUInt32LE(2, o); o += 4;
  glb.writeUInt32LE(total, o); o += 4;
  glb.writeUInt32LE(jsonPadded.length, o); o += 4;
  glb.writeUInt32LE(0x4e4f534a, o); o += 4;   // "JSON"
  jsonPadded.copy(glb, o); o += jsonPadded.length;
  glb.writeUInt32LE(binPadded.length, o); o += 4;
  glb.writeUInt32LE(0x004e4942, o); o += 4;   // "BIN"
  binPadded.copy(glb, o);

  return { glb, bounds, triangles };
}

function collectSteps(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...collectSteps(full));
    else if (/\.stp?e?p?$/i.test(entry.name) && /\.(step|stp)$/i.test(entry.name)) found.push(full);
  }
  return found;
}

const occt = await occtimportjs();
const steps = collectSteps(SRC).sort();
fs.mkdirSync(OUT, { recursive: true });

const manifest = [];
for (const file of steps) {
  const rel = path.relative(SRC, file);
  const group = path.dirname(rel) === '.' ? 'Raiz' : path.dirname(rel).split(path.sep).join(' / ');
  const label = path.basename(file).replace(/\.(step|stp)$/i, '');
  const slug = rel.replace(/\.(step|stp)$/i, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();

  const started = Date.now();
  const source = fs.readFileSync(file);
  const result = occt.ReadStepFile(new Uint8Array(source), null);
  if (!result.success || result.meshes.length === 0) {
    console.error(`  FALHOU  ${rel}`);
    continue;
  }
  const { glb, bounds, triangles } = buildGlb(result.meshes);
  fs.writeFileSync(path.join(OUT, `${slug}.glb`), glb);

  // Reconhecimento de features num arquivo ao lado: o visualizador so busca
  // quando a peca entra em foco, e o manifesto fica pequeno.
  const features = analyzeStep(source.toString('latin1'));
  if (features) fs.writeFileSync(path.join(OUT, `${slug}.features.json`), JSON.stringify(features));

  const size = [0, 1, 2].map((i) => +(bounds.max[i] - bounds.min[i]).toFixed(2));
  manifest.push({
    slug,
    label: label.replace(/_/g, ' '),
    group,
    source: rel,
    file: `${slug}.glb`,
    bytes: glb.length,
    sourceBytes: fs.statSync(file).size,
    triangles,
    features: features
      ? {
          file: `${slug}.features.json`,
          holes: features.holes.length,
          patterns: features.patterns.length,
        }
      : null,
    size,
    center: [0, 1, 2].map((i) => +((bounds.max[i] + bounds.min[i]) / 2).toFixed(3)),
  });
  console.log(
    `  ok  ${rel}  ->  ${slug}.glb  (${triangles} tris, ${(glb.length / 1024).toFixed(0)} kB, ${Date.now() - started} ms)`,
  );
}

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`\n${manifest.length} pecas convertidas em ${OUT}`);
