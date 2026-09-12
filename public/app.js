import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { analyzeStep, allHoles, allPatterns, findPattern } from './lib/step-features.js';
import { stretchPositions, suggestStation, conflictsAt } from './lib/stretch.js';
import { rebuildWithHoles, holeSolids } from './lib/holes.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';

// Os .step do repositorio sao pre-tesselados em .glb por tools/step2glb.mjs.
// Arquivos soltos arrastados para a janela passam pelo OpenCascade em WASM,
// carregado sob demanda em readStepInBrowser().

const PALETTE = [
  0x4ea8ff, 0xffb454, 0x7ee081, 0xff7b7b, 0xc08cff,
  0x4fd6d2, 0xf27ac0, 0xd5dd5a, 0x8fa3ff, 0xffa07a,
];

const state = {
  parts: [],                 // manifesto
  active: new Map(),         // slug -> { part, holder, meshes, edges, box }
  layout: 'origin',
  originBounds: null,        // extensao do conjunto nas coordenadas do CAD
  focus: null,               // slug da peca que o painel de medidas edita
  uniform: true,             // escala proporcional nos tres eixos
  editMode: 'scale',         // painel ativo: 'scale' ou 'stretch'
  show: { edges: true, wireframe: false, bbox: false, grid: true, spin: false },
  dropped: 0,
};

const el = {
  canvas: document.getElementById('canvas'),
  parts: document.getElementById('parts'),
  status: document.getElementById('status'),
  info: document.getElementById('info'),
  focus: document.getElementById('focus'),
  // So os campos do painel de escala — o de estiramento tem os seus proprios.
  dims: document.querySelectorAll('[data-panel="scale"] .dims input'),
  uniform: document.getElementById('uniform'),
  pct: document.getElementById('scale-pct'),
  vars: document.getElementById('vars'),
  stretchLength: document.getElementById('stretch-length'),
  stretchStation: document.getElementById('stretch-station'),
  stretchSlider: document.getElementById('stretch-slider'),
  stretchHint: document.getElementById('stretch-hint'),
  holePattern: document.getElementById('hole-pattern'),
  holeCount: document.getElementById('hole-count'),
  holePitch: document.getElementById('hole-pitch'),
  holeEdge: document.getElementById('hole-edge'),
  holeDiameter: document.getElementById('hole-diameter'),
  holeHint: document.getElementById('hole-hint'),
  overlay: document.getElementById('overlay'),
  toolbar: document.getElementById('toolbar'),
};

/* ------------------------------------------------------------------ cena */

const renderer = new THREE.WebGLRenderer({ canvas: el.canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1014);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(38, 1, 0.5, 8000);
camera.position.set(220, 170, 260);

const controls = new OrbitControls(camera, el.canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxDistance = 4000;

const key = new THREE.DirectionalLight(0xffffff, 1.5);
key.position.set(180, 320, 240);
scene.add(key, new THREE.AmbientLight(0xffffff, 0.25));

// Grade em milimetros: celulas de 10 mm, reforco a cada 50 mm.
const grid = new THREE.Group();
const fine = new THREE.GridHelper(600, 60, 0x2a323d, 0x1c222a);
const coarse = new THREE.GridHelper(600, 12, 0x3a4450, 0x39424f);
grid.add(fine, coarse);
scene.add(grid);

const world = new THREE.Group();     // pecas, com o conjunto assentado na grade
const helpers = new THREE.Group();   // caixas envolventes, sempre em coordenadas de mundo
scene.add(world, helpers);

/* ------------------------------------------------------- carregar pecas */

const loader = new GLTFLoader();
const cache = new Map();   // slug -> THREE.Group (template, ja em Y-up)

function toYUp(object) {
  // CAD exporta Z para cima; three.js usa Y. Envelopa e rotaciona.
  const wrapper = new THREE.Group();
  object.rotation.x = -Math.PI / 2;
  wrapper.add(object);
  return wrapper;
}

async function templateFor(part) {
  if (cache.has(part.slug)) return cache.get(part.slug);
  const gltf = await loader.loadAsync(`models/${part.file}`);
  const template = toYUp(gltf.scene);
  cache.set(part.slug, template);
  return template;
}

function instantiate(template, color) {
  const holder = new THREE.Group();
  const clone = template.clone(true);
  const meshes = [];
  const edges = [];

  clone.traverse((node) => {
    if (!node.isMesh) return;
    // A geometria vem do template e e compartilhada; o material e por instancia.
    node.material = new THREE.MeshStandardMaterial({ color, metalness: 0.04, roughness: 0.55 });
    node.material.wireframe = state.show.wireframe;
    sourceOf(node);
    meshes.push(node);

    const line = new THREE.LineSegments(
      new THREE.EdgesGeometry(node.geometry, 22),
      new THREE.LineBasicMaterial({ color: 0x0b0e12, transparent: true, opacity: 0.5 }),
    );
    line.visible = state.show.edges && !state.show.wireframe;
    node.add(line);
    edges.push(line);
  });

  holder.add(clone);

  // Fica fora do holder para nao se auto-incluir no calculo do proprio limite.
  const box = new THREE.Box3Helper(new THREE.Box3(), 0x4ea8ff);
  box.visible = state.show.bbox;

  // `clone` e o involucro Y-up: escalar nele casa com os eixos do painel
  // (X = largura, Y = altura Z do CAD, Z = profundidade Y do CAD).
  holder.updateMatrixWorld(true);
  const baseSize = new THREE.Vector3();
  {
    const bounds = new THREE.Box3();
    for (const mesh of meshes) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      bounds.union(new THREE.Box3().copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld));
    }
    bounds.getSize(baseSize);
  }

  // Destaque das variaveis: dentro do cadRoot, entao usa coordenadas do CAD.
  const highlight = new THREE.Group();
  clone.children[0].add(highlight);

  return {
    holder, meshes, edges, box, highlight,
    scaleNode: clone,
    cadRoot: clone.children[0],
    baseSize,
    ownGeometry: false,
    stretch: null,
    holeEdit: null,
  };
}

// Booleana sempre parte daqui, nunca do resultado anterior: encadear edicoes
// sobre malha ja editada acumula erro e lixo topologico.
function sourceOf(mesh) {
  if (!mesh.userData.source) {
    mesh.userData.source = {
      positions: Float32Array.from(mesh.geometry.attributes.position.array),
      indices: Uint32Array.from(mesh.geometry.index.array),
    };
  }
  return mesh.userData.source;
}

