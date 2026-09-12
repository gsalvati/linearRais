# Publicar

O conteúdo a servir é a pasta `public/` inteira. Não há build: o que está no
disco é o que roda.

```sh
npm run convert            # se algum .step mudou
npm test                   # 22 testes
npm run check https://seu.dominio    # depois de subir
```

## O jeito de isto quebrar

Todos os arquivos respondem 200, o servidor está certo, e a página abre vazia.

Foi o que aconteceu em 12/09/2026: o navegador recebia o `index.html` novo com um
`app.js` de três commits antes. O JS antigo procurava `hole-count`, um elemento
que o HTML novo não tem mais, e o módulo morria em

```
TypeError: Cannot read properties of null (reading 'addEventListener')
```

antes de montar a lista de peças. Nenhum arquivo faltava, nenhum estava
corrompido — só não eram da mesma versão.

A causa foi o cache. O `app.js` é referenciado pelo nome puro, sem versão na
URL, e vinha com `cache-control: max-age=14400`. Quem tivesse carregado o site
durante o deploy anterior guardava o arquivo velho por até quatro horas, e o
recebia junto com o HTML novo.

**Diagnóstico rápido:** `fetch('app.js')` e `fetch('app.js?x=1')` devolvendo
tamanhos diferentes é a assinatura. O segundo contorna o cache e mostra o que o
servidor realmente tem. É o que o `npm run check` faz, e por isso ele separa
"o servidor está com versão antiga" de "o cache está entregando versão antiga",
que pedem correções diferentes.

## O que configurar

**Não cachear os arquivos de entrada.** `index.html`, `app.js`, `style.css` e
`lib/*.js` referenciam-se pelo nome e precisam chegar sempre na mesma versão:

```
Cache-Control: no-cache
```

`no-cache` não desliga o cache — manda revalidar, então uma resposta 304 continua
barata. O que ele impede é justamente a mistura de versões.

**Cachear longamente o que é pesado e não muda de nome:** `models/` e `vendor/`
somam uns 12 MB e só mudam quando a peça muda. `max-age=31536000` neles é seguro
desde que o purge aconteça a cada deploy.

**Servir `.wasm` como `application/wasm`.** Hoje sai `application/octet-stream`.
O Emscripten cai para o caminho lento quando isso acontece — funciona, mas perde
a compilação em streaming, e são 7,6 MB no caso do OpenCascade.

**Purgar o cache a cada deploy.** No Cloudflare: *Caching → Configuration →
Purge Everything*. Sem isso, as regras acima só valem para quem visita pela
primeira vez.
