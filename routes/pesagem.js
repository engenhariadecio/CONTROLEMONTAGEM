/* ═══════════════════════════════════════════════════════════════════════
   ESTAÇÃO DE PESAGEM
   Um notebook na linha, com a balança e a coletora (leitor de código de
   barras) ligadas por USB. A tela /pesagem lê o peso em tempo real,
   confere com o peso cadastrado no produto da célula e, com o peso certo,
   pede para bipar o número de série. Cada pesagem fica gravada com
   célula, programação (OP), produto, série e peso.

   A balança NÃO pertence a nenhuma célula. Quem liga a pesagem à célula é o
   número de série bipado: só os números contam (JSF0000433645 = 433645) e
   ele é procurado na faixa inicial-final de cada célula que está rodando.
   A contagem de peças pesadas é comparada com a meta e com a cadência (takt)
   da célula. Peso incorreto vira aviso de voz nos tablets dessa célula.
   ═══════════════════════════════════════════════════════════════════════ */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const central = require('./cadenciador-central');

const ONLINE_SEG = 10;
const COOKIE = 'cadc_est';
const DEZ_ANOS = 10 * 365 * 24 * 60 * 60 * 1000;
const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const deviceOk = d => typeof d === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(d);
const texto = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const num = v => { const x = parseFloat(String(v == null ? '' : v).replace(',', '.')); return Number.isFinite(x) ? x : null; };
const arred = x => Math.round(x * 1000) / 1000;
const cookieEm = new Map();
const avisoEm = new Map();        // último aviso de voz "peso incorreto" por célula

/* ─────────────── credencial própria do notebook (fica ligado sem depender de login) ─────────────── */

function credencialDoPedido(req) {
  const h = req.headers || {};
  if (h['x-est-device'] && h['x-est-token']) return { device: String(h['x-est-device']), token: String(h['x-est-token']) };
  const m = /(?:^|;\s*)cadc_est=([^;]+)/.exec(h.cookie || '');
  if (!m) return null;
  let v = m[1]; try { v = decodeURIComponent(v); } catch (e) { /* usa como veio */ }
  const i = v.indexOf('.');
  return i > 0 ? { device: v.slice(0, i), token: v.slice(i + 1) } : null;
}
async function estacaoDaCredencial(req) {
  const c = credencialDoPedido(req);
  if (!c || !deviceOk(c.device) || !/^[a-f0-9]{32,96}$/.test(c.token)) return null;
  const r = await pool.query('SELECT id, device_id FROM cadc_estacoes WHERE device_id=$1 AND token_hash=$2', [c.device, sha(c.token)]);
  return r.rows[0] || null;
}
function gravarCookie(res, device, token) {
  res.cookie(COOKIE, `${device}.${token}`, {
    maxAge: DEZ_ANOS, httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/'
  });
}
/** Deixa passar quem está logado (menos o perfil PCP) OU um notebook com credencial válida. */
async function estacaoOuSessao(req, res, next) {
  if (req.session && req.session.userId) return next();
  try {
    const e = await estacaoDaCredencial(req);
    if (e) { req.estCred = e; return next(); }
  } catch (e) { console.error('pesagem credencial', e.message); return res.status(503).json({ error: 'Servidor indisponível, tentando de novo' }); }
  if ((req.originalUrl || '').startsWith('/api/')) return res.status(401).json({ error: 'Estação sem autorização. Faça o login uma vez neste computador.' });
  return res.redirect('/login');
}
const mesmaEstacao = (req, deviceId) =>
  !!(req.session && req.session.userId) || !!(req.estCred && req.estCred.device_id === deviceId);

async function garantirCredencial(req, res, estId, deviceId) {
  const atual = req.estCred || await estacaoDaCredencial(req);
  if (atual && atual.device_id === deviceId) {
    const semCookie = !/(?:^|;\s*)cadc_est=/.test(req.headers.cookie || '');
    if (semCookie || Date.now() - (cookieEm.get(deviceId) || 0) > 24 * 60 * 60 * 1000) {
      const c = credencialDoPedido(req);
      if (c) { gravarCookie(res, deviceId, c.token); cookieEm.set(deviceId, Date.now()); }
    }
    return null;
  }
  if (!(req.session && req.session.userId)) return null;
  const r = await pool.query(
    `SELECT (token_em IS NOT NULL AND token_em > NOW() - INTERVAL '60 seconds') AS recente FROM cadc_estacoes WHERE id=$1`, [estId]);
  if (r.rows[0] && r.rows[0].recente) return null;
  const token = crypto.randomBytes(24).toString('hex');
  await pool.query('UPDATE cadc_estacoes SET token_hash=$2, token_em=NOW() WHERE id=$1', [estId, sha(token)]);
  gravarCookie(res, deviceId, token);
  return token;
}