// Cada corpo do .step vira uma malha no glTF, mas as duas listas nao vem na
// mesma ordem — o pareamento e pela caixa, que e o que as duas tem em comum.
function meshForBody(entry, body) {
  if (entry.meshes.length === 1) return entry.meshes[0];

  const target = [0, 1, 2].map((a) => (body.box.min[a] + body.box.max[a]) / 2);
  let best = null;
  let bestDistance = Infinity;

  for (const mesh of entry.meshes) {
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const box = mesh.geometry.boundingBox;
    const distance = Math.hypot(
      ...[0, 1, 2].map((a) => (box.min.getComponent(a) + box.max.getComponent(a)) / 2 - target[a]),
    );
    if (distance < bestDistance) {
      bestDistance = distance;
      best = mesh;
    }
  }
  // Um milimetro de tolerancia: corpos distintos ficam muito mais longe que isso.
  return bestDistance < 1 ? best : null;
}

// Troca a geometria de uma malha depois de uma booleana e reancora o estiramento.
function setMeshGeometry(entry, mesh, positions, indices) {
  // As outras malhas da peca precisam sair do template antes, senao um
  // estiramento posterior escreveria por cima da geometria compartilhada.
  ownGeometry(entry);
  const line = mesh.children.find((child) => child.isLineSegments);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  // A saida do manifold nao tem normais. Vincar por angulo mantem cilindro
  // liso e quina viva, em vez de sombrear a peca inteira de um jeito so.
  const creased = toCreasedNormals(geometry, THREE.MathUtils.degToRad(35));
  geometry.dispose();

  mesh.geometry.dispose();
  mesh.geometry = creased;
  mesh.userData.pristine = Float32Array.from(creased.attributes.position.array);

  if (line) {
    line.geometry.dispose();
    line.geometry = new THREE.EdgesGeometry(creased, 22);
    line.userData.pristine = Float32Array.from(line.geometry.attributes.position.array);
  }

}

// A geometria vem compartilhada do template. Antes de deformar, a instancia
// precisa da sua propria copia — e de uma copia intocada para reaplicar a
// deformacao do zero a cada ajuste, em vez de acumular erro.
function ownGeometry(entry) {
  if (entry.ownGeometry) return;
  for (const node of [...entry.meshes, ...entry.edges]) {
    node.geometry = node.geometry.clone();
    node.userData.pristine = Float32Array.from(node.geometry.attributes.position.array);
  }
  entry.ownGeometry = true;
}

// O tamanho base e medido com escala 1: as duas edicoes se compoem, entao um
// estiramento muda a base sobre a qual a escala e calculada.
function recomputeBaseSize(entry) {
  const scale = entry.scaleNode.scale.clone();
  entry.scaleNode.scale.set(1, 1, 1);
  entry.holder.updateMatrixWorld(true);
  entryBox(entry, _box).getSize(entry.baseSize);
  entry.scaleNode.scale.copy(scale);
  entry.holder.updateMatrixWorld(true);
}

async function addPart(part) {
  const color = PALETTE[state.active.size % PALETTE.length];
  const template = await templateFor(part);
  const built = instantiate(template, color);
  built.part = part;
  built.color = color;
  world.add(built.holder);
  helpers.add(built.box);
  state.active.set(part.slug, built);
  state.focus = part.slug;
}

function removePart(slug) {
  const entry = state.active.get(slug);
  if (!entry) return;
  world.remove(entry.holder);
  helpers.remove(entry.box);
  if (state.focus === slug) state.focus = null;
  // Malhas reusam a geometria do template; so o que foi criado por instancia e liberado.
  for (const mesh of entry.meshes) {
    mesh.material.dispose();
    if (entry.ownGeometry) mesh.geometry.dispose();
  }
  for (const line of entry.edges) {
    line.geometry.dispose();
    line.material.dispose();
  }
  entry.box.geometry.dispose();
  entry.box.material.dispose();
  state.active.delete(slug);
}

/* ---------------------------------------------------------- disposicao */

const _box = new THREE.Box3();
const _center = new THREE.Vector3();

// Mede so as malhas. setFromObject varreria tambem o grupo de destaque, e o
// plano do corte — maior que a peca de proposito — falsearia toda medida.
function entryBox(entry, target = new THREE.Box3()) {
  target.makeEmpty();
  for (const mesh of entry.meshes) {
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    target.union(_box.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld));
  }
  return target;
}

function activeBounds() {
  const target = new THREE.Box3();
  for (const entry of state.active.values()) target.union(entryBox(entry, new THREE.Box3()));
  return target;
}

function applyLayout() {
  const entries = [...state.active.values()];
  for (const entry of entries) entry.holder.position.set(0, 0, 0);
  world.position.set(0, 0, 0);
  world.updateMatrixWorld(true);

  // Medida util e sempre a do conjunto montado, mesmo quando ele e espalhado.
  state.originBounds = entries.length ? activeBounds() : null;

  if (state.layout === 'spread' && entries.length > 1) {
    const gap = 12;
    const spans = entries.map((entry) => {
      const b = entryBox(entry, new THREE.Box3());
      return { entry, b, width: b.max.x - b.min.x, center: (b.max.x + b.min.x) / 2 };
    });
    const total = spans.reduce((sum, s) => sum + s.width, 0) + gap * (spans.length - 1);
    let cursor = -total / 2;
    for (const s of spans) {
      // Alinha em X e assenta cada peca na grade, como pecas numa bancada.
      s.entry.holder.position.set(cursor + s.width / 2 - s.center, -s.b.min.y, -s.b.getCenter(_center).z);
      cursor += s.width + gap;
    }
  }

  // Assenta o conjunto sobre a grade, depois recalcula as caixas envolventes.
  world.updateMatrixWorld(true);
  if (entries.length > 0) {
    const floor = activeBounds().min.y;
    if (Number.isFinite(floor)) world.position.y = -floor;
    world.updateMatrixWorld(true);
  }
  for (const entry of entries) {
    entryBox(entry, entry.box.box);
  }
  resizeGrid();
}

function worldBounds() {
  if (state.active.size === 0) return null;
  world.updateMatrixWorld(true);
  const box = activeBounds();
  return box.isEmpty() ? null : box;
}

function resizeGrid() {
  const bounds = worldBounds();
  const span = bounds ? Math.max(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z) : 200;
  const size = Math.max(100, Math.ceil((span * 1.8) / 100) * 100);
  grid.scale.setScalar(size / 600);
  grid.visible = state.show.grid;
}

