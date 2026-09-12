// O estiramento é a operação que promete não distorcer. Estes testes prendem
// essa promessa: nada antes do corte se move, nada fora do eixo muda de tamanho.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stretchPositions, blockedRanges, suggestStation, conflictsAt } from '../public/lib/stretch.js';
import { readFeatures, readGlb, boundingBox } from './helpers.mjs';

const SLUG = 'longer-rails-petg-rail-method-1-linear-rail';
const features = readFeatures(SLUG);
const holes = features.bodies.flatMap((b) => b.holes);
const AXIS = 1;   // comprimento do trilho

test('só os vértices depois do corte se movem', () => {
  const positions = Float32Array.from(readGlb(SLUG).positions);
  const before = Float32Array.from(positions);
  const station = 100;
  const delta = 50;

  stretchPositions(positions, AXIS, station, delta);

  for (let i = 0; i < positions.length; i += 3) {
    const original = before[i + AXIS];
    // fround porque a soma acontece dentro de um Float32Array.
    const expected = original > station ? Math.fround(original + delta) : original;
    assert.equal(positions[i + AXIS], expected);
    // Os outros eixos ficam intactos — é isso que separa estirar de escalar.
    assert.equal(positions[i], before[i]);
    assert.equal(positions[i + 2], before[i + 2]);
  }
});

test('a peça cresce exatamente o delta, e só no eixo escolhido', () => {
  const positions = Float32Array.from(readGlb(SLUG).positions);
  const before = boundingBox(positions);

  stretchPositions(positions, AXIS, 100, 70);
  const after = boundingBox(positions);

  assert.ok(Math.abs(after.size[AXIS] - before.size[AXIS] - 70) < 1e-3);
  assert.ok(Math.abs(after.size[0] - before.size[0]) < 1e-6);
  assert.ok(Math.abs(after.size[2] - before.size[2]) < 1e-6);
});

test('delta zero não toca em nada', () => {
  const positions = Float32Array.from(readGlb(SLUG).positions);
  const before = Float32Array.from(positions);
  stretchPositions(positions, AXIS, 100, 0);
  assert.deepEqual(positions, before);
});

test('furo paralelo ao estiramento não bloqueia; transversal bloqueia', () => {
  const ranges = blockedRanges(holes, AXIS);
  // Os furos Ø4 e Ø4,1 correm ao longo de Y: alongam junto com a peça.
  assert.ok(!ranges.some(([, , label]) => label.includes('4.1')));
  // Os Ø3,3 do padrão atravessam Y: seriam rasgados por um corte em cima deles.
  assert.ok(ranges.some(([, , label]) => label.includes('3.3')));
});

test('a estação sugerida não cai em cima de nenhum furo', () => {
  const { min, max } = features.bodies[0].box;
  const station = suggestStation(holes, AXIS, min[AXIS], max[AXIS]);

  assert.ok(station > min[AXIS] && station < max[AXIS]);
  assert.deepEqual(conflictsAt(holes, AXIS, station), []);
});

test('cortar em cima de um furo é denunciado', () => {
  const hole = holes.find((h) => h.diameter === 3.3);
  const conflicts = conflictsAt(holes, AXIS, hole.center[AXIS]);
  assert.ok(conflicts.length > 0);
  assert.ok(conflicts[0].includes('3.3'));
});

test('sem furos, a sugestão é o meio', () => {
  assert.equal(suggestStation([], AXIS, 0, 250), 125);
});
