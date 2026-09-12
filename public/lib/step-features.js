// Reconhecimento de features a partir do B-rep de um .step.
//
// O arquivo nao traz nenhuma intencao de projeto — nem cota, nem parametro, nem
// arvore de features. O que existe e geometria analitica, e dela da para
// reconstruir o que interessa editar: furos, padroes de furos, espessuras entre
// planos paralelos, arredondamentos e chanfros.
//
// Modulo puro: roda igual no Node (pre-processo) e no navegador (arquivo solto).

const round = (value, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;
const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const norm = (a) => Math.hypot(...a);

/* ----------------------------------------------------- grafo de entidades */

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
    if (char === "'") {
      inString = true;
      current += char;
      continue;
    }
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function parseEntities(source) {
  const body = source.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const data = body.slice(Math.max(0, body.indexOf('DATA;')));
  const entities = new Map();

  for (const [, id, type, args] of data.matchAll(/#(\d+)\s*=\s*([A-Z_0-9]+)\s*\(([\s\S]*?)\)\s*;/g)) {
    entities.set(Number(id), { type, args: splitArgs(args) });
  }
  return entities;
}

/* ------------------------------------------------------------ percurso */

export function analyzeStep(source) {
  const entities = parseEntities(source);

  const ref = (arg) => entities.get(Number(String(arg).replace('#', '')));
  const refs = (arg) =>
    String(arg)
      .replace(/[()]/g, '')
      .split(',')
      .map((a) => ref(a.trim()))
      .filter(Boolean);
  const triple = (entity) => entity.args.at(-1).replace(/[()]/g, '').split(',').map(Number);
  const point = (arg) => triple(ref(arg));

  const placement = (arg) => {
    const p = ref(arg);
    return { origin: point(p.args[1]), axis: triple(ref(p.args[2])) };
  };

  // Cada ADVANCED_FACE carrega a superficie e os vertices do seu contorno.
  const faces = [];
  for (const entity of entities.values()) {
    if (entity.type !== 'ADVANCED_FACE') continue;
    const surface = ref(entity.args[2]);
    if (!surface) continue;

    const vertices = [];
    for (const bound of refs(entity.args[1])) {
      const loop = ref(bound.args[1]);
      if (loop?.type !== 'EDGE_LOOP') continue;
      for (const oriented of refs(loop.args[1])) {
        const edge = ref(oriented.args[3]);
        if (!edge) continue;
        for (const end of [edge.args[1], edge.args[2]]) {
          const vertex = ref(end);
          if (vertex?.type === 'VERTEX_POINT') vertices.push(point(vertex.args[1]));
        }
      }
    }
    faces.push({ surface, vertices, sameSense: entity.args[3]?.includes('T') });
  }

  if (faces.length === 0) return null;

  /* ------------------------------------------------- classifica superficies */

  const holeMap = new Map();
  const roundMap = new Map();
  const cones = [];
  const planes = [];

  for (const face of faces) {
    const { type, args } = face.surface;

    if (type === 'CYLINDRICAL_SURFACE') {
      const place = placement(args[1]);
      const radius = Number(args[2]);
      // Chave pelo eixo: direcao mais o ponto do eixo mais proximo da origem.
      const perpendicular = sub(place.origin, place.axis.map((c) => c * dot(place.origin, place.axis)));
      const key = [...place.axis, ...perpendicular, radius].map((v) => round(v, 2)).join('|');

      // A normal natural do cilindro aponta para fora do eixo. Se a face inverte
      // esse sentido (same_sense = .F.), o material esta do lado de fora: e furo.
      // Se concorda, o material esta dentro: e arredondamento de quina.
      const bucket = face.sameSense ? roundMap : holeMap;
      const entry = bucket.get(key) ?? {
        radius,
        axis: place.axis,
        origin: place.origin,
        span: [Infinity, -Infinity],
      };
      for (const vertex of face.vertices) {
        const t = dot(sub(vertex, place.origin), place.axis);
        entry.span[0] = Math.min(entry.span[0], t);
        entry.span[1] = Math.max(entry.span[1], t);
      }
      bucket.set(key, entry);
    } else if (type === 'CONICAL_SURFACE') {
      cones.push({
        diameter: round(Number(args[2]) * 2, 2),
        angle: round((Number(args[3]) * 180) / Math.PI, 1),
      });
    } else if (type === 'PLANE') {
      planes.push({ ...placement(args[1]), vertices: face.vertices });
    }
  }

  /* ------------------------------------------------------ caixa envolvente */

  const all = faces.flatMap((f) => f.vertices);
  const min = [0, 1, 2].map((a) => Math.min(...all.map((p) => p[a])));
  const max = [0, 1, 2].map((a) => Math.max(...all.map((p) => p[a])));
  const box = { min, max, size: [0, 1, 2].map((a) => round(max[a] - min[a], 2)) };

  /* --------------------------------- espessuras entre planos paralelos */

  const families = new Map();
  for (const plane of planes) {
    // Normais opostas descrevem a mesma familia: canoniza o sentido, senao as
    // duas faces de uma parede aparecem separadas pelo dobro da distancia.
    const flip = plane.axis.find((v) => Math.abs(v) > 1e-6) < 0 ? -1 : 1;
    const normal = plane.axis.map((v) => v * flip);
    const key = normal.map((v) => round(v, 3)).join('|');
    const offset = dot(plane.origin, normal);

    const family = families.get(key) ?? { normal, offsets: [] };
    if (!family.offsets.some((o) => Math.abs(o - offset) < 1e-6)) family.offsets.push(offset);
    families.set(key, family);
  }

  const thicknesses = [];
  for (const family of families.values()) {
    if (family.offsets.length < 2) continue;
    const sorted = [...family.offsets].sort((a, b) => a - b);
    // Guarda tambem onde cada plano esta: sem isso nao da para desenhar a cota.
    const stations = sorted.filter((v, i) => i === 0 || v - sorted[i - 1] > 0.01).map((v) => round(v, 3));
    const gaps = stations.slice(1).map((v, i) => round(v - stations[i], 2));
    if (gaps.length) {
      thicknesses.push({ normal: family.normal.map((v) => round(v, 3)), gaps, stations });
    }
  }

  /* ------------------------------------------------------------- furos */

  const holes = [...holeMap.values()]
    .sort((a, b) => b.radius - a.radius)
    .map((hole, index) => {
      // Distancia do eixo ate cada plano paralelo a ele — as "paredes" do furo.
      const walls = planes
        .filter((p) => Math.abs(dot(p.axis, hole.axis)) < 0.01 && p.vertices.length)
        .map((p) => round(Math.abs(dot(sub(hole.origin, p.origin), p.axis)) - hole.radius, 2))
        .filter((d) => d > 0.01)
        .sort((a, b) => a - b);

      return {
        id: `furo-${index + 1}`,
        diameter: round(hole.radius * 2, 2),
        axis: hole.axis.map((v) => round(v, 4)),
        origin: hole.origin.map((v) => round(v, 3)),
        depth: round(hole.span[1] - hole.span[0], 2),
        span: hole.span.map((v) => round(v, 3)),
        wall: walls[0] ?? null,
        walls: walls.slice(0, 4),
        patternId: null,
      };
    });

  /* -------------------------------------------- padroes lineares de furos */

  const patterns = [];
  const byFamily = new Map();
  for (const hole of holes) {
    const key = [hole.diameter, ...hole.axis.map((v) => round(Math.abs(v), 2))].join('|');
    byFamily.set(key, [...(byFamily.get(key) ?? []), hole]);
  }

  for (const group of byFamily.values()) {
    if (group.length < 3) continue;

    // Direcao em que os centros variam: o eixo de maior dispersao.
    const spread = [0, 1, 2].map((a) => {
      const values = group.map((h) => h.origin[a]);
      return Math.max(...values) - Math.min(...values);
    });
    const along = spread.indexOf(Math.max(...spread));
    if ([0, 1, 2].some((a) => a !== along && spread[a] > 0.05)) continue;   // nao colineares

    const ordered = [...group].sort((a, b) => a.origin[along] - b.origin[along]);
    const stations = ordered.map((h) => h.origin[along]);
    const gaps = stations.slice(1).map((v, i) => round(v - stations[i], 2));
    const pitch = Math.min(...gaps);
    // Aceita falhas: todo vao precisa ser multiplo do passo base.
    if (!gaps.every((g) => Math.abs(g / pitch - Math.round(g / pitch)) < 0.02)) continue;

    const id = `padrao-${patterns.length + 1}`;
    for (const hole of ordered) hole.patternId = id;

    patterns.push({
      id,
      diameter: ordered[0].diameter,
      direction: 'XYZ'[along],
      axisIndex: along,
      count: ordered.length,
      slots: Math.round((stations.at(-1) - stations[0]) / pitch) + 1,
      pitch,
      first: round(stations[0], 3),
      last: round(stations.at(-1), 3),
      length: round(stations.at(-1) - stations[0], 2),
      edgeStart: round(stations[0] - min[along], 2),
      edgeEnd: round(max[along] - stations.at(-1), 2),
      holeIds: ordered.map((h) => h.id),
    });
  }

  /* ------------------------------------------ arredondamentos e chanfros */

  const roundsBySize = new Map();
  for (const entry of roundMap.values()) {
    const radius = round(entry.radius, 2);
    roundsBySize.set(radius, (roundsBySize.get(radius) ?? 0) + 1);
  }
  const rounds = [...roundsBySize.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([radius, count]) => ({ radius, count }));

  const conesBySize = new Map();
  for (const cone of cones) {
    const key = `${cone.diameter}|${cone.angle}`;
    conesBySize.set(key, (conesBySize.get(key) ?? 0) + 1);
  }
  const chamfers = [...conesBySize.entries()].map(([key, count]) => {
    const [diameter, angle] = key.split('|').map(Number);
    return { diameter, angle, count };
  });

  return { faceCount: faces.length, box, thicknesses, holes, patterns, rounds, chamfers };
}

// Nome legivel por omissao, quando o usuario ainda nao renomeou a variavel.
export function defaultName(kind, item) {
  if (kind === 'pattern') return `padrao_${item.diameter}mm_${item.direction.toLowerCase()}`;
  if (kind === 'hole') return `furo_${item.diameter}mm`;
  if (kind === 'thickness') return `espessura_${item.gap}mm`;
  return kind;
}
