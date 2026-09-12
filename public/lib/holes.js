// Edicao de furos por booleana de malha, com o kernel manifold-3d em WASM.
//
// Tapar um furo e unir a peca com um cilindro do tamanho exato do vazio; abrir
// um furo e subtrair esse cilindro noutro lugar. Manifold exige malha estanque,
// e a tesselacao do OpenCascade duplica vertices na costura entre faces — por
// isso `merge()` antes de qualquer operacao.
//
// Isto opera sobre triangulos, nao sobre B-rep: o furo resultante e um prisma
// de N lados, e um chanfro na boca do furo antigo nao e tapado junto. Para
// saida em STEP o caminho e outro (ver DECISIONS.md).

const SEGMENTS = 48;

let modulePromise = null;

// Resolvido a partir do proprio modulo para o mesmo codigo servir ao navegador
// (http) e ao Node (file), que le do disco e nao entende uma URL file://.
function wasmLocation(file) {
  const url = new URL(`../vendor/manifold/${file}`, import.meta.url);
  return url.protocol === 'file:' ? decodeURIComponent(url.pathname) : url.href;
}

export async function getManifold() {
  if (!modulePromise) {
    modulePromise = import('../vendor/manifold/manifold.js')
      .then((module) => module.default({ locateFile: wasmLocation }))
      .then((wasm) => {
        wasm.setup();
        return wasm;
      });
  }
  return modulePromise;
}

const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

function normalize(v) {
  const length = Math.hypot(...v) || 1;
  return v.map((c) => c / length);
}

// Matriz 4x4 em ordem por colunas, com o eixo do furo na terceira coluna: o
// cilindro do manifold nasce ao longo de Z, entao basta levar Z ate o eixo.
function placement(axis, center) {
  const z = normalize(axis);
  const helper = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const x = normalize(cross(helper, z));
  const y = cross(z, x);
  return [
    x[0], x[1], x[2], 0,
    y[0], y[1], y[2], 0,
    z[0], z[1], z[2], 0,
    center[0], center[1], center[2], 1,
  ];
}

/**
 * Aplica tampas e recortes sobre uma malha, em coordenadas do CAD.
 *
 * `plugs` e `cuts` sao `{ radius, length, axis, center }`. A malha devolvida
 * nao tem normais — quem chama decide como sombrear.
 */
export async function rebuildWithHoles(positions, indices, plugs, cuts) {
  const wasm = await getManifold();
  const { Manifold, Mesh } = wasm;

  const mesh = new Mesh({
    numProp: 3,
    vertProperties: Float32Array.from(positions),
    triVerts: Uint32Array.from(indices),
  });
  mesh.merge();

  const parts = [];
  let solid = new Manifold(mesh);
  parts.push(solid);

  const cylinder = ({ radius, radiusTop = radius, length, axis, center, segments = SEGMENTS }) => {
    // radiusLow fica na ponta -Z do cilindro, que o placement leva ate o inicio
    // do trecho — a mesma ponta de onde `from` e medido.
    const shape = Manifold.cylinder(length, radius, radiusTop, segments, true).transform(
      placement(axis, center),
    );
    parts.push(shape);
    return shape;
  };

  for (const plug of plugs) {
    solid = solid.add(cylinder(plug));
    parts.push(solid);
  }
  for (const cut of cuts) {
    solid = solid.subtract(cylinder(cut));
    parts.push(solid);
  }

  // Uniao de faces coplanares deixa retalhos separados por um degrau
  // submicrometrico — invisivel no solido, mas a EdgesGeometry desenha cada
  // costura dessas como se fosse uma quina. simplify funde o que e plano.
  const merged = solid.simplify(0.001);
  parts.push(merged);

  const result = merged.getMesh();
  const output = {
    positions: Float32Array.from(result.vertProperties),
    indices: Uint32Array.from(result.triVerts),
    volume: merged.volume(),
    genus: merged.genus(),
  };

  // Objetos do WASM nao sao coletados pelo GC do JS.
  for (const part of parts) part.delete?.();

  return output;
}

/**
 * Solidos que descrevem um furo: o cilindro e, quando existe, o escareado ou
 * chanfro coaxial. Serve tanto para tapar o furo onde ele esta (`mode: 'plug'`)
 * quanto para reabri-lo noutra estacao, noutro diametro.
 *
 * Um cilindro de N lados nao e um circulo: o raio inscrito e R·cos(π/N). A
 * tampa precisa envolver o prisma tesselado do furo por fora — se as duas
 * superficies se cruzarem, cada cruzamento vira uma alca, e no trilho isso dava
 * genus +15 por furo tapado, com o volume saindo certo. O corte usa o mesmo
 * ajuste por outro motivo: assim o furo aberto mede o diametro pedido no ponto
 * mais estreito, que e o que importa para passar um parafuso.
 */
export function holeSolids(hole, options = {}) {
  const {
    axisIndex = null,
    station = null,
    diameter = hole.diameter,
    mode = 'cut',
    segments = SEGMENTS,
  } = options;

  const axis = normalize(hole.axis);
  const center = [...hole.center];
  if (axisIndex !== null && station !== null) center[axisIndex] = station;

  // As duas folgas se sobrepoem de proposito. Com 48 lados, o `grow` da tampa
  // ja bastaria para envolver o prisma; com poucos lados, ou com uma tampa
  // justa, e o `cover` que segura. Tirar qualquer um deles reabre o erro do
  // genus — test/holes.test.mjs pega, mas so na combinacao certa.
  const cover = 1 / Math.cos(Math.PI / segments);
  const grow = mode === 'plug' ? 0.01 : 0;
  // O corte avanca alem de cada face para nenhuma tampa ficar exatamente
  // coplanar com a superficie da peca. A tampa nao avanca: ali um excesso
  // viraria saliencia visivel em vez de sumir dentro do material.
  const overshoot = mode === 'plug' ? 0 : 0.05;
  const at = (offset) => center.map((value, i) => value + axis[i] * offset);

  // Mudar o diametro leva o escareado junto: o mesmo deslocamento nos dois
  // raios mantem o angulo do chanfro e faz a garganta casar com o novo furo.
  const delta = (diameter - hole.diameter) / 2;

  const solids = [
    {
      radius: (diameter / 2 + grow) * cover,
      length: hole.depth + 2 * overshoot,
      axis,
      center,
      segments,
    },
  ];

  for (const cone of hole.cones ?? []) {
    // Estender as duas pontas ao longo da propria inclinacao alonga o trecho
    // sem mover a superficie do cone: o solido cresce, a geometria nao muda.
    const slope = (cone.radiusTo - cone.radiusFrom) / (cone.to - cone.from);
    const from = cone.from - overshoot;
    const to = cone.to + overshoot;

    solids.push({
      radius: (cone.radiusFrom - slope * overshoot + delta + grow) * cover,
      radiusTop: (cone.radiusTo + slope * overshoot + delta + grow) * cover,
      length: to - from,
      axis,
      center: at((from + to) / 2),
      segments,
    });
  }

  return solids;
}
