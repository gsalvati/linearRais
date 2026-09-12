// CLI sobre public/lib/step-features.js — imprime o que o reconhecimento
// encontrou num .step. Util para conferir arquivos novos fora do visualizador.
import fs from 'node:fs';
import { analyzeStep } from '../public/lib/step-features.js';

const file = process.argv[2];
if (!file) {
  console.error('uso: node tools/inspect-step.mjs <arquivo.step>');
  process.exit(1);
}

const features = analyzeStep(fs.readFileSync(file, 'latin1'));
if (!features) {
  console.error(`${file}: nenhuma face reconhecida`);
  process.exit(1);
}

console.log(`\n${file}`);
console.log(`  ${features.faceCount} faces · caixa ${features.box.size.join(' × ')} mm\n`);

if (features.thicknesses.length) {
  console.log('  planos paralelos (candidatos a espessura / altura):');
  for (const { normal, gaps } of features.thicknesses) {
    console.log(`    eixo ${normal.join(', ')}  ->  ${gaps.join(' / ')} mm`);
  }
}

if (features.patterns.length) {
  console.log('\n  padroes lineares de furos:');
  for (const pattern of features.patterns) {
    const vacant = pattern.slots - pattern.count;
    console.log(
      `    Ø${pattern.diameter} mm · ${pattern.count} furos ao longo de ${pattern.direction}` +
        ` · passo ${pattern.pitch} mm · extensao ${pattern.length} mm` +
        (vacant > 0 ? `  (${vacant} estacao(oes) vaga(s))` : ''),
    );
    console.log(`             bordas: ${pattern.edgeStart} mm no inicio, ${pattern.edgeEnd} mm no fim`);
  }
}

const loose = features.holes.filter((h) => !h.patternId);
if (loose.length) {
  console.log('\n  furos avulsos:');
  for (const hole of loose) {
    const axis = ['X', 'Y', 'Z'][hole.axis.findIndex((v) => Math.abs(v) > 0.9)] ?? 'obliquo';
    console.log(
      `    Ø${hole.diameter} mm · eixo ${axis} · prof ${hole.depth} mm · centro (${hole.origin})` +
        (hole.wall === null ? '' : ` · parede ${hole.wall} mm`),
    );
  }
}

if (features.rounds.length) {
  console.log('\n  arredondamentos (cilindros convexos, nao sao furos):');
  for (const { radius, count } of features.rounds) console.log(`    R${radius} mm × ${count}`);
}

if (features.chamfers.length) {
  console.log('\n  conicas (chanfros / escareados):');
  for (const { diameter, angle, count } of features.chamfers) {
    console.log(`    Ø${diameter} mm · ${angle}° × ${count}`);
  }
}
console.log();