function fitView(instant = false) {
  const bounds = worldBounds();
  if (!bounds) return;
  const center = bounds.getCenter(new THREE.Vector3());
  const radius = bounds.getSize(new THREE.Vector3()).length() / 2;
  const distance = (radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.12;

  const direction = camera.position.clone().sub(controls.target).normalize();
  controls.target.copy(center);
  camera.position.copy(center).addScaledVector(direction, distance);
  camera.near = Math.max(0.1, distance / 500);
  camera.far = distance * 12;
  camera.updateProjectionMatrix();
  controls.update();
  if (instant) controls.update();
}

function setView(name) {
  const dirs = {
    iso: [1, 0.78, 1.15],
    front: [0, 0, 1],
    side: [1, 0, 0],
    top: [0, 1, 0.0001],
  };
  const d = new THREE.Vector3(...dirs[name]).normalize();
  const distance = camera.position.distanceTo(controls.target);
  camera.position.copy(controls.target).addScaledVector(d, distance);
  controls.update();
  fitView();
}

/* --------------------------------------------------------- interface */

function fmt(n) {
  return Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
}

function buildList() {
  const groups = new Map();
  for (const part of state.parts) {
    if (!groups.has(part.group)) groups.set(part.group, []);
    groups.get(part.group).push(part);
  }

  el.parts.innerHTML = '';
  for (const [group, parts] of groups) {
    const title = document.createElement('div');
    title.className = 'group-name';
    title.textContent = group;
    el.parts.append(title);

    for (const part of parts) {
      const button = document.createElement('button');
      button.className = 'part';
      button.dataset.slug = part.slug;
      button.dataset.group = group;
      button.innerHTML =
        `<span class="swatch"></span><span class="part-name"></span>` +
        `<span class="part-dim">${fmt(part.size[0])}×${fmt(part.size[1])}×${fmt(part.size[2])}</span>`;
      button.querySelector('.part-name').textContent = part.label;
      button.title = `${part.source} — ${part.triangles.toLocaleString('pt-BR')} triângulos`;
      button.addEventListener('click', (event) => onPartClick(part, event));
      el.parts.append(button);
    }
  }
}

function syncList() {
  for (const button of el.parts.querySelectorAll('.part')) {
    const entry = state.active.get(button.dataset.slug);
    button.classList.toggle('on', Boolean(entry));
    button.style.setProperty('--chip', entry ? `#${entry.color.toString(16).padStart(6, '0')}` : '');
  }
}

async function onPartClick(part, event) {
  const additive = event.shiftKey || event.metaKey || event.ctrlKey;
  const isOn = state.active.has(part.slug);

  busy(true, `Carregando ${part.label}…`);
  try {
    if (additive) {
      if (isOn) removePart(part.slug);
      else await addPart(part);
    } else {
      for (const slug of [...state.active.keys()]) removePart(slug);
      await addPart(part);
    }
    applyLayout();
    fitView();
    syncList();
    updateInfo();
  } finally {
    busy(false);
  }
}

function focusedEntry() {
  if (state.focus && state.active.has(state.focus)) return state.active.get(state.focus);
  state.focus = [...state.active.keys()].at(-1) ?? null;
  return state.focus ? state.active.get(state.focus) : null;
}

function parseNumber(text) {
  return Number.parseFloat(String(text).replace(/\s/g, '').replace(',', '.'));
}

function updateInfo() {
  const entries = [...state.active.values()];
  if (entries.length === 0) {
    el.info.hidden = true;
    el.status.textContent = 'Selecione uma peça · Shift+clique soma peças';
    return;
  }

  const entry = focusedEntry();
  el.info.hidden = false;
  el.info.querySelector('.info-title').textContent = entry.part.label;

  el.focus.hidden = entries.length < 2;
  if (!el.focus.hidden) {
    el.focus.innerHTML = entries
      .map((e) => `<option value="${e.part.slug}">${escapeHtml(e.part.label)}</option>`)
      .join('');
    el.focus.value = entry.part.slug;
  }

  // O campo em edicao nao e reescrito, senao o cursor pula a cada tecla.
  const scale = entry.scaleNode.scale;
  for (const input of el.dims) {
    if (document.activeElement === input) continue;
    const axis = Number(input.dataset.axis);
    input.value = fmt(entry.baseSize.getComponent(axis) * scale.getComponent(axis));
  }

  const isUniform = Math.abs(scale.x - scale.y) < 1e-6 && Math.abs(scale.y - scale.z) < 1e-6;
  el.pct.textContent = isUniform
    ? `${fmt(scale.x * 100)}%`
    : `${fmt(scale.x * 100)} / ${fmt(scale.y * 100)} / ${fmt(scale.z * 100)}%`;
  el.pct.classList.toggle('changed', !isUniform || Math.abs(scale.x - 1) > 1e-6);

  el.info.querySelector('.info-rows').innerHTML = [
    ['Triângulos', entry.part.triangles.toLocaleString('pt-BR')],
    ['Origem', entry.part.source ?? 'arquivo solto'],
  ]
    .map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`)
    .join('');

  syncFeatures(entry);

  const size = (state.originBounds ?? worldBounds()).getSize(new THREE.Vector3());
  const triangles = entries.reduce((sum, e) => sum + e.part.triangles, 0);
  el.status.textContent =
    `${entries.length} peça(s) · ${fmt(size.x)} × ${fmt(size.y)} × ${fmt(size.z)} mm · ` +
    `${triangles.toLocaleString('pt-BR')} triângulos`;
}

// As features chegam por fetch, entao a atualizacao e assincrona. A guarda de
// foco evita que uma resposta atrasada pinte o painel de outra peca.
let varsRenderedFor = null;

// O .step pode ser uma montagem: cada corpo definido no seu proprio sistema e
// posicionado por uma ITEM_DEFINED_TRANSFORMATION. O OpenCascade aplica essas
// transformacoes ao tesselar; o leitor de features nao. Quando isso acontece as
// medidas de cada corpo continuam certas, mas as posicoes nao batem com a malha
// — entao destaque e booleana ficam desligados em vez de apontar para o lugar
// errado.
function featuresArePlaced(entry, features) {
  if (!features) return false;
  if (entry.placed !== undefined) return entry.placed;

  const bounds = cadBounds(entry);
  entry.placed = [0, 1, 2].every(
    (axis) => Math.abs(bounds.max[axis] - bounds.min[axis] - features.box.size[axis]) < 0.5,
  );
  return entry.placed;
}

async function syncFeatures(entry) {
  const features = await featuresFor(entry.part);
  if (focusedEntry() !== entry) return;

  if (varsRenderedFor !== entry.part.slug) {
    renderVars(entry, features);
    varsRenderedFor = entry.part.slug;
  }
  if (state.editMode === 'stretch') {
    refreshStretchPanel(entry, features);
    showStationPlane(entry);
  } else {
    clearHighlight(entry);
    if (state.editMode === 'holes') refreshHolePanel(entry, features);
  }
}

/* ------------------------------------------------- redimensionar peca */

function rescale(entry, axis, millimetres) {
  const base = entry.baseSize.getComponent(axis);
  if (!(millimetres > 0) || !(base > 0)) return;
  const factor = millimetres / base;
  if (state.uniform) entry.scaleNode.scale.setScalar(factor);
  else entry.scaleNode.scale.setComponent(axis, factor);
  applyLayout();
  updateInfo();
}

for (const input of el.dims) {
  input.addEventListener('input', () => {
    const entry = focusedEntry();
    if (entry) rescale(entry, Number(input.dataset.axis), parseNumber(input.value));
  });
  input.addEventListener('blur', updateInfo);
}

el.uniform.addEventListener('change', () => {
  state.uniform = el.uniform.checked;
});

el.focus.addEventListener('change', () => {
  state.focus = el.focus.value;
  varsRenderedFor = null;
  updateInfo();
});

document.getElementById('reset-scale').addEventListener('click', async () => {
  const entry = focusedEntry();
  if (!entry) return;
  const features = featureCache.get(entry.part.slug);
  const found = findPattern(features, entry.holeEdit?.patternId);

  entry.scaleNode.scale.set(1, 1, 1);
  if (entry.stretch) entry.stretch.delta = 0;

  // Desfaz a booleana voltando o padrao aos parametros do arquivo — como tudo
  // e refeito a partir da geometria original, o resultado e a peca de origem.
  if (found) {
    entry.holeEdit = editFor(found.pattern);
    await applyHoleEdit(entry, features);
  } else if (entry.stretch) {
    applyStretch(entry);
  }

  applyLayout();
  fitView();
  varsRenderedFor = null;
  updateInfo();
});

document.getElementById('export-stl').addEventListener('click', () => {
  const entry = focusedEntry();
  if (entry) exportStl(entry);
});

// Exporta a peca com a escala aplicada, de volta na orientacao Z-up do CAD.
function exportStl(entry) {
  entry.holder.updateMatrixWorld(true);
  const toCad = entry.cadRoot.matrixWorld.clone().invert();
  const s = entry.scaleNode.scale;
  const cadScale = new THREE.Vector3(s.x, s.z, s.y);   // mundo Y-up -> eixos do CAD

  const corners = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const edge1 = new THREE.Vector3();
  const edge2 = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const local = new THREE.Matrix4();
  const facets = [];

  for (const mesh of entry.meshes) {
    local.multiplyMatrices(toCad, mesh.matrixWorld);
    const position = mesh.geometry.attributes.position;
    const index = mesh.geometry.index;
    const count = index ? index.count : position.count;

    for (let i = 0; i < count; i += 3) {
      for (let corner = 0; corner < 3; corner++) {
        const vertex = index ? index.getX(i + corner) : i + corner;
        corners[corner].fromBufferAttribute(position, vertex).applyMatrix4(local).multiply(cadScale);
      }
      edge1.subVectors(corners[1], corners[0]);
      edge2.subVectors(corners[2], corners[0]);
      normal.crossVectors(edge1, edge2);
      if (normal.lengthSq() > 0) normal.normalize();
      facets.push([normal.x, normal.y, normal.z, ...corners.flatMap((c) => [c.x, c.y, c.z])]);
    }
  }

  const buffer = new ArrayBuffer(84 + facets.length * 50);
  const view = new DataView(buffer);
  new Uint8Array(buffer, 0, 80).set(
    new TextEncoder().encode(`${entry.part.label} - PTFE/PETG viewer - mm`).subarray(0, 80),
  );
  view.setUint32(80, facets.length, true);

  let offset = 84;
  for (const facet of facets) {
    for (const value of facet) {
      view.setFloat32(offset, value, true);
      offset += 4;
    }
    view.setUint16(offset, 0, true);
    offset += 2;
  }

  const size = [0, 1, 2].map((axis) => Math.round(entry.baseSize.getComponent(axis) * s.getComponent(axis)));
  download(
    new Blob([buffer], { type: 'model/stl' }),
    `${entry.part.label.replace(/\s+/g, '_')}_${size.join('x')}mm.stl`,
  );
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  link.click();
  URL.revokeObjectURL(url);
}

function escapeHtml(value) {
  return value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function busy(on, message = '') {
  el.overlay.hidden = !on;
  el.overlay.querySelector('span').textContent = message;
}

/* ------------------------------------------------ toggles e atalhos */

function applyToggles() {
  for (const entry of state.active.values()) {
    for (const line of entry.edges) line.visible = state.show.edges && !state.show.wireframe;
    entry.box.visible = state.show.bbox;
    for (const mesh of entry.meshes) mesh.material.wireframe = state.show.wireframe;
  }
  grid.visible = state.show.grid;
  controls.autoRotate = state.show.spin;
}

el.toolbar.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;

  if (button.dataset.view) {
    setView(button.dataset.view);
    for (const b of el.toolbar.querySelectorAll('[data-view]')) b.classList.toggle('active', b === button);
  } else if (button.dataset.toggle) {
    const flag = button.dataset.toggle;
    state.show[flag] = !state.show[flag];
    button.classList.toggle('active', state.show[flag]);
    applyToggles();
  } else if (button.dataset.layout) {
    state.layout = button.dataset.layout;
    for (const b of el.toolbar.querySelectorAll('[data-layout]')) b.classList.toggle('active', b === button);
    applyLayout();
    fitView();
    updateInfo();
  } else if (button.id === 'fit') {
    fitView();
  } else if (button.id === 'shot') {
    saveScreenshot();
  }
});

document.getElementById('select-none').addEventListener('click', () => {
  for (const slug of [...state.active.keys()]) removePart(slug);
  applyLayout();
  syncList();
  updateInfo();
});

document.getElementById('select-group').addEventListener('click', async () => {
  const current = [...state.active.values()][0];
  const group = current ? current.part.group : state.parts[0].group;
  busy(true, `Carregando ${group}…`);
  try {
    for (const slug of [...state.active.keys()]) removePart(slug);
    for (const part of state.parts.filter((p) => p.group === group)) await addPart(part);
    applyLayout();
    fitView();
    syncList();
    updateInfo();
  } finally {
    busy(false);
  }
});

addEventListener('keydown', (event) => {
  if (event.target.matches('input, textarea')) return;
  const map = { e: 'edges', w: 'wireframe', b: 'bbox', g: 'grid', r: 'spin' };
  const flag = map[event.key.toLowerCase()];
  if (flag) {
    state.show[flag] = !state.show[flag];
    el.toolbar.querySelector(`[data-toggle="${flag}"]`)?.classList.toggle('active', state.show[flag]);
    applyToggles();
  } else if (event.key.toLowerCase() === 'f') {
    fitView();
  }
});

function saveScreenshot() {
  renderer.render(scene, camera);
  el.canvas.toBlob((blob) => download(blob, 'ptfe-petg.png'));
}

/* ------------------------------- arrastar um .step qualquer (OCCT WASM) */

let occtPromise = null;

async function getOcct() {
  // O bundle e um script classico que expoe `occtimportjs` como global;
  // sao 7 MB de WASM, entao so e buscado quando alguem arrasta um arquivo.
  if (!occtPromise) {
    occtPromise = loadOcctScript().then(() =>
      globalThis.occtimportjs({ locateFile: (file) => `vendor/occt/${file}` }),
    );
  }
  return occtPromise;
}

function loadOcctScript() {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'vendor/occt/occt-import-js.js';
    script.onload = resolve;
    script.onerror = () => reject(new Error('não foi possível carregar o OpenCascade'));
    document.head.append(script);
  });
}

async function readStepInBrowser(file) {
  busy(true, `Lendo ${file.name} com OpenCascade…`);
  try {
    const occt = await getOcct();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = occt.ReadStepFile(bytes, null);
    if (!result.success || result.meshes.length === 0) throw new Error('STEP sem geometria legível');

    const group = new THREE.Group();
    let triangles = 0;
    const bounds = new THREE.Box3();

    for (const mesh of result.meshes) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(mesh.attributes.position.array, 3));
      if (mesh.attributes.normal) {
        geometry.setAttribute('normal', new THREE.Float32BufferAttribute(mesh.attributes.normal.array, 3));
      } else {
        geometry.computeVertexNormals();
      }
      geometry.setIndex(mesh.index.array);
      geometry.computeBoundingBox();
      bounds.union(geometry.boundingBox);
      triangles += mesh.index.array.length / 3;
      group.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()));
    }

    const slug = `drop-${++state.dropped}`;
    const size = bounds.getSize(new THREE.Vector3());

    // O mesmo texto ja lido serve ao reconhecimento de features — nao ha
    // sidecar para arquivo solto, entao a analise acontece aqui.
    // latin1 porque e o que o STEP usa no cabecalho, e o resto e ASCII.
    const features = analyzeStep(new TextDecoder('windows-1252').decode(bytes));
    featureCache.set(slug, features);
    const part = {
      slug,
      label: file.name.replace(/\.(step|stp)$/i, ''),
      group: 'Arquivos arrastados',
      source: file.name,
      triangles,
      features: features
        ? { holes: allHoles(features).length, patterns: allPatterns(features).length }
        : null,
      size: [size.x, size.y, size.z].map((v) => +v.toFixed(2)),
    };

    cache.set(slug, toYUp(group));
    state.parts.push(part);
    buildList();
    for (const s of [...state.active.keys()]) removePart(s);
    await addPart(part);
    applyLayout();
    fitView();
    syncList();
    updateInfo();
  } catch (error) {
    el.status.textContent = `Falha ao ler o arquivo: ${error.message}`;
  } finally {
    busy(false);
  }
}

addEventListener('dragover', (event) => {
  event.preventDefault();
  document.body.classList.add('dragging');
});
addEventListener('dragleave', (event) => {
  if (event.relatedTarget === null) document.body.classList.remove('dragging');
});
addEventListener('drop', async (event) => {
  event.preventDefault();
  document.body.classList.remove('dragging');
  for (const file of event.dataTransfer.files) {
    if (/\.(step|stp)$/i.test(file.name)) await readStepInBrowser(file);
  }
});


/* ======================================== variaveis reconhecidas no B-rep */

const featureCache = new Map();   // slug -> features | null

async function featuresFor(part) {
  // Arquivo arrastado ja deixa o resultado no cache; peca do catalogo busca o
  // sidecar gerado na conversao.
  if (featureCache.has(part.slug)) return featureCache.get(part.slug);
  let features = null;
  if (part.features?.file) {
    features = await fetch(`models/${part.features.file}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }
  featureCache.set(part.slug, features);
  return features;
}

