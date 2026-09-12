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

## Ajustar dimensões

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

## Estrutura

```
tools/step2glb.mjs      OpenCascade -> GLB (escreve o container GLB na mão, sem dependências extras)
tools/serve.mjs         servidor estático (GLB e WASM não carregam via file://)
public/app.js           cena, lista de peças, controles, leitura de .step arrastado
public/models/          .glb gerados + manifest.json
public/vendor/three/    three.js r180 (módulo + OrbitControls, GLTFLoader, RoomEnvironment)
public/vendor/occt/     occt-import-js (OpenCascade em WASM)
vendor/PTFE-PETG-examples/  cópia do repositório de origem
```

Peças e arquivos `.step` originais são da Printabot. three.js é MIT;
o OpenCascade usa LGPL-2.1 com exceção de linking (ver `public/vendor/occt/license.occt.txt`).
