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
  solid: 0,                  // corpo em foco dentro dessa peca
  allBodies: false,          // painel mostra todos os corpos ou so o em foco
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
    edits: {},
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

// Cada corpo do .step vira uma malha no glTF; o pareamento é feito em
// linkSolids e consultado por aqui.
function meshForBody(entry, body) {
  if (entry.meshes.length === 1) return entry.meshes[0];
  return entry.solids?.find((solid) => solid.body === body)?.mesh ?? null;
}

// Emparelha cada corpo reconhecido com a sua malha. E o que permite selecionar,
// destacar, estirar e furar um corpo de cada vez em vez da peca inteira.
function linkSolids(entry, features) {
  if (entry.solids || !features) return entry.solids ?? null;

  // Pareamento global, do par mais próximo para o mais distante. Escolher o
  // vizinho de cada corpo isoladamente deixa corpos disputando a mesma malha e
  // outros sem nenhuma — e quem fica sem par não se move nem muda de cor.
  const centerOf = (box) => [0, 1, 2].map((a) => (box.min[a] + box.max[a]) / 2);
  const meshCenter = (mesh) => {
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const { min, max } = mesh.geometry.boundingBox;
    return [0, 1, 2].map((a) => (min.getComponent(a) + max.getComponent(a)) / 2);
  };

  const candidates = [];
  for (const [bodyIndex, body] of features.bodies.entries()) {
    const target = centerOf(body.box);
    // Tolerância proporcional ao corpo. Um corpo degenerado — o MGN9 tem seis
    // com espessura zero — tem o centro deslocado meia espessura da malha, e
    // um limite fixo de 1 mm os deixaria de fora do pareamento.
    const reach = Math.max(2, 0.1 * Math.hypot(...body.box.size));
    for (const mesh of entry.meshes) {
      const center = meshCenter(mesh);
      candidates.push({
        bodyIndex,
        mesh,
        reach,
        distance: Math.hypot(...[0, 1, 2].map((a) => center[a] - target[a])),
      });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance);

  const paired = new Map();
  const takenMeshes = new Set();
  for (const candidate of candidates) {
    if (paired.has(candidate.bodyIndex) || takenMeshes.has(candidate.mesh)) continue;
    if (candidate.distance > candidate.reach) continue;
    paired.set(candidate.bodyIndex, candidate.mesh);
    takenMeshes.add(candidate.mesh);
  }

  entry.solids = features.bodies.map((body, bodyIndex) => ({
    body,
    mesh: paired.get(bodyIndex) ?? null,
    holder: new THREE.Group(),
    stretch: null,
    edits: {},
  }));

  // Cada corpo ganha um grupo proprio: e o que deixa "Separado" afasta-los. O
  // destaque entra junto, senao fica para tras quando o corpo se afasta.
  for (const solid of entry.solids) {
    if (!solid.mesh) continue;
    solid.highlight = new THREE.Group();
    solid.holder.add(solid.mesh, solid.highlight);
    entry.cadRoot.add(solid.holder);
  }
  return entry.solids;
}

function focusedSolid(entry) {
  const solids = entry?.solids;
  if (!solids?.length) return null;
  return solids[Math.min(state.solid, solids.length - 1)] ?? solids[0];
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
  // Caixa nova, não `_box`: entryBox usa `_box` como rascunho, e passá-la como
  // destino faz a união se sobrescrever — sobra a última malha só. Com uma
  // malha o resultado coincide, e o erro fica escondido até haver várias.
  entryBox(entry, new THREE.Box3()).getSize(entry.baseSize);
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
  state.solid = 0;
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

// Deslocamento em coordenadas de mundo aplicado a um grupo que vive dentro do
// cadRoot: la o eixo Y do CAD aponta para -Z do mundo, e o Z para +Y.
const toCadOffset = (x, y, z) => [x, -z, y];

function spreadSolids(entry) {
  const solids = entry.solids.filter((solid) => solid.mesh);
  if (solids.length < 2) return;

  const gap = 12;
  const spans = solids.map((solid) => {
    const box = new THREE.Box3()
      .copy(solid.mesh.geometry.boundingBox)
      .applyMatrix4(solid.mesh.matrixWorld);
    return { solid, box, width: box.max.x - box.min.x };
  });

  const total = spans.reduce((sum, s) => sum + s.width, 0) + gap * (spans.length - 1);
  let cursor = -total / 2;
  for (const span of spans) {
    const center = span.box.getCenter(_center);
    span.solid.holder.position.set(
      ...toCadOffset(cursor + span.width / 2 - center.x, -span.box.min.y, -center.z),
    );
    cursor += span.width + gap;
  }
}

// Num arquivo com varios corpos, o que esta em foco fica na cor da peca e o
// resto vai para cinza. Transparencia foi a primeira tentativa e nao serve:
// vinte e dois corpos translucidos sobrepostos viram sopa.
const RESTING = 0x59626e;
const SELECTED_EDGE = 0xffb454;
const RESTING_EDGE = 0x0b0e12;

function paintFocus(entry) {
  if (!entry.solids || entry.solids.length < 2) return;
  const focus = focusedSolid(entry);

  for (const solid of entry.solids) {
    if (!solid.mesh) continue;
    const on = solid === focus;
    solid.mesh.material.color.setHex(on ? entry.color : RESTING);
    solid.mesh.material.emissive.setHex(on ? 0x1d2836 : 0x000000);

    // As arestas do corpo selecionado viram contorno: âmbar, opacas e
    // desenhadas por cima de tudo, para a silhueta aparecer mesmo quando o
    // corpo está atrás de outro.
    for (const line of solid.mesh.children) {
      if (!line.isLineSegments) continue;
      line.material.color.setHex(on ? SELECTED_EDGE : RESTING_EDGE);
      line.material.opacity = on ? 1 : 0.2;
      line.material.depthTest = !on;
      line.material.needsUpdate = true;
      line.renderOrder = on ? 3 : 0;
      line.visible = on || (state.show.edges && !state.show.wireframe);
    }
  }
}

function applyLayout() {
  const entries = [...state.active.values()];
  for (const entry of entries) {
    entry.holder.position.set(0, 0, 0);
    for (const solid of entry.solids ?? []) solid.holder.position.set(0, 0, 0);
  }
  world.position.set(0, 0, 0);
  world.updateMatrixWorld(true);

  // Medida util e sempre a do conjunto montado, mesmo quando ele e espalhado.
  state.originBounds = entries.length ? activeBounds() : null;

  // Uma peca com varios corpos espalha os corpos; varias pecas espalham pecas.
  if (state.layout === 'spread' && entries.length === 1 && entries[0].solids?.length > 1) {
    world.updateMatrixWorld(true);
    spreadSolids(entries[0]);
  }

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
  linkSolids(entry, features);

  paintFocus(entry);

  if (varsRenderedFor !== `${entry.part.slug}:${state.solid}`) {
    renderVars(entry, features);
    varsRenderedFor = `${entry.part.slug}:${state.solid}`;
  }
  if (state.editMode === 'stretch') {
    refreshStretchPanel(entry, features);
    showStationPlane(entry);
  } else {
    clearHighlight(entry);
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

  entry.scaleNode.scale.set(1, 1, 1);
  for (const solid of entry.solids ?? [entry]) {
    if (solid.stretch) {
      solid.stretch.byAxis = {};
      stretchAxisState(solid.stretch, solid.stretch.axis);
    }
    // Como tudo é refeito a partir da geometria original, limpar as edições
    // devolve a peça de origem, triângulo por triângulo.
    if (solid.edits && Object.keys(solid.edits).length) {
      solid.edits = {};
      await rebuildSolid(entry, solid, features);
    }
  }
  if (entry.stretch) {
    entry.stretch.byAxis = {};
    stretchAxisState(entry.stretch, entry.stretch.axis);
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
    const focus = entry.solids?.length > 1 ? focusedSolid(entry) : null;
    for (const line of entry.edges) {
      // O contorno do corpo selecionado sobrevive ao desligar "Arestas".
      const outline = focus && line.parent === focus.mesh;
      line.visible = outline || (state.show.edges && !state.show.wireframe);
    }
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
// Monta as linhas do painel a partir das features, agrupadas pelo tipo de coisa
// que sao — que e como se pensa a peca, nao como o STEP a descreve. Cada linha
// que pode ser mexida carrega os campos que a descrevem.
function buildRows(analysis, entry) {
  const rows = [];
  const many = analysis.bodies.length > 1;
  const prefix = (body, group) => (many ? `${body.name} · ${group}` : group);
  const solidOf = (body) => entry.solids?.find((solid) => solid.body === body) ?? entry;
  // Com um corpo só o estiramento vive na peça, não no corpo — o mesmo critério
  // de stretchOwner, senão a dimensão mostrada ignora o que foi estirado.
  const stretchOf = (solid) => (entry.solids?.length > 1 ? solid.stretch : entry.stretch);

  for (const body of analysis.bodies) {
    const solid = solidOf(body);
    const edits = solid.edits ?? {};
    const { box } = body;

    for (const [axis, label] of [[0, 'largura_x'], [1, 'comprimento_y'], [2, 'altura_z']]) {
      const stretched = stretchOf(solid)?.byAxis[axis]?.delta ?? 0;
      const current = box.size[axis] + stretched;
      rows.push({
        group: prefix(body, 'Geral'),
        id: `${body.bodyIndex}-dim-${axis}`,
        body,
        fallback: label,
        value: `${fmt(current)} mm`,
        detail:
          `extensão em ${AXIS_LABEL[axis]}` +
          (stretched ? ` · estirado de ${fmt(box.size[axis])} mm` : ''),
        edit: {
          kind: 'dimension',
          axis,
          // Só a letra do eixo: o detalhe da linha logo acima já diz "extensão em X".
          fields: [{ key: 'length', label: AXIS_LABEL[axis], suffix: 'mm' }],
        },
      });
    }

    for (const pattern of body.patterns) {
      const edit = edits[pattern.id];
      const count = edit?.count ?? pattern.count;
      const pitch = edit?.pitch ?? pattern.pitch;
      const edge = edit?.edge ?? pattern.edge ?? pattern.edgeStart;
      const diameter = edit?.diameter ?? pattern.diameter;
      const vacant = edit ? 0 : pattern.slots - pattern.count;
      const changed =
        count !== pattern.count ||
        pitch !== pattern.pitch ||
        edge !== pattern.edgeStart ||
        diameter !== pattern.diameter;

      // O padrão é recortado na geometria original, então o que tem de caber é o
      // comprimento do corpo antes de qualquer estiramento.
      const span = body.box.size[pattern.axisIndex];
      const tail = span - edge - (count - 1) * pitch;

      rows.push({
        group: prefix(body, 'Padrões de furos'),
        id: pattern.id,
        body,
        fallback: `padrao_${pattern.diameter}_${pattern.direction.toLowerCase()}`,
        value: `${count} × Ø${fmt(diameter)}`,
        warn: tail < 0,
        detail:
          (tail < 0
            ? `não cabe: o último furo cai ${fmt(-tail)} mm além dos ${fmt(span)} mm do corpo`
            : `${fmt(edge)} + ${fmt((count - 1) * pitch)} + ${fmt(tail)} = ${fmt(span)} mm em ` +
              pattern.direction) +
          (vacant > 0 ? ` · ${vacant} estação(ões) vaga(s)` : '') +
          (changed
            ? ` · refeito (era ${pattern.count} × Ø${pattern.diameter} a ${fmt(pattern.pitch)} mm)`
            : ''),
        highlight: changed ? null : { kind: 'holes', ids: pattern.holeIds },
        edit: {
          kind: 'pattern',
          patternId: pattern.id,
          fields: [
            { key: 'diameter', label: 'diâmetro', value: diameter, suffix: 'mm' },
            { key: 'count', label: 'quantidade', value: count, integer: true, suffix: 'furos' },
            { key: 'pitch', label: 'passo', value: pitch, suffix: 'mm' },
            { key: 'edge', label: 'borda', value: edge, suffix: 'mm' },
          ],
        },
      });
    }

    // Canal e furo entram em baldes separados: cilindro côncavo com o eixo fora
    // do material é guia de trilho, não furo, e misturar confunde a leitura.
    const byDiameter = new Map();
    for (const hole of body.holes) {
      if (hole.patternId) continue;
      const key = `${hole.diameter}|${hole.groove ? 'canal' : 'furo'}`;
      byDiameter.set(key, [...(byDiameter.get(key) ?? []), hole]);
    }

    const ordered = [...byDiameter.values()].sort((a, b) => b[0].diameter - a[0].diameter);
    for (const holes of ordered) {
      const original = holes[0].diameter;
      const groove = holes[0].groove;
      const id = `${body.bodyIndex}-dia-${original}-${groove ? 'canal' : 'furo'}`;
      const diameter = edits[id]?.diameter ?? original;
      const axis = holes[0].axis.findIndex((v) => Math.abs(v) > 0.9);
      const depth = Math.max(...holes.map((h) => h.depth));
      const wall = holes.map((h) => h.wall).filter((w) => w !== null).sort((a, b) => a - b)[0];

      rows.push({
        group: prefix(body, groove ? 'Canais' : 'Furos avulsos'),
        id,
        body,
        fallback: groove ? `canal_${original}mm` : `furo_${original}mm`,
        value: `${holes.length} × Ø${fmt(diameter)}`,
        detail:
          `eixo ${AXIS_LABEL[axis] ?? 'oblíquo'} · prof ${fmt(depth)} mm` +
          (wall === undefined ? '' : ` · parede ${fmt(wall)} mm`) +
          (diameter !== original ? ` · era Ø${original}` : ''),
        highlight: { kind: 'holes', ids: holes.map((h) => h.id) },
        // Canal não é editável: mexer no raio de uma guia mudaria o encaixe com
        // a esfera, e a booleana não tem como saber disso.
        edit: groove
          ? null
          : {
              kind: 'holes',
              holeIds: holes.map((h) => h.id),
              fields: [{ key: 'diameter', label: 'diâmetro', value: diameter, suffix: 'mm' }],
            },
      });
    }

    for (const [index, family] of body.thicknesses.entries()) {
      const axis = family.normal.findIndex((v) => Math.abs(v) > 0.9);
      for (const [gapIndex, gap] of family.gaps.entries()) {
        if (gap < 0.2) continue;                       // ruido de chanfro
        rows.push({
          group: prefix(body, 'Espessuras'),
          id: `${body.bodyIndex}-esp-${index}-${gapIndex}`,
          body,
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
        body,
        fallback: `raio_${round.radius}mm`,
        value: `${round.count} × R${round.radius}`,
        detail: 'cilindro convexo',
      });
    }

    for (const chamfer of body.chamfers) {
      rows.push({
        group: prefix(body, 'Arredondamentos e chanfros'),
        id: `${body.bodyIndex}-chanfro-${chamfer.diameter}-${chamfer.angle}`,
        body,
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
  const names = savedNames(entry.part.slug);
  const focus = focusedSolid(entry)?.body;
  const many = features.bodies.length > 1;

  // Com muitos corpos, listar todos de uma vez é despejo: o MGN9 tem 22, e
  // achar o que está selecionado exige rolar. Por padrão só ele aparece.
  if (many) el.vars.append(bodyPicker(entry, features, focus));
  const rows = buildRows(features, entry).filter(
    (row) => !many || state.allBodies || row.body === focus,
  );

  let currentGroup = null;
  for (const row of rows) {
    if (row.group !== currentGroup) {
      currentGroup = row.group;
      const title = document.createElement('div');
      title.className = 'var-group';
      // Com um corpo só na tela, o nome dele já está no cabeçalho.
      title.textContent =
        many && !state.allBodies ? currentGroup.split(' · ').slice(1).join(' · ') : currentGroup;
      el.vars.append(title);
    }

    const item = document.createElement('div');
    item.className = 'var';
    if (row.body === focus && entry.solids?.length > 1) item.classList.add('on');

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
    detail.className = row.warn ? 'var-detail warn' : 'var-detail';
    detail.textContent = row.detail;

    item.append(name, value, detail);

    if (row.edit && placed) item.append(editorFor(entry, features, row));

    if (row.highlight && placed) {
      item.addEventListener('pointerenter', () => showHighlight(entry, features, row.highlight));
      item.addEventListener('pointerleave', () => clearHighlight(entry));
    }
    // Clicar na linha traz o corpo dela para o foco.
    item.addEventListener('pointerdown', () => focusBody(entry, row.body));
    el.vars.append(item);
  }
}

// Cabeçalho de escolha de corpo, para arquivos com mais de um.
function bodyPicker(entry, features, focus) {
  const bar = document.createElement('div');
  bar.className = 'body-picker';

  const select = document.createElement('select');
  select.className = 'focus wide';
  select.innerHTML = features.bodies
    .map(
      // O nome vem do CAD e costuma repetir — o Fusion exportou três "Body1"
      // no MGN9. O número é o que distingue de fato.
      (body, index) =>
        `<option value="${index}">${index + 1}. ${escapeHtml(body.name)} · ` +
        `${body.box.size.join(' × ')} mm</option>`,
    )
    .join('');
  select.value = String(features.bodies.indexOf(focus));
  select.addEventListener('change', () => {
    state.solid = Number(select.value);
    paintFocus(entry);
    varsRenderedFor = null;
    updateInfo();
  });

  const toggle = document.createElement('button');
  toggle.className = state.allBodies ? 'active' : '';
  toggle.textContent = 'todos';
  toggle.title = 'Listar as variáveis de todos os corpos de uma vez';
  toggle.addEventListener('click', () => {
    state.allBodies = !state.allBodies;
    varsRenderedFor = null;
    updateInfo();
  });

  const count = document.createElement('span');
  count.className = 'body-count';
  count.textContent = `${features.bodies.indexOf(focus) + 1}/${features.bodies.length}`;

  bar.append(select, count, toggle);
  return bar;
}

// Campos de uma linha editável. O valor é aplicado ao sair do campo, não a cada
// tecla: a booleana leva uns 200 ms e recortar a peça a cada dígito seria pior
// que esperar.
function editorFor(entry, features, row) {
  const wrap = document.createElement('div');
  wrap.className = 'var-fields';

  const fields =
    row.edit.kind === 'dimension'
      ? [{ ...row.edit.fields[0], value: dimensionValue(entry, row) }]
      : row.edit.fields;

  for (const field of fields) {
    // `display: contents` no label joga rótulo, campo e unidade direto nas três
    // colunas da grade, então as linhas se alinham entre si como numa tabela.
    const label = document.createElement('label');
    const caption = document.createElement('span');
    caption.textContent = field.label ?? '';
    label.append(caption);

    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = field.integer ? 'numeric' : 'decimal';
    input.value = fmt(field.value);
    input.addEventListener('pointerdown', (event) => event.stopPropagation());
    input.addEventListener('change', async () => {
      const parsed = field.integer ? Math.round(parseNumber(input.value)) : parseNumber(input.value);
      if (!Number.isFinite(parsed) || parsed <= (field.key === 'edge' ? -0.001 : 0)) {
        input.value = fmt(field.value);
        return;
      }
      await commitEdit(entry, features, row, field.key, parsed);
    });

    const suffix = document.createElement('em');
    suffix.textContent = field.suffix ?? '';
    label.append(input, suffix);
    wrap.append(label);
  }
  return wrap;
}

function dimensionValue(entry, row) {
  const owner = stretchOwner(entry);
  const stretch = owner.stretch;
  if (!stretch) return row.body.box.size[row.edit.axis];
  const axis = row.edit.axis;
  const length = stretch.base.max[axis] - stretch.base.min[axis];
  return length + (stretch.byAxis[axis]?.delta ?? 0);
}

function focusBody(entry, body) {
  if (!body || !entry.solids) return;
  const index = entry.solids.findIndex((solid) => solid.body === body);
  if (index < 0 || index === state.solid) return;
  state.solid = index;
  paintFocus(entry);
  updateInfo();
}

async function commitEdit(entry, features, row, key, value) {
  focusBody(entry, row.body);

  if (row.edit.kind === 'dimension') {
    const stretch = stretchState(entry, features);
    const axis = row.edit.axis;
    stretch.axis = axis;
    const length = stretch.base.max[axis] - stretch.base.min[axis];
    stretchAxisState(stretch, axis).delta = value - length;
    applyStretch(entry);
    fitView();
    varsRenderedFor = null;
    updateInfo();
    return;
  }

  const solid = entry.solids?.find((s) => s.body === row.body) ?? entry;
  solid.edits = solid.edits ?? {};
  const current = solid.edits[row.id] ?? { ...row.edit };
  solid.edits[row.id] = { ...current, [key]: value };

  await rebuildSolid(entry, solid, features);
  varsRenderedFor = null;
  updateInfo();
}

/* ------------------------------------------------- destaque no 3D */

const HIGHLIGHT = 0xffb454;

// Onde desenhar o destaque de um corpo: dentro do grupo dele, para acompanhar
// o arranjo. Sem corpos, na raiz da peça.
function highlightHost(entry, body) {
  const solid = body && entry.solids?.find((s) => s.body === body);
  return solid?.highlight ?? entry.highlight;
}

function clearHighlight(entry) {
  const groups = [entry.highlight, ...(entry.solids ?? []).map((s) => s.highlight)];
  for (const group of groups) {
    if (!group) continue;
    for (const child of [...group.children]) {
      child.geometry?.dispose();
      child.material?.dispose();
      group.remove(child);
    }
  }
}

function showHighlight(entry, features, target) {
  clearHighlight(entry);
  const bodyOf = (hole) => features.bodies.find((b) => b.holes.includes(hole));

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
      highlightHost(entry, bodyOf(hole)).add(mesh);
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
    highlightHost(entry, body).add(line);
  }
}

/* ================================================ estiramento prismatico */

// Caixa da peca no espaco do CAD. Os nos do glTF nao tem transformacao, entao a
// caixa da geometria ja esta nas coordenadas em que o estiramento opera.
function cadBounds(entry, meshes = entry.meshes) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of meshes) {
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const { min: lo, max: hi } = mesh.geometry.boundingBox;
    for (const axis of [0, 1, 2]) {
      min[axis] = Math.min(min[axis], lo.getComponent(axis));
      max[axis] = Math.max(max[axis], hi.getComponent(axis));
    }
  }
  return { min, max };
}

// Malhas que uma operacao alcanca: o corpo em foco quando ha varios, a peca
// inteira quando so ha um.
function targetMeshes(entry) {
  const solid = focusedSolid(entry);
  return solid?.mesh && entry.solids.length > 1 ? [solid.mesh] : entry.meshes;
}

// Um estiramento por eixo. Eles se compoem sem conflito — cada um mexe numa
// coordenada diferente — e sem isso editar a largura desfaria o comprimento.
function stretchState(entry, features) {
  const solid = entry.solids?.length > 1 ? focusedSolid(entry) : entry;
  if (solid.stretch) return solid.stretch;
  const base = cadBounds(entry, targetMeshes(entry));
  // Comeca pelo eixo mais longo: e quase sempre o que se quer alongar.
  const longest = [0, 1, 2].reduce((a, b) => (base.max[b] - base.min[b] > base.max[a] - base.min[a] ? b : a));
  // Corte sugerido a partir dos furos do corpo em foco, nao de todos.
  const holes = entry.solids?.length > 1 ? (solid.body?.holes ?? []) : allHoles(features);
  solid.stretch = {
    axis: longest,
    base,
    byAxis: {},   // eixo -> { station, delta }
    holes,
  };
  stretchAxisState(solid.stretch, longest);
  return solid.stretch;
}

// Estado de um eixo, criado sob demanda com o corte sugerido daquele eixo.
function stretchAxisState(stretch, axis) {
  if (!stretch.byAxis[axis]) {
    stretch.byAxis[axis] = {
      station: suggestStation(stretch.holes, axis, stretch.base.min[axis], stretch.base.max[axis]),
      delta: 0,
    };
  }
  return stretch.byAxis[axis];
}

// O estado de estiramento vive no corpo quando ha varios, na peca quando nao.
function stretchOwner(entry) {
  return entry.solids?.length > 1 ? focusedSolid(entry) ?? entry : entry;
}

function applyStretch(entry) {
  const owner = stretchOwner(entry);
  if (!owner.stretch) return;
  ownGeometry(entry);

  const meshes = targetMeshes(entry);
  const lines = meshes.flatMap((mesh) => mesh.children.filter((c) => c.isLineSegments));

  for (const node of [...meshes, ...lines]) {
    const attribute = node.geometry.attributes.position;
    attribute.array.set(node.userData.pristine);
    for (const [axis, { station, delta }] of Object.entries(owner.stretch.byAxis)) {
      if (delta !== 0) stretchPositions(attribute.array, Number(axis), station, delta);
    }
    attribute.needsUpdate = true;
    node.geometry.computeBoundingBox();
    node.geometry.computeBoundingSphere();
  }

  recomputeBaseSize(entry);
  applyLayout();
}

function resetStretch(entry) {
  const owner = stretchOwner(entry);
  if (!owner.stretch) return;
  owner.stretch.byAxis = {};
  stretchAxisState(owner.stretch, owner.stretch.axis);
  applyStretch(entry);
}

// Plano indicando onde o corte acontece, enquanto o painel esta aberto.
function showStationPlane(entry) {
  clearHighlight(entry);
  if (state.editMode !== 'stretch') return;
  const owner = stretchOwner(entry);
  if (!owner.stretch) return;

  const { axis, base } = owner.stretch;
  const { station } = stretchAxisState(owner.stretch, axis);
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
  highlightHost(entry, focusedSolid(entry)?.body).add(plane);
}

function refreshStretchPanel(entry, features) {
  const stretch = stretchState(entry, features);
  const { axis, base } = stretch;
  const { station, delta } = stretchAxisState(stretch, axis);
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

  const holes = entry.solids?.length > 1 ? (focusedSolid(entry)?.body.holes ?? []) : allHoles(features);
  const conflicts = conflictsAt(holes, axis, station);
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
    const owner = entry && stretchOwner(entry);
    if (!owner?.stretch) return;
    const axis = Number(button.dataset.stretchAxis);
    owner.stretch.axis = axis;
    stretchAxisState(owner.stretch, axis);
    applyStretch(entry);
    fitView();
    updateInfo();
  });
}

el.stretchLength.addEventListener('input', () => {
  const entry = focusedEntry();
  const owner = entry && stretchOwner(entry);
  if (!owner?.stretch) return;
  const target = parseNumber(el.stretchLength.value);
  const { axis, base } = owner.stretch;
  const length = base.max[axis] - base.min[axis];
  if (!(target > 0)) return;
  stretchAxisState(owner.stretch, axis).delta = target - length;
  applyStretch(entry);
  updateInfo();
});

function setStation(value) {
  const entry = focusedEntry();
  const owner = entry && stretchOwner(entry);
  if (!owner?.stretch || !Number.isFinite(value)) return;
  const { axis, base } = owner.stretch;
  stretchAxisState(owner.stretch, axis).station =
    Math.min(Math.max(value, base.min[axis]), base.max[axis]);
  applyStretch(entry);
  updateInfo();
}

el.stretchStation.addEventListener('input', () => setStation(parseNumber(el.stretchStation.value)));
el.stretchSlider.addEventListener('input', () => setStation(Number(el.stretchSlider.value)));


/* ================================== refazer furos a partir das variaveis */

// Refaz o corpo inteiro a partir da geometria original, aplicando todas as
// edicoes de furo de uma vez. Partir sempre do original e o que faz "voltar ao
// valor do arquivo" devolver a peca de origem em vez de acumular recortes.
async function rebuildSolid(entry, solid, features) {
  const mesh = solid.mesh ?? entry.meshes[0];
  if (!mesh || !featuresArePlaced(entry, features)) return;

  const source = sourceOf(mesh);
  const plugs = [];
  const cuts = [];
  let changed = false;

  const holesById = new Map(
    (solid.body ? solid.body.holes : allHoles(features)).map((hole) => [hole.id, hole]),
  );

  for (const [id, edit] of Object.entries(solid.edits ?? {})) {
    if (edit.kind === 'pattern') {
      const found = findPattern(features, edit.patternId);
      if (!found) continue;
      const { body, pattern } = found;
      const holes = pattern.holeIds.map((holeId) => holesById.get(holeId)).filter(Boolean);
      if (holes.length === 0) continue;

      const count = edit.count ?? pattern.count;
      const pitch = edit.pitch ?? pattern.pitch;
      const edge = edit.edge ?? pattern.edgeStart;
      const diameter = edit.diameter ?? pattern.diameter;
      if (
        count === pattern.count &&
        pitch === pattern.pitch &&
        edge === pattern.edgeStart &&
        diameter === pattern.diameter
      ) {
        continue;
      }
      changed = true;

      plugs.push(...holes.flatMap((hole) => holeSolids(hole, { mode: 'plug' })));
      for (let index = 0; index < count; index++) {
        cuts.push(
          ...holeSolids(holes[0], {
            axisIndex: pattern.axisIndex,
            station: body.box.min[pattern.axisIndex] + edge + index * pitch,
            diameter,
          }),
        );
      }
    } else if (edit.kind === 'holes') {
      const holes = edit.holeIds.map((holeId) => holesById.get(holeId)).filter(Boolean);
      if (holes.length === 0 || edit.diameter === holes[0].diameter) continue;
      changed = true;

      // Cada furo do grupo é tapado e reaberto no mesmo lugar, no diâmetro novo.
      for (const hole of holes) {
        plugs.push(...holeSolids(hole, { mode: 'plug' }));
        cuts.push(...holeSolids(hole, { diameter: edit.diameter }));
      }
    }
    void id;
  }

  const finish = () => {
    if (stretchOwner(entry).stretch) applyStretch(entry);
    else {
      recomputeBaseSize(entry);
      applyLayout();
    }
  };

  // Sem nenhuma diferença, a booleana seria uma volta inteira para chegar na
  // peça de origem — e chegaria com o dobro de triângulos, porque os furos
  // voltariam com 48 lados no lugar dos que o OpenCascade tesselou.
  if (!changed) {
    setMeshGeometry(entry, mesh, Float32Array.from(source.positions), Uint32Array.from(source.indices));
    entry.part.triangles = totalTriangles(entry);
    finish();
    return;
  }

  busy(true, 'Refazendo furos…');
  solid.error = null;
  try {
    const result = await rebuildWithHoles(source.positions, source.indices, plugs, cuts);
    setMeshGeometry(entry, mesh, result.positions, result.indices);
    entry.part.triangles = totalTriangles(entry);
    finish();
  } catch (error) {
    // Sem isto o erro some: o redesenho seguinte reescreve o painel, e a falha
    // fica invisível com a peça intacta na tela.
    console.error('booleana falhou', error);
    solid.error = error.message;
    el.status.textContent = `A booleana falhou: ${error.message}`;
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

/* ------------------------------------- selecionar clicando na peça */

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let pressedAt = null;

el.canvas.addEventListener('pointerdown', (event) => {
  pressedAt = [event.clientX, event.clientY];
});

el.canvas.addEventListener('pointerup', (event) => {
  if (!pressedAt) return;
  const travelled = Math.hypot(event.clientX - pressedAt[0], event.clientY - pressedAt[1]);
  pressedAt = null;
  // Orbitar a camera tambem solta um pointerup: so conta como clique se o
  // ponteiro praticamente nao andou.
  if (travelled < 4) selectAt(event);
});

function selectAt(event) {
  const rect = el.canvas.getBoundingClientRect();
  pointer.set(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(pointer, camera);

  const meshes = [...state.active.values()].flatMap((entry) => entry.meshes);
  const hit = raycaster.intersectObjects(meshes, false)[0];
  if (!hit) return;   // clique no vazio nao desfaz a selecao

  for (const [slug, entry] of state.active) {
    if (!entry.meshes.includes(hit.object)) continue;
    const index = entry.solids?.findIndex((solid) => solid.mesh === hit.object) ?? -1;

    state.focus = slug;
    state.solid = index >= 0 ? index : 0;
    // O padrao em edicao pertence ao corpo antigo: deixa o painel reabrir.
    varsRenderedFor = null;
    syncList();
    updateInfo();
    break;
  }
}

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
