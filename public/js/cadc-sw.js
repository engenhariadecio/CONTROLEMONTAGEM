/* Cadenciador central — guarda a tela do tablet no próprio aparelho.
   Se a internet cair ou o servidor estiver reiniciando na hora em que o tablet
   abrir (ou recarregar) a tela, ela abre assim mesmo com a última versão guardada
   e volta a se atualizar sozinha quando a conexão voltar.
   Sempre tenta a rede primeiro: nunca fica preso numa versão velha. */
const CACHE = 'cadc-tela-v1';
const TELA = '/cadenciador/celula';
const GUARDAR = /^\/(css|js|assets)\//;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

const SEM_REDE = `<!DOCTYPE html><html lang="pt-BR"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cadenciador — sem conexão</title>
<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0A1620;color:#E8F1F6;font:20px system-ui,sans-serif;text-align:center">
<div><div style="font-size:60px">📡</div><p><b>Sem conexão com o servidor</b></p><p style="color:#9DB3C2;font-size:15px">Tentando de novo sozinho a cada 5 segundos…</p></div>
<script>setInterval(function(){fetch('/api/health',{cache:'no-store'}).then(function(r){if(r.ok)location.reload()}).catch(function(){})},5000)</script></body></html>`;

function comPrazo(req, ms) {
  return new Promise((ok, erro) => {
    const t = setTimeout(() => erro(new Error('prazo')), ms);
    fetch(req).then(r => { clearTimeout(t); ok(r); }, e => { clearTimeout(t); erro(e); });
  });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const ehTela = req.mode === 'navigate' && url.pathname === TELA;
  if (!ehTela && !GUARDAR.test(url.pathname)) return;           // API e o resto do site passam direto

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const resp = await comPrazo(req, ehTela ? 7000 : 10000);
      if (ehTela && resp.redirected) return Response.redirect(resp.url, 302);   // ex.: mandou para o login
      if (resp.ok) cache.put(ehTela ? TELA : req, resp.clone()).catch(() => {});
      else if (ehTela && resp.status >= 500) throw new Error('servidor fora');
      return resp;
    } catch (err) {
      const guardado = await cache.match(ehTela ? TELA : req);
      if (guardado) return guardado;
      if (ehTela) return new Response(SEM_REDE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      throw err;
    }
  })());
});
