// Confere um deploy contra os arquivos locais.
//
// O modo como isto quebra na prática não é "faltou arquivo": é o servidor
// entregar uma mistura de versões. Um app.js de ontem com o index.html de hoje
// derruba a página inteira, e nada no ar parece errado — todos respondem 200.
// Por isso a comparação é por tamanho, arquivo a arquivo, e não por status.
import fs from 'node:fs';
import path from 'node:path';

const base = (process.argv[2] ?? '').replace(/\/$/, '');
if (!base) {
  console.error('uso: node tools/check-deploy.mjs https://exemplo.com');
  process.exit(1);
}

const ROOT = path.resolve('public');

const EXPECTED_TYPE = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'javascript',
  '.json': 'json',
  '.wasm': 'application/wasm',
};

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const files = walk(ROOT)
  .map((full) => path.relative(ROOT, full).split(path.sep).join('/'))
  .sort();

console.log(`\nConferindo ${files.length} arquivos em ${base}\n`);

const problems = [];

for (const file of files) {
  const local = fs.statSync(path.join(ROOT, file)).size;
  const url = `${base}/${file === 'index.html' ? '' : file}`;

  let response;
  try {
    // identity: sem isto o tamanho recebido é o do corpo comprimido, e a
    // comparação com o arquivo local não diz nada.
    response = await fetch(url, { headers: { 'accept-encoding': 'identity' } });
  } catch (error) {
    problems.push({ file, kind: 'rede', detail: error.message });
    continue;
  }

  if (!response.ok) {
    problems.push({ file, kind: 'ausente', detail: `HTTP ${response.status}` });
    continue;
  }

  const remote = (await response.arrayBuffer()).byteLength;
  if (remote !== local) {
    // Um parâmetro na URL contorna o cache e alcança a origem. Se por ali o
    // arquivo confere, o servidor está certo e quem entrega errado é o cache —
    // que é um problema bem diferente de ter subido arquivo velho.
    const fresh = await fetch(`${url}${url.includes('?') ? '&' : '?'}v=${Date.now()}`, {
      headers: { 'accept-encoding': 'identity' },
    })
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((buffer) => buffer?.byteLength ?? null)
      .catch(() => null);

    problems.push({
      file,
      kind: fresh === local ? 'cache' : 'versão',
      detail: `no ar ${remote} B · local ${local} B`,
    });
  }

  const wanted = EXPECTED_TYPE[path.extname(file)];
  const got = response.headers.get('content-type') ?? '';
  if (wanted && !got.includes(wanted)) {
    problems.push({ file, kind: 'tipo', detail: `${got || 'sem tipo'} · esperado ${wanted}` });
  }
}

if (problems.length === 0) {
  console.log('  Tudo confere: mesmos tamanhos e tipos servidos corretamente.\n');
  process.exit(0);
}

const byKind = new Map();
for (const problem of problems) {
  byKind.set(problem.kind, [...(byKind.get(problem.kind) ?? []), problem]);
}

const EXPLAIN = {
  ausente: 'não chegaram ao servidor',
  versão: 'estão no servidor numa versão diferente da local — o deploy não subiu tudo',
  cache: 'estão certos no servidor, mas o cache entrega versão antiga — precisa purgar',
  tipo: 'chegam com o tipo errado; .wasm fora de application/wasm perde o carregamento em streaming',
  rede: 'não responderam',
};

for (const [kind, list] of byKind) {
  console.log(`  ${list.length} arquivo(s) ${EXPLAIN[kind]}:`);
  for (const problem of list.slice(0, 12)) console.log(`     ${problem.file}  —  ${problem.detail}`);
  if (list.length > 12) console.log(`     … e mais ${list.length - 12}`);
  console.log();
}

process.exit(1);
