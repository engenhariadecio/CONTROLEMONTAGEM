/* ═══════════════════════════════════════════════════════════════════════
   CADENCIADOR CENTRAL
   A célula é criada e controlada no PC do administrador
   (ProGestão › Linha de Produção › Cadenciador central).
   Os tablets só se conectam a uma célula e espelham o que o admin define:
   produto, turno, pausa, mensagens e comandos de voz.

   Cada célula roda uma PROGRAMAÇÃO (produto + turno + dia + OP + números de série).
   A programação começa sozinha na hora do turno, preenche a Linha de Produção
   (histórico) e, no fim, é enviada ao Plano de Produção como Apontamento Diário.

   Não usa nem altera nada do cadenciador comum (routes/cadenciador.js).
   ═══════════════════════════════════════════════════════════════════════ */

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { listarTurnos, calcularCiclos, paraSegundos, duracaoTurnoSeg } = require('../lib/turnos');
const { atualizarStatusPlano } = require('./producao');

const FUSO = process.env.TZ_FABRICA || 'America/Sao_Paulo';
const ONLINE_SEG = 10;            // tablet sem dar sinal há mais que isso = offline
const VALIDADE_CMD_SEG = 120;     // comando de voz mais velho que isso não é mais falado

/** Hora da fábrica (HH:MM:SS), independente do fuso do servidor (o Railway roda em UTC). */
function horaFabrica(d = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: FUSO, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(d).replace(/^24/, '00');
}

function offsetNoTurno(hms, turno) {
  let o = paraSegundos(hms) - paraSegundos(turno.hora_inicio);
  if (o < 0) o += 86400;
  return o;
}

/**
 * Relógio oficial: segundos do dia na fábrica, com fração.
 * PC do admin e tablets usam ESTE relógio (não o do aparelho) — por isso
 * o "próximo ciclo" é idêntico em todas as telas.
 */
function relogio() {
  const d = new Date();
  const hora = horaFabrica(d);
  return { hora, hora_seg: paraSegundos(hora) + d.getMilliseconds() / 1000 };
}

/** Segundos do dia (hora da fábrica) de um instante qualquer, com fração. */
function segFabrica(quando) {
  const d = new Date(quando);
  return paraSegundos(horaFabrica(d)) + d.getMilliseconds() / 1000;
}

