// O reconhecimento é a base de tudo: se ele erra uma cota, a booleana recorta
// no lugar errado e o estiramento corta onde não devia. Estes testes prendem as
// medidas de peças conhecidas e os dois erros que já custaram caro.
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeStep, allHoles, allPatterns } from '../public/lib/step-features.js';
import { readStep } from './helpers.mjs';

const RAIL = 'Longer_rails/PETG_rail_(method_1)/Linear_rail.step';
const BLOCK = 'Linear_mechanism_2/PTFE_block.step';
const MGN9 = 'MGN9_PETG/PETG_linear_rails_MGN9 v3.step';

test('trilho de 250 mm: caixa, padrão e bordas', () => {
  const analysis = analyzeStep(readStep(RAIL));

  assert.equal(analysis.bodies.length, 1);
  assert.deepEqual(analysis.box.size, [22, 250, 11.5]);

  const [pattern] = allPatterns(analysis);
  assert.equal(pattern.diameter, 3.3);
  assert.equal(pattern.count, 6);
  assert.equal(pattern.pitch, 46);
  assert.equal(pattern.direction, 'Y');
  assert.equal(pattern.edgeStart, 10);
  assert.equal(pattern.edgeEnd, 10);

  // As bordas e o passo têm que fechar o comprimento da peça.
  const length = pattern.edgeStart + (pattern.count - 1) * pattern.pitch + pattern.edgeEnd;
  assert.equal(length, analysis.box.size[1]);
});

test('escareado coaxial entra na profundidade do furo', () => {
  // O trecho cilíndrico sozinho dá 1,35 mm; com o escareado, os 3,1 mm da
  // parede. Reabrir o furo pela medida menor faria um rebaixo cego no lugar de
  // um passante — foi assim que o genus parou de subir ao recortar.
  const analysis = analyzeStep(readStep(RAIL));
  const [pattern] = allPatterns(analysis);
  const hole = allHoles(analysis).find((h) => h.id === pattern.holeIds[0]);

  assert.equal(Math.round(hole.depth * 100) / 100, 3.1);
  assert.equal(hole.cones.length, 1);
  // A garganta do cone casa com o raio do furo.
  assert.ok(Math.abs(hole.cones[0].radiusTo - hole.diameter / 2) < 1e-6);
});

test('furos de um padrão só variam na direção do padrão', () => {
  // A `origin` do STEP é um ponto qualquer sobre o eixo do furo: usá-la fazia o
  // detector ver dispersão onde não havia. O centro é a posição com significado.
  const analysis = analyzeStep(readStep(MGN9));
  const pattern = allPatterns(analysis)[0];
  const holes = allHoles(analysis).filter((h) => pattern.holeIds.includes(h.id));

  for (const axis of [0, 1, 2]) {
    const values = holes.map((h) => h.center[axis]);
    const spread = Math.max(...values) - Math.min(...values);
    if (axis === pattern.axisIndex) assert.ok(spread > 1, 'padrão precisa variar no seu eixo');
    else assert.ok(spread < 0.05, `eixo ${axis} não deveria variar (${spread})`);
  }
});

test('cilindro convexo é arredondamento, não furo', () => {
  // Sem o teste de same_sense, um raio de canto R0,4 virava "furo Ø0,8".
  const analysis = analyzeStep(readStep(BLOCK));
  const [body] = analysis.bodies;

  assert.deepEqual(
    body.holes.map((h) => h.diameter).sort((a, b) => b - a),
    [6.6, 4.3, 4.1, 4.1],
  );
  assert.ok(body.rounds.some((r) => r.radius === 0.4));
  assert.ok(!body.holes.some((h) => h.diameter === 0.8));
});

test('espessura é entre planos opostos, não o dobro da distância', () => {
  // Sem canonizar o sentido da normal, as duas faces de uma parede de 14 mm
  // apareciam a 280 mm uma da outra.
  const analysis = analyzeStep(readStep(BLOCK));
  const [body] = analysis.bodies;

  const gapsFor = (axis) =>
    body.thicknesses.find((t) => Math.abs(t.normal[axis]) > 0.9)?.gaps ?? [];

  assert.deepEqual(gapsFor(0), [14]);
  assert.deepEqual(gapsFor(1), [1, 28, 1]);
  assert.deepEqual(gapsFor(2), [8.8]);
});

test('montagem é medida corpo a corpo', () => {
  // Medindo tudo junto, a borda do primeiro furo saía a 260 mm — a caixa da
  // chapa inteira, não a do trilho.
  const analysis = analyzeStep(readStep(MGN9));
  assert.equal(analysis.bodies.length, 22);

  const rail = analysis.bodies[0];
  assert.deepEqual(rail.box.size, [9.8, 251, 6.5]);

  const six = rail.patterns.find((p) => p.diameter === 6);
  assert.equal(six.count, 13);
  assert.equal(six.pitch, 20);
  assert.equal(six.edgeStart, 5.5);
  assert.equal(
    six.edgeStart + (six.count - 1) * six.pitch + six.edgeEnd,
    rail.box.size[six.axisIndex],
  );
});

test('montagem: os corpos são posicionados como na malha', () => {
  // O arquivo define cada corpo no seu próprio sistema e o coloca por
  // ITEM_DEFINED_TRANSFORMATION. Sem seguir essa cadeia, as medidas saem certas
  // e as posições não batem com nada — 423 × 631 × 495 em vez de 159 × 251 × 20.
  const analysis = analyzeStep(readStep(MGN9));
  assert.deepEqual(analysis.box.size, [159.37, 251, 20.03]);

  // E cada furo tem que cair dentro do corpo a que pertence. Canal não conta:
  // as guias laterais do trilho são cilindros côncavos com o eixo fora do
  // material, e é isso que os separa de um furo.
  for (const body of analysis.bodies) {
    for (const hole of body.holes.filter((h) => !h.groove)) {
      for (const axis of [0, 1, 2]) {
        assert.ok(
          hole.center[axis] >= body.box.min[axis] - 0.01 &&
            hole.center[axis] <= body.box.max[axis] + 0.01,
          `${hole.id} fora de ${body.name} no eixo ${axis}`,
        );
      }
    }
  }
});

test('canal lateral não é furo nem entra em padrão', () => {
  const analysis = analyzeStep(readStep(MGN9));
  const rail = analysis.bodies[0];
  const grooves = rail.holes.filter((h) => h.groove);

  // As duas guias do MGN9, uma de cada lado, correndo ao longo do trilho.
  assert.equal(grooves.length, 2);
  assert.ok(grooves.every((g) => Math.abs(g.axis[1]) > 0.99));
  assert.ok(grooves.every((g) => !g.patternId));
});

test('arquivo sem geometria reconhecível devolve null', () => {
  assert.equal(analyzeStep('ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;'), null);
});
