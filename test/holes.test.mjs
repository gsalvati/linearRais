// A booleana erra em silêncio: o volume sai certo e a topologia sai um lixo.
// Foi assim que o genus chegou a 151 num trilho que tem 6. Por isso estes
// testes olham genus e volume juntos — nenhum dos dois sozinho denuncia o erro.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rebuildWithHoles, holeSolids, getManifold } from '../public/lib/holes.js';
import { readFeatures, readGlb, relative } from './helpers.mjs';

const SLUG = 'longer-rails-petg-rail-method-1-linear-rail';

const features = readFeatures(SLUG);
const { positions, indices } = readGlb(SLUG);
const body = features.bodies[0];
const pattern = body.patterns[0];
const holes = pattern.holeIds.map((id) => body.holes.find((h) => h.id === id));

const stationOf = (index, { pitch = pattern.pitch, edge = pattern.edgeStart } = {}) =>
  body.box.min[pattern.axisIndex] + edge + index * pitch;

const cutsFor = (count, options = {}) =>
  Array.from({ length: count }, (_, index) =>
    holeSolids(holes[0], {
      axisIndex: pattern.axisIndex,
      station: stationOf(index, options),
      diameter: options.diameter ?? pattern.diameter,
    }),
  ).flat();

const plugs = () => holes.flatMap((hole) => holeSolids(hole, { mode: 'plug' }));

// Estado de partida, medido uma vez.
const original = await (async () => {
  const wasm = await getManifold();
  const mesh = new wasm.Mesh({
    numProp: 3,
    vertProperties: Float32Array.from(positions),
    triVerts: Uint32Array.from(indices),
  });
  mesh.merge();
  const solid = new wasm.Manifold(mesh);
  const state = { genus: solid.genus(), volume: solid.volume() };
  solid.delete();
  return state;
})();

test('a malha do OpenCascade só vira sólido depois do merge', async () => {
  // A tesselação duplica vértices na costura entre faces: sem juntar, o
  // manifold recusa o sólido.
  const wasm = await getManifold();
  assert.throws(() => {
    const mesh = new wasm.Mesh({
      numProp: 3,
      vertProperties: Float32Array.from(positions),
      triVerts: Uint32Array.from(indices),
    });
    new wasm.Manifold(mesh);
  }, /manifold/i);

  assert.equal(original.genus, 6);
});

test('tapar os furos remove exatamente uma alça por furo', async () => {
  // O sintoma do dimensionamento errado da tampa: cada furo tapado somava ~15
  // alças em vez de remover uma, com o volume aparentando estar certo.
  const result = await rebuildWithHoles(positions, indices, plugs(), []);
  assert.equal(result.genus, original.genus - pattern.count);
  assert.ok(result.volume > original.volume, 'tapar furo adiciona material');
});

test('tapar e reabrir no mesmo lugar devolve a peça', async () => {
  const result = await rebuildWithHoles(positions, indices, plugs(), cutsFor(pattern.count));

  assert.equal(result.genus, original.genus);
  // A tolerância cobre a diferença entre o prisma tesselado do arquivo e o de
  // 48 lados que a booleana abre: 0,02% no trilho.
  assert.ok(
    relative(result.volume, original.volume) < 0.001,
    `volume ${result.volume} contra ${original.volume}`,
  );
});

test('mudar a quantidade muda o genus na mesma medida', async () => {
  for (const count of [3, 9, 12]) {
    const result = await rebuildWithHoles(positions, indices, plugs(), cutsFor(count, { pitch: 20 }));
    assert.equal(result.genus, original.genus - pattern.count + count, `com ${count} furos`);
  }
});

test('furo maior remove mais material, com o escareado junto', async () => {
  const small = await rebuildWithHoles(positions, indices, plugs(), cutsFor(pattern.count));
  const large = await rebuildWithHoles(
    positions, indices, plugs(), cutsFor(pattern.count, { diameter: 4.3 }),
  );

  assert.equal(large.genus, small.genus, 'mudar diâmetro não muda a topologia');
  assert.ok(large.volume < small.volume, 'Ø4,3 tira mais material que Ø3,3');

  // O cone acompanha o diâmetro, então a diferença é maior que a do cilindro só.
  const cylinderOnly =
    pattern.count * Math.PI * ((4.3 / 2) ** 2 - (3.3 / 2) ** 2) * holes[0].depth;
  assert.ok(small.volume - large.volume > cylinderOnly);
});

test('a tampa envolve o prisma tesselado, não o corta', async () => {
  // Guarda direta contra o erro do raio: se a tampa cruzar a parede do furo,
  // cada cruzamento vira uma alça e o genus dispara.
  const result = await rebuildWithHoles(positions, indices, plugs(), []);
  assert.ok(result.genus <= original.genus, `genus subiu para ${result.genus} ao tapar`);
  assert.equal(result.genus, 0, 'trilho sem furos passantes é genus 0');
});