// Nomes das variaveis ficam no navegador de quem usa: sao anotacao pessoal
// sobre a peca, nao algo que precise voltar para o arquivo.
function savedNames(slug) {
  try {
    return JSON.parse(localStorage.getItem(`vars:${slug}`) ?? '{}');
  } catch {
    return {};
  }
}

function saveName(slug, id, name) {
  try {
    const all = savedNames(slug);
    if (name) all[id] = name;
    else delete all[id];
    localStorage.setItem(`vars:${slug}`, JSON.stringify(all));
  } catch {
    /* aba privada ou armazenamento bloqueado: o nome vale so por esta sessao */
  }
}

const AXIS_LABEL = ['X', 'Y', 'Z'];

// Monta as linhas do painel a partir das features, ja agrupadas pelo tipo de
// coisa que sao — que e como se pensa a peca, nao como o STEP a descreve.
function buildRows(analysis, holeEdit = null) {
  const rows = [];
  const many = analysis.bodies.length > 1;
  const prefix = (body, group) => (many ? `${body.name} · ${group}` : group);

  for (const body of analysis.bodies) {
    const { box } = body;
    for (const [axis, label] of [[0, 'largura_x'], [1, 'comprimento_y'], [2, 'altura_z']]) {
      rows.push({
        group: prefix(body, 'Geral'),
        id: `${body.bodyIndex}-dim-${axis}`,
        fallback: label,
        value: `${fmt(box.size[axis])} mm`,
        detail: `extensão em ${AXIS_LABEL[axis]}`,
      });
    }

    for (const pattern of body.patterns) {
      // Se o padrao foi refeito, a linha mostra o que vale agora, nao o do arquivo.
      const edited = holeEdit?.patternId === pattern.id ? holeEdit : null;
      const count = edited?.count ?? pattern.count;
      const pitch = edited?.pitch ?? pattern.pitch;
      const edge = edited?.edge ?? pattern.edgeStart;
      const diameter = edited?.diameter ?? pattern.diameter;
      const vacant = edited ? 0 : pattern.slots - pattern.count;
      const changed =
        edited &&
        (count !== pattern.count ||
          pitch !== pattern.pitch ||
          edge !== pattern.edgeStart ||
          diameter !== pattern.diameter);

      rows.push({
        group: prefix(body, 'Padrões de furos'),
        id: pattern.id,
        fallback: `padrao_${pattern.diameter}_${pattern.direction.toLowerCase()}`,
        value: `${count} × Ø${diameter}`,
        detail:
          `passo ${fmt(pitch)} mm ao longo de ${pattern.direction} · borda ${fmt(edge)} mm` +
          (vacant > 0 ? ` · ${vacant} estação(ões) vaga(s)` : '') +
          (changed
            ? ` · refeito (era ${pattern.count} × Ø${pattern.diameter} a ${fmt(pattern.pitch)} mm)`
            : ''),
        highlight: changed ? null : { kind: 'holes', ids: pattern.holeIds },
      });
    }

    // Furos fora de padrao entram agrupados por diametro: e assim que se pergunta
    // "quantos furos de 4 mm tem esta peca", e nao um a um.
    const byDiameter = new Map();
    for (const hole of body.holes) {
      if (hole.patternId) continue;
      byDiameter.set(hole.diameter, [...(byDiameter.get(hole.diameter) ?? []), hole]);
    }

    for (const [diameter, holes] of [...byDiameter].sort((a, b) => b[0] - a[0])) {
      const axis = holes[0].axis.findIndex((v) => Math.abs(v) > 0.9);
      const depth = Math.max(...holes.map((h) => h.depth));
      const wall = holes.map((h) => h.wall).filter((w) => w !== null).sort((a, b) => a - b)[0];
      rows.push({
        group: prefix(body, 'Furos avulsos'),
        id: `${body.bodyIndex}-dia-${diameter}`,
        fallback: `furo_${diameter}mm`,
        value: `${holes.length} × Ø${diameter}`,
        detail:
          `eixo ${AXIS_LABEL[axis] ?? 'oblíquo'} · prof ${fmt(depth)} mm` +
          (wall === undefined ? '' : ` · parede ${fmt(wall)} mm`),
        highlight: { kind: 'holes', ids: holes.map((h) => h.id) },
      });
    }

    for (const [index, family] of body.thicknesses.entries()) {
      const axis = family.normal.findIndex((v) => Math.abs(v) > 0.9);
      for (const [gapIndex, gap] of family.gaps.entries()) {
        if (gap < 0.2) continue;                       // ruido de chanfro
        rows.push({
          group: prefix(body, 'Espessuras'),
          id: `${body.bodyIndex}-esp-${index}-${gapIndex}`,
          fallback: `espessura_${AXIS_LABEL[axis]?.toLowerCase() ?? 'obl'}_${gapIndex + 1}`,
          value: `${fmt(gap)} mm`,
          detail: `entre planos normais a ${axis < 0 ? family.normal.join(', ') : AXIS_LABEL[axis]}`,
          highlight: { kind: 'thickness', body: body.bodyIndex, family: index, gap: gapIndex },
        });
      }
    }

    for (const round of body.rounds) {
      rows.push({
        group: prefix(body, 'Arredondamentos e chanfros'),
        id: `${body.bodyIndex}-raio-${round.radius}`,
        fallback: `raio_${round.radius}mm`,
        value: `${round.count} × R${round.radius}`,
        detail: 'cilindro convexo',
      });
    }

    for (const chamfer of body.chamfers) {
      rows.push({
        group: prefix(body, 'Arredondamentos e chanfros'),
        id: `${body.bodyIndex}-chanfro-${chamfer.diameter}-${chamfer.angle}`,
        fallback: `chanfro_${chamfer.angle}deg`,
        value: `${chamfer.count} × ${chamfer.angle}°`,
        detail: `Ø${chamfer.diameter} mm`,
      });
    }
  }

  return rows;
}

