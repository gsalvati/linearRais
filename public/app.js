import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

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
  show: { edges: true, wireframe: false, bbox: false, grid: true, spin: false },
  dropped: 0,
};

const el = {
  canvas: document.getElementById('canvas'),
  parts: document.getElementById('parts'),
  status: document.getElementById('status'),
  info: document.getElementById('info'),
  focus: document.getElementById('focus'),
  dims: document.querySelectorAll('.dims input'),
  uniform: document.getElementById('uniform'),
  pct: document.getElementById('scale-pct'),
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
  const baseSize = new THREE.Box3().setFromObject(clone).getSize(new THREE.Vector3());

  return { holder, meshes, edges, box, scaleNode: clone, cadRoot: clone.children[0], baseSize };
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
  for (const mesh of entry.meshes) mesh.material.dispose();
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

function applyLayout() {
  const entries = [...state.active.values()];
  for (const entry of entries) entry.holder.position.set(0, 0, 0);
  world.position.set(0, 0, 0);
  world.updateMatrixWorld(true);

  // Medida util e sempre a do conjunto montado, mesmo quando ele e espalhado.
  state.originBounds = entries.length
    ? new THREE.Box3().setFromObject(world)
    : null;

  if (state.layout === 'spread' && entries.length > 1) {
    const gap = 12;
    const spans = entries.map((entry) => {
      const b = _box.setFromObject(entry.holder).clone();
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
    const floor = new THREE.Box3().setFromObject(world).min.y;
    if (Number.isFinite(floor)) world.position.y = -floor;
    world.updateMatrixWorld(true);
  }
  for (const entry of entries) {
    entry.box.box.setFromObject(entry.holder);
  }
  resizeGrid();
}

function worldBounds() {
  if (state.active.size === 0) return null;
  world.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(world);
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

  const size = (state.originBounds ?? worldBounds()).getSize(new THREE.Vector3());
  const triangles = entries.reduce((sum, e) => sum + e.part.triangles, 0);
  el.status.textContent =
    `${entries.length} peça(s) · ${fmt(size.x)} × ${fmt(size.y)} × ${fmt(size.z)} mm · ` +
    `${triangles.toLocaleString('pt-BR')} triângulos`;
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
  updateInfo();
});

document.getElementById('reset-scale').addEventListener('click', () => {
  const entry = focusedEntry();
  if (!entry) return;
  entry.scaleNode.scale.set(1, 1, 1);
  applyLayout();
  fitView();
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
    const part = {
      slug,
      label: file.name.replace(/\.(step|stp)$/i, ''),
      group: 'Arquivos arrastados',
      source: file.name,
      triangles,
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