/* ─────────────── regras de peso e de número de série ─────────────── */

/** Faixa de peso aceita para o produto: { padrao, tol, min, max } ou null se o produto não tem peso cadastrado. */
function faixaDoProduto(prod) {
  const padrao = prod && prod.peso_kg > 0 ? Number(prod.peso_kg) : null;
  if (!padrao) return null;
  // sem tolerância cadastrada: 2 % do peso, no mínimo 50 g
  const tol = prod.peso_tol_kg != null && prod.peso_tol_kg >= 0 ? Number(prod.peso_tol_kg) : Math.max(0.05, arred(padrao * 0.02));
  return { padrao, tol, min: arred(padrao - tol), max: arred(padrao + tol) };
}
const limparSerie = v => String(v == null ? '' : v).trim().toUpperCase().replace(/\s+/g, '');

/** Só os números da série contam: "JSF0000433645" → 433645. null se não houver número. */
function numeroDaSerie(serie) {
  const d = String(serie == null ? '' : serie).replace(/\D/g, '');
  if (!d) return null;
  const n = Number(d.slice(-15));
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * A balança não pertence a nenhuma célula: quem diz de qual célula é a peça é o número de série.
 * Procura a programação cuja faixa (série inicial → final) contém o número bipado.
 * Vale primeiro a que está rodando; depois a que já encerrou e ainda não foi enviada ao Plano.
 * Devolve { ordem } | { programada } (ainda não começou) | {} (nenhuma célula tem essa série).
 */
async function ordemDaSerie(n) {
  const r = await pool.query(
    `SELECT o.id, o.celula_id, o.celula_nome, o.status, o.produto_id, o.num_op, o.cod_decio, o.turno_id,
            o.serie_inicial, o.serie_final, o.meta::float AS meta, to_char(o.data,'YYYY-MM-DD') AS dia,
            COALESCE(p.nome, o.produto_nome) AS produto_nome, p.cod_decio AS p_cod,
            p.peso_kg::float AS peso_kg, p.peso_tol_kg::float AS peso_tol_kg,
            (c.id IS NOT NULL) AS rodando, COALESCE(cc.usa_balanca, FALSE) AS usa_balanca, cc.modo_contagem AS modo
       FROM cadc_ordens o
       LEFT JOIN cad_produtos p ON p.id = o.produto_id
       LEFT JOIN cadc_celulas c ON c.ordem_id = o.id
       LEFT JOIN cadc_celulas cc ON cc.id = COALESCE(c.id, o.celula_id)
      WHERE COALESCE(o.serie_inicial,'') <> ''
        AND (o.status IN ('ativa','programada') OR (o.status = 'encerrada' AND o.data >= CURRENT_DATE - 7)
             OR (o.status = 'concluida' AND o.data >= CURRENT_DATE - 2))     -- peça que chegou na balança logo depois da troca de produto
      ORDER BY COALESCE(cc.usa_balanca, FALSE) DESC, (c.id IS NOT NULL) DESC, (o.status = 'ativa') DESC, (o.status = 'encerrada') DESC, o.data DESC, o.id DESC`);
  let programada = null, semBalanca = null;
  for (const o of r.rows) {
    const a = numeroDaSerie(o.serie_inicial), b = numeroDaSerie(o.serie_final);
    if (a == null) continue;
    const ini = b == null ? a : Math.min(a, b), fim = b == null ? a : Math.max(a, b);
    if (n < ini || n > fim) continue;
    if (o.status === 'programada') { programada = programada || o; continue; }
    if (!o.usa_balanca) { semBalanca = semBalanca || o; continue; }      // célula não marcada para usar a balança
    return { ordem: o };
  }
  return programada ? { programada } : semBalanca ? { semBalanca } : {};
}

async function contagem(ordemId) {
  if (!ordemId) return { ok: 0, nok: 0 };
  const r = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE ok IS NOT FALSE)::int AS ok, COUNT(*) FILTER (WHERE ok = FALSE)::int AS nok
       FROM cadc_pesagens WHERE ordem_id=$1`, [ordemId]);
  return r.rows[0];
}
/** Últimas pesagens feitas nesta estação (de qualquer célula). */
async function ultimas(estacaoId, n = 12) {
  return (await pool.query(
    `SELECT id, serie, peso_kg::float AS peso_kg, ok, celula_nome, produto_nome,
            to_char(criado_em AT TIME ZONE '${central.FUSO}', 'HH24:MI:SS') AS hora
       FROM cadc_pesagens WHERE estacao_id=$1 AND criado_em > NOW() - INTERVAL '18 hours'
      ORDER BY id DESC LIMIT $2`, [estacaoId, n])).rows.map(x => ({ ...x, id: Number(x.id) }));
}

async function estacaoDoPedido(req, deviceId) {
  if (!deviceOk(deviceId)) { const e = new Error('Identificação da estação inválida'); e.status = 400; throw e; }
  if (!mesmaEstacao(req, deviceId)) { const e = new Error('Estação sem autorização'); e.status = 401; throw e; }
  return (await pool.query('SELECT * FROM cadc_estacoes WHERE device_id=$1', [deviceId])).rows[0] || null;
}
const falha = (res, e, onde) => {
  if (!e.status) console.error('pesagem ' + onde, e);
  res.status(e.status || 500).json({ error: e.message });
};

/* ═════════════════════ TELA DO NOTEBOOK ═════════════════════ */

/* GET /estado?device_id=&nome=&balanca=0|1&peso= — tudo o que a tela precisa, consultado a cada 2 s.
   Traz TODAS as células que estão rodando (a estação não é de nenhuma delas). */
router.get('/estado', estacaoOuSessao, async (req, res) => {
  try {
    const { device_id } = req.query;
    let est = await estacaoDoPedido(req, device_id);
    const logado = !!(req.session && req.session.userId);
    const peso = num(req.query.peso);
    if (!est) {
      const nome = texto(req.query.nome, 120) || ('Balança ' + device_id.slice(-4).toUpperCase());
      est = (await pool.query(
        `INSERT INTO cadc_estacoes (device_id, nome, usuario, visto_em) VALUES ($1,$2,$3,NOW())
         ON CONFLICT (device_id) DO UPDATE SET visto_em=NOW() RETURNING *`,
        [device_id, nome, logado ? req.session.username || null : null])).rows[0];
    } else {
      await pool.query(
        `UPDATE cadc_estacoes SET visto_em=NOW(), balanca_ok=$2, ultimo_peso=$3, usuario=COALESCE($4, usuario) WHERE id=$1`,
        [est.id, req.query.balanca === '1', peso != null && Math.abs(peso) < 100000 ? arred(peso) : null,
         logado ? req.session.username || null : null]);
    }
    const token = await garantirCredencial(req, res, est.id, device_id);
    const celulas = (await central.carregarCelulas()).filter(c => !c.ociosa && c.usa_balanca).map(c => {
      delete c.marcas; delete c.anteriores; delete c.mensagem; delete c.saidas;
      c.faixa = c.modo_contagem === 'pesar' ? faixaDoProduto(c.produto) : null;
      return c;
    });
    res.json({ ...central.relogio(), ...(token ? { token } : {}),
               estacao: { id: est.id, nome: est.nome }, celulas, ultimas: await ultimas(est.id) });
  } catch (e) { falha(res, e, 'estado'); }
});

/* POST /estacao  body: { device_id, nome } — o notebook muda o próprio nome */
router.post('/estacao', estacaoOuSessao, async (req, res) => {
  try {
    const b = req.body || {};
    const est = await estacaoDoPedido(req, b.device_id);
    if (!est) return res.status(404).json({ error: 'Estação ainda não registrada' });
    if (b.nome != null && texto(b.nome, 120)) await pool.query('UPDATE cadc_estacoes SET nome=$2 WHERE id=$1', [est.id, texto(b.nome, 120)]);
    res.json({ success: true });
  } catch (e) { falha(res, e, 'estacao'); }
});

async function gravar(est, o, req, { serie, n, peso, ok, f }) {
  const r = await pool.query(
    `INSERT INTO cadc_pesagens (celula_id, celula_nome, ordem_id, produto_id, produto_nome, cod_decio, num_op, serie, serie_num,
                                peso_kg, peso_padrao, tolerancia, ok, data, turno_id, estacao_id, estacao_nome, usuario)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING id, to_char(criado_em AT TIME ZONE '${central.FUSO}', 'HH24:MI:SS') AS hora`,
    [o.celula_id, o.celula_nome, o.id, o.produto_id, o.produto_nome, o.cod_decio || o.p_cod || null, o.num_op || null, serie, n,
     peso == null ? null : arred(peso), f ? f.padrao : null, f ? f.tol : null, ok, o.dia, o.turno_id, est.id, est.nome,
     (req.session && (req.session.nome || req.session.username)) || est.usuario || null]);
  return r.rows[0];
}

/*
 * POST /registrar  body: { device_id, serie, peso_kg }
 * O número de série diz de qual célula é a peça. O peso é conferido com o produto dessa célula:
 *   certo  → grava e conta para a célula;
 *   errado → grava como "peso incorreto" (não conta) e o tablet da célula fala "Peso incorreto".
 */
router.post('/registrar', estacaoOuSessao, async (req, res) => {
  try {
    const b = req.body || {};
    const est = await estacaoDoPedido(req, b.device_id);
    if (!est) return res.status(404).json({ error: 'Estação ainda não registrada' });
    // peso vazio = bipou sem nada (parado) na balança: só vale para célula no modo "só bipar"
    let peso = b.peso_kg == null || b.peso_kg === '' ? null : num(b.peso_kg);
    if (peso != null && (peso <= 0 || peso > 99999)) peso = null;
    const serie = limparSerie(b.serie);
    if (!/^[A-Z0-9][A-Z0-9\-_/.]{2,39}$/.test(serie)) return res.status(400).json({ error: 'Código lido não parece um número de série. Bipe de novo.', serie_invalida: true });
    const n = numeroDaSerie(serie);
    if (n == null) return res.status(400).json({ error: `O código ${serie} não tem número. Bipe a etiqueta de série.`, serie_invalida: true });

    const achado = await ordemDaSerie(n);
    if (!achado.ordem) {
      const p = achado.programada;
      if (!p && achado.semBalanca) return res.status(404).json({ sem_celula: true, numero: n,
        error: `Série ${n} é da ${achado.semBalanca.celula_nome}, que está no modo “só takt time” (não conta peça). O administrador muda o modo no cartão da célula.` });
      return res.status(404).json({ sem_celula: true, numero: n, error: p
        ? `Série ${n} é da ${p.celula_nome}, programada para ${p.dia.slice(8, 10)}/${p.dia.slice(5, 7)} — ela ainda não começou a rodar.`
        : `Série ${n} não está na faixa de nenhuma célula. Avise o líder.` });
    }
    const o = achado.ordem;
    const soBipe = o.modo === 'bipar';               // célula que só bipa: não confere (nem guarda) peso
    if (soBipe) peso = null;
    const f = soBipe ? null : faixaDoProduto(o);
    const info = { celula: o.celula_nome, celula_id: o.celula_id, produto: o.produto_nome, num_op: o.num_op, serie, numero: n,
                   peso_kg: peso == null ? null : arred(peso), faixa: f, so_bipe: soBipe };

    // já contada? (mesmo número na mesma programação, ou a mesma etiqueta em qualquer lugar)
    const ja = (await pool.query(
      `SELECT celula_nome, to_char(criado_em AT TIME ZONE '${central.FUSO}', 'DD/MM HH24:MI') AS quando
         FROM cadc_pesagens WHERE ok IS NOT FALSE AND ((ordem_id=$1 AND serie_num=$2) OR serie=$3) LIMIT 1`, [o.id, n, serie])).rows[0];
    if (ja) return res.status(409).json({ ...info, duplicada: true, error: `Série ${n} já foi registrada (${ja.quando}, ${ja.celula_nome}). Não contou de novo.` });
    if (!soBipe && peso == null) return res.status(400).json({ ...info, falta_peso: true,
      error: `A ${o.celula_nome} confere o peso: coloque o produto na balança, espere o peso parar e bipe de novo.` });

    if (f && (peso < f.min - 1e-9 || peso > f.max + 1e-9)) {
      const linha = await gravar(est, o, req, { serie, n, peso, ok: false, f });
      let falou = false;
      if (o.celula_id && Date.now() - (avisoEm.get(o.celula_id) || 0) > 4000) {     // não fala um aviso em cima do outro
        avisoEm.set(o.celula_id, Date.now());
        await central.comando(o.celula_id, { texto: 'Peso incorreto', origem: 'balanca', por: est.nome });
        falou = true;
      }
      return res.status(422).json({ ...info, incorreto: true, falou, hora: linha.hora, diferenca: arred(peso - f.padrao),
        error: 'Peso incorreto', contagem: await contagem(o.id), ultimas: await ultimas(est.id) });
    }

    let linha;
    try { linha = await gravar(est, o, req, { serie, n, peso, ok: f ? true : null, f }); }
    catch (e) {
      if (e.code !== '23505') throw e;
      return res.status(409).json({ ...info, duplicada: true, error: `Série ${n} já foi registrada. Não contou de novo.` });
    }
    res.json({ success: true, ...info, id: Number(linha.id), hora: linha.hora, conferido: !!f && !soBipe,
               contagem: await contagem(o.id), ultimas: await ultimas(est.id) });
  } catch (e) { falha(res, e, 'registrar'); }
});

/* ═════════════════════ ADMINISTRADOR ═════════════════════ */

/* GET /admin/lista?celula_id=&ordem_id=&dia=&de=&ate=&serie= — pesagens gravadas */
router.get('/admin/lista', requireAdmin, async (req, res) => {
  try {
    const q = req.query, cond = [], p = [];
    const DATA = /^\d{4}-\d{2}-\d{2}$/;
    if (q.ordem_id) { p.push(Number(q.ordem_id)); cond.push(`g.ordem_id=$${p.length}`); }
    if (q.celula_id) { p.push(Number(q.celula_id)); cond.push(`g.celula_id=$${p.length}`); }
    if (DATA.test(q.dia || '')) { p.push(q.dia); cond.push(`g.data=$${p.length}`); }
    if (DATA.test(q.de || '')) { p.push(q.de); cond.push(`g.data>=$${p.length}`); }
    if (DATA.test(q.ate || '')) { p.push(q.ate); cond.push(`g.data<=$${p.length}`); }
    if (q.serie) { p.push('%' + limparSerie(q.serie) + '%'); cond.push(`g.serie LIKE $${p.length}`); }
    const r = await pool.query(
      `SELECT g.id, g.celula_id, g.celula_nome, g.ordem_id, g.produto_nome, g.cod_decio, g.num_op, g.serie,
              g.peso_kg::float AS peso_kg, g.peso_padrao::float AS peso_padrao, g.tolerancia::float AS tolerancia,
              g.ok, g.fora_faixa, to_char(g.data,'YYYY-MM-DD') AS dia, g.estacao_nome, g.usuario,
              to_char(g.criado_em AT TIME ZONE '${central.FUSO}', 'HH24:MI:SS') AS hora
         FROM cadc_pesagens g ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
        ORDER BY g.id DESC LIMIT 1000`, p);
    res.json(r.rows.map(x => ({ ...x, id: Number(x.id) })));
  } catch (e) { falha(res, e, 'lista'); }
});

/* DELETE /admin/pesagens/:id — apaga uma pesagem lançada errada (a série pode ser pesada de novo) */
router.delete('/admin/pesagens/:id', requireAdmin, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM cadc_pesagens WHERE id=$1', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Pesagem não encontrada' });
    res.json({ success: true });
  } catch (e) { falha(res, e, 'apagar'); }
});

/* PUT /admin/estacoes/:id  body: { nome } — renomeia a estação */
router.put('/admin/estacoes/:id', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const est = (await pool.query('SELECT id FROM cadc_estacoes WHERE id=$1', [req.params.id])).rows[0];
    if (!est) return res.status(404).json({ error: 'Estação não encontrada' });
    if (b.nome != null && texto(b.nome, 120)) await pool.query('UPDATE cadc_estacoes SET nome=$2 WHERE id=$1', [est.id, texto(b.nome, 120)]);
    res.json({ success: true });
  } catch (e) { falha(res, e, 'estacao admin'); }
});

/* DELETE /admin/estacoes/:id — tira o notebook da lista (cancela a credencial dele) */
router.delete('/admin/estacoes/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM cadc_estacoes WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { falha(res, e, 'estacao apagar'); }
});

/* PUT /admin/produtos/:id/peso  body: { peso_kg, peso_tol_kg } — peso padrão do produto (vazio = não confere peso) */
router.put('/admin/produtos/:id/peso', requireAdmin, async (req, res) => {
  try {
    const peso = num(req.body && req.body.peso_kg), tol = num(req.body && req.body.peso_tol_kg);
    if (peso != null && (peso < 0 || peso > 99999)) return res.status(400).json({ error: 'Peso inválido' });
    if (tol != null && (tol < 0 || tol > 99999)) return res.status(400).json({ error: 'Tolerância inválida' });
    const r = await pool.query(
      `UPDATE cad_produtos SET peso_kg=$2, peso_tol_kg=$3, updated_at=NOW() WHERE id=$1
       RETURNING id, nome, peso_kg::float AS peso_kg, peso_tol_kg::float AS peso_tol_kg`,
      [req.params.id, peso > 0 ? arred(peso) : null, peso > 0 && tol != null ? arred(tol) : null]);
    if (!r.rowCount) return res.status(404).json({ error: 'Produto não encontrado' });
    res.json({ ...r.rows[0], faixa: faixaDoProduto(r.rows[0]) });
  } catch (e) { falha(res, e, 'peso produto'); }
});

router.estacaoOuSessao = estacaoOuSessao;
module.exports = router;