function renderVars(entry, features) {
  el.vars.innerHTML = '';

  if (!features?.bodies?.length) {
    el.vars.innerHTML =
      '<p class="empty">Nenhuma feature reconhecida nesta peça.<br />' +
      'O reconhecimento cobre plano, cilindro e cone — superfícies livres ficam mudas.</p>';
    return;
  }

  const placed = featuresArePlaced(entry, features);
  if (!placed) {
    const note = document.createElement('p');
    note.className = 'empty';
    note.textContent =
      'Arquivo de montagem: cada corpo vem no seu próprio sistema de coordenadas. ' +
      'As medidas abaixo estão certas, mas o destaque no 3D e a edição de furos ficam ' +
      'desligados porque as posições não batem com a malha.';
    el.vars.append(note);
  }

  const names = savedNames(entry.part.slug);
  let currentGroup = null;

  for (const row of buildRows(features, entry.holeEdit)) {
    if (row.group !== currentGroup) {
      currentGroup = row.group;
      const title = document.createElement('div');
      title.className = 'var-group';
      title.textContent = currentGroup;
      el.vars.append(title);
    }

    const item = document.createElement('div');
    item.className = 'var';

    const name = document.createElement('input');
    name.className = 'var-name';
    name.value = names[row.id] ?? row.fallback;
    name.spellcheck = false;
    name.addEventListener('change', () => {
      const clean = name.value.trim();
      name.value = clean || row.fallback;
      saveName(entry.part.slug, row.id, clean === row.fallback ? '' : clean);
    });

    const value = document.createElement('div');
    value.className = 'var-value';
    value.textContent = row.value;

    const detail = document.createElement('div');
    detail.className = 'var-detail';
    detail.textContent = row.detail;

    item.append(name, value, detail);
    if (row.highlight && placed) {
      item.addEventListener('pointerenter', () => showHighlight(entry, features, row.highlight));
      item.addEventListener('pointerleave', () => clearHighlight(entry));
    }
    el.vars.append(item);
  }
}

