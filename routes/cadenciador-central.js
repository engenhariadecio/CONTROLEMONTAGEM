/* ═══════════════════════════════════════════════════════════════════════
   CADENCIADOR CENTRAL
   A célula é criada e controlada no PC do administrador
   (ProGestão › Linha de Produção › Cadenciador central).
   Os tablets só se conectam a uma célula e espelham o que o admin define:
   produto, turno, pausa, mensagens e comandos de voz.

   Não usa nem altera nada do cadenciador comum (routes/cadenciador.js).
   ═══════════════════════════════════════════════════════════════════════ */

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { listarTurnos, calcularCiclos, paraSegundos, duracaoTurnoSeg } = require('../lib/turnos');

const FUSO = process.env.TZ_FABRICA || 'America/Sao_Paulo';
const ONLINE_SEG = 10;            // tablet sem dar sinal há mais que isso = offline
const VALIDADE_CMD_SEG = 120;     // comando de voz mais velho que isso não é mais falado
const ZERA_APOS_H = 12;           // tempo parado / reinício de contagem valem só para o turno em curso

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

const quem = req => req.session.nome || req.session.username || 'admin';
const texto = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

async function limiteCiclos() {
  const r = await pool.query(`SELECT valor FROM app_config WHERE chave='cad_limite_ciclos'`);
  return parseInt(r.rows[0]?.valor || '500', 10) || 500;
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
         EXTRACT(EPOCH FROM (NOW() - c.ref_em))::int AS ref_idade_seg
  FROM cadc_celulas c
  LEFT JOIN cad_produtos p ON p.id = c.produto_id
  LEFT JOIN cad_takt_turno tt ON tt.produto_id = c.produto_id AND tt.turno_id = c.turno_id`;

/** Quanto da pausa caiu dentro do turno — só esse pedaço empurra os ciclos. */
function pausaDentroDoTurno(turno, inicio, duracaoSeg) {
  if (!turno || !inicio) return 0;
  const dur = duracaoTurnoSeg(turno);
  let a = offsetNoTurno(horaFabrica(new Date(inicio)), turno);
  if (a > dur) a -= 86400;                 // começou antes do turno abrir
  const A = Math.max(a, 0), B = Math.min(a + duracaoSeg, dur);
  if (B <= A) return 0;
  // Pedaço da pausa que caiu em cima de um intervalo (café, almoço) não conta duas vezes
  let emIntervalo = 0;
  for (const i of (turno.intervalos || [])) {
    const ia = offsetNoTurno(i.hora_inicio, turno), ib = offsetNoTurno(i.hora_fim, turno);
    if (ib > ia) emIntervalo += Math.max(0, Math.min(B, ib) - Math.max(A, ia));
  }
  return Math.max(0, Math.round(B - A - emIntervalo));
}

/** Fecha a pausa aberta da célula. `fim` permite fechar no horário programado. */
async function fecharPausa(cel, turno, { noPrevisto = false } = {}) {
  const fimSql = noPrevisto ? 'LEAST(NOW(), $2::timestamptz)' : 'NOW()';
  const params = noPrevisto ? [cel.id, cel.pausa_fim_prev] : [cel.id];
  const p = await pool.query(
    `UPDATE cadc_paradas SET fim = ${fimSql},
            duracao_seg = GREATEST(0, EXTRACT(EPOCH FROM (${fimSql} - inicio))::int)
      WHERE celula_id = $1 AND fim IS NULL RETURNING duracao_seg`, params);
  let dur = p.rows[0]?.duracao_seg;
  if (dur == null) {
    dur = noPrevisto
      ? Math.max(0, Math.round((new Date(cel.pausa_fim_prev) - new Date(cel.pausa_inicio)) / 1000))
      : Math.max(0, cel.pausa_decorrido_seg || 0);
  }
  const soma = pausaDentroDoTurno(turno, cel.pausa_inicio, dur);
  await pool.query(
    `UPDATE cadc_celulas SET pausada=FALSE, pausa_motivo=NULL, pausa_inicio=NULL, pausa_fim_prev=NULL,
            tempo_parado_seg = tempo_parado_seg + $2, ref_em = NOW(),
            versao = versao + 1, updated_at = NOW()
      WHERE id = $1`, [cel.id, soma]);
  return dur;
}

/**
 * Carrega as células já "arrumadas":
 *  - pausa com duração programada que já venceu é encerrada sozinha;
 *  - tempo parado e reinício de contagem de um turno antigo são zerados.
 */
async function carregarCelulas(filtroId = null) {
  const turnos = await listarTurnos();
  const porId = new Map(turnos.map(t => [t.id, t]));
  const ler = async () => (await pool.query(
    SQL_CELULA + (filtroId ? ' WHERE c.id = $1' : '') + ' ORDER BY c.nome', filtroId ? [filtroId] : []
  )).rows;

  let linhas = await ler();
  let mudou = false;

  for (const c of linhas) {
    const turno = porId.get(c.turno_id);
    if (c.pausada && c.pausa_fim_prev && c.pausa_restante_seg <= 0) {
      await fecharPausa(c, turno, { noPrevisto: true });
      await comando(c.id, { texto: 'Pausa encerrada. Ciclo iniciado.', origem: 'auto' });
      mudou = true;
    } else if (!c.pausada && (c.tempo_parado_seg > 0 || c.inicio_off_seg > 0)
               && (c.ref_idade_seg == null || c.ref_idade_seg > ZERA_APOS_H * 3600)) {
      await pool.query(
        `UPDATE cadc_celulas SET tempo_parado_seg=0, inicio_off_seg=0, ref_em=NULL,
                versao=versao+1, updated_at=NOW() WHERE id=$1`, [c.id]);
      mudou = true;
    }
  }
  if (mudou) linhas = await ler();

  const limite = await limiteCiclos();
  return linhas.map(c => montarEstado(c, porId.get(c.turno_id), limite));
}

function montarEstado(c, turno, limite) {
  const pronto = !!(turno && c.produto_id && c.takt_min > 0);
  let ciclos = [];
  if (pronto) {
    ciclos = calcularCiclos(turno, c.takt_min, {
      tempoParadoSeg: (c.inicio_off_seg || 0) + (c.tempo_parado_seg || 0), limite
    }).map(x => x.hora);
  }
  return {
    id: c.id,
    nome: c.nome,
    versao: c.versao,
    pronto,
    produto: c.produto_id ? { id: c.produto_id, nome: c.produto_nome, cod_decio: c.cod_decio } : null,
    turno: turno ? {
      id: turno.id, nome: turno.nome, codigo: turno.codigo,
      hora_inicio: turno.hora_inicio, hora_fim: turno.hora_fim,
      intervalos: (turno.intervalos || []).map(i => ({
        nome: i.nome, hora_inicio: i.hora_inicio, hora_fim: i.hora_fim, aviso_voz: i.aviso_voz
      }))
    } : null,
    takt_min: c.takt_min,
    takt_cadastro: c.takt_cadastro,
    takt_manual: c.takt_manual != null,
    inicio_off_seg: c.inicio_off_seg || 0,
    tempo_parado_seg: c.tempo_parado_seg || 0,
    pausada: c.pausada,
    pausa_motivo: c.pausa_motivo,
    pausa_decorrido_seg: c.pausada ? Math.max(0, c.pausa_decorrido_seg || 0) : 0,
    pausa_restante_seg: c.pausada && c.pausa_fim_prev ? Math.max(0, c.pausa_restante_seg || 0) : null,
    voz_ativa: c.voz_ativa,
    mensagem: c.mensagem || '',
    ciclos
  };
}

async function umaCelula(id) {
  return (await carregarCelulas(Number(id)))[0] || null;
}

/* ═════════════════════ ADMIN (PC central) ═════════════════════ */

/* GET /api/cadenciador-central/admin/visao — tudo que o painel do admin precisa */
router.get('/admin/visao', requireAdmin, async (_req, res) => {
  try {
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

    res.json({ hora: horaFabrica(), celulas, tablets, comandos });
  } catch (e) { console.error('cadc visao', e); res.status(500).json({ error: e.message }); }
});

/* GET /admin/cadastros — turnos e produtos para os seletores */
router.get('/admin/cadastros', requireAdmin, async (_req, res) => {
  try {
    const turnos = (await listarTurnos({ apenasAtivos: true }))
      .map(t => ({ id: t.id, nome: t.nome, codigo: t.codigo, hora_inicio: t.hora_inicio, hora_fim: t.hora_fim }));
    const produtos = (await pool.query(
      `SELECT id, nome, cod_decio, takt_min::float FROM cad_produtos WHERE ativo = TRUE ORDER BY ordem, nome`)).rows;
    const celulasCadastro = (await pool.query(
      `SELECT nome FROM celulas WHERE ativa IS NOT FALSE ORDER BY nome`)).rows.map(r => r.nome);
    res.json({ turnos, produtos, celulas_cadastro: celulasCadastro });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* POST /celulas — cria a célula */
router.post('/celulas', requireAdmin, async (req, res) => {
  try {
    const nome = texto(req.body.nome, 120);
    const { turno_id, produto_id } = req.body;
    if (!nome) return res.status(400).json({ error: 'Dê um nome para a célula' });
    if (!turno_id || !produto_id) return res.status(400).json({ error: 'Escolha o turno e o produto' });
    const takt = req.body.takt_min === '' || req.body.takt_min == null ? null : parseFloat(req.body.takt_min);
    if (takt != null && !(takt > 0)) return res.status(400).json({ error: 'Takt deve ser maior que zero' });

    const r = await pool.query(
      `INSERT INTO cadc_celulas (nome,turno_id,produto_id,takt_manual) VALUES ($1,$2,$3,$4) RETURNING id`,
      [nome, turno_id, produto_id, takt]);
    res.json(await umaCelula(r.rows[0].id));
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Já existe uma célula com esse nome' });
    if (e.code === '23503') return res.status(400).json({ error: 'Turno ou produto inválido' });
    res.status(500).json({ error: e.message });
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
      set('inicio_off_seg', off);
      set('tempo_parado_seg', 0);
      sets.push('ref_em = NOW()');
    }

    if (!sets.length) return res.json(antes);
    vals.push(req.params.id);
    await pool.query(
      `UPDATE cadc_celulas SET ${sets.join(', ')}, versao = versao + 1, updated_at = NOW()
        WHERE id = $${vals.length}`, vals);

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

    const motivo = texto(req.body.motivo, 120) || 'Linha parada';
    const min = parseFloat(req.body.duracao_min);
    const comFim = min > 0 && min <= 600;

    await pool.query(
      `UPDATE cadc_celulas SET pausada=TRUE, pausa_motivo=$2, pausa_inicio=NOW(),
              pausa_fim_prev = ${comFim ? `NOW() + ($3 || ' seconds')::interval` : 'NULL'},
              versao=versao+1, updated_at=NOW() WHERE id=$1`,
      comFim ? [cel.id, motivo, String(Math.round(min * 60))] : [cel.id, motivo]);
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

    await fecharPausa(c, turnos.find(t => t.id === c.turno_id));
    if (req.body.avisar !== false) {
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
    await pool.query(
      `UPDATE cadc_celulas SET inicio_off_seg=$2, tempo_parado_seg=0, ref_em=NOW(),
              versao=versao+1, updated_at=NOW() WHERE id=$1`, [cel.id, off]);
    res.json(await umaCelula(cel.id));
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

/* GET /tablet/celulas — células disponíveis para conectar */
router.get('/tablet/celulas', requireAuth, async (_req, res) => {
  try {
    const cels = await carregarCelulas();
    const n = (await pool.query(
      `SELECT celula_id, COUNT(*)::int AS n FROM cadc_tablets
        WHERE celula_id IS NOT NULL AND visto_em > NOW() - INTERVAL '${ONLINE_SEG} seconds'
        GROUP BY celula_id`)).rows;
    const mapa = new Map(n.map(x => [x.celula_id, x.n]));
    res.json(cels.map(c => ({
      id: c.id, nome: c.nome, pronto: c.pronto, pausada: c.pausada,
      produto: c.produto?.nome || null, turno: c.turno?.nome || null,
      takt_min: c.takt_min, tablets_online: mapa.get(c.id) || 0
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/*
 * POST /tablet/conectar  body: { device_id, celula_id, nome? }
 * Depois de conectado, o tablet NÃO troca de célula sozinho: só o admin
 * libera (pelo painel) ou alguém com senha de admin, no próprio tablet.
 */
router.post('/tablet/conectar', requireAuth, async (req, res) => {
  try {
    const { device_id, celula_id } = req.body;
    if (!deviceOk(device_id)) return res.status(400).json({ error: 'Identificação do tablet inválida' });
    const cel = (await pool.query('SELECT id FROM cadc_celulas WHERE id=$1', [celula_id])).rows[0];
    if (!cel) return res.status(404).json({ error: 'Célula não encontrada' });

    const atual = (await pool.query('SELECT * FROM cadc_tablets WHERE device_id=$1', [device_id])).rows[0];
    if (atual && atual.celula_id && atual.celula_id !== cel.id && req.session.role !== 'admin') {
      return res.status(423).json({ error: 'Este tablet está preso a outra célula. Só o administrador pode liberar.' });
    }
    const nome = texto(req.body.nome, 120) || atual?.nome || ('Tablet ' + device_id.slice(-4).toUpperCase());
    const ult = Number((await pool.query('SELECT COALESCE(MAX(id),0) AS m FROM cadc_comandos')).rows[0].m);

    const r = await pool.query(
      `INSERT INTO cadc_tablets (device_id,nome,celula_id,usuario,conectado_em,visto_em,ultimo_cmd)
       VALUES ($1,$2,$3,$4,NOW(),NOW(),$5)
       ON CONFLICT (device_id) DO UPDATE SET nome=EXCLUDED.nome, celula_id=EXCLUDED.celula_id,
         usuario=EXCLUDED.usuario, conectado_em=NOW(), visto_em=NOW(), ultimo_cmd=EXCLUDED.ultimo_cmd
       RETURNING id, nome, celula_id`,
      [device_id, nome, cel.id, req.session.username || null, ult]);
    res.json({ tablet: r.rows[0], ultimo_comando: ult });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/*
 * GET /tablet/estado?device_id=&c=&v=&depois=&som=
 * Chamado pelo tablet a cada ~2 s. Serve de "estou vivo" e traz:
 *  - a célula (grade de ciclos só quando a versão mudou);
 *  - os comandos novos (voz, recarregar).
 */
router.get('/tablet/estado', requireAuth, async (req, res) => {
  try {
    const { device_id } = req.query;
    if (!deviceOk(device_id)) return res.status(400).json({ error: 'Identificação do tablet inválida' });
    const depois = req.query.depois != null && req.query.depois !== '' ? Number(req.query.depois) : null;

    const tb = (await pool.query(
      `UPDATE cadc_tablets SET visto_em=NOW(), som_ok=$2,
              ultimo_cmd = GREATEST(ultimo_cmd, $3), usuario = COALESCE($4, usuario)
        WHERE device_id=$1 RETURNING id, nome, celula_id`,
      [device_id, req.query.som === '1', depois || 0, req.session.username || null])).rows[0];

    if (!tb || !tb.celula_id) {
      return res.json({ hora: horaFabrica(), tablet: tb || null, celula: null, comandos: [] });
    }

    const cel = await umaCelula(tb.celula_id);
    if (!cel) return res.json({ hora: horaFabrica(), tablet: { ...tb, celula_id: null }, celula: null, comandos: [] });

    let comandos = [];
    let ultimo = depois;
    if (depois == null) {
      ultimo = Number((await pool.query('SELECT COALESCE(MAX(id),0) AS m FROM cadc_comandos')).rows[0].m);
    } else {
      comandos = (await pool.query(
        `SELECT id, tipo, texto, repetir, origem FROM cadc_comandos
          WHERE celula_id=$1 AND id > $2 AND (tablet_id IS NULL OR tablet_id=$3)
            AND criado_em > NOW() - INTERVAL '${VALIDADE_CMD_SEG} seconds'
          ORDER BY id LIMIT 20`, [cel.id, depois, tb.id])).rows.map(k => ({ ...k, id: Number(k.id) }));
      const m = Number((await pool.query(
        'SELECT COALESCE(MAX(id),0) AS m FROM cadc_comandos WHERE celula_id=$1', [cel.id])).rows[0].m);
      ultimo = Math.max(depois, m);
    }

    // Grade de ciclos é a parte pesada: só vai quando algo mudou
    if (req.query.v && Number(req.query.v) === cel.versao && Number(req.query.c) === cel.id) {
      delete cel.ciclos; delete cel.turno; cel.igual = true;
    }
    res.json({ hora: horaFabrica(), tablet: tb, celula: cel, comandos, ultimo_comando: ultimo });
  } catch (e) { console.error('cadc estado', e); res.status(500).json({ error: e.message }); }
});

/*
 * POST /tablet/liberar  body: { device_id, usuario?, senha? }
 * Solta o tablet da célula. Só vale se quem está logado é admin
 * ou se for informado usuário + senha de um administrador.
 */
router.post('/tablet/liberar', requireAuth, async (req, res) => {
  try {
    const { device_id, usuario, senha } = req.body;
    if (!deviceOk(device_id)) return res.status(400).json({ error: 'Identificação do tablet inválida' });

    let autorizado = req.session.role === 'admin';
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

module.exports = router;
