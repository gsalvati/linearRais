// Sonda: o que dá para recuperar de um .step sem a arvore de features do CAD.
// Le o grafo de entidades e reconhece furos (faces cilindricas coaxiais),
// chanfros (conicas) e faces planas, medindo o que existe entre eles.
import fs from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('uso: node tools/inspect-step.mjs <arquivo.step>');
  process.exit(1);
}

const text = fs
  .readFileSync(file, 'latin1')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')           // comentarios
  .slice(fs.readFileSync(file, 'latin1').indexOf('DATA;'));

/* ------------------------------------------------------- grafo de entidades */

const entities = new Map();
for (const [, id, type, body] of text.matchAll(/#(\d+)\s*=\s*([A-Z_0-9]+)\s*\(([\s\S]*?)\)\s*;/g)) {
  entities.set(Number(id), { type, args: splitArgs(body) });
}

// Separa os argumentos do nivel de cima, respeitando parenteses e strings.
function splitArgs(body) {
  const out = [];
  let depth = 0;
  let inString = false;
  let current = '';
  for (const char of body) {
    if (inString) {
      inString = char !== "'";
      current += char;
      continue;
    }
    if (char === "'") { inString = true; current += char; continue; }
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ',' && depth === 0) { out.push(current.trim()); current = ''; continue; }
    current += char;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

const ref = (arg) => entities.get(Number(String(arg).replace('#', '')));
const refs = (arg) => String(arg).replace(/[()]/g, '').split(',').map((a) => ref(a.trim())).filter(Boolean);
const triple = (entity) => entity.args.at(-1).replace(/[()]/g, '').split(',').map(Number);

const point = (arg) => triple(ref(arg));
const direction = (arg) => triple(ref(arg));

function placement(arg) {
  const p = ref(arg);
  return { origin: point(p.args[1]), axis: direction(p.args[2]), ref: p.args[3] ? direction(p.args[3]) : null };
}

/* ----------------------------------------------------------------- geometria */

const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const norm = (a) => Math.hypot(...a);
const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

// Distancia de um ponto ate a reta (origem, direcao).
function pointToAxis(p, origin, axis) {
  const d = sub(p, origin);
  return norm(sub(d, axis.map((c) => c * dot(d, axis))));
}

/* -------------------------------------------------- percorre as faces do solido */

const faces = [];
for (const [id, entity] of entities) {
  if (entity.type !== 'ADVANCED_FACE') continue;
  const surface = ref(entity.args[2]);
  if (!surface) continue;

  const vertices = [];
  for (const bound of refs(entity.args[1])) {
    const loop = ref(bound.args[1]);
    if (!loop || loop.type !== 'EDGE_LOOP') continue;
    for (const oriented of refs(loop.args[1])) {
      const edge = ref(oriented.args[3]);
      if (!edge) continue;
      for (const end of [edge.args[1], edge.args[2]]) {
        const vertex = ref(end);
        if (vertex?.type === 'VERTEX_POINT') vertices.push(point(vertex.args[1]));
      }
    }
  }
  faces.push({ id, surface, vertices, sameSense: entity.args[3]?.includes('T') });
}

/* ------------------------------------------------------ agrupa em features */

const holes = new Map();      // eixo+raio -> furo (cilindro concavo)
const rounds = new Map();     // arredondamentos (cilindro convexo)
const cones = [];
const planes = [];

for (const face of faces) {
  const { type, args } = face.surface;

  if (type === 'CYLINDRICAL_SURFACE') {
    const place = placement(args[1]);
    const radius = Number(args[2]);
    // Chave pelo eixo (direcao normalizada + ponto mais proximo da origem) e raio.
    const perpendicular = sub(place.origin, place.axis.map((c) => c * dot(place.origin, place.axis)));
    const key = [...place.axis, ...perpendicular, radius].map((v) => round(v, 2)).join('|');

    // A normal natural do cilindro aponta para fora do eixo. Se a face inverte
    // esse sentido (same_sense = .F.), o material esta do lado de fora: e furo.
    // Se concorda, o material esta dentro: e um arredondamento de quina.
    const bucket = face.sameSense ? rounds : holes;
    const hole = bucket.get(key) ?? { radius, axis: place.axis, origin: place.origin, span: [Infinity, -Infinity], faces: 0 };
    for (const vertex of face.vertices) {
      const t = dot(sub(vertex, place.origin), place.axis);
      hole.span[0] = Math.min(hole.span[0], t);
      hole.span[1] = Math.max(hole.span[1], t);
    }
    hole.faces++;
    bucket.set(key, hole);
  } else if (type === 'CONICAL_SURFACE') {
    cones.push({ radius: Number(args[2]), angle: (Number(args[3]) * 180) / Math.PI, place: placement(args[1]) });
  } else if (type === 'PLANE') {
    const place = placement(args[1]);
    planes.push({ normal: place.axis, origin: place.origin, vertices: face.vertices });
  }
}

/* ------------------------------------------------------------------ relatorio */

const all = faces.flatMap((f) => f.vertices);
const box = [0, 1, 2].map((a) => [Math.min(...all.map((p) => p[a])), Math.max(...all.map((p) => p[a]))]);

console.log(`\n${file}`);
console.log(`  ${faces.length} faces · caixa ${box.map(([lo, hi]) => round(hi - lo, 2)).join(' × ')} mm\n`);

// Faces planas paralelas viram "paredes": a distancia entre elas e uma espessura.
const groups = new Map();
for (const plane of planes) {
  // Normais opostas descrevem a mesma familia de planos: canoniza o sentido,
  // senao as duas faces de uma parede aparecem separadas pelo dobro da distancia.
  const flip = plane.normal.find((v) => Math.abs(v) > 1e-6) < 0 ? -1 : 1;
  const normal = plane.normal.map((v) => v * flip);
  const key = normal.map((v) => round(v, 3)).join('|');
  const offset = dot(plane.origin, normal);
  const list = groups.get(key) ?? [];
  if (!list.some((o) => Math.abs(o - offset) < 1e-6)) list.push(offset);
  groups.set(key, list);
}

console.log('  planos paralelos (candidatos a espessura / altura):');
for (const [key, offsets] of groups) {
  if (offsets.length < 2) continue;
  const sorted = [...offsets].sort((a, b) => a - b);
  const gaps = sorted.slice(1).map((v, i) => round(v - sorted[i], 2)).filter((g) => g > 0.01);
  console.log(`    eixo ${key.replace(/\|/g, ', ')}  ->  ${gaps.join(' / ')} mm`);
}

console.log('\n  furos reconhecidos:');
const sortedHoles = [...holes.values()].sort((a, b) => b.radius - a.radius);
for (const [i, hole] of sortedHoles.entries()) {
  const depth = round(hole.span[1] - hole.span[0], 2);
  const axisName = ['X', 'Y', 'Z'][hole.axis.findIndex((v) => Math.abs(v) > 0.9)] ?? 'obliquo';
  const center = hole.origin.map((v) => round(v, 2));

  // Distancia do eixo do furo ate cada plano perpendicular ao eixo do furo.
  const edges = planes
    .filter((p) => Math.abs(dot(p.normal, hole.axis)) < 0.01 && p.vertices.length)
    .map((p) => round(Math.abs(dot(sub(hole.origin, p.origin), p.normal)) - hole.radius, 2))
    .filter((d) => d > 0.01)
    .sort((a, b) => a - b);

  console.log(
    `    furo ${i + 1}: Ø${round(hole.radius * 2, 2)} mm · eixo ${axisName} · prof ${depth} mm · centro (${center})`,
  );
  if (edges.length) console.log(`             parede mais proxima: ${edges[0]} mm  (todas: ${edges.slice(0, 4).join(', ')})`);
}

/* ------------------------------------------ padroes lineares de furos */

// Furos de mesmo diametro e mesmo eixo, com centros colineares e passo
// constante, sao um padrao: viram (quantidade, passo, distancia do primeiro).
function linearPatterns(list) {
  const families = new Map();
  for (const hole of list) {
    const key = [round(hole.radius * 2, 2), ...hole.axis.map((v) => round(Math.abs(v), 2))].join('|');
    families.set(key, [...(families.get(key) ?? []), hole]);
  }

  const found = [];
  for (const [key, group] of families) {
    if (group.length < 3) continue;

    // Direcao em que os centros variam: o eixo de maior dispersao.
    const spread = [0, 1, 2].map((a) => {
      const values = group.map((h) => h.origin[a]);
      return Math.max(...values) - Math.min(...values);
    });
    const along = spread.indexOf(Math.max(...spread));
    const perpendicular = [0, 1, 2].filter((a) => a !== along);
    if (perpendicular.some((a) => spread[a] > 0.05)) continue;   // nao sao colineares

    const stations = group.map((h) => h.origin[along]).sort((a, b) => a - b);
    const gaps = stations.slice(1).map((v, i) => round(v - stations[i], 2));
    const pitch = Math.min(...gaps);
    // Aceita falhas no padrao: todo vao precisa ser multiplo do passo base.
    if (!gaps.every((g) => Math.abs(g / pitch - Math.round(g / pitch)) < 0.02)) continue;

    const slots = Math.round((stations.at(-1) - stations[0]) / pitch) + 1;
    found.push({
      diameter: Number(key.split('|')[0]),
      direction: 'XYZ'[along],
      count: group.length,
      slots,
      pitch,
      first: stations[0],
      last: stations.at(-1),
      length: round(stations.at(-1) - stations[0], 2),
    });
  }
  return found;
}

const patterns = linearPatterns(sortedHoles);
if (patterns.length) {
  console.log('\n  padroes lineares de furos:');
  for (const pattern of patterns) {
    const gaps = pattern.slots - pattern.count;
    console.log(
      `    Ø${pattern.diameter} mm · ${pattern.count} furos ao longo de ${pattern.direction}` +
        ` · passo ${pattern.pitch} mm · extensao ${pattern.length} mm` +
        (gaps > 0 ? `  (${gaps} estacao(oes) vaga(s) no passo)` : ''),
    );
    const edge = round(pattern.first - box['XYZ'.indexOf(pattern.direction)][0], 2);
    console.log(`             primeiro furo a ${edge} mm da borda`);
  }
}

const roundList = [...rounds.values()].sort((a, b) => b.radius - a.radius);
if (roundList.length) {
  console.log('\n  arredondamentos (cilindros convexos, nao sao furos):');
  const bySize = new Map();
  for (const r of roundList) bySize.set(round(r.radius, 2), (bySize.get(round(r.radius, 2)) ?? 0) + 1);
  for (const [radius, count] of bySize) console.log(`    R${radius} mm × ${count}`);
}

if (cones.length) {
  console.log('\n  conicas (chanfros / escareados):');
  for (const cone of cones) {
    console.log(`    Ø${round(cone.radius * 2, 2)} mm · ${round(cone.angle, 1)}°`);
  }
}
console.log();