/* ------------------------------------------------- destaque no 3D */

const HIGHLIGHT = 0xffb454;

function clearHighlight(entry) {
  for (const child of [...entry.highlight.children]) {
    child.geometry?.dispose();
    child.material?.dispose();
    entry.highlight.remove(child);
  }
}

function showHighlight(entry, features, target) {
  clearHighlight(entry);

  if (target.kind === 'holes') {
    // depthTest desligado para o furo aparecer mesmo estando dentro do material.
    const material = new THREE.MeshBasicMaterial({
      color: HIGHLIGHT,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
      depthTest: false,
    });
    const up = new THREE.Vector3(0, 1, 0);

    const holes = allHoles(features);
    for (const id of target.ids) {
      const hole = holes.find((h) => h.id === id);
      if (!hole) continue;
      const axis = new THREE.Vector3(...hole.axis).normalize();
      const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(hole.diameter / 2 + 0.06, hole.diameter / 2 + 0.06, hole.depth, 24, 1, true),
        material,
      );
      mesh.quaternion.setFromUnitVectors(up, axis);
      mesh.position.set(...hole.center);
      mesh.renderOrder = 2;
      entry.highlight.add(mesh);
    }
  }

  if (target.kind === 'thickness') {
    const body = features.bodies.find((b) => b.bodyIndex === target.body);
    const family = body?.thicknesses[target.family];
    if (!family) return;
    const normal = new THREE.Vector3(...family.normal);
    const center = new THREE.Vector3(
      (body.box.min[0] + body.box.max[0]) / 2,
      (body.box.min[1] + body.box.max[1]) / 2,
      (body.box.min[2] + body.box.max[2]) / 2,
    );
    const onPlane = (station) => center.clone().addScaledVector(normal, station - center.dot(normal));

    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        onPlane(family.stations[target.gap]),
        onPlane(family.stations[target.gap + 1]),
      ]),
      new THREE.LineBasicMaterial({ color: HIGHLIGHT, depthTest: false }),
    );
    line.renderOrder = 2;
    entry.highlight.add(line);
  }
}

/* ================================================ estiramento prismatico */

// Caixa da peca no espaco do CAD. Os nos do glTF nao tem transformacao, entao a
// caixa da geometria ja esta nas coordenadas em que o estiramento opera.
function cadBounds(entry) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of entry.meshes) {
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const { min: lo, max: hi } = mesh.geometry.boundingBox;
    for (const axis of [0, 1, 2]) {
      min[axis] = Math.min(min[axis], lo.getComponent(axis));
      max[axis] = Math.max(max[axis], hi.getComponent(axis));
    }
  }
  return { min, max };
}

