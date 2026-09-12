# Decisões e caminhos em aberto

## Por que não há parametrização vinda do arquivo

Os `.step` são B-rep AP214 sem nenhuma intenção de projeto: zero `DIMENSIONAL_SIZE`,
`DIMENSIONAL_LOCATION`, `SHAPE_ASPECT` ou `PARAMETER_VALUE`. São sólidos "burros" —
o Fusion exporta o resultado, nunca a receita.

O `Tutorial/Tutorial_PETG_linear_rail.f3d` é um zip que *contém* a árvore de features
(`DcSketchMetaType`, `DcExtrudeFeatureMetaType`, `DcFilletEdgeFeatureMetaType`,
`DcChamferFeatureMetaType`), mas comprimida em zstd num grafo de objetos proprietário
da Autodesk chaveado por GUIDs. Descomprimido, não há uma única string legível de nome
de parâmetro — o autor usou cotas de sketch sem criar parâmetros de usuário. Reverter
esse formato não é caminho.

Conclusão: a parametrização tem que ser **reconstruída a partir da geometria**, e é o
que `tools/inspect-step.mjs` faz.

## Requisito que orienta as escolhas

O usuário sobe **qualquer** STEP e o sistema apresenta variáveis editáveis: dimensões,
quantidade de furos, distância entre furos, distância do primeiro — redimensionando
partes da peça **sem distorcê-la**.

## O que foi descartado

**Re-modelar as peças como código paramétrico** (Replicad, build123d, CadQuery).
Entregaria parametrização perfeita, mas só funciona para um catálogo conhecido:
não há como re-modelar automaticamente um STEP arbitrário recém-enviado. Morreu
quando o requisito passou a ser "qualquer arquivo".

## Caminhos para aplicar a edição de volta na peça

A leitura das variáveis é independente destes três — vale para qualquer um.

### 1. Edição na malha — FEITO

Estiramento prismático (mover só os vértices além de uma estação de corte) para
redimensionar sem distorcer, e booleana de malha (`manifold-3d`, ~1 MB de WASM)
para mexer em furos.

Entregue na branch `malha/variaveis-e-estiramento`:

- Leitura das variáveis — `public/lib/step-features.js`
- Estiramento prismático — `public/lib/stretch.js`
- Edição do padrão de furos por booleana — `public/lib/holes.js`, sobre
  `manifold-3d` (529 kB de WASM)
- Export STL carregando as três edições

Limites que ficam:

- Saída só em STL. Quem sobe STEP não recebe STEP de volta.
- O furo refeito é um prisma de 48 lados, não um cilindro analítico.
- Onde o furo novo encosta no antigo, a costura da região tapada aparece como
  linha no modo Arestas. A superfície é contínua; é só o traçado.
- Peças com vários corpos no mesmo arquivo ficam de fora — a booleana precisa
  de um sólido só.
- Só padrão linear. Padrão circular ou furo avulso não são editáveis ainda.
- Canal — cilindro côncavo com o eixo fora do material, como a guia lateral de
  um trilho — é reconhecido e listado à parte, mas não é editável.

- A favor: leve, roda no visualizador atual, resposta imediata, nada sai da máquina.
- Contra: saída só em STL. Furo novo vira polígono de N lados, não cilindro.
  Quem sobe STEP não recebe STEP de volta.

### 2. Edição no B-rep com OpenCascade completo — FUTURO

`opencascade.js`, ~35 MB de WASM, com a API de topologia. `BRepAlgoAPI_Defeaturing`
remove um furo e cicatriza a superfície vizinha; booleana exata recorta os novos;
estiramento vira cortar em duas estações, transladar e refundir.

- A favor: CAD de verdade. Furo continua cilindro analítico e o STEP de saída
  abre no Fusion.
- Contra: 35 MB antes do primeiro uso, API C++ crua via bindings, booleanas de
  segundos em peças grandes, maior esforço de implementação dos três.

### 3. Kernel no servidor — FUTURO

FreeCAD/OCCT ou `build123d` em Python num backend.

- A favor: o mais robusto, sem peso no cliente, aguenta peças pesadas, e dá
  reconhecimento de features melhor que um parser próprio.
- Contra: deixa de ser 100% no navegador, precisa hospedagem, e os arquivos do
  usuário passam a sair da máquina dele.

**Gatilho para decidir entre 2 e 3:** quando a saída precisar ser STEP em vez de STL.
Se STL bastar, o caminho 1 fecha o escopo sozinho.

## Limites conhecidos do reconhecimento

Valem para os três caminhos:

- Só plano, cilindro e cone são reconhecidos. Peça com NURBS tem regiões mudas —
  `cover.step` e `Linear_rail.step` têm dezenas.
- ~~Arquivos multi-corpo confundem as medidas de borda~~ — resolvido: o
  analisador segmenta por `MANIFOLD_SOLID_BREP` e mede cada corpo separadamente.
- ~~Montagens ainda não são posicionadas~~ — resolvido: o parser lê entidades
  complexas (`#N = ( A(...) B(...) )`) e compõe a cadeia
  `REPRESENTATION_RELATIONSHIP` → `ITEM_DEFINED_TRANSFORMATION`, seguindo os
  apelidos de `SHAPE_REPRESENTATION_RELATIONSHIP`. A conferência é objetiva: a
  caixa do arquivo passou de 423 × 631 × 495 para 159,37 × 251 × 20,03, que é o
  que a malha mede.
- Furo atravessando superfície curva é bem mais difícil de reposicionar que num plano.
- Rosca modelada vira geometria helicoidal que nenhuma heurística entende.
