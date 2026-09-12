# Visualizador STEP — trilhos lineares PTFE / PETG

Renderizador three.js das peças de [Printabot/PTFE-PETG-examples](https://github.com/Printabot/PTFE-PETG-examples/),
lidas direto dos arquivos `.step` originais.

## Por que não dá para "só ler" o .step

Os arquivos são B-rep ISO-10303-21 (AP214): descrevem as peças como superfícies
analíticas e NURBS (`ADVANCED_FACE`, `CYLINDRICAL_SURFACE`, `B_SPLINE_SURFACE_WITH_KNOTS`…),
não como triângulos. A GPU só desenha triângulos, então alguém precisa tesselar —
e isso é trabalho de kernel CAD, não de parser de texto.

Quem faz isso aqui é o **OpenCascade compilado em WebAssembly**
([occt-import-js](https://github.com/kovacsv/occt-import-js)), usado nas duas pontas:

| | quando | onde |
|---|---|---|
| **Pré-conversão** | `npm run convert` | Node — gera `.glb` para as 15 peças do repositório |
| **Leitura ao vivo** | arrastar um `.step` na janela | navegador — 7 MB de WASM carregados sob demanda |

A pré-conversão existe porque tesselar a peça maior leva ~1,5 s; servida como GLB
ela abre instantaneamente.

## Uso

```sh
npm install
npm run convert     # vendor/PTFE-PETG-examples/**/*.step  ->  public/models/*.glb
npm start           # http://localhost:8777
```

`npm run convert` só precisa rodar de novo se os arquivos `.step` mudarem —
os `.glb` gerados ficam em `public/models/` junto com um `manifest.json`
(grupo, nome, dimensões em mm, contagem de triângulos, arquivo de origem).

## Na interface

- **Clique** numa peça carrega sozinha; **Shift/⌘+clique** soma à cena, cada uma com sua cor.
- **Selecionar grupo** carrega o mecanismo inteiro da peça atual.
- **Montado** usa as coordenadas originais do CAD; **Separado** alinha as peças lado a lado.
- Atalhos: `E` arestas · `W` malha · `B` caixa envolvente · `G` grade · `R` girar · `F` enquadrar.
- **PNG** salva a vista atual.
- Arrastar qualquer `.step` ou `.stp` para a janela abre o arquivo sem passar pela conversão.

## Variáveis reconhecidas

A aba **Variáveis** mostra o que foi possível reconstruir da geometria de qualquer
`.step` — inclusive um arrastado agora, analisado no próprio navegador:

```
PADRÕES DE FUROS
  padrao_3.3_y      6 × Ø3.3
  passo 46 mm ao longo de Y · bordas 10 / 10 mm

FUROS AVULSOS
  furo_4.1mm        2 × Ø4.1
  eixo Y · prof 231,7 mm · parede 2 mm

ESPESSURAS
  espessura_x_1     3,6 mm
```

Cada linha tem um nome editável — clique e digite `distancia_furo_borda`,
`altura_do_perfil`, o que fizer sentido. Os nomes ficam no `localStorage` do
navegador de quem usa: são anotação pessoal sobre a peça, não algo que volte
para o arquivo. Passar o mouse numa linha destaca a feature no 3D.

O reconhecimento cobre plano, cilindro e cone. Duas distinções fazem o resultado
ser confiável: o `same_sense` da face separa cilindro côncavo (furo) de convexo
(arredondamento), e a normal dos planos é canonizada antes de medir espessura.
`tools/inspect-step.mjs <arquivo>` imprime o mesmo relatório no terminal.

## Estirar sem distorcer

Escala multiplica tudo: um trilho de 178 para 300 mm levaria o furo Ø4,1 para
Ø6,9 e o chanfro de 45° deixaria de ser 45°. A aba **Estirar** faz outra coisa —
escolhida uma estação de corte ao longo de um eixo, só o que está depois dela
translada em bloco. Para a região atravessada pelo corte, que precisa ser
prismática, o resultado é exato.

O corte sugerido cai no meio do maior vão livre entre features, para dar a maior
folga possível dos dois lados. Se você mover o corte para cima de um furo
transversal, o painel avisa que essa feature seria rasgada — furo paralelo ao
eixo do estiramento apenas fica mais fundo, e não incomoda.

O trilho de 178 vira 300 mm com perfil, chanfros e diâmetros intactos: o passo
de 40 mm entre os furos continua 40 mm, e só o vão atravessado pelo corte cresce.
O STL exportado já sai estirado.

## Editar o padrão de furos

As variáveis são editadas no próprio painel, cada uma no seu campo:

```
PADRÕES DE FUROS
  padrao_3.3_y                              6 × Ø3.3
  10 + 230 + 10 = 250 mm em Y
  Ø [3,3]  qtd [6]  passo [46]  borda [10]

FUROS AVULSOS
  furo_4.1mm                                2 × Ø4.1
  eixo Y · prof 231,7 mm · parede 2 mm
  Ø [4,1]
```

Um padrão tem quatro variáveis; um grupo de furos avulsos tem o diâmetro, e
mudá-lo vale para os furos daquele diâmetro naquele corpo — que é o que a linha
diz. Editar uma dimensão em **Geral** estira a peça naquele eixo, um estiramento
por eixo, que se compõem. Espessura, canal, arredondamento e chanfro são só
leitura.

O trilho de 6 furos a cada 46 mm vira 12 a cada 20 mm sem sair do navegador, e o
painel avisa quando o padrão não cabe: *"o último furo cai 174 mm além dos
250 mm do corpo"*.

Quem faz isso é o [manifold-3d](https://github.com/elalish/manifold) (529 kB de
WASM): tapar um furo é unir a peça com um cilindro do tamanho exato do vazio,
abrir é subtrair esse cilindro noutro lugar. O escareado coaxial vai junto —
o furo refeito sai com o mesmo chanfro do original.

Cada edição parte da geometria original, nunca do resultado anterior. Voltar aos
parâmetros do arquivo devolve a peça de origem, triângulo por triângulo.

Três coisas que valem saber:

- **A malha precisa ser estanque.** A tesselação do OpenCascade duplica vértices
  na costura entre faces, então `merge()` roda antes de qualquer operação. Sem
  isso o manifold recusa o sólido.
- **Um cilindro de N lados não é um círculo.** A tampa tem que envolver o prisma
  tesselado por fora; se as duas superfícies se cruzarem, cada cruzamento vira
  uma alça — no trilho isso dava genus 151 com o volume saindo certo.
- **Onde um furo novo encosta num antigo**, a aresta da região tapada aparece
  como uma linha fina no modo Arestas. É só o traçado das arestas: a superfície
  em si é contínua, como dá para ver desligando **Arestas**.

Peças com vários corpos no mesmo arquivo (o `MGN9_PETG` é uma chapa com 22) não
entram: a booleana precisa de um sólido só.

## Ajustar dimensões (escala)

O painel inferior direito edita a peça em foco (quando há várias carregadas, um seletor
escolhe qual). Digite a medida desejada em mm em qualquer eixo:

- **Manter proporção** marcado escala os três eixos juntos.
- Desmarcado, estica só o eixo digitado — foi assim que o `PETG_rail` de 178 mm
  virou 300 mm sem engordar o perfil.
- **Tamanho original** volta para 100%.
- **Exportar STL** grava a peça já redimensionada, em STL binário e na orientação
  Z-up do CAD, pronta para o fatiador.

Uma ressalva importante: isto é **escala, não modelagem paramétrica**. Esticar o
comprimento de um trilho também estica os chanfros e recortes das pontas, e escalar
proporcionalmente muda furos, folgas e encaixes na mesma razão — o bloco em 200%
não desliza mais num trilho em 100%. Para mudar só o comprimento mantendo as
tolerâncias, o caminho é o `Tutorial/Tutorial_PETG_linear_rail.f3d` no Fusion.

As peças são rotacionadas de Z-up (convenção CAD) para Y-up (three.js) e assentadas
sobre uma grade de 10 mm. Todas as medidas exibidas estão em milímetros.

## Testes

```sh
npm test
```

Vinte testes sobre as três camadas. Os que importam são os que prendem
invariantes, não valores: **tapar um furo remove exatamente uma alça**
(o genus caiu de 6 para 0 no trilho), **tapar e reabrir no mesmo lugar devolve
o mesmo volume**, **estirar move só o que está depois do corte e só no eixo
escolhido**.

Vale saber por quê. A booleana erra em silêncio: quando a tampa cruzava a parede
tesselada do furo, o volume saía exato e a topologia virava lixo — genus 151 num
trilho que tem 6. Nenhuma inspeção visual pegaria; só olhar genus e volume
juntos pega. Repondo a configuração antiga, 5 dos 6 testes de booleana falham.

## Estrutura

```
tools/step2glb.mjs      OpenCascade -> GLB + sidecar de features, por peça
tools/inspect-step.mjs  o mesmo reconhecimento, no terminal
tools/serve.mjs         servidor estático (GLB e WASM não carregam via file://)
public/lib/step-features.js  reconhecimento de features no B-rep, por corpo
public/lib/stretch.js        estiramento prismático
public/lib/holes.js          booleana de malha sobre manifold-3d
public/app.js           cena, painéis e ligação de tudo
public/models/          .glb + .features.json gerados + manifest.json
public/vendor/three/    three.js r180 (módulo + OrbitControls, GLTFLoader, RoomEnvironment)
public/vendor/occt/     occt-import-js (OpenCascade em WASM)
public/vendor/manifold/ manifold-3d (booleana de malha em WASM)
test/                   node --test sobre as três camadas
vendor/PTFE-PETG-examples/  cópia do repositório de origem
```

Peças e arquivos `.step` originais são da Printabot. three.js é MIT;
o OpenCascade usa LGPL-2.1 com exceção de linking (ver `public/vendor/occt/license.occt.txt`).