/** Data da fábrica (AAAA-MM-DD). */
function dataFabrica(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Dia a que o turno em curso pertence: o dia em que ele abriu (turno da noite não "vira" à meia-noite). */
function dataDoTurno(turno) {
  if (!turno) return dataFabrica();
  return dataFabrica(new Date(Date.now() - offsetNoTurno(horaFabrica(), turno) * 1000));
}

const quem = req => req.session.nome || req.session.username || 'admin';
const texto = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

/* Turnos e limite mudam raramente e são lidos a cada consulta de tablet: guarda por 3 s. */
const memo = { turnos: null, turnosEm: 0, limite: 500, limiteEm: 0 };
async function turnosCache() {
  if (!memo.turnos || Date.now() - memo.turnosEm > 3000) {
    memo.turnos = await listarTurnos();
    memo.turnosEm = Date.now();
  }
  return memo.turnos;
}
async function limiteCiclos() {
  if (Date.now() - memo.limiteEm > 3000) {
    const r = await pool.query(`SELECT valor FROM app_config WHERE chave='cad_limite_ciclos'`);
    memo.limite = parseInt(r.rows[0]?.valor || '500', 10) || 500;
    memo.limiteEm = Date.now();
  }
  return memo.limite;
}

/** Assinatura curta de um texto (para saber se a grade de ciclos mudou). */
function assinatura(txt) {
  let h = 5381;
  for (let i = 0; i < txt.length; i++) h = ((h << 5) + h + txt.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/* ─────────────── comandos (voz / recarregar) ─────────────── */

async function comando(celulaId, { tipo = 'voz', texto: t = null, tabletId = null, repetir = 1, origem = 'admin', por = null }) {
  const r = await pool.query(
    `INSERT INTO cadc_comandos (celula_id,tablet_id,tipo,texto,repetir,origem,criado_por)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [celulaId, tabletId, tipo, t, Math.min(3, Math.max(1, parseInt(repetir, 10) || 1)), origem, por]
  );
  // Faxina leve: o histórico de comandos não precisa passar de alguns dias
  if (r.rows[0].id % 50 === 0) {
    pool.query(`DELETE FROM cadc_comandos WHERE criado_em < NOW() - INTERVAL '7 days'`).catch(() => {});
  }
  return r.rows[0].id;
}

/* ─────────────── estado da célula ─────────────── */

const SQL_CELULA = `
  SELECT c.*, p.nome AS produto_nome, p.cod_decio,
         COALESCE(c.takt_manual, tt.takt_min, p.takt_min)::float AS takt_min,
         COALESCE(tt.takt_min, p.takt_min)::float AS takt_cadastro,
         EXTRACT(EPOCH FROM (NOW() - c.pausa_inicio))::int AS pausa_decorrido_seg,
         EXTRACT(EPOCH FROM (c.pausa_fim_prev - NOW()))::int AS pausa_restante_seg,
         to_char(c.rodada_data, 'YYYY-MM-DD') AS rodada_dia,
         o.num_op AS o_num_op, o.serie_inicial AS o_serie_inicial, o.serie_final AS o_serie_final,
         o.meta::float AS o_meta, o.operadores AS o_operadores, o.horas_operador::float AS o_horas,
         o.obs AS o_obs, o.repetir AS o_repetir, o.cod_decio AS o_cod_decio, to_char(o.data,'YYYY-MM-DD') AS o_dia
  FROM cadc_celulas c
  LEFT JOIN cad_produtos p ON p.id = c.produto_id
  LEFT JOIN cad_takt_turno tt ON tt.produto_id = c.produto_id AND tt.turno_id = c.turno_id
  LEFT JOIN cadc_ordens o ON o.id = c.ordem_id`;

/** Quanto da pausa caiu dentro do turno — só esse pedaço empurra os ciclos. */
function pausaDentroDoTurno(turno, inicio, duracaoSeg, inicioOff = 0) {
  if (!turno || !inicio) return 0;
  const dur = duracaoTurnoSeg(turno);
  let a = offsetNoTurno(horaFabrica(new Date(inicio)), turno);
  if (a > dur) a -= 86400;                 // começou antes do turno abrir
  // Antes do ponto onde a contagem (re)começou a pausa não empurra nada
  const A = Math.max(a, 0, inicioOff || 0), B = Math.min(a + duracaoSeg, dur);
  if (B <= A) return 0;
  // Pedaço da pausa que caiu em cima de um intervalo (café, almoço) não conta duas vezes
  let emIntervalo = 0;
  for (const i of (turno.intervalos || [])) {
    const ia = offsetNoTurno(i.hora_inicio, turno), ib = offsetNoTurno(i.hora_fim, turno);
    if (ib > ia) emIntervalo += Math.max(0, Math.min(B, ib) - Math.max(A, ia));
  }
  return Math.max(0, Math.round(B - A - emIntervalo));
}

/**
 * Fecha a pausa aberta da célula. Devolve a duração, ou null se outra consulta
 * já tinha fechado (várias telas consultam ao mesmo tempo — só uma pode somar o tempo).
 */
async function fecharPausa(cel, turno, { noPrevisto = false } = {}) {
  const dur = noPrevisto
    ? Math.max(0, Math.round((new Date(cel.pausa_fim_prev) - new Date(cel.pausa_inicio)) / 1000))
    : Math.max(0, cel.pausa_decorrido_seg || 0);
  const soma = pausaDentroDoTurno(turno, cel.pausa_inicio, dur, cel.inicio_off_seg);

  const r = await pool.query(
    `UPDATE cadc_celulas SET pausada=FALSE, pausa_motivo=NULL, pausa_inicio=NULL, pausa_fim_prev=NULL,
            tempo_parado_seg = tempo_parado_seg + $2, ref_em = NOW(),
            versao = versao + 1, updated_at = NOW()
      WHERE id = $1 AND pausada = TRUE`, [cel.id, soma]);
  if (!r.rowCount) return null;

  await pool.query(
    `UPDATE cadc_paradas SET fim = inicio + ($2 || ' seconds')::interval, duracao_seg = $2::int
      WHERE celula_id = $1 AND fim IS NULL`, [cel.id, String(dur)]);
  return dur;
}

/**
 * Carrega as células já "arrumadas":
 *  - pausa com duração programada que já venceu é encerrada sozinha;
 *  - a programação (início automático, virada do dia de turno) fica por conta do motor().
 */
async function carregarCelulas(filtroId = null) {
  await motor();          // inicia programadas na hora e vira o dia de turno
  const turnos = await turnosCache();
  const porId = new Map(turnos.map(t => [t.id, t]));
  const ler = async () => (await pool.query(
    SQL_CELULA + (filtroId ? ' WHERE c.id = $1' : '') + ' ORDER BY c.nome', filtroId ? [filtroId] : []
  )).rows;

  let linhas = await ler();
  let mudou = false;
  const limite = await limiteCiclos();

  for (const c of linhas) {
    const turno = porId.get(c.turno_id);
    if (c.pausada && c.pausa_fim_prev && c.pausa_restante_seg <= 0) {
      if (await fecharPausa(c, turno, { noPrevisto: true }) != null) {
        await comando(c.id, { texto: 'Pausa encerrada. Ciclo iniciado.', origem: 'auto' });
      }
      mudou = true;
    }
  }
  if (mudou) linhas = await ler();

  // Marcações (concluído / não concluído + motivo) da contagem atual e contagens anteriores do mesmo dia
  const ids = linhas.map(c => c.id);
  const marcas = new Map(), anteriores = new Map();
  if (ids.length) {
    const r = await pool.query(
      `SELECT k.celula_id, k.rodada, k.numero, to_char(k.hora_prevista,'HH24:MI:SS') AS hora, k.produto_nome,
              k.concluido, k.observacao, (k.rodada = c.rodada) AS atual
         FROM cadc_ciclos k JOIN cadc_celulas c ON c.id = k.celula_id
        WHERE k.celula_id = ANY($1::int[]) AND (k.rodada = c.rodada OR k.data = c.rodada_data)
        ORDER BY k.rodada, k.numero`, [ids]);
    for (const k of r.rows) {
      if (k.atual) {
        if (!marcas.has(k.celula_id)) marcas.set(k.celula_id, {});
        marcas.get(k.celula_id)[k.numero] = { c: k.concluido, o: k.observacao || '' };
      } else {
        if (!anteriores.has(k.celula_id)) anteriores.set(k.celula_id, []);
        anteriores.get(k.celula_id).push({ rodada: k.rodada, numero: k.numero, hora: k.hora,
          produto: k.produto_nome, concluido: k.concluido, observacao: k.observacao || '' });
      }
    }
  }

  // Próxima programação de cada célula (aparece no cartão e no tablet quando ela está sem nada rodando)
  const proximas = new Map();
  if (ids.length) {
    const r = await pool.query(SQL_ORDEM + ` WHERE o.status='programada' ORDER BY o.data, o.id`);
    for (const o of r.rows) {
      const k = String(o.celula_nome).toLowerCase();
      if (!proximas.has(k)) proximas.set(k, { id: o.id, dia: o.dia, turno: o.turno_nome, hora: o.turno_inicio, produto: o.prod_nome });
    }
  }

  return linhas.map(c => {
    const e = montarEstado(c, porId.get(c.turno_id), limite);
    e.proxima = proximas.get(String(c.nome).toLowerCase()) || null;
    if (e.proxima) e.sinal += '.' + e.proxima.id;
    e.marcas = marcas.get(c.id) || {};
    e.anteriores = anteriores.get(c.id) || [];
    return e;
  });
}

/**
 * Guarda no histórico os ciclos já encerrados da contagem atual (antes de ela ser reiniciada).
 * Marcações que o admin já fez são preservadas.
 */
async function arquivarRodada(c, turno, limite, { todos = false } = {}) {
  const e = montarEstado(c, turno, limite);
  if (!e.pronto || !e.ciclos.length || !c.rodada_dia) return;
  let encerrados = e.ciclos.map((hora, i) => ({ numero: i + 1, hora }));
  if (!todos) {
    const o = offsetNoTurno(horaFabrica(), turno);
    if (o <= duracaoTurnoSeg(turno)) encerrados = encerrados.filter(x => offsetNoTurno(x.hora, turno) <= o);
  }
  if (!encerrados.length) return;
  await pool.query(
    `INSERT INTO cadc_ciclos (celula_id, rodada, numero, data, hora_prevista, produto_nome)
     SELECT $1, $2, x.numero, $3::date, x.hora::time, $4
       FROM unnest($5::int[], $6::text[]) AS x(numero, hora)
     ON CONFLICT (celula_id, rodada, numero) DO UPDATE
        SET hora_prevista = EXCLUDED.hora_prevista, produto_nome = EXCLUDED.produto_nome`,
    [c.id, c.rodada, c.rodada_dia, c.produto_nome, encerrados.map(x => x.numero), encerrados.map(x => x.hora)]);
}

/** Arquiva a contagem atual de uma célula (usado antes de trocar produto/takt ou reiniciar). */
async function arquivarAtual(id) {
  const c = (await pool.query(SQL_CELULA + ' WHERE c.id=$1', [id])).rows[0];
  if (!c) return;
  const turno = (await turnosCache()).find(t => t.id === c.turno_id);
  if (turno) await arquivarRodada(c, turno, await limiteCiclos());
}

function montarEstado(c, turno, limite) {
  // Sem programação rodando, a célula fica parada esperando a próxima
  const pronto = !!(c.ordem_id && turno && c.produto_id && c.takt_min > 0);
  const ordem = c.ordem_id ? {
    id: c.ordem_id, dia: c.o_dia, num_op: c.o_num_op, serie_inicial: c.o_serie_inicial, serie_final: c.o_serie_final,
    meta: c.o_meta, operadores: c.o_operadores, horas_operador: c.o_horas, obs: c.o_obs || '',
    repetir: !!c.o_repetir, cod_decio: c.o_cod_decio
  } : null;
  let ciclos = [];
  if (pronto) {
    ciclos = calcularCiclos(turno, c.takt_min, {
      tempoParadoSeg: (c.inicio_off_seg || 0) + (c.tempo_parado_seg || 0), limite
    }).map(x => x.hora);
  }
  const turnoPub = turno ? {
    id: turno.id, nome: turno.nome, codigo: turno.codigo,
    hora_inicio: turno.hora_inicio, hora_fim: turno.hora_fim,
    intervalos: (turno.intervalos || []).map(i => ({
      nome: i.nome, hora_inicio: i.hora_inicio, hora_fim: i.hora_fim, aviso_voz: i.aviso_voz
    }))
  } : null;
  return {
    id: c.id,
    nome: c.nome,
    versao: c.versao,
    // Muda quando QUALQUER coisa que o tablet mostra muda — inclusive cadastro de turno ou de takt
    sinal: c.versao + '.' + assinatura(JSON.stringify([turnoPub, c.takt_min, c.produto_nome, ciclos.length, ciclos[0], ciclos[ciclos.length - 1], ordem])),
    rodada: c.rodada,
    dia: c.rodada_dia,
    pronto,
    ociosa: !c.ordem_id,
    ordem,
    produto: c.produto_id ? { id: c.produto_id, nome: c.produto_nome, cod_decio: c.cod_decio } : null,
    turno: turnoPub,
    takt_min: c.takt_min,
    takt_cadastro: c.takt_cadastro,
    takt_manual: c.takt_manual != null,
    inicio_off_seg: c.inicio_off_seg || 0,
    tempo_parado_seg: c.tempo_parado_seg || 0,
    pausada: c.pausada,
    pausa_motivo: c.pausa_motivo,
    pausa_decorrido_seg: c.pausada ? Math.max(0, c.pausa_decorrido_seg || 0) : 0,
    pausa_restante_seg: c.pausada && c.pausa_fim_prev ? Math.max(0, c.pausa_restante_seg || 0) : null,
    // Mesmos instantes no relógio oficial: cada tela faz a conta sozinha e todas mostram o mesmo número
    pausa_inicio_seg: c.pausada && c.pausa_inicio ? segFabrica(c.pausa_inicio) : null,
    pausa_fim_seg: c.pausada && c.pausa_fim_prev ? segFabrica(c.pausa_fim_prev) : null,
    voz_ativa: c.voz_ativa,
    mensagem: c.mensagem || '',
    ciclos
  };
}

async function umaCelula(id) {
  return (await carregarCelulas(Number(id)))[0] || null;
}

/* ═════════════════════ PROGRAMAÇÃO (ordens) ═════════════════════
   Cada "ordem" é uma célula rodando um produto em um turno de um dia, com OP e
   faixa de números de série. Fica PROGRAMADA até a hora do turno, vira ATIVA
   sozinha, e no fim é ENVIADA ao Plano de Produção como apontamento diário.     */

const SQL_ORDEM = `
  SELECT o.*, to_char(o.data,'YYYY-MM-DD') AS dia,
         COALESCE(p.nome, o.produto_nome) AS prod_nome,
         COALESCE(o.takt_manual, tt.takt_min, p.takt_min)::float AS takt_min,
         o.meta::float AS meta, o.horas_operador::float AS horas_operador, o.realizado::float AS realizado,
         t.nome AS turno_nome, t.codigo AS turno_codigo,
         to_char(t.hora_inicio,'HH24:MI') AS turno_inicio, to_char(t.hora_fim,'HH24:MI') AS turno_fim
    FROM cadc_ordens o
    LEFT JOIN cad_produtos p ON p.id = o.produto_id
    LEFT JOIN cad_takt_turno tt ON tt.produto_id = o.produto_id AND tt.turno_id = o.turno_id
    LEFT JOIN turnos t ON t.id = o.turno_id`;

const umaOrdem = async id => (await pool.query(SQL_ORDEM + ' WHERE o.id=$1', [id])).rows[0] || null;

const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;
const limparSerie = v => String(v == null ? '' : v).trim().toUpperCase();
const serieOk = s => /^[A-Z0-9]{13}$/.test(s);

function somaDias(iso, n) {
  const [a, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
}
/** Se cair em sábado ou domingo, vai para a segunda-feira. */
function primeiroDiaUtil(iso) {
  const [a, m, d] = iso.split('-').map(Number);
  const sem = new Date(Date.UTC(a, m - 1, d)).getUTCDay();
  return sem === 6 ? somaDias(iso, 2) : sem === 0 ? somaDias(iso, 1) : iso;
}

/** Parte numérica do fim de uma série: { prefixo, numero, casas } ou null. */
function fimNumerico(serie) {
  const m = /^(.*?)(\d+)$/.exec(serie || '');
  return m ? { prefixo: m[1], numero: m[2], casas: m[2].length } : null;
}
/** Quantas peças há entre duas séries (inclusive). null se não der para calcular. */
function qtdEntreSeries(a, b) {
  const x = fimNumerico(a), y = fimNumerico(b);
  if (!x || !y) return null;
  // compara pela parte numérica em comum no fim das duas
  const casas = Math.min(x.casas, y.casas, 15);
  if (a.slice(0, a.length - casas) !== b.slice(0, b.length - casas)) return null;
  const n = Number(b.slice(-casas)) - Number(a.slice(-casas)) + 1;
  return Number.isFinite(n) ? n : null;
}
/** Série seguinte (…0040 → …0041). null se não terminar em número ou estourar as casas. */
function proximaSerie(serie) {
  const f = fimNumerico(serie);
  if (!f) return null;
  const casas = Math.min(f.casas, 15);
  const prox = String(Number(serie.slice(-casas)) + 1);
  if (prox.length > casas) return null;
  return serie.slice(0, serie.length - casas) + prox.padStart(casas, '0');
}

/** Turno no formato do Plano de Produção ('1', '2' ou '3'). */
function turnoDoPlano(turno) {
  if (!turno) return '1';
  const d = String(turno.codigo || '').replace(/\D/g, '');
  if (['1', '2', '3'].includes(d)) return d;
  return ['1', '2', '3'].includes(String(turno.ordem)) ? String(turno.ordem) : '1';
}

/** Quando este turno pode rodar: hoje (se está em andamento) ou no próximo início. */
function proximaOcorrencia(turno) {
  const o = offsetNoTurno(horaFabrica(), turno);
  if (o <= duracaoTurnoSeg(turno)) return { dia: dataDoTurno(turno), emAndamento: true };
  return { dia: dataFabrica(new Date(Date.now() + (86400 - o) * 1000)), emAndamento: false };
}

/** Código Décio do produto: primeiro o do plano da OP, depois o do cadastro do cadenciador. */
async function codDecioDe(numOp, produtoId) {
  if (numOp) {
    const p = await pool.query(`SELECT cod_decio FROM prod_planos WHERE num_op=$1 AND COALESCE(cod_decio,'') <> '' LIMIT 1`, [numOp]);
    if (p.rows[0]) return p.rows[0].cod_decio;
  }
  if (produtoId) {
    const c = await pool.query(`SELECT cod_decio FROM cad_produtos WHERE id=$1 AND COALESCE(cod_decio,'') <> ''`, [produtoId]);
    if (c.rows[0]) return c.rows[0].cod_decio;
  }
  return null;
}

const erro = (status, msg) => Object.assign(new Error(msg), { status });
const numOuNulo = (v, inteiro) => {
  if (v === '' || v == null) return null;
  const n = inteiro ? parseInt(v, 10) : parseFloat(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** Lê e confere os campos de uma programação vindos do formulário. `tem(k)` = campo foi enviado. */
function lerCamposOrdem(b) {
  const tem = k => b[k] !== undefined;
  const c = {};
  if (tem('celula_nome')) {
    c.celula_nome = texto(b.celula_nome, 50);
    if (!c.celula_nome) throw erro(400, 'Informe a célula');
  }
  if (tem('turno_id')) { c.turno_id = Number(b.turno_id) || null; if (!c.turno_id) throw erro(400, 'Escolha o turno'); }
  if (tem('produto_id')) { c.produto_id = Number(b.produto_id) || null; if (!c.produto_id) throw erro(400, 'Escolha o produto'); }
  if (tem('takt_min')) {
    c.takt_manual = b.takt_min === '' || b.takt_min == null ? null : parseFloat(b.takt_min);
    if (c.takt_manual != null && !(c.takt_manual > 0)) throw erro(400, 'Takt deve ser maior que zero');
  }
  if (tem('num_op')) {
    c.num_op = String(b.num_op || '').replace(/\D/g, '') || null;
    if (c.num_op && c.num_op.length !== 8) throw erro(400, 'N° OP deve ter 8 dígitos (ou ficar em branco)');
  }
  for (const k of ['serie_inicial', 'serie_final']) {
    if (!tem(k)) continue;
    c[k] = limparSerie(b[k]) || null;
    if (c[k] && !serieOk(c[k])) throw erro(400, `N° de série ${k === 'serie_inicial' ? 'inicial' : 'final'} deve ter 13 caracteres (letras/números)`);
  }
  if (tem('operadores')) c.operadores = numOuNulo(b.operadores, true);
  if (tem('horas_operador')) c.horas_operador = numOuNulo(b.horas_operador);
  if (tem('meta')) c.meta = numOuNulo(b.meta);
  if (tem('obs')) c.obs = texto(b.obs, 500) || null;
  if (tem('repetir')) c.repetir = !!b.repetir;
  if (tem('tablets')) {
    const ids = (Array.isArray(b.tablets) ? b.tablets : []).map(Number).filter(n => Number.isInteger(n) && n > 0);
    c.tablets = ids.length ? [...new Set(ids)].slice(0, 50) : null;
  }
  if (tem('data')) {
    if (b.data && !DATA_RE.test(b.data)) throw erro(400, 'Data inválida');
    c.data = b.data || null;
  }
  return c;
}

/**
 * Preenche a Linha de Produção (histórico) do dia com o que a célula está rodando —
 * o mesmo registro que antes era digitado na aba "Programação do dia".
 */
async function registrarLinha(o, userId = null, db = pool) {
  try {
    const dia = o.dia || (o.data instanceof Date ? o.data.toISOString().slice(0, 10) : String(o.data).slice(0, 10));
    const turno = (await turnosCache()).find(t => t.id === o.turno_id);
    const nome = String(o.celula_nome).slice(0, 80);
    const cel = (await db.query('SELECT id FROM celulas WHERE nome=$1', [nome])).rows[0];
    let prod = { id: null, cod_decio: o.cod_decio || null, cod_intelbras: null, descricao: o.prod_nome || o.produto_nome || null };
    if (o.cod_decio) {
      const p = (await db.query('SELECT id, cod_decio, cod_intelbras, descricao FROM prod_produtos WHERE cod_decio=$1', [o.cod_decio])).rows[0];
      if (p) prod = p;
    }
    await db.query(
      `INSERT INTO linha_producao
         (data, celula_id, celula_nome, funcionando, produto_id, cod_decio, cod_intelbras, descricao,
          num_op, turno, operadores, horas_operador, meta, obs, registrado_por, updated_at)
       VALUES ($1,$2,$3,TRUE,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
       ON CONFLICT (data, celula_nome) DO UPDATE SET
         celula_id=EXCLUDED.celula_id, funcionando=TRUE, produto_id=EXCLUDED.produto_id,
         cod_decio=EXCLUDED.cod_decio, cod_intelbras=EXCLUDED.cod_intelbras, descricao=EXCLUDED.descricao,
         num_op=EXCLUDED.num_op, turno=EXCLUDED.turno, operadores=EXCLUDED.operadores,
         horas_operador=EXCLUDED.horas_operador, meta=EXCLUDED.meta, obs=EXCLUDED.obs,
         registrado_por=COALESCE(EXCLUDED.registrado_por, linha_producao.registrado_por), updated_at=NOW()`,
      [dia, cel ? cel.id : null, nome, prod.id, prod.cod_decio, prod.cod_intelbras, prod.descricao,
       o.num_op || null, turnoDoPlano(turno), o.operadores, o.horas_operador, o.meta, o.obs || null, userId]);
  } catch (e) { console.error('cadc linha_producao', e.message); }
}

/** Tira a célula de produção (fica "sem programação"), guardando os ciclos já feitos. */
async function soltarCelula(celId, { dia = null } = {}) {
  const c = (await pool.query(SQL_CELULA + ' WHERE c.id=$1', [celId])).rows[0];
  if (!c) return;
  const turno = (await turnosCache()).find(t => t.id === c.turno_id);
  if (turno && c.ordem_id) {
    await arquivarRodada(c, turno, await limiteCiclos(), { todos: !!(dia && c.rodada_dia && c.rodada_dia !== dia) });
  }
  await pool.query(
    `UPDATE cadc_celulas SET ordem_id=NULL, inicio_off_seg=0, tempo_parado_seg=0, ref_em=NULL,
            pausada=FALSE, pausa_motivo=NULL, pausa_inicio=NULL, pausa_fim_prev=NULL,
            rodada=rodada+1, rodada_data=COALESCE($2::date, rodada_data), versao=versao+1, updated_at=NOW()
      WHERE id=$1`, [celId, dia]);
  await pool.query(
    `UPDATE cadc_paradas SET fim=NOW(), duracao_seg=GREATEST(0, EXTRACT(EPOCH FROM (NOW()-inicio))::int)
      WHERE celula_id=$1 AND fim IS NULL`, [celId]);
}

/** Cópia de uma programação para outro dia (repetição ou continuação do que faltou). */
async function clonarOrdem(o, dia, extra = {}) {
  // Se a célula já tem algo programado para esse dia e turno, não programa por cima
  const dup = await pool.query(
    `SELECT id FROM cadc_ordens WHERE lower(celula_nome)=lower($1) AND data=$2 AND turno_id=$3 AND status='programada'`,
    [o.celula_nome, dia, o.turno_id]);
  if (dup.rowCount) return null;
  const r = await pool.query(
    `INSERT INTO cadc_ordens (celula_id, celula_nome, data, turno_id, produto_id, produto_nome, takt_manual, num_op,
                              serie_inicial, serie_final, cod_decio, operadores, horas_operador, meta, obs, repetir,
                              status, origem_id, criado_por, criado_por_id, tablets)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'programada',$17,$18,$19,$20) RETURNING id`,
    [o.celula_id, o.celula_nome, dia, o.turno_id, o.produto_id, o.prod_nome || o.produto_nome, o.takt_manual, o.num_op,
     'serie_inicial' in extra ? extra.serie_inicial : o.serie_inicial,
     'serie_final' in extra ? extra.serie_final : o.serie_final,
     o.cod_decio, o.operadores, o.horas_operador, 'meta' in extra ? extra.meta : o.meta, o.obs,
     'repetir' in extra ? extra.repetir : o.repetir, o.id, o.criado_por, o.criado_por_id, o.tablets || null]);
  return r.rows[0].id;
}

/** Põe uma programação para rodar na célula dela (cria a célula se ainda não existir). */
async function ativarOrdem(o, turno, { por = null, userId = null } = {}) {
  const dia = dataDoTurno(turno);
  const pega = await pool.query(
    `UPDATE cadc_ordens SET status='ativa', iniciada_em=NOW(), data=$2, updated_at=NOW()
      WHERE id=$1 AND status='programada' RETURNING id`, [o.id, dia]);
  if (!pega.rowCount) return false;

  // Começou com o turno já andando: os ciclos contam a partir de agora (não desde a abertura do turno)
  const off = offsetNoTurno(horaFabrica(), turno);
  const inicioOff = off > 120 && off < duracaoTurnoSeg(turno) ? off : 0;

  let cel = (await pool.query(SQL_CELULA + ' WHERE lower(c.nome) = lower($1) ORDER BY c.id LIMIT 1', [o.celula_nome])).rows[0];
  let celId;
  if (!cel) {
    celId = (await pool.query(
      `INSERT INTO cadc_celulas (nome, turno_id, produto_id, takt_manual, rodada_data, ordem_id, inicio_off_seg, ref_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW()) RETURNING id`,
      [o.celula_nome, o.turno_id, o.produto_id, o.takt_manual, dia, o.id, inicioOff])).rows[0].id;
  } else {
    celId = cel.id;
    if (cel.ordem_id) {
      // O que estava rodando sai: fica guardado para ser enviado ao Plano depois
      const turnoAnt = (await turnosCache()).find(t => t.id === cel.turno_id);
      if (turnoAnt) await arquivarRodada(cel, turnoAnt, await limiteCiclos(), { todos: cel.rodada_dia !== dia });
      await pool.query(
        `UPDATE cadc_ordens SET status = CASE WHEN num_op IS NOT NULL THEN 'encerrada' ELSE 'concluida' END,
                encerrada_em = NOW(), updated_at = NOW() WHERE id=$1 AND status='ativa'`, [cel.ordem_id]);
    }
    await pool.query(
      `UPDATE cadc_celulas SET turno_id=$2, produto_id=$3, takt_manual=$4, ordem_id=$5,
              inicio_off_seg=$7, tempo_parado_seg=0, ref_em=NOW(),
              pausada=FALSE, pausa_motivo=NULL, pausa_inicio=NULL, pausa_fim_prev=NULL,
              rodada=rodada+1, rodada_data=$6, versao=versao+1, updated_at=NOW()
        WHERE id=$1`, [celId, o.turno_id, o.produto_id, o.takt_manual, o.id, dia, inicioOff]);
    await pool.query(
      `UPDATE cadc_paradas SET fim=NOW(), duracao_seg=GREATEST(0, EXTRACT(EPOCH FROM (NOW()-inicio))::int)
        WHERE celula_id=$1 AND fim IS NULL`, [celId]);
  }
  await pool.query('UPDATE cadc_ordens SET celula_id=$2 WHERE id=$1', [o.id, celId]);
  // Tablets escolhidos na programação vão sozinhos para a célula — ninguém precisa ir até eles
  if (Array.isArray(o.tablets) && o.tablets.length) {
    await pool.query(
      `UPDATE cadc_tablets SET celula_id=$1, conectado_em=NOW(), pula_cmd=TRUE,
              ultimo_cmd=(SELECT COALESCE(MAX(id),0) FROM cadc_comandos)
        WHERE id = ANY($2::int[]) AND celula_id IS DISTINCT FROM $1`, [celId, o.tablets]);
  }
  await registrarLinha({ ...o, dia }, userId);
  await comando(celId, {
    texto: `Atenção. Nova programação. Produto ${o.prod_nome || ''}.`.replace(' .', '.'), origem: 'auto', por
  });
  return true;
}

/**
 * Motor da programação. Roda sozinho no servidor (mesmo com todas as telas fechadas):
 *  1. virou o dia de turno → a programação de ontem sai da célula (fica pendente de envio, se tem OP)
 *     e, se estava marcada para repetir, já deixa a do próximo dia útil programada;
 *  2. chegou a hora de uma programada → ela começa a rodar.
 */
let motorEm = 0, motorRodando = null;
function motor(forcar = false) {
  if (motorRodando) return motorRodando;
  if (!forcar && Date.now() - motorEm < 3000) return Promise.resolve();
  motorRodando = (async () => {
    try { await motorPasso(); }
    catch (e) { console.error('cadc motor', e); }
    finally { motorEm = Date.now(); motorRodando = null; }
  })();
  return motorRodando;
}

async function motorPasso() {
  const turnos = await turnosCache();
  const porId = new Map(turnos.map(t => [t.id, t]));
  const limite = await limiteCiclos();

  // Programação ativa cuja célula foi apagada não tem mais onde rodar
  await pool.query(`UPDATE cadc_ordens SET status='cancelada', updated_at=NOW() WHERE status='ativa' AND celula_id IS NULL`);

  // 1. virada do dia de turno
  const cels = (await pool.query(SQL_CELULA + ' WHERE c.pausada = FALSE')).rows;
  for (const c of cels) {
    const turno = porId.get(c.turno_id);
    const dia = dataDoTurno(turno);
    if (!c.rodada_dia) {
      await pool.query('UPDATE cadc_celulas SET rodada_data=$2 WHERE id=$1 AND rodada_data IS NULL', [c.id, dia]);
      continue;
    }
    if (c.rodada_dia === dia) continue;
    const pega = await pool.query(
      `UPDATE cadc_celulas SET tempo_parado_seg=0, inicio_off_seg=0, ref_em=NULL, ordem_id=NULL,
              rodada=rodada+1, rodada_data=$2, versao=versao+1, updated_at=NOW()
        WHERE id=$1 AND rodada=$3 RETURNING id`, [c.id, dia, c.rodada]);
    if (!pega.rowCount) continue;
    if (!c.ordem_id) continue;
    if (turno) await arquivarRodada(c, turno, limite, { todos: true });
    const o = await umaOrdem(c.ordem_id);
    if (!o || o.status !== 'ativa') continue;
    await pool.query(
      `UPDATE cadc_ordens SET status=$2, encerrada_em=NOW(), updated_at=NOW() WHERE id=$1 AND status='ativa'`,
      [o.id, o.num_op ? 'encerrada' : 'concluida']);
    if (o.repetir) await clonarOrdem(o, primeiroDiaUtil(dia));
  }

  // 2. programadas que chegaram na hora
  const prog = (await pool.query(SQL_ORDEM + ` WHERE o.status='programada' ORDER BY o.data, o.id`)).rows;
  for (const o of prog) {
    const turno = porId.get(o.turno_id);
    if (!turno || !o.produto_id) continue;
    if (dataDoTurno(turno) >= o.dia) await ativarOrdem(o, turno);
  }
}
// Mesmo sem ninguém com a tela aberta, as células programadas começam na hora
setInterval(() => { motor().catch(() => {}); }, 20000).unref();

/** Cria uma programação. Se o turno já está em andamento no dia pedido, começa a rodar na hora. */
async function criarOrdem(body, req) {
  const c = lerCamposOrdem(body);
  if (!c.celula_nome) throw erro(400, 'Informe a célula');
  if (!c.turno_id || !c.produto_id) throw erro(400, 'Escolha o turno e o produto');
  const turno = (await listarTurnos()).find(t => t.id === c.turno_id);
  if (!turno) throw erro(400, 'Turno inválido');
  const prod = (await pool.query('SELECT id, nome FROM cad_produtos WHERE id=$1', [c.produto_id])).rows[0];
  if (!prod) throw erro(400, 'Produto inválido');

  // Dia: nunca no passado. Turno que já acabou hoje fica para o próximo início dele.
  const oc = proximaOcorrencia(turno);
  let dia = c.data && c.data > oc.dia ? c.data : oc.dia;

  // Uma célula não pode ter duas programações esperando o mesmo dia e turno
  const dup = await pool.query(
    `SELECT id FROM cadc_ordens WHERE lower(celula_nome)=lower($1) AND data=$2 AND turno_id=$3 AND status='programada'`,
    [c.celula_nome, dia, c.turno_id]);
  if (dup.rowCount) throw erro(409, `Já existe uma programação da ${c.celula_nome} para esse dia e turno. Edite a que já existe.`);

  const cod = await codDecioDe(c.num_op, c.produto_id);
  const r = await pool.query(
    `INSERT INTO cadc_ordens (celula_nome, data, turno_id, produto_id, produto_nome, takt_manual, num_op, serie_inicial,
                              serie_final, cod_decio, operadores, horas_operador, meta, obs, repetir, status,
                              criado_por, criado_por_id, tablets)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'programada',$16,$17,$18) RETURNING id`,
    [c.celula_nome, dia, c.turno_id, c.produto_id, prod.nome, c.takt_manual ?? null, c.num_op ?? null,
     c.serie_inicial ?? null, c.serie_final ?? null, cod, c.operadores ?? null, c.horas_operador ?? null,
     c.meta ?? null, c.obs ?? null, !!c.repetir, req ? quem(req) : null, req ? req.session.userId || null : null,
     c.tablets ?? null]);
  memo.turnosEm = 0;
  await motor(true);
  return umaOrdem(r.rows[0].id);
}

/* GET /ordens?status=programada|encerrada|enviada — lista de programações */
router.get('/ordens', requireAdmin, async (req, res) => {
  try {
    const st = String(req.query.status || 'programada');
    const r = await pool.query(SQL_ORDEM + ' WHERE o.status = $1 ORDER BY o.data DESC, o.id DESC LIMIT 200', [st]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* POST /ordens — programa uma célula (agora, próximo turno, amanhã…) */
router.post('/ordens', requireAdmin, async (req, res) => {
  try {
    const o = await criarOrdem(req.body, req);
    let aviso = null;
    if (o.num_op) {
      const pl = await pool.query('SELECT 1 FROM prod_planos WHERE num_op=$1 LIMIT 1', [o.num_op]);
      if (!pl.rowCount) aviso = `A OP ${o.num_op} ainda não está no plano mensal. Cadastre o plano dela antes de enviar a produção.`;
    }
    res.json({ ordem: o, aviso });
  } catch (e) {
    if (e.code === '23503') return res.status(400).json({ error: 'Turno ou produto inválido' });
    res.status(e.status || 500).json({ error: e.message });
  }
});

/*
 * PUT /ordens/:id — edita a programação.
 * Programada: qualquer campo. Ativa: OP, séries, operadores, meta, observação e repetir
 * (produto, turno e takt de quem já está rodando se trocam no cartão da célula).
 */
router.put('/ordens/:id', requireAdmin, async (req, res) => {
  try {
    const o = await umaOrdem(req.params.id);
    if (!o) return res.status(404).json({ error: 'Programação não encontrada' });
    if (!['programada', 'ativa', 'encerrada'].includes(o.status)) return res.status(409).json({ error: 'Esta programação já foi finalizada' });
    const c = lerCamposOrdem(req.body);
    if (o.status !== 'programada') { delete c.celula_nome; delete c.turno_id; delete c.produto_id; delete c.takt_manual; delete c.data; delete c.tablets; }

    if (o.status === 'programada') {
      const turnoId = c.turno_id || o.turno_id;
      const turno = (await listarTurnos()).find(t => t.id === turnoId);
      if (!turno) return res.status(400).json({ error: 'Turno inválido' });
      if (c.data !== undefined || c.turno_id) {
        const oc = proximaOcorrencia(turno);
        const pedido = c.data || o.dia;
        c.data = pedido > oc.dia ? pedido : oc.dia;
      }
      if (c.produto_id) {
        const p = (await pool.query('SELECT nome FROM cad_produtos WHERE id=$1', [c.produto_id])).rows[0];
        if (!p) return res.status(400).json({ error: 'Produto inválido' });
        c.produto_nome = p.nome;
      }
      const dup = await pool.query(
        `SELECT id FROM cadc_ordens WHERE lower(celula_nome)=lower($1) AND data=$2 AND turno_id=$3 AND status='programada' AND id<>$4`,
        [c.celula_nome || o.celula_nome, c.data || o.dia, turnoId, o.id]);
      if (dup.rowCount) return res.status(409).json({ error: 'Já existe outra programação dessa célula para esse dia e turno' });
    }
    if (c.num_op !== undefined || c.produto_id) {
      c.cod_decio = await codDecioDe(c.num_op !== undefined ? c.num_op : o.num_op, c.produto_id || o.produto_id);
    }
    const cols = Object.keys(c);
    if (cols.length) {
      await pool.query(
        `UPDATE cadc_ordens SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at=NOW() WHERE id=$1`,
        [o.id, ...cols.map(k => c[k])]);
    }
    const depois = await umaOrdem(o.id);
    if (depois.status === 'ativa') {
      await registrarLinha(depois, req.session.userId || null);
      if (depois.celula_id) await pool.query('UPDATE cadc_celulas SET versao=versao+1, updated_at=NOW() WHERE id=$1', [depois.celula_id]);
    }
    await motor(true);
    res.json(await umaOrdem(o.id));
  } catch (e) {
    if (e.code === '23503') return res.status(400).json({ error: 'Turno ou produto inválido' });
    res.status(e.status || 500).json({ error: e.message });
  }
});

/* DELETE /ordens/:id — cancela uma programada, ou descarta uma pendente de envio */
router.delete('/ordens/:id', requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE cadc_ordens SET status = CASE status WHEN 'programada' THEN 'cancelada' ELSE 'descartada' END, updated_at=NOW()
        WHERE id=$1 AND status IN ('programada','encerrada') RETURNING id`, [req.params.id]);
    if (!r.rowCount) return res.status(409).json({ error: 'Só dá para cancelar programação que ainda não começou, ou descartar uma pendente' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* POST /ordens/:id/iniciar — começa agora, sem esperar o dia/turno programado */
router.post('/ordens/:id/iniciar', requireAdmin, async (req, res) => {
  try {
    const o = await umaOrdem(req.params.id);
    if (!o) return res.status(404).json({ error: 'Programação não encontrada' });
    if (o.status !== 'programada') return res.status(409).json({ error: 'Esta programação já começou ou foi cancelada' });
    const turno = (await listarTurnos()).find(t => t.id === o.turno_id);
    if (!turno) return res.status(400).json({ error: 'Turno inválido' });
    if (!proximaOcorrencia(turno).emAndamento) {
      return res.status(409).json({ error: `O ${turno.nome} não está em andamento agora. Esta programação começa sozinha quando o turno abrir (${String(turno.hora_inicio).slice(0, 5)}).` });
    }
    await ativarOrdem(o, turno, { por: quem(req), userId: req.session.userId || null });
    res.json(await umaOrdem(o.id));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

/*
 * POST /ordens/:id/finalizar — fim do turno: encerra a célula e envia a produção ao
 * Plano de Produção (vira um Apontamento Diário, igual ao digitado à mão).
 * body: { enviar (padrão true), num_op, serie_inicial, serie_final_real, realizado, meta,
 *         observacoes, data_execucao, continuar }
 */
router.post('/ordens/:id/finalizar', requireAdmin, async (req, res) => {
  const b = req.body || {};
  try {
    const o = await umaOrdem(req.params.id);
    if (!o) return res.status(404).json({ error: 'Programação não encontrada' });
    if (!['ativa', 'encerrada'].includes(o.status)) return res.status(409).json({ error: 'Esta programação não está rodando nem pendente de envio' });
    const enviar = b.enviar !== false;
    const turno = (await listarTurnos()).find(t => t.id === o.turno_id);
    let ap = null;

    if (enviar) {
      const numOp = String(b.num_op !== undefined ? b.num_op : (o.num_op || '')).replace(/\D/g, '');
      const si = limparSerie(b.serie_inicial !== undefined ? b.serie_inicial : o.serie_inicial);
      const sf = limparSerie(b.serie_final_real !== undefined ? b.serie_final_real : o.serie_final);
      const realizado = parseFloat(b.realizado);
      if (numOp.length !== 8) throw erro(400, 'N° OP deve ter exatos 8 dígitos numéricos');
      if (!serieOk(si)) throw erro(400, 'N° de série inicial deve ter exatos 13 caracteres (letras/números)');
      if (!serieOk(sf)) throw erro(400, 'Último n° de série produzido deve ter exatos 13 caracteres (letras/números)');
      if (!(realizado > 0)) throw erro(400, 'Informe a quantidade realizada');
      const plano = (await pool.query('SELECT id, cod_decio, cod_intelbras, descricao FROM prod_planos WHERE num_op=$1 LIMIT 1', [numOp])).rows[0];
      if (!plano) throw erro(400, `OP ${numOp} não cadastrada no plano mensal. Cadastre o plano com essa OP antes de enviar.`);
      const cod = plano.cod_decio || o.cod_decio || await codDecioDe(null, o.produto_id);
      if (!cod) throw erro(400, 'Este produto está sem Código Décio. Preencha o código no plano da OP (Plano de Produção) e envie de novo.');
      const prod = (await pool.query('SELECT * FROM prod_produtos WHERE cod_decio=$1', [cod])).rows[0] || {};
      const dataExec = DATA_RE.test(b.data_execucao || '') ? b.data_execucao : o.dia;
      const meta = numOuNulo(b.meta !== undefined ? b.meta : o.meta) || 0;
      const obs = texto(b.observacoes !== undefined ? b.observacoes : o.obs, 1000) || null;
      ap = { numOp, si, sf, realizado, plano, cod, prod, dataExec, meta, obs };
    }

    // 1. grava o apontamento diário (se algo falhar aqui, nada mais muda)
    let apontamentoId = null;
    if (ap) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const r = await client.query(
          `INSERT INTO prod_apontamentos_detalhados
             (data_execucao, turno, celula, num_op, serie_inicial, serie_final, cod_decio, cod_intelbras, descricao,
              categoria, meta, realizado, hora_reportada_total, observacoes, plano_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
          [ap.dataExec, turnoDoPlano(turno), String(o.celula_nome).slice(0, 50), ap.numOp, ap.si, ap.sf, ap.cod,
           ap.prod.cod_intelbras || ap.plano.cod_intelbras || null,
           ap.prod.descricao || ap.plano.descricao || o.prod_nome || null, ap.prod.categoria || null,
           ap.meta, ap.realizado, (parseFloat(ap.prod.hora_reportado) || 0) * ap.realizado, ap.obs, ap.plano.id]);
        apontamentoId = r.rows[0].id;
        await atualizarStatusPlano(ap.plano.id, client);
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
      finally { client.release(); }
    }

    // 2. a célula para de rodar esta programação
    if (o.status === 'ativa' && o.celula_id) {
      await soltarCelula(o.celula_id);
      await comando(o.celula_id, { texto: 'Produção do turno encerrada.', origem: 'auto', por: quem(req) });
    }

    // 3. situação da programação
    if (ap) {
      await pool.query(
        `UPDATE cadc_ordens SET status='enviada', num_op=$2, serie_inicial=$3, serie_final_real=$4, realizado=$5,
                meta=$6, cod_decio=$7, apontamento_id=$8, enviada_em=NOW(),
                encerrada_em=COALESCE(encerrada_em, NOW()), updated_at=NOW() WHERE id=$1`,
        [o.id, ap.numOp, ap.si, ap.sf, ap.realizado, ap.meta || null, ap.cod, apontamentoId]);
      await registrarLinha({ ...o, dia: ap.dataExec, num_op: ap.numOp, cod_decio: ap.cod, meta: ap.meta || o.meta, obs: ap.obs }, req.session.userId || null);
    } else {
      await pool.query(
        `UPDATE cadc_ordens SET status=$2, encerrada_em=COALESCE(encerrada_em, NOW()), updated_at=NOW() WHERE id=$1`,
        [o.id, b.descartar ? 'descartada' : 'encerrada']);
    }

    // 4. o que faltou continua no próximo dia útil
    let continuacao = null;
    if (ap) {
      const prox = proximaSerie(ap.sf);
      const falta = prox && o.serie_final ? qtdEntreSeries(prox, o.serie_final) : null;
      const sucessora = (await pool.query(
        `SELECT id, serie_inicial FROM cadc_ordens WHERE origem_id=$1 AND status IN ('programada','ativa') ORDER BY id LIMIT 1`, [o.id])).rows[0];
      if (sucessora) {
        // já existia (repetição automática): só acerta de onde ela começa
        if (prox && falta > 0 && (sucessora.serie_inicial || '') === (o.serie_inicial || '')) {
          await pool.query('UPDATE cadc_ordens SET serie_inicial=$2, updated_at=NOW() WHERE id=$1', [sucessora.id, prox]);
        }
        continuacao = sucessora.id;
      } else if (b.continuar) {
        const base = turno && dataDoTurno(turno) > o.dia ? dataDoTurno(turno) : o.dia;
        continuacao = await clonarOrdem({ ...o, num_op: ap.numOp, cod_decio: ap.cod }, primeiroDiaUtil(somaDias(base, 1)),
          falta > 0 ? { serie_inicial: prox, meta: falta } : { serie_inicial: null, serie_final: null });
      }
    }
    await motor(true);
    let aviso = null;
    if (ap && b.continuar && !continuacao) aviso = 'A célula já tinha outra programação para o próximo dia; o que faltou não foi programado de novo.';
    res.json({ success: true, ordem: await umaOrdem(o.id), apontamento_id: apontamentoId,
               continuacao: continuacao ? await umaOrdem(continuacao) : null, aviso });
  } catch (e) {
    if (!e.status) console.error('cadc finalizar', e);
    res.status(e.status || 500).json({ error: e.message });
  }
});

/* ═════════════════════ ADMIN (PC central) ═════════════════════ */

/* GET /api/cadenciador-central/admin/visao — tudo que o painel do admin precisa */
router.get('/admin/visao', requireAdmin, async (_req, res) => {
  try {
    // Faxina: tablet livre que não aparece há mais de 15 dias sai da lista
    if (Date.now() - (memo.faxinaEm || 0) > 10 * 60 * 1000) {
      memo.faxinaEm = Date.now();
      pool.query(`DELETE FROM cadc_tablets WHERE celula_id IS NULL
                   AND COALESCE(visto_em, created_at) < NOW() - INTERVAL '15 days'`).catch(() => {});
    }
    const celulas = await carregarCelulas();
    const tablets = (await pool.query(`
      SELECT t.id, t.nome, t.celula_id, t.usuario, t.som_ok, t.ultimo_cmd, t.conectado_em, t.visto_em,
             EXTRACT(EPOCH FROM (NOW() - t.visto_em))::int AS visto_ha_seg
      FROM cadc_tablets t ORDER BY t.nome NULLS LAST, t.id`)).rows
      .map(t => ({ ...t, ultimo_cmd: Number(t.ultimo_cmd || 0),
                   online: t.visto_ha_seg != null && t.visto_ha_seg <= ONLINE_SEG }));

    const comandos = (await pool.query(`
      SELECT k.id, k.celula_id, c.nome AS celula_nome, k.tablet_id, t.nome AS tablet_nome,
             k.tipo, k.texto, k.origem, k.criado_por, k.criado_em
      FROM cadc_comandos k
      JOIN cadc_celulas c ON c.id = k.celula_id
      LEFT JOIN cadc_tablets t ON t.id = k.tablet_id
      ORDER BY k.id DESC LIMIT 40`)).rows.map(k => ({ ...k, id: Number(k.id) }));

    const hoje = dataFabrica();
    const programadas = (await pool.query(SQL_ORDEM + ` WHERE o.status='programada' ORDER BY o.data, t.hora_inicio, o.celula_nome`)).rows;
    const pendentes = (await pool.query(SQL_ORDEM + ` WHERE o.status='encerrada' ORDER BY o.data DESC, o.id DESC LIMIT 100`)).rows;
    const enviadas = (await pool.query(SQL_ORDEM + ` WHERE o.status='enviada' ORDER BY o.enviada_em DESC LIMIT 12`)).rows;
    // ciclos do dia de cada pendente (para sugerir a quantidade realizada)
    if (pendentes.length) {
      const k = await pool.query(
        `SELECT celula_id, to_char(data,'YYYY-MM-DD') AS dia, COUNT(*) FILTER (WHERE concluido)::int AS ok,
                COUNT(*) FILTER (WHERE NOT concluido)::int AS nok
           FROM cadc_ciclos WHERE celula_id = ANY($1::int[]) GROUP BY celula_id, data`,
        [pendentes.map(o => o.celula_id).filter(Boolean)]);
      for (const o of pendentes) {
        const x = k.rows.find(r => r.celula_id === o.celula_id && r.dia === o.dia);
        o.ciclos_ok = x ? x.ok : 0; o.ciclos_nok = x ? x.nok : 0;
      }
    }
    const ap = (await pool.query(
      `SELECT COALESCE(SUM(realizado),0)::float AS qtd, COUNT(*)::int AS n FROM prod_apontamentos_detalhados WHERE data_execucao=$1`, [hoje])).rows[0];

    res.json({ ...relogio(), hoje, celulas, tablets, comandos, programadas, pendentes, enviadas, apontado: ap });
  } catch (e) { console.error('cadc visao', e); res.status(500).json({ error: e.message }); }
});

/* GET /admin/cadastros — turnos e produtos para os seletores */
router.get('/admin/cadastros', requireAdmin, async (_req, res) => {
  try {
    const turnos = (await listarTurnos({ apenasAtivos: true }))
      .map(t => ({ id: t.id, nome: t.nome, codigo: t.codigo, hora_inicio: t.hora_inicio, hora_fim: t.hora_fim }));
    const produtos = (await pool.query(
      `SELECT id, nome, cod_decio, takt_min::float FROM cad_produtos WHERE ativo = TRUE ORDER BY ordem, nome`)).rows;
    const cels = (await pool.query(
      `SELECT nome, categoria, operadores, horas_operador::float AS horas_operador, turno
         FROM celulas WHERE ativa IS NOT FALSE ORDER BY nome`)).rows;
    // OPs do plano mensal (para escolher na lista) e horas por peça (para a capacidade)
    const planos = (await pool.query(
      `SELECT num_op, cod_decio, COALESCE(descricao, produto) AS descricao, meta::float AS meta,
              realizado::float AS realizado, status, mes
         FROM prod_planos WHERE COALESCE(num_op,'') <> '' ORDER BY (status = 'concluido'), data_limite NULLS LAST, id DESC LIMIT 400`)).rows;
    const horas = (await pool.query(
      `SELECT cod_decio, hora_reportado::float AS hora_reportado FROM prod_produtos WHERE COALESCE(hora_reportado,0) > 0`)).rows;
    res.json({ turnos, produtos, celulas_cadastro: cels.map(c => c.nome), celulas: cels, planos,
               horas_por_peca: Object.fromEntries(horas.map(h => [h.cod_decio, h.hora_reportado])) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* POST /celulas — atalho antigo: cria a célula já com uma programação para agora */
router.post('/celulas', requireAdmin, async (req, res) => {
  try {
    const o = await criarOrdem({ ...req.body, celula_nome: req.body.nome }, req);
    res.json(o.celula_id ? await umaCelula(o.celula_id) : { programada: true, ordem: o });
  } catch (e) {
    if (e.code === '23503') return res.status(400).json({ error: 'Turno ou produto inválido' });
    res.status(e.status || 500).json({ error: e.message });
  }
});

/*
 * PUT /celulas/:id — altera qualquer coisa da célula. Tudo é espelhado nos tablets.
 * body: { nome?, turno_id?, produto_id?, takt_min? ('' volta ao takt do cadastro),
 *         voz_ativa?, mensagem?, reiniciar? (default true ao trocar produto/takt/turno), avisar? }
 */
router.put('/celulas/:id', requireAdmin, async (req, res) => {
  try {
    const antes = await umaCelula(req.params.id);
    if (!antes) return res.status(404).json({ error: 'Célula não encontrada' });
    const b = req.body;
    const sets = [], vals = [];
    const set = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };

    if (b.nome !== undefined) {
      const nome = texto(b.nome, 120);
      if (!nome) return res.status(400).json({ error: 'O nome não pode ficar vazio' });
      set('nome', nome);
    }
    const trocaProduto = b.produto_id !== undefined && Number(b.produto_id) !== (antes.produto?.id || 0);
    const trocaTurno = b.turno_id !== undefined && Number(b.turno_id) !== (antes.turno?.id || 0);
    let trocaTakt = false;
    if (antes.ociosa && (b.produto_id !== undefined || b.turno_id !== undefined || b.takt_min !== undefined)) {
      return res.status(409).json({ error: 'Esta célula está sem programação. Use "Programar" para definir produto e turno.' });
    }

    if (b.produto_id !== undefined) set('produto_id', b.produto_id || null);
    if (b.turno_id !== undefined) set('turno_id', b.turno_id || null);
    if (b.takt_min !== undefined) {
      const takt = b.takt_min === '' || b.takt_min == null ? null : parseFloat(b.takt_min);
      if (takt != null && !(takt > 0)) return res.status(400).json({ error: 'Takt deve ser maior que zero' });
      trocaTakt = (takt == null ? antes.takt_manual : takt !== antes.takt_min);
      set('takt_manual', takt);
    } else if (trocaProduto) {
      set('takt_manual', null);       // produto novo começa com o takt do cadastro dele
    }
    if (typeof b.voz_ativa === 'boolean') set('voz_ativa', b.voz_ativa);
    if (b.mensagem !== undefined) set('mensagem', texto(b.mensagem, 200) || null);

    // Trocou produto/takt no meio do turno: a contagem de ciclos recomeça de agora.
    if ((trocaProduto || trocaTakt || trocaTurno) && b.reiniciar !== false) {
      let off = 0;
      const turnos = await listarTurnos();
      const turno = turnos.find(t => t.id === Number(b.turno_id !== undefined ? b.turno_id : antes.turno?.id));
      if (turno && !trocaTurno) {
        const o = offsetNoTurno(horaFabrica(), turno);
        if (o < duracaoTurnoSeg(turno)) off = o;
      }
      await arquivarAtual(req.params.id);      // os ciclos já feitos ficam no histórico
      if (trocaTurno && turno) set('rodada_data', dataDoTurno(turno));
      set('inicio_off_seg', off);
      set('tempo_parado_seg', 0);
      sets.push('ref_em = NOW()');
      sets.push('rodada = rodada + 1');
    }

    if (!sets.length) return res.json(antes);
    vals.push(req.params.id);
    await pool.query(
      `UPDATE cadc_celulas SET ${sets.join(', ')}, versao = versao + 1, updated_at = NOW()
        WHERE id = $${vals.length}`, vals);
    memo.turnosEm = 0;
    // Renomeou a célula: as programações dela acompanham o nome novo
    if (b.nome !== undefined && texto(b.nome, 120) !== antes.nome) {
      await pool.query(
        `UPDATE cadc_ordens SET celula_nome=$2, updated_at=NOW()
          WHERE status IN ('programada','ativa','encerrada') AND (celula_id=$1 OR lower(celula_nome)=lower($3))`,
        [req.params.id, texto(b.nome, 120), antes.nome]);
    }

    // A programação em andamento acompanha o que foi trocado no cartão, e o histórico do dia também
    if (antes.ordem && (trocaProduto || trocaTurno || b.takt_min !== undefined)) {
      await pool.query(
        `UPDATE cadc_ordens o SET turno_id=c.turno_id, produto_id=c.produto_id, takt_manual=c.takt_manual,
                produto_nome=(SELECT nome FROM cad_produtos WHERE id=c.produto_id),
                data=COALESCE(c.rodada_data, o.data), updated_at=NOW()
           FROM cadc_celulas c WHERE c.id=$1 AND o.id=c.ordem_id`, [req.params.id]);
      const od = await umaOrdem(antes.ordem.id);
      if (od) {
        if (trocaProduto) {
          const cod = await codDecioDe(od.num_op, od.produto_id);
          await pool.query('UPDATE cadc_ordens SET cod_decio=$2 WHERE id=$1', [od.id, cod]);
          od.cod_decio = cod;
        }
        await registrarLinha(od, req.session.userId || null);
      }
    }

    const depois = await umaCelula(req.params.id);
    if (b.avisar !== false && depois) {
      if (trocaProduto && depois.produto) {
        await comando(depois.id, { texto: `Atenção. Produto alterado para ${depois.produto.nome}.`, origem: 'auto', por: quem(req) });
      } else if (trocaTurno && depois.turno) {
        await comando(depois.id, { texto: `Atenção. Turno alterado para ${depois.turno.nome}.`, origem: 'auto', por: quem(req) });
      } else if (trocaTakt) {
        await comando(depois.id, { texto: `Atenção. Tempo de ciclo alterado para ${String(depois.takt_min).replace('.', ' vírgula ')} minutos.`, origem: 'auto', por: quem(req) });
      }
    }
    res.json(depois);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Já existe uma célula com esse nome' });
    if (e.code === '23503') return res.status(400).json({ error: 'Turno ou produto inválido' });
    res.status(500).json({ error: e.message });
  }
});

/* DELETE /celulas/:id — apaga a célula e solta os tablets que estavam nela */
router.delete('/celulas/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query(
      `UPDATE cadc_ordens SET status = CASE WHEN num_op IS NOT NULL THEN 'encerrada' ELSE 'cancelada' END,
              encerrada_em=NOW(), updated_at=NOW() WHERE celula_id=$1 AND status='ativa'`, [req.params.id]);
    await pool.query('DELETE FROM cadc_celulas WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* POST /celulas/:id/pausar  body: { motivo?, duracao_min?, avisar? } */
router.post('/celulas/:id/pausar', requireAdmin, async (req, res) => {
  try {
    const cel = await umaCelula(req.params.id);
    if (!cel) return res.status(404).json({ error: 'Célula não encontrada' });
    if (cel.pausada) return res.status(409).json({ error: 'Esta célula já está pausada' });
    if (cel.ociosa) return res.status(409).json({ error: 'Esta célula está sem programação rodando' });

    const motivo = texto(req.body.motivo, 120) || 'Linha parada';
    const min = parseFloat(req.body.duracao_min);
    const comFim = min > 0 && min <= 600;

    const up = await pool.query(
      `UPDATE cadc_celulas SET pausada=TRUE, pausa_motivo=$2, pausa_inicio=NOW(),
              pausa_fim_prev = ${comFim ? `NOW() + ($3 || ' seconds')::interval` : 'NULL'},
              versao=versao+1, updated_at=NOW() WHERE id=$1 AND pausada=FALSE`,
      comFim ? [cel.id, motivo, String(Math.round(min * 60))] : [cel.id, motivo]);
    if (!up.rowCount) return res.status(409).json({ error: 'Esta célula já está pausada' });
    await pool.query(
      'INSERT INTO cadc_paradas (celula_id,motivo,usuario) VALUES ($1,$2,$3)', [cel.id, motivo, quem(req)]);

    if (req.body.avisar !== false) {
      const fala = texto(req.body.fala, 300)
        || `Atenção. Linha pausada. ${motivo}.` + (comFim && Math.round(min) >= 1 ? ` Duração de ${Math.round(min)} minuto${Math.round(min) === 1 ? '' : 's'}.` : '');
      await comando(cel.id, { texto: fala, origem: 'auto', por: quem(req) });
    }
    res.json(await umaCelula(cel.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* POST /celulas/:id/retomar */
router.post('/celulas/:id/retomar', requireAdmin, async (req, res) => {
  try {
    const turnos = await listarTurnos();
    const c = (await pool.query(SQL_CELULA + ' WHERE c.id=$1', [req.params.id])).rows[0];
    if (!c) return res.status(404).json({ error: 'Célula não encontrada' });
    if (!c.pausada) return res.status(409).json({ error: 'Esta célula não está pausada' });

    const fechou = await fecharPausa(c, turnos.find(t => t.id === c.turno_id));
    if (fechou != null && req.body.avisar !== false) {
      await comando(c.id, { texto: 'Linha retomada. Ciclo iniciado.', origem: 'auto', por: quem(req) });
    }
    res.json(await umaCelula(c.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* POST /celulas/:id/reiniciar — zera tempo parado e recomeça a contagem (agora ou do início do turno) */
router.post('/celulas/:id/reiniciar', requireAdmin, async (req, res) => {
  try {
    const cel = await umaCelula(req.params.id);
    if (!cel) return res.status(404).json({ error: 'Célula não encontrada' });
    let off = 0;
    if (req.body.de === 'agora' && cel.turno) {
      const o = offsetNoTurno(horaFabrica(), cel.turno);
      if (o < duracaoTurnoSeg(cel.turno)) off = o;
    }
    await arquivarAtual(cel.id);
    await pool.query(
      `UPDATE cadc_celulas SET inicio_off_seg=$2, tempo_parado_seg=0, ref_em=NOW(), rodada=rodada+1,
              versao=versao+1, updated_at=NOW() WHERE id=$1`, [cel.id, off]);
    res.json(await umaCelula(cel.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ─────────────── histórico de ciclos (igual ao do cadenciador comum) ─────────────── */

/* GET /celulas/:id/ciclos?data=AAAA-MM-DD — todos os ciclos do dia, com situação e motivo */
router.get('/celulas/:id/ciclos', requireAdmin, async (req, res) => {
  try {
    const cel = await umaCelula(req.params.id);
    if (!cel) return res.status(404).json({ error: 'Célula não encontrada' });
    const dia = /^\d{4}-\d{2}-\d{2}$/.test(req.query.data || '') ? req.query.data : cel.dia;

    const linhas = (await pool.query(
      `SELECT rodada, numero, to_char(hora_prevista,'HH24:MI:SS') AS hora, produto_nome AS produto,
              concluido, observacao
         FROM cadc_ciclos WHERE celula_id=$1 AND data=$2 AND rodada <> $3 ORDER BY rodada, numero`,
      [cel.id, dia, cel.rodada])).rows.map(k => ({ ...k, observacao: k.observacao || '', estado: 'encerrado', atual: false }));

    if (dia === cel.dia && cel.pronto) {
      const o = offsetNoTurno(horaFabrica(), cel.turno);
      const fora = o > duracaoTurnoSeg(cel.turno);
      let achouAtual = false;
      cel.ciclos.forEach((hora, i) => {
        const m = cel.marcas[i + 1];
        let estado = 'encerrado';
        if (!fora && offsetNoTurno(hora, cel.turno) > o) { estado = achouAtual ? 'futuro' : 'andamento'; achouAtual = true; }
        linhas.push({ rodada: cel.rodada, numero: i + 1, hora, produto: cel.produto.nome,
                      concluido: m ? m.c : true, observacao: m ? m.o : '', estado, atual: true });
      });
    }

    const dias = (await pool.query(
      `SELECT DISTINCT to_char(data,'YYYY-MM-DD') AS d FROM cadc_ciclos WHERE celula_id=$1 ORDER BY 1 DESC LIMIT 90`,
      [cel.id])).rows.map(r => r.d);
    if (cel.dia && !dias.includes(cel.dia)) dias.unshift(cel.dia);

    res.json({ celula: { id: cel.id, nome: cel.nome }, data: dia, hoje: cel.dia, rodada_atual: cel.rodada, dias, linhas });
  } catch (e) { console.error('cadc ciclos', e); res.status(500).json({ error: e.message }); }
});

/* PUT /celulas/:id/ciclos  body: { rodada, numero, concluido?, observacao? } */
router.put('/celulas/:id/ciclos', requireAdmin, async (req, res) => {
  try {
    const cel = await umaCelula(req.params.id);
    if (!cel) return res.status(404).json({ error: 'Célula não encontrada' });
    const rodada = Number(req.body.rodada), numero = Number(req.body.numero);
    const concl = typeof req.body.concluido === 'boolean' ? req.body.concluido : null;
    const obs = req.body.observacao !== undefined ? String(req.body.observacao).trim().slice(0, 500) : null;

    if (rodada === cel.rodada) {
      const hora = cel.ciclos[numero - 1];
      if (!hora) return res.status(404).json({ error: 'Ciclo não encontrado' });
      await pool.query(
        `INSERT INTO cadc_ciclos (celula_id, rodada, numero, data, hora_prevista, produto_nome, concluido, observacao, usuario)
         VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,TRUE),$8,$9)
         ON CONFLICT (celula_id, rodada, numero) DO UPDATE SET
           hora_prevista = EXCLUDED.hora_prevista, produto_nome = EXCLUDED.produto_nome,
           concluido = COALESCE($7, cadc_ciclos.concluido),
           observacao = CASE WHEN $10 THEN $8 ELSE cadc_ciclos.observacao END,
           usuario = EXCLUDED.usuario, updated_at = NOW()`,
        [cel.id, rodada, numero, cel.dia, hora, cel.produto.nome, concl, obs, quem(req), obs !== null]);
    } else {
      const r = await pool.query(
        `UPDATE cadc_ciclos SET concluido = COALESCE($4, concluido),
                observacao = CASE WHEN $6 THEN $5 ELSE observacao END, usuario=$7, updated_at=NOW()
          WHERE celula_id=$1 AND rodada=$2 AND numero=$3`,
        [cel.id, rodada, numero, concl, obs, obs !== null, quem(req)]);
      if (!r.rowCount) return res.status(404).json({ error: 'Ciclo não encontrado' });
    }
    await pool.query('UPDATE cadc_celulas SET versao=versao+1, updated_at=NOW() WHERE id=$1', [cel.id]);
    res.json({ success: true });
  } catch (e) { console.error('cadc ciclo', e); res.status(500).json({ error: e.message }); }
});

/* POST /celulas/:id/ciclos/limpar  body: { data } — volta tudo para "Concluído", sem observação */
router.post('/celulas/:id/ciclos/limpar', requireAdmin, async (req, res) => {
  try {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.body.data || '')) return res.status(400).json({ error: 'Informe o dia' });
    await pool.query(
      'UPDATE cadc_ciclos SET concluido=TRUE, observacao=NULL, updated_at=NOW() WHERE celula_id=$1 AND data=$2',
      [req.params.id, req.body.data]);
    await pool.query('UPDATE cadc_celulas SET versao=versao+1, updated_at=NOW() WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/*
 * POST /voz — o admin digita, o tablet fala.
 * body: { texto, celula_id? | tablet_id? | todas?: true, repetir? }
 */
router.post('/voz', requireAdmin, async (req, res) => {
  try {
    const t = texto(req.body.texto, 300);
    if (!t) return res.status(400).json({ error: 'Digite o que o tablet deve falar' });
    const rep = req.body.repetir;
    let enviados = 0;

    if (req.body.tablet_id) {
      const tb = (await pool.query('SELECT id, celula_id FROM cadc_tablets WHERE id=$1', [req.body.tablet_id])).rows[0];
      if (!tb || !tb.celula_id) return res.status(400).json({ error: 'Esse tablet não está conectado a nenhuma célula' });
      await comando(tb.celula_id, { texto: t, tabletId: tb.id, repetir: rep, por: quem(req) });
      enviados = 1;
    } else if (req.body.todas) {
      const ids = (await pool.query('SELECT id FROM cadc_celulas')).rows;
      for (const c of ids) { await comando(c.id, { texto: t, repetir: rep, por: quem(req) }); enviados++; }
    } else if (req.body.celula_id) {
      const c = (await pool.query('SELECT id FROM cadc_celulas WHERE id=$1', [req.body.celula_id])).rows[0];
      if (!c) return res.status(404).json({ error: 'Célula não encontrada' });
      await comando(c.id, { texto: t, repetir: rep, por: quem(req) });
      enviados = 1;
    } else {
      return res.status(400).json({ error: 'Informe a célula ou o tablet' });
    }
    res.json({ success: true, enviados });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* PUT /tablets/:id — renomeia, move para outra célula ou libera (celula_id: null) */
router.put('/tablets/:id', requireAdmin, async (req, res) => {
  try {
    const sets = [], vals = [];
    if (req.body.nome !== undefined) { vals.push(texto(req.body.nome, 120) || null); sets.push(`nome=$${vals.length}`); }
    if (req.body.celula_id !== undefined) {
      vals.push(req.body.celula_id || null); sets.push(`celula_id=$${vals.length}`);
      sets.push('conectado_em = NOW()');
    }
    if (!sets.length) return res.status(400).json({ error: 'Nada para alterar' });
    vals.push(req.params.id);
    // Ao mudar de célula, o tablet não deve falar avisos antigos da célula nova
    if (req.body.celula_id !== undefined) {
      sets.push('ultimo_cmd = (SELECT COALESCE(MAX(id),0) FROM cadc_comandos)');
      sets.push('pula_cmd = TRUE');
    }
    const r = await pool.query(`UPDATE cadc_tablets SET ${sets.join(', ')} WHERE id=$${vals.length} RETURNING *`, vals);
    if (!r.rows.length) return res.status(404).json({ error: 'Tablet não encontrado' });
    res.json(r.rows[0]);
  } catch (e) {
    if (e.code === '23503') return res.status(400).json({ error: 'Célula inválida' });
    res.status(500).json({ error: e.message });
  }
});

/* DELETE /tablets/:id — esquece o tablet (ele volta para a tela de escolha) */
router.delete('/tablets/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM cadc_tablets WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* POST /tablets/:id/recarregar — manda o tablet recarregar a página */
router.post('/tablets/:id/recarregar', requireAdmin, async (req, res) => {
  try {
    const tb = (await pool.query('SELECT id, celula_id FROM cadc_tablets WHERE id=$1', [req.params.id])).rows[0];
    if (!tb || !tb.celula_id) return res.status(400).json({ error: 'Esse tablet não está conectado a nenhuma célula' });
    await comando(tb.celula_id, { tipo: 'recarregar', tabletId: tb.id, por: quem(req) });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* GET /celulas/:id/paradas — histórico de pausas da célula */
router.get('/celulas/:id/paradas', requireAdmin, async (req, res) => {
  try {
    res.json((await pool.query(
      'SELECT * FROM cadc_paradas WHERE celula_id=$1 ORDER BY inicio DESC LIMIT 100', [req.params.id])).rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ═════════════════════ TABLET ═════════════════════ */

const deviceOk = d => typeof d === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(d);

/* ── Credencial do tablet ────────────────────────────────────────────────
   O tablet precisa ficar ligado no painel 24 horas por dia, sem depender do
   login de uma pessoa (que vence em 12 h). Na primeira vez que alguém logado
   abre a tela no tablet, ele ganha uma credencial própria (cookie renovado
   todo dia + cópia no aparelho, que não vence). Daí em diante a tela e as consultas do tablet valem
   com ela — mesmo depois de o login vencer, do servidor reiniciar ou do
   tablet ser desligado e ligado. Ela só dá acesso às telas/consultas do
   tablet; "apagar o tablet da lista" no PC cancela a credencial.          */
const COOKIE_TAB = 'cadc_tab';
const DEZ_ANOS = 10 * 365 * 24 * 60 * 60 * 1000;
const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const cookieEm = new Map();     // quando o cookie de cada tablet foi regravado pela última vez

function credencialDoPedido(req) {
  const h = req.headers || {};
  if (h['x-cadc-device'] && h['x-cadc-token']) return { device: String(h['x-cadc-device']), token: String(h['x-cadc-token']) };
  const m = /(?:^|;\s*)cadc_tab=([^;]+)/.exec(h.cookie || '');
  if (!m) return null;
  let v = m[1]; try { v = decodeURIComponent(v); } catch (e) { /* usa como veio */ }
  const i = v.indexOf('.');
  return i > 0 ? { device: v.slice(0, i), token: v.slice(i + 1) } : null;
}

async function tabletDaCredencial(req) {
  const c = credencialDoPedido(req);
  if (!c || !deviceOk(c.device) || !/^[a-f0-9]{32,96}$/.test(c.token)) return null;
  const r = await pool.query('SELECT id, device_id FROM cadc_tablets WHERE device_id=$1 AND token_hash=$2', [c.device, sha(c.token)]);
  return r.rows[0] || null;
}

function gravarCookie(res, device, token) {
  res.cookie(COOKIE_TAB, `${device}.${token}`, {
    maxAge: DEZ_ANOS, httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/'
  });
}

/** Deixa passar quem está logado OU um tablet com credencial válida. */
async function tabletOuSessao(req, res, next) {
  if (req.session && req.session.userId) return next();
  try {
    const t = await tabletDaCredencial(req);
    if (t) { req.tabletCred = t; return next(); }
  } catch (e) { console.error('cadc credencial', e.message); return res.status(503).json({ error: 'Servidor indisponível, tentando de novo' }); }
  if ((req.originalUrl || '').startsWith('/api/')) return res.status(401).json({ error: 'Tablet sem autorização' });
  return res.redirect('/login');
}

/** Sem login, o tablet só pode falar por ele mesmo. */
function mesmoTablet(req, deviceId) {
  return !!(req.session && req.session.userId) || !!(req.tabletCred && req.tabletCred.device_id === deviceId);
}

/**
 * Entrega a credencial ao tablet quando há alguém logado nele (primeira vez, ou se ele perdeu o cookie).
 * Devolve o token para a tela guardar uma cópia, ou null se o tablet já tem o dele.
 */
async function garantirCredencial(req, res, tabletId, deviceId) {
  const atual = req.tabletCred || await tabletDaCredencial(req);
  if (atual && atual.device_id === deviceId) {
    // já tem. O navegador guarda cookie por no máximo ~400 dias, então ele é regravado uma vez por dia
    // (e na hora, se o tablet chegou só com a cópia guardada na tela porque o cookie se perdeu).
    const semCookie = !/(?:^|;\s*)cadc_tab=/.test(req.headers.cookie || '');
    if (semCookie || Date.now() - (cookieEm.get(deviceId) || 0) > 24 * 60 * 60 * 1000) {
      const c = credencialDoPedido(req);
      if (c) { gravarCookie(res, deviceId, c.token); cookieEm.set(deviceId, Date.now()); }
    }
    return null;
  }
  if (!(req.session && req.session.userId)) return null;
  // evita gerar uma atrás da outra se o navegador recusar o cookie
  const r = await pool.query(
    `SELECT (token_em IS NOT NULL AND token_em > NOW() - INTERVAL '60 seconds') AS recente FROM cadc_tablets WHERE id=$1`, [tabletId]);
  if (r.rows[0] && r.rows[0].recente) return null;
  const token = crypto.randomBytes(24).toString('hex');
  await pool.query('UPDATE cadc_tablets SET token_hash=$2, token_em=NOW() WHERE id=$1', [tabletId, sha(token)]);
  gravarCookie(res, deviceId, token);
  return token;
}

/* GET /tablet/eu — quem está usando o tablet (nunca manda para a tela de login) */
router.get('/tablet/eu', tabletOuSessao, (req, res) => {
  const s = req.session || {};
  res.json({ logado: !!s.userId, role: s.role || null, nome: s.nome || s.username || null });
});

/* POST /tablet/nome  body: { device_id, nome } — o próprio tablet diz como quer aparecer na lista do admin */
router.post('/tablet/nome', tabletOuSessao, async (req, res) => {
  try {
    const { device_id } = req.body;
    if (!deviceOk(device_id)) return res.status(400).json({ error: 'Identificação do tablet inválida' });
    if (!mesmoTablet(req, device_id)) return res.status(401).json({ error: 'Tablet sem autorização' });
    const nome = texto(req.body.nome, 120);
    if (!nome) return res.status(400).json({ error: 'Digite um nome para o tablet' });
    const r = await pool.query('UPDATE cadc_tablets SET nome=$2 WHERE device_id=$1 RETURNING id, nome, celula_id', [device_id, nome]);
    if (!r.rowCount) return res.status(404).json({ error: 'Tablet ainda não registrado — aguarde alguns segundos' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* GET /tablet/celulas — células disponíveis para conectar */
router.get('/tablet/celulas', tabletOuSessao, async (_req, res) => {
  try {
    const cels = await carregarCelulas();
    const n = (await pool.query(
      `SELECT celula_id, COUNT(*)::int AS n FROM cadc_tablets
        WHERE celula_id IS NOT NULL AND visto_em > NOW() - INTERVAL '${ONLINE_SEG} seconds'
        GROUP BY celula_id`)).rows;
    const mapa = new Map(n.map(x => [x.celula_id, x.n]));
    res.json(cels.map(c => ({
      id: c.id, nome: c.nome, pronto: c.pronto, pausada: c.pausada,
      ociosa: c.ociosa, proxima: c.proxima,
      produto: c.ociosa ? null : (c.produto?.nome || null), turno: c.ociosa ? null : (c.turno?.nome || null),
      takt_min: c.ociosa ? null : c.takt_min, tablets_online: mapa.get(c.id) || 0
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/*
 * POST /tablet/conectar  body: { device_id, celula_id, nome? }
 * Depois de conectado, o tablet NÃO troca de célula sozinho: só o admin
 * libera (pelo painel) ou alguém com senha de admin, no próprio tablet.
 */
router.post('/tablet/conectar', tabletOuSessao, async (req, res) => {
  try {
    const { device_id, celula_id } = req.body;
    if (!deviceOk(device_id)) return res.status(400).json({ error: 'Identificação do tablet inválida' });
    if (!mesmoTablet(req, device_id)) return res.status(401).json({ error: 'Tablet sem autorização' });
    const cel = (await pool.query('SELECT id FROM cadc_celulas WHERE id=$1', [celula_id])).rows[0];
    if (!cel) return res.status(404).json({ error: 'Célula não encontrada' });

    const atual = (await pool.query('SELECT * FROM cadc_tablets WHERE device_id=$1', [device_id])).rows[0];
    if (atual && atual.celula_id && atual.celula_id !== cel.id && !(req.session && req.session.role === 'admin')) {
      return res.status(423).json({ error: 'Este tablet está preso a outra célula. Só o administrador pode liberar.' });
    }
    const nome = texto(req.body.nome, 120) || atual?.nome || ('Tablet ' + device_id.slice(-4).toUpperCase());
    const ult = Number((await pool.query('SELECT COALESCE(MAX(id),0) AS m FROM cadc_comandos')).rows[0].m);

    const r = await pool.query(
      `INSERT INTO cadc_tablets (device_id,nome,celula_id,usuario,conectado_em,visto_em,ultimo_cmd)
       VALUES ($1,$2,$3,$4,NOW(),NOW(),$5)
       ON CONFLICT (device_id) DO UPDATE SET nome=EXCLUDED.nome, celula_id=EXCLUDED.celula_id,
         usuario=COALESCE(EXCLUDED.usuario, cadc_tablets.usuario), conectado_em=NOW(), visto_em=NOW(), ultimo_cmd=EXCLUDED.ultimo_cmd
       RETURNING id, nome, celula_id`,
      [device_id, nome, cel.id, (req.session && req.session.username) || null, ult]);
    const token = await garantirCredencial(req, res, r.rows[0].id, device_id);
    res.json({ tablet: r.rows[0], ultimo_comando: ult, ...(token ? { token } : {}) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/*
 * GET /tablet/estado?device_id=&c=&v=&depois=&som=&nome=
 * Chamado pelo tablet a cada ~2 s. Serve de "estou vivo" e traz:
 *  - a célula (grade de ciclos só quando a versão mudou);
 *  - os comandos novos (voz, recarregar).
 */
router.get('/tablet/estado', tabletOuSessao, async (req, res) => {
  try {
    const { device_id } = req.query;
    if (!deviceOk(device_id)) return res.status(400).json({ error: 'Identificação do tablet inválida' });
    if (!mesmoTablet(req, device_id)) return res.status(401).json({ error: 'Tablet sem autorização' });
    let depois = req.query.depois != null && req.query.depois !== '' ? Number(req.query.depois) : null;
    if (depois != null && !Number.isFinite(depois)) depois = null;
    const logado = !!(req.session && req.session.userId);

    // Se há alguém logado no tablet, o login também é renovado enquanto ele consulta
    if (logado && (!req.session.cadcRenova || Date.now() - req.session.cadcRenova > 30 * 60 * 1000)) {
      req.session.cadcRenova = Date.now();
    }

    const maxGlobal = Number((await pool.query('SELECT COALESCE(MAX(id),0) AS m FROM cadc_comandos')).rows[0].m);
    if (depois != null && depois > maxGlobal) depois = maxGlobal;     // banco restaurado / histórico limpo

    let tb = (await pool.query(
      `UPDATE cadc_tablets t SET visto_em=NOW(), som_ok=$2, usuario = COALESCE($3, t.usuario), pula_cmd=FALSE
         FROM (SELECT id, pula_cmd, ultimo_cmd FROM cadc_tablets WHERE device_id=$1 FOR UPDATE) a
        WHERE t.id = a.id
        RETURNING t.id, t.nome, t.celula_id, a.pula_cmd AS pular, a.ultimo_cmd`,
      [device_id, req.query.som === '1', logado ? req.session.username || null : null])).rows[0];

    // Tablet que abriu a tela pela primeira vez já aparece para o admin (livre), que pode puxá-lo pelo PC
    if (!tb) {
      const nome = texto(req.query.nome, 120) || ('Tablet ' + device_id.slice(-4).toUpperCase());
      tb = (await pool.query(
        `INSERT INTO cadc_tablets (device_id, nome, usuario, visto_em, ultimo_cmd) VALUES ($1,$2,$3,NOW(),$4)
         ON CONFLICT (device_id) DO UPDATE SET visto_em=NOW()
         RETURNING id, nome, celula_id, FALSE AS pular, ultimo_cmd`,
        [device_id, nome, logado ? req.session.username || null : null, maxGlobal])).rows[0];
    }
    // credencial própria do aparelho: é ela que mantém o tablet ligado 24 h
    const token = await garantirCredencial(req, res, tb.id, device_id);
    const extra = token ? { token } : {};
    // O admin trocou este tablet de célula: começa a ouvir a partir de agora
    if (tb.pular) depois = Number(tb.ultimo_cmd);
    const tablet = { id: tb.id, nome: tb.nome, celula_id: tb.celula_id };

    if (!tb.celula_id) return res.json({ ...relogio(), ...extra, tablet, celula: null, comandos: [] });

    const cel = await umaCelula(tb.celula_id);
    if (!cel) return res.json({ ...relogio(), ...extra, tablet: { ...tablet, celula_id: null }, celula: null, comandos: [] });

    let comandos = [];
    let ultimo = depois;
    if (depois == null) {
      ultimo = maxGlobal;
    } else {
      comandos = (await pool.query(
        `SELECT id, tipo, texto, repetir, origem FROM cadc_comandos
          WHERE celula_id=$1 AND id > $2 AND (tablet_id IS NULL OR tablet_id=$3)
            AND criado_em > NOW() - INTERVAL '${VALIDADE_CMD_SEG} seconds'
          ORDER BY id LIMIT 20`, [cel.id, depois, tb.id])).rows.map(k => ({ ...k, id: Number(k.id) }));
      // Fila cheia: continua de onde parou na próxima consulta. Senão, já está em dia.
      ultimo = comandos.length === 20 ? comandos[19].id : Math.max(depois, maxGlobal);
    }
    await pool.query('UPDATE cadc_tablets SET ultimo_cmd=$2 WHERE id=$1 AND ultimo_cmd <> $2', [tb.id, ultimo]);

    // Grade de ciclos é a parte pesada: só vai quando algo mudou
    if (req.query.v && String(req.query.v) === cel.sinal && Number(req.query.c) === cel.id) {
      delete cel.ciclos; delete cel.turno; delete cel.marcas; delete cel.anteriores; cel.igual = true;
    }
    res.json({ ...relogio(), ...extra, tablet, celula: cel, comandos, ultimo_comando: ultimo });
  } catch (e) { console.error('cadc estado', e); res.status(500).json({ error: e.message }); }
});

/*
 * POST /tablet/liberar  body: { device_id, usuario?, senha? }
 * Solta o tablet da célula. Só vale se quem está logado é admin
 * ou se for informado usuário + senha de um administrador.
 */
router.post('/tablet/liberar', tabletOuSessao, async (req, res) => {
  try {
    const { device_id, usuario, senha } = req.body;
    if (!deviceOk(device_id)) return res.status(400).json({ error: 'Identificação do tablet inválida' });
    if (!mesmoTablet(req, device_id)) return res.status(401).json({ error: 'Tablet sem autorização' });

    let autorizado = !!(req.session && req.session.role === 'admin');
    if (!autorizado) {
      if (!usuario || !senha) return res.status(403).json({ error: 'Informe usuário e senha de um administrador' });
      const u = (await pool.query('SELECT * FROM users WHERE username=$1', [String(usuario).trim()])).rows[0];
      autorizado = !!(u && u.ativo !== false && u.role === 'admin' && await bcrypt.compare(String(senha), u.password));
      if (!autorizado) return res.status(403).json({ error: 'Usuário ou senha de administrador inválidos' });
    }
    await pool.query('UPDATE cadc_tablets SET celula_id=NULL WHERE device_id=$1', [device_id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.tabletOuSessao = tabletOuSessao;

module.exports = router;