function stretchState(entry, features) {
  if (entry.stretch) return entry.stretch;
  const base = cadBounds(entry);
  // Comeca pelo eixo mais longo: e quase sempre o que se quer alongar.
  const longest = [0, 1, 2].reduce((a, b) => (base.max[b] - base.min[b] > base.max[a] - base.min[a] ? b : a));
  entry.stretch = {
    axis: longest,
    station: suggestStation(allHoles(features), longest, base.min[longest], base.max[longest]),
    delta: 0,
    base,
  };
  return entry.stretch;
}

function applyStretch(entry) {
  const { axis, station, delta } = entry.stretch;
  ownGeometry(entry);

  for (const node of [...entry.meshes, ...entry.edges]) {
    const attribute = node.geometry.attributes.position;
    attribute.array.set(node.userData.pristine);
    if (delta !== 0) stretchPositions(attribute.array, axis, station, delta);
    attribute.needsUpdate = true;
    node.geometry.computeBoundingBox();
    node.geometry.computeBoundingSphere();
  }

  recomputeBaseSize(entry);
  applyLayout();
}

function resetStretch(entry) {
  if (!entry.stretch) return;
  entry.stretch.delta = 0;
  applyStretch(entry);
}

// Plano indicando onde o corte acontece, enquanto o painel esta aberto.
function showStationPlane(entry) {
  clearHighlight(entry);
  if (state.editMode !== 'stretch' || !entry.stretch) return;

  const { axis, station, base } = entry.stretch;
  const others = [0, 1, 2].filter((a) => a !== axis);
  const size = others.map((a) => (base.max[a] - base.min[a]) * 1.25);

  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(size[0], size[1]),
    new THREE.MeshBasicMaterial({
      color: HIGHLIGHT,
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
      depthTest: false,
    }),
  );
  plane.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0),
  );
  plane.position.set(
    axis === 0 ? station : (base.min[0] + base.max[0]) / 2,
    axis === 1 ? station : (base.min[1] + base.max[1]) / 2,
    axis === 2 ? station : (base.min[2] + base.max[2]) / 2,
  );
  plane.renderOrder = 2;
  entry.highlight.add(plane);
}

function refreshStretchPanel(entry, features) {
  const stretch = stretchState(entry, features);
  const { axis, station, delta, base } = stretch;
  const length = base.max[axis] - base.min[axis];

  for (const button of document.querySelectorAll('[data-stretch-axis]')) {
    button.classList.toggle('active', Number(button.dataset.stretchAxis) === axis);
    button.textContent = AXIS_LABEL[Number(button.dataset.stretchAxis)];
  }

  if (document.activeElement !== el.stretchLength) el.stretchLength.value = fmt(length + delta);
  if (document.activeElement !== el.stretchStation) el.stretchStation.value = fmt(station);

  el.stretchSlider.min = base.min[axis];
  el.stretchSlider.max = base.max[axis];
  el.stretchSlider.step = Math.max(0.1, (base.max[axis] - base.min[axis]) / 400);
  el.stretchSlider.value = station;

  const conflicts = conflictsAt(allHoles(features), axis, station);
  if (conflicts.length) {
    el.stretchHint.className = 'hint warn';
    el.stretchHint.textContent =
      `O corte atravessa ${conflicts.join(', ')} — essa feature seria rasgada. ` +
      'Mova o corte para uma região sem furo transversal.';
  } else {
    el.stretchHint.className = 'hint';
    el.stretchHint.textContent =
      `Tudo depois de ${fmt(station)} mm em ${AXIS_LABEL[axis]} translada em bloco. ` +
      'Furos, chanfros e o perfil não mudam de tamanho.';
  }
}

/* --------------------------------------------------------- ligacoes */

document.addEventListener('click', (event) => {
  const tab = event.target.closest('[data-tab]');
  if (tab) {
    for (const button of document.querySelectorAll('[data-tab]')) {
      button.classList.toggle('active', button === tab);
    }
    el.parts.hidden = tab.dataset.tab !== 'parts';
    el.vars.hidden = tab.dataset.tab !== 'vars';
    return;
  }

  const edit = event.target.closest('[data-edit]');
  if (edit) {
    state.editMode = edit.dataset.edit;
    for (const button of document.querySelectorAll('[data-edit]')) {
      button.classList.toggle('active', button === edit);
    }
    for (const panel of document.querySelectorAll('[data-panel]')) {
      panel.hidden = panel.dataset.panel !== state.editMode;
    }
    updateInfo();
  }
});

for (const button of document.querySelectorAll('[data-stretch-axis]')) {
  button.addEventListener('click', () => {
    const entry = focusedEntry();
    if (!entry?.stretch) return;
    resetStretch(entry);
    const axis = Number(button.dataset.stretchAxis);
    const features = featureCache.get(entry.part.slug);
    entry.stretch.axis = axis;
    entry.stretch.station = suggestStation(
      allHoles(features), axis, entry.stretch.base.min[axis], entry.stretch.base.max[axis],
    );
    applyStretch(entry);
    fitView();
    updateInfo();
  });
}

el.stretchLength.addEventListener('input', () => {
  const entry = focusedEntry();
  if (!entry?.stretch) return;
  const target = parseNumber(el.stretchLength.value);
  const { axis, base } = entry.stretch;
  const length = base.max[axis] - base.min[axis];
  if (!(target > 0)) return;
  entry.stretch.delta = target - length;
  applyStretch(entry);
  updateInfo();
});

function setStation(value) {
  const entry = focusedEntry();
  if (!entry?.stretch || !Number.isFinite(value)) return;
  const { axis, base } = entry.stretch;
  entry.stretch.station = Math.min(Math.max(value, base.min[axis]), base.max[axis]);
  applyStretch(entry);
  updateInfo();
}

el.stretchStation.addEventListener('input', () => setStation(parseNumber(el.stretchStation.value)));
el.stretchSlider.addEventListener('input', () => setStation(Number(el.stretchSlider.value)));


/* ============================================= refazer o padrao de furos */

function holeEditState(entry, features) {
  if (entry.holeEdit) return entry.holeEdit;
  const pattern = allPatterns(features)[0];
  return pattern ? (entry.holeEdit = editFor(pattern)) : null;
}

const editFor = (pattern) => ({
  patternId: pattern.id,
  count: pattern.count,
  pitch: pattern.pitch,
  edge: pattern.edgeStart,
  diameter: pattern.diameter,
});

