// Estiramento prismatico: alonga uma peca sem distorcer o que ela tem.
//
// Escala multiplica todas as coordenadas, entao furo Ø4 vira Ø6,7 e o chanfro
// de 45° deixa de ser 45°. Aqui o que muda e so a posicao: escolhida uma estacao
// de corte ao longo de um eixo, tudo que esta depois dela translada em bloco.
// Para a regiao atravessada pelo corte — que precisa ser prismatica, um perfil
// extrudado — o resultado e exato, nao aproximado.

/**
 * Desloca os vertices alem de `station` em `delta`, ao longo de `axis`.
 * Opera sobre o array de posicoes cru, em coordenadas do CAD.
 */
export function stretchPositions(array, axis, station, delta) {
  for (let i = axis; i < array.length; i += 3) {
    if (array[i] > station) array[i] += delta;
  }
}

/**
 * Estacoes onde um corte romperia alguma feature.
 *
 * Furo paralelo ao eixo do estiramento so fica mais longo — tudo bem. Furo
 * transversal seria rasgado ao meio, entao o intervalo que ele ocupa e proibido.
 */
export function blockedRanges(holes, axis) {
  const ranges = [];

  for (const hole of holes ?? []) {
    const parallel = Math.abs(hole.axis[axis]) > 0.99;
    if (parallel) continue;

    // O furo transversal ocupa, ao longo do eixo do estiramento, o seu diametro.
    const half = hole.diameter / 2;
    ranges.push([hole.center[axis] - half, hole.center[axis] + half, `furo Ø${hole.diameter}`]);
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

/**
 * Melhor estacao de corte: o meio do maior vao livre entre features.
 *
 * Preferir o vao mais largo deixa a maior folga possivel dos dois lados, que e
 * o que evita rasgar um furo quando a peca e reprocessada.
 */
export function suggestStation(holes, axis, min, max) {
  const blocked = blockedRanges(holes, axis);
  const middle = (min + max) / 2;
  if (blocked.length === 0) return middle;

  // Junta intervalos que se sobrepoem para achar os vaos de verdade.
  const merged = [];
  for (const [start, end] of blocked) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }

  const gaps = [];
  let cursor = min;
  for (const [start, end] of merged) {
    if (start > cursor) gaps.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < max) gaps.push([cursor, max]);

  if (gaps.length === 0) return middle;
  const widest = gaps.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));
  return (widest[0] + widest[1]) / 2;
}

/**
 * O que o corte atravessa nesta estacao, para avisar antes de aplicar.
 */
export function conflictsAt(holes, axis, station) {
  return blockedRanges(holes, axis)
    .filter(([start, end]) => station > start && station < end)
    .map(([, , label]) => label);
}