// Tapa os furos originais e reabre a quantidade pedida, no passo e no diametro
// pedidos. Parte sempre da geometria original: o padrao e descrito pelos
// parametros, nao pela ultima edicao, entao voltar aos valores do arquivo
// devolve a peca de origem.
async function applyHoleEdit(entry, features) {
  const edit = entry.holeEdit;
  const found = findPattern(features, edit?.patternId);
  if (!found) return;

  const { body, pattern } = found;
  const mesh = featuresArePlaced(entry, features) ? meshForBody(entry, body) : null;
  if (!mesh) return;

  const source = sourceOf(mesh);
  const untouched =
    edit.count === pattern.count &&
    edit.pitch === pattern.pitch &&
    edit.edge === pattern.edgeStart &&
    edit.diameter === pattern.diameter;

  const finish = () => {
    if (entry.stretch) applyStretch(entry);
    else {
      recomputeBaseSize(entry);
      applyLayout();
    }
  };

  // Com os parametros do arquivo, a booleana seria uma volta inteira para
  // chegar na peca de origem — e chegaria com o dobro de triangulos, porque os
  // furos voltariam com 48 lados no lugar dos que o OpenCascade tesselou.
  if (untouched) {
    setMeshGeometry(entry, mesh, Float32Array.from(source.positions), Uint32Array.from(source.indices));
    entry.part.triangles = totalTriangles(entry);
    finish();
    return;
  }

  const holes = pattern.holeIds.map((id) => body.holes.find((h) => h.id === id));
  const plugs = holes.flatMap((hole) => holeSolids(hole, { mode: 'plug' }));
  const cuts = Array.from({ length: edit.count }, (_, index) =>
    holeSolids(holes[0], {
      axisIndex: pattern.axisIndex,
      station: body.box.min[pattern.axisIndex] + edit.edge + index * edit.pitch,
      diameter: edit.diameter,
    }),
  ).flat();

  busy(true, `Refazendo ${edit.count} furo(s)…`);
  entry.holeError = null;
  try {
    const result = await rebuildWithHoles(source.positions, source.indices, plugs, cuts);
    setMeshGeometry(entry, mesh, result.positions, result.indices);
    entry.part.triangles = totalTriangles(entry);
    finish();
  } catch (error) {
    // Sem isto o erro some: o refreshHolePanel do updateInfo seguinte reescreve
    // a dica, e a falha fica invisivel com a peca intacta na tela.
    console.error('booleana falhou', error);
    entry.holeError = error.message;
  } finally {
    busy(false);
  }
}

function totalTriangles(entry) {
  // toCreasedNormals devolve geometria sem indice, entao a contagem vem das
  // posicoes quando o indice nao existe.
  return entry.meshes.reduce((sum, mesh) => {
    const { index, attributes } = mesh.geometry;
    return sum + (index ? index.count : attributes.position.count) / 3;
  }, 0);
}

function refreshHolePanel(entry, features) {
  const patterns = allPatterns(features);

  if (patterns.length === 0) {
    el.holePattern.hidden = true;
    el.holeHint.className = 'hint';
    el.holeHint.textContent =
      'Nenhum padrão linear reconhecido nesta peça — são necessários pelo menos três furos ' +
      'de mesmo diâmetro, colineares e em passo regular.';
    return;
  }

  const edit = holeEditState(entry, features);
  const { body, pattern } = findPattern(features, edit.patternId);
  const many = features.bodies.length > 1;

  el.holePattern.hidden = patterns.length < 2;
  el.holePattern.innerHTML = features.bodies
    .flatMap((b) =>
      b.patterns.map(
        (p) =>
          `<option value="${p.id}">${many ? `${escapeHtml(b.name)} · ` : ''}` +
          `Ø${p.diameter} mm · ${p.count} furos em ${p.direction}</option>`,
      ),
    )
    .join('');
  el.holePattern.value = edit.patternId;

  const fields = [
    [el.holeCount, edit.count],
    [el.holePitch, edit.pitch],
    [el.holeEdge, edit.edge],
    [el.holeDiameter, edit.diameter],
  ];
  for (const [input, value] of fields) {
    if (document.activeElement !== input) input.value = fmt(value);
  }

  if (!featuresArePlaced(entry, features) || !meshForBody(entry, body)) {
    el.holeHint.className = 'hint warn';
    el.holeHint.textContent =
      'Arquivo de montagem: os corpos vêm posicionados por transformação, que o leitor ' +
      'de features ainda não aplica. As medidas de cada corpo estão certas, mas a ' +
      'booleana não sabe onde recortar.';
    return;
  }

  if (entry.holeError) {
    el.holeHint.className = 'hint warn';
    el.holeHint.textContent = `A booleana falhou: ${entry.holeError}`;
    return;
  }

  const length = body.box.size[pattern.axisIndex];
  const extent = (edit.count - 1) * edit.pitch;
  const tail = length - edit.edge - extent;

  if (tail < 0) {
    el.holeHint.className = 'hint warn';
    el.holeHint.textContent =
      `O último furo cai ${fmt(-tail)} mm além do corpo, que tem ${fmt(length)} mm em ` +
      `${pattern.direction}. Reduza a quantidade, o passo ou a borda.`;
  } else {
    el.holeHint.className = 'hint';
    el.holeHint.textContent =
      `${fmt(edit.edge)} + ${fmt(extent)} + ${fmt(tail)} = ${fmt(length)} mm em ${pattern.direction}. ` +
      'Aplica ao sair do campo. Chanfro e escareado acompanham o diâmetro.';
  }
}

const HOLE_FIELDS = [
  [el.holeCount, 'count'],
  [el.holePitch, 'pitch'],
  [el.holeEdge, 'edge'],
  [el.holeDiameter, 'diameter'],
];

for (const [input, key] of HOLE_FIELDS) {
  input.addEventListener('change', async () => {
    const entry = focusedEntry();
    const features = featureCache.get(entry?.part.slug);
    if (!entry?.holeEdit || !features) return;

    const value = key === 'count' ? Math.round(parseNumber(input.value)) : parseNumber(input.value);
    const valid = key === 'edge' ? value >= 0 : value > 0;
    if (!Number.isFinite(value) || !valid) {
      refreshHolePanel(entry, features);
      return;
    }

    entry.holeEdit[key] = value;
    await applyHoleEdit(entry, features);
    varsRenderedFor = null;
    updateInfo();
  });
}

el.holePattern.addEventListener('change', () => {
  const entry = focusedEntry();
  const features = featureCache.get(entry?.part.slug);
  const found = findPattern(features, el.holePattern.value);
  if (!entry || !found) return;
  entry.holeEdit = editFor(found.pattern);
  refreshHolePanel(entry, features);
});

/* ------------------------------------------------------------- laço */

function resize() {
  const { clientWidth, clientHeight } = el.canvas;
  if (clientWidth === 0 || clientHeight === 0) return;
  renderer.setSize(clientWidth, clientHeight, false);
  camera.aspect = clientWidth / clientHeight;
  camera.updateProjectionMatrix();
}

new ResizeObserver(resize).observe(el.canvas);

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

/* ------------------------------------------------------------ início */

const manifest = await fetch('models/manifest.json').then((r) => r.json());
state.parts = manifest;
buildList();
resize();
applyToggles();
updateInfo();

const first = manifest.find((p) => /petg-rail|linear-rail/.test(p.slug)) ?? manifest[0];
busy(true, 'Carregando…');
await addPart(first);
applyLayout();
fitView();
syncList();
updateInfo();
busy(false);
