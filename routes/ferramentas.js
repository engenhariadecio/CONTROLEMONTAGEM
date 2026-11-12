const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

/*
 * A tela de ferramentas usa nomes longos (codigo, categoria, localizacao,
 * calibracao_venc...) e o banco usa os curtos (cod, cat, loc, cal...).
 * As rotas aceitam os dois e devolvem os dois, para a tela e o Excel funcionarem.
 */
const SELECT_FERR = `SELECT id, nome, cod, cat, loc, status, cal, prev, obs, created_at, updated_at,
  cod AS codigo, cat AS categoria, loc AS localizacao, cal AS calibracao_venc, prev AS preventiva_venc
  FROM ferramentas`;

function camposFerramenta(b) {
  const v = (curto, longo) => (b[curto] !== undefined ? b[curto] : b[longo]);
  return {
    nome: b.nome,
    cod:  v('cod', 'codigo'),
    cat:  v('cat', 'categoria'),
    loc:  v('loc', 'localizacao'),
    status: b.status,
    cal:  v('cal', 'calibracao_venc'),
    prev: v('prev', 'preventiva_venc'),
    obs:  b.obs
  };
}

// ======================== CHECKLISTS (conferências salvas) ========================
/*
 * GET    /api/ferramentas/checklists          histórico (cabeçalhos com totais)
 * GET    /api/ferramentas/checklists/:id      cabeçalho + itens
 * POST   /api/ferramentas/checklists          { data, hora, turno, obs, itens: [{ ferramenta_id, situacao, obs }] }
 * DELETE /api/ferramentas/checklists/:id
 *
 * Ficam antes das rotas /:id para não serem capturadas por elas.
 * Cada item guarda uma cópia do código/nome/status da ferramenta naquele
 * momento: se ela for renomeada ou excluída depois, o histórico continua legível.
 */
const SITUACOES = ['ok', 'problema', 'nao_encontrada', 'pendente'];

router.get('/checklists', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM ferr_checklists ORDER BY data DESC, hora DESC, id DESC');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/checklists/:id', requireAuth, async (req, res) => {
  try {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'ID inválido' });
    const cab = await pool.query('SELECT * FROM ferr_checklists WHERE id=$1', [req.params.id]);
    if (!cab.rows.length) return res.status(404).json({ error: 'Checklist não encontrado' });
    const itens = await pool.query(
      'SELECT * FROM ferr_checklist_itens WHERE checklist_id=$1 ORDER BY cod, nome, id',
      [req.params.id]
    );
    res.json({ ...cab.rows[0], itens: itens.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/checklists', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { data, hora, turno, obs } = req.body;
    const itens = Array.isArray(req.body.itens) ? req.body.itens : [];
    if (!data) return res.status(400).json({ error: 'Data obrigatória' });
    if (!itens.length) return res.status(400).json({ error: 'Checklist sem ferramentas' });

    // Situação vem da tela; o resto (código, nome, status) vem do cadastro atual
    const ids = [...new Set(itens.map(i => Number(i.ferramenta_id)).filter(n => Number.isInteger(n) && n > 0))];
    const ferr = await client.query('SELECT id, cod, nome, cat, loc, status FROM ferramentas WHERE id = ANY($1)', [ids]);
    const porId = new Map(ferr.rows.map(f => [f.id, f]));

    // Uma linha por ferramenta; se vier repetida, vale a última
    const porFerr = new Map();
    for (const it of itens) {
      const f = porId.get(Number(it.ferramenta_id));
      if (!f) continue;
      const sit = SITUACOES.includes(it.situacao) ? it.situacao : 'pendente';
      porFerr.set(f.id, [f.id, f.cod, f.nome, f.cat, f.loc, f.status, sit, (it.obs || '').trim() || null]);
    }
    const linhas = [...porFerr.values()];
    const cont = { ok: 0, problema: 0, nao_encontrada: 0, pendente: 0 };
    linhas.forEach(l => cont[l[6]]++);
    if (!linhas.length) return res.status(400).json({ error: 'Nenhuma ferramenta válida no checklist' });
    if (cont.pendente === linhas.length) return res.status(400).json({ error: 'Marque pelo menos uma ferramenta antes de salvar' });

    const usuario = await client.query('SELECT nome, username FROM users WHERE id=$1', [req.session.userId]);
    const respNome = usuario.rows[0] ? (usuario.rows[0].nome || usuario.rows[0].username) : null;

    await client.query('BEGIN');
    const cab = await client.query(
      `INSERT INTO ferr_checklists (data, hora, turno, responsavel_id, responsavel_nome, obs, total, ok, problema, nao_encontrada, pendente)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [data, hora || new Date().toTimeString().slice(0, 8), turno || null, req.session.userId || null, respNome,
       (obs || '').trim() || null, linhas.length, cont.ok, cont.problema, cont.nao_encontrada, cont.pendente]
    );
    const cid = cab.rows[0].id;
    for (const l of linhas) {
      await client.query(
        `INSERT INTO ferr_checklist_itens (checklist_id, ferramenta_id, cod, nome, cat, loc, status_ferr, situacao, obs)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [cid, ...l]
      );
    }
    await client.query('COMMIT');
    res.json(cab.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

router.delete('/checklists/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM ferr_checklists WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ======================== INSUMOS ========================
/*
 * GET    /api/ferramentas/insumos          lista (filtros: q, status=pendente|concluido|so_entrada, mes=AAAA-MM)
 * POST   /api/ferramentas/insumos          { insumo, unidade, quantidade, data_saida, data_entrada, colaborador_id, local, obs }
 * PUT    /api/ferramentas/insumos/:id      mesmo corpo (edição completa)
 * PUT    /api/ferramentas/insumos/:id/entrada  { data_entrada }  — registra só a entrada
 * DELETE /api/ferramentas/insumos/:id
 * Ficam antes das rotas /:id para não serem capturadas por elas.
 */
const SELECT_INSUMO = `SELECT i.*, to_char(i.data_saida,'YYYY-MM-DD') AS data_saida, to_char(i.data_entrada,'YYYY-MM-DD') AS data_entrada,
  COALESCE(c.nome, i.colab_nome) AS colab_nome, u.nome AS registrado_por_nome
  FROM ferr_insumos i
  LEFT JOIN colaboradores c ON c.id = i.colaborador_id
  LEFT JOIN users u ON u.id = i.registrado_por`;
const DATA_OK = d => !d || /^\d{4}-\d{2}-\d{2}$/.test(d);

async function camposInsumo(b) {
  const insumo = String(b.insumo || '').trim();
  const quantidade = parseFloat(String(b.quantidade ?? '').replace(',', '.'));
  const data_saida = b.data_saida || null, data_entrada = b.data_entrada || null;
  if (!insumo) throw Object.assign(new Error('Informe o insumo'), { status: 400 });
  if (!Number.isFinite(quantidade) || quantidade <= 0) throw Object.assign(new Error('Informe uma quantidade maior que zero'), { status: 400 });
  if (!data_saida && !data_entrada) throw Object.assign(new Error('Informe a data de saída e/ou a data de entrada'), { status: 400 });
  if (!DATA_OK(data_saida) || !DATA_OK(data_entrada)) throw Object.assign(new Error('Data inválida'), { status: 400 });
  const colaborador_id = parseInt(b.colaborador_id) || null;
  let colab_nome = null;
  if (colaborador_id) {
    const c = await pool.query('SELECT nome FROM colaboradores WHERE id=$1', [colaborador_id]);
    colab_nome = c.rows[0] ? c.rows[0].nome : null;
  }
  return {
    insumo, quantidade, data_saida, data_entrada, colaborador_id, colab_nome,
    unidade: String(b.unidade || 'un').trim().slice(0, 20) || 'un',
    local: String(b.local || '').trim() || null,
    obs: String(b.obs || '').trim() || null
  };
}

router.get('/insumos', requireAuth, async (req, res) => {
  try {
    const { q, status, mes } = req.query;
    const params = [], where = [];
    if (q) { params.push('%' + String(q).toLowerCase() + '%'); where.push(`(LOWER(i.insumo) LIKE $${params.length} OR LOWER(COALESCE(i.obs,'')) LIKE $${params.length} OR LOWER(COALESCE(i.local,'')) LIKE $${params.length})`); }
    if (status === 'pendente')   where.push('i.data_saida IS NOT NULL AND i.data_entrada IS NULL');
    if (status === 'concluido')  where.push('i.data_saida IS NOT NULL AND i.data_entrada IS NOT NULL');
    if (status === 'so_entrada') where.push('i.data_saida IS NULL AND i.data_entrada IS NOT NULL');
    if (mes && /^\d{4}-\d{2}$/.test(mes)) { params.push(mes); where.push(`(to_char(i.data_saida,'YYYY-MM') = $${params.length} OR to_char(i.data_entrada,'YYYY-MM') = $${params.length})`); }
    const r = await pool.query(SELECT_INSUMO + (where.length ? ' WHERE ' + where.join(' AND ') : '') +
      ' ORDER BY COALESCE(i.data_saida, i.data_entrada) DESC, i.id DESC', params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/insumos', requireAuth, async (req, res) => {
  try {
    const c = await camposInsumo(req.body);
    const r = await pool.query(
      `INSERT INTO ferr_insumos (insumo, unidade, quantidade, data_saida, data_entrada, colaborador_id, colab_nome, local, obs, registrado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [c.insumo, c.unidade, c.quantidade, c.data_saida, c.data_entrada, c.colaborador_id, c.colab_nome, c.local, c.obs, req.session.userId || null]);
    res.json((await pool.query(SELECT_INSUMO + ' WHERE i.id=$1', [r.rows[0].id])).rows[0]);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.put('/insumos/:id/entrada', requireAuth, async (req, res) => {
  try {
    const d = req.body.data_entrada || new Date().toISOString().slice(0, 10);
    if (!DATA_OK(d)) return res.status(400).json({ error: 'Data inválida' });
    const r = await pool.query('UPDATE ferr_insumos SET data_entrada=$1, updated_at=NOW() WHERE id=$2 RETURNING id', [d, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Registro não encontrado' });
    res.json((await pool.query(SELECT_INSUMO + ' WHERE i.id=$1', [req.params.id])).rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/insumos/:id', requireAuth, async (req, res) => {
  try {
    const c = await camposInsumo(req.body);
    const r = await pool.query(
      `UPDATE ferr_insumos SET insumo=$1, unidade=$2, quantidade=$3, data_saida=$4, data_entrada=$5,
         colaborador_id=$6, colab_nome=$7, local=$8, obs=$9, updated_at=NOW() WHERE id=$10 RETURNING id`,
      [c.insumo, c.unidade, c.quantidade, c.data_saida, c.data_entrada, c.colaborador_id, c.colab_nome, c.local, c.obs, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Registro não encontrado' });
    res.json((await pool.query(SELECT_INSUMO + ' WHERE i.id=$1', [req.params.id])).rows[0]);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.delete('/insumos/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM ferr_insumos WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ======================== ESTOQUE INTERMEDIÁRIO (insumos) ========================
/*
 * GET    /api/ferramentas/estoque                 { saldo: [...], movimentos: [...] }
 * POST   /api/ferramentas/estoque/entradas        { codigo, descricao, quantidade, data_entrada }
 * PUT    /api/ferramentas/estoque/entradas/:id    mesmo corpo
 * DELETE /api/ferramentas/estoque/entradas/:id
 * POST   /api/ferramentas/estoque/saidas          { codigo, descricao, quantidade, colaborador_id, motivo, data_saida }
 * PUT    /api/ferramentas/estoque/saidas/:id      mesmo corpo
 * DELETE /api/ferramentas/estoque/saidas/:id
 *
 * O saldo de um código é Σ entradas − Σ baixas. Toda alteração roda numa
 * transação que trava o(s) código(s) envolvidos e é desfeita se algum saldo
 * ficar negativo — assim não dá para baixar mais do que entrou, nem apagar
 * ou reduzir uma entrada que já foi consumida.
 */
const MOTIVOS_BAIXA = ['Novo', 'Gasto', 'Quebrado', 'Perdido', 'Não se aplica'];
const chaveCod = c => String(c || '').trim().toUpperCase();
const erro400 = msg => Object.assign(new Error(msg), { status: 400 });
const fmtNum = n => Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 3 });

function camposMovEstoque(b, tipo) {
  const codigo = String(b.codigo || '').trim().slice(0, 100);
  const descricao = String(b.descricao || '').trim().slice(0, 300);
  const quantidade = parseFloat(String(b.quantidade ?? '').replace(',', '.'));
  const data = tipo === 'entrada' ? b.data_entrada : b.data_saida;
  if (!codigo) throw erro400('Informe o código');
  if (!descricao) throw erro400('Informe a descrição');
  if (!Number.isFinite(quantidade) || quantidade <= 0) throw erro400('Informe uma quantidade maior que zero');
  if (!data || !DATA_OK(data)) throw erro400(tipo === 'entrada' ? 'Informe a data de entrada' : 'Informe a data de saída');
  const c = { codigo, descricao, quantidade, data };
  if (tipo === 'saida') {
    c.motivo = MOTIVOS_BAIXA.find(m => m.toLowerCase() === String(b.motivo || '').trim().toLowerCase());
    if (!c.motivo) throw erro400('Escolha o motivo: ' + MOTIVOS_BAIXA.join(', '));
    c.colaborador_id = parseInt(b.colaborador_id) || null;
    if (!c.colaborador_id) throw erro400('Informe o operador');
  }
  return c;
}

async function saldoCodigo(client, codigo) {
  const r = await client.query(
    `SELECT COALESCE((SELECT SUM(quantidade) FROM ferr_estoque_entradas WHERE UPPER(TRIM(codigo))=$1),0)
          - COALESCE((SELECT SUM(quantidade) FROM ferr_estoque_saidas   WHERE UPPER(TRIM(codigo))=$1),0) AS saldo`,
    [chaveCod(codigo)]);
  return Number(r.rows[0].saldo);
}

/* Roda `fn` numa transação com os códigos travados; confere os saldos no fim. */
async function movimentarEstoque(codigos, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const chaves = [...new Set(codigos.filter(Boolean).map(chaveCod))].sort();
    for (const k of chaves) await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['estoque:' + k]);
    const out = await fn(client);
    for (const k of chaves) {
      const s = await saldoCodigo(client, k);
      if (s < -1e-9) {
        const disp = s + (out && out._qtdBaixa && chaveCod(out._codBaixa) === k ? out._qtdBaixa : 0);
        throw erro400(out && out._qtdBaixa && chaveCod(out._codBaixa) === k
          ? `Saldo insuficiente para o código ${k}: disponível ${fmtNum(Math.max(disp, 0))}`
          : `Não é possível: o saldo do código ${k} ficaria negativo (${fmtNum(s)}). Já houve baixas dessa entrada.`);
      }
    }
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

async function nomeColab(client, id) {
  if (!id) return null;
  const c = await client.query('SELECT nome FROM colaboradores WHERE id=$1', [id]);
  if (!c.rows.length) throw erro400('Operador não encontrado');
  return c.rows[0].nome;
}

router.get('/estoque', requireAuth, async (req, res) => {
  try {
    const saldo = await pool.query(`
      WITH mov AS (
        SELECT UPPER(TRIM(codigo)) AS chave, codigo, descricao, quantidade AS ent, 0::numeric AS sai, data_entrada AS dt_ent, NULL::date AS dt_sai, created_at, id
          FROM ferr_estoque_entradas
        UNION ALL
        SELECT UPPER(TRIM(codigo)), codigo, descricao, 0, quantidade, NULL, data_saida, created_at, id
          FROM ferr_estoque_saidas
      )
      SELECT chave,
        (ARRAY_AGG(TRIM(codigo) ORDER BY (dt_ent IS NULL), COALESCE(dt_ent, dt_sai) DESC, created_at DESC, id DESC))[1] AS codigo,
        (ARRAY_AGG(descricao    ORDER BY (dt_ent IS NULL), COALESCE(dt_ent, dt_sai) DESC, created_at DESC, id DESC))[1] AS descricao,
        SUM(ent) AS entradas, SUM(sai) AS saidas, SUM(ent) - SUM(sai) AS saldo,
        to_char(MAX(dt_ent),'YYYY-MM-DD') AS ultima_entrada, to_char(MAX(dt_sai),'YYYY-MM-DD') AS ultima_saida
      FROM mov GROUP BY chave ORDER BY chave`);
    const movimentos = await pool.query(`
      SELECT 'entrada' AS tipo, e.id, e.codigo, e.descricao, e.quantidade, to_char(e.data_entrada,'YYYY-MM-DD') AS data,
             NULL::int AS colaborador_id, NULL AS operador_nome, NULL AS motivo, e.created_at, u.nome AS registrado_por_nome
        FROM ferr_estoque_entradas e LEFT JOIN users u ON u.id = e.registrado_por
      UNION ALL
      SELECT 'saida', s.id, s.codigo, s.descricao, s.quantidade, to_char(s.data_saida,'YYYY-MM-DD'),
             s.colaborador_id, COALESCE(c.nome, s.operador_nome), s.motivo, s.created_at, u.nome
        FROM ferr_estoque_saidas s LEFT JOIN colaboradores c ON c.id = s.colaborador_id LEFT JOIN users u ON u.id = s.registrado_por
      ORDER BY data DESC, created_at DESC`);
    res.json({ saldo: saldo.rows, movimentos: movimentos.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/estoque/entradas', requireAuth, async (req, res) => {
  try {
    const c = camposMovEstoque(req.body, 'entrada');
    const r = await movimentarEstoque([c.codigo], cl => cl.query(
      `INSERT INTO ferr_estoque_entradas (codigo, descricao, quantidade, data_entrada, registrado_por)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [c.codigo, c.descricao, c.quantidade, c.data, req.session.userId || null]));
    res.json(r.rows[0]);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.put('/estoque/entradas/:id', requireAuth, async (req, res) => {
  try {
    const c = camposMovEstoque(req.body, 'entrada');
    const ant = await pool.query('SELECT codigo FROM ferr_estoque_entradas WHERE id=$1', [req.params.id]);
    if (!ant.rows.length) return res.status(404).json({ error: 'Entrada não encontrada' });
    const r = await movimentarEstoque([c.codigo, ant.rows[0].codigo], cl => cl.query(
      `UPDATE ferr_estoque_entradas SET codigo=$1, descricao=$2, quantidade=$3, data_entrada=$4, updated_at=NOW()
       WHERE id=$5 RETURNING *`, [c.codigo, c.descricao, c.quantidade, c.data, req.params.id]));
    res.json(r.rows[0]);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.delete('/estoque/entradas/:id', requireAuth, async (req, res) => {
  try {
    const ant = await pool.query('SELECT codigo FROM ferr_estoque_entradas WHERE id=$1', [req.params.id]);
    if (!ant.rows.length) return res.json({ success: true });
    await movimentarEstoque([ant.rows[0].codigo], cl => cl.query('DELETE FROM ferr_estoque_entradas WHERE id=$1', [req.params.id]));
    res.json({ success: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/estoque/saidas', requireAuth, async (req, res) => {
  try {
    const c = camposMovEstoque(req.body, 'saida');
    const r = await movimentarEstoque([c.codigo], async cl => {
      const tem = await cl.query('SELECT 1 FROM ferr_estoque_entradas WHERE UPPER(TRIM(codigo))=$1 LIMIT 1', [chaveCod(c.codigo)]);
      if (!tem.rows.length) throw erro400(`O código ${chaveCod(c.codigo)} não tem entrada no estoque. Registre a entrada antes da baixa.`);
      const nome = await nomeColab(cl, c.colaborador_id);
      const ins = await cl.query(
        `INSERT INTO ferr_estoque_saidas (codigo, descricao, quantidade, colaborador_id, operador_nome, motivo, data_saida, registrado_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [c.codigo, c.descricao, c.quantidade, c.colaborador_id, nome, c.motivo, c.data, req.session.userId || null]);
      return Object.assign(ins, { _codBaixa: c.codigo, _qtdBaixa: c.quantidade });
    });
    res.json(r.rows[0]);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.put('/estoque/saidas/:id', requireAuth, async (req, res) => {
  try {
    const c = camposMovEstoque(req.body, 'saida');
    const ant = await pool.query('SELECT codigo, quantidade FROM ferr_estoque_saidas WHERE id=$1', [req.params.id]);
    if (!ant.rows.length) return res.status(404).json({ error: 'Baixa não encontrada' });
    const r = await movimentarEstoque([c.codigo, ant.rows[0].codigo], async cl => {
      const nome = await nomeColab(cl, c.colaborador_id);
      const up = await cl.query(
        `UPDATE ferr_estoque_saidas SET codigo=$1, descricao=$2, quantidade=$3, colaborador_id=$4, operador_nome=$5,
           motivo=$6, data_saida=$7, updated_at=NOW() WHERE id=$8 RETURNING *`,
        [c.codigo, c.descricao, c.quantidade, c.colaborador_id, nome, c.motivo, c.data, req.params.id]);
      // na edição o "disponível" informado é o saldo sem esta baixa
      return Object.assign(up, { _codBaixa: c.codigo, _qtdBaixa: c.quantidade });
    });
    res.json(r.rows[0]);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.delete('/estoque/saidas/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM ferr_estoque_saidas WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ======================== FERRAMENTAS CRUD ========================

// GET /api/ferramentas
router.get('/', requireAuth, async (req, res) => {
  try { res.json((await pool.query(SELECT_FERR + ' ORDER BY nome')).rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/ferramentas/:id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(SELECT_FERR + ' WHERE id=$1', [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Nao encontrado' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/ferramentas
router.post('/', requireAuth, async (req, res) => {
  try {
    const { nome, cod, cat, loc, status, cal, prev, obs } = camposFerramenta(req.body);
    if (!nome || !cod) return res.status(400).json({ error: 'Nome e codigo obrigatorios' });
    const r = await pool.query(
      'INSERT INTO ferramentas (nome,cod,cat,loc,status,cal,prev,obs) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [nome, cod, cat||null, loc||null, status||'Disponível', cal||null, prev||null, obs||null]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/ferramentas/:id
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { nome, cod, cat, loc, status, cal, prev, obs } = camposFerramenta(req.body);
    if (!nome || !cod) return res.status(400).json({ error: 'Nome e codigo obrigatorios' });
    const r = await pool.query(
      'UPDATE ferramentas SET nome=$1,cod=$2,cat=$3,loc=$4,status=$5,cal=$6,prev=$7,obs=$8,updated_at=NOW() WHERE id=$9 RETURNING *',
      [nome, cod, cat||null, loc||null, status||'Disponível', cal||null, prev||null, obs||null, req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Nao encontrado' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/ferramentas/:id
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM ferramentas WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ======================== EMPRESTIMOS ========================

// GET /api/ferramentas/emprestimos/todos
router.get('/emprestimos/todos', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT e.*, f.nome as ferr_nome, f.cod as ferr_cod, c.nome as colab_nome,
             e.dt AS retirado_em, e.dev_dt AS devolvido_em
      FROM emprestimos e
      JOIN ferramentas f ON e.ferramenta_id = f.id
      JOIN colaboradores c ON e.colaborador_id = c.id
      ORDER BY e.created_at DESC
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/ferramentas/emprestimos
router.post('/emprestimos', requireAuth, async (req, res) => {
  try {
    const { ferramenta_id, colaborador_id, obs } = req.body;
    const dt = req.body.dt || req.body.retirado_em;
    if (!ferramenta_id || !colaborador_id || !dt) return res.status(400).json({ error: 'Campos obrigatorios' });
    const r = await pool.query(
      'INSERT INTO emprestimos (ferramenta_id,colaborador_id,dt,obs) VALUES ($1,$2,$3,$4) RETURNING *',
      [ferramenta_id, colaborador_id, dt, obs||null]
    );
    await pool.query('UPDATE ferramentas SET status=$1 WHERE id=$2', ['Em Uso', ferramenta_id]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/ferramentas/emprestimos/:id/devolver
router.put('/emprestimos/:id/devolver', requireAuth, async (req, res) => {
  try {
    const dev_dt = req.body.dev_dt || req.body.devolvido_em || new Date().toISOString().slice(0, 10);
    const r = await pool.query(
      'UPDATE emprestimos SET dev_dt=$1, devolvido=TRUE WHERE id=$2 RETURNING *',
      [dev_dt, req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Nao encontrado' });
    const emp = r.rows[0];
    const pend = await pool.query(
      'SELECT COUNT(*) FROM emprestimos WHERE ferramenta_id=$1 AND devolvido=FALSE',
      [emp.ferramenta_id]
    );
    if (parseInt(pend.rows[0].count) === 0) {
      await pool.query('UPDATE ferramentas SET status=$1 WHERE id=$2', ['Disponível', emp.ferramenta_id]);
    }
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/ferramentas/emprestimos/:id
router.delete('/emprestimos/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM emprestimos WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ======================== MANUTENCOES ========================

// GET /api/ferramentas/manutencoes/todos
router.get('/manutencoes/todos', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT m.*, f.nome as ferr_nome, f.cod as ferr_cod, c.nome as resp_nome, c.nome as colab_nome,
             m.env AS dt_envio, m.ret AS dt_retorno
      FROM manutencoes m
      JOIN ferramentas f ON m.ferramenta_id = f.id
      LEFT JOIN colaboradores c ON m.responsavel_id = c.id
      ORDER BY m.created_at DESC
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/ferramentas/manutencoes
router.post('/manutencoes', requireAuth, async (req, res) => {
  try {
    const { ferramenta_id, tipo, responsavel_id, descricao } = req.body;
    const env = req.body.env || req.body.dt_envio;
    const ret = req.body.ret || req.body.dt_retorno;
    if (!ferramenta_id || !env || !descricao) return res.status(400).json({ error: 'Campos obrigatorios' });
    const r = await pool.query(
      'INSERT INTO manutencoes (ferramenta_id,tipo,responsavel_id,env,ret,descricao) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [ferramenta_id, tipo, responsavel_id||null, env, ret||null, descricao]
    );
    if (!ret) await pool.query('UPDATE ferramentas SET status=$1 WHERE id=$2', ['Manutenção', ferramenta_id]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/ferramentas/manutencoes/:id
router.put('/manutencoes/:id', requireAuth, async (req, res) => {
  try {
    // A tela manda só { dt_retorno } ao registrar o retorno: o que não veio é mantido
    const b = req.body;
    const env = b.env !== undefined ? b.env : b.dt_envio;
    const ret = b.ret !== undefined ? b.ret : b.dt_retorno;
    const r = await pool.query(
      `UPDATE manutencoes SET
         tipo = COALESCE($1, tipo),
         responsavel_id = CASE WHEN $2::text IS NULL THEN responsavel_id ELSE NULLIF($2::text, '')::int END,
         env = COALESCE($3, env),
         ret = CASE WHEN $4::text IS NULL THEN ret ELSE NULLIF($4::text, '')::date END,
         descricao = COALESCE($5, descricao),
         updated_at = NOW()
       WHERE id = $6 RETURNING *`,
      [b.tipo ?? null, b.responsavel_id === undefined ? null : String(b.responsavel_id ?? ''),
       env || null, ret === undefined ? null : String(ret ?? ''), b.descricao ?? null, req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Nao encontrado' });
    // Voltou da manutenção: libera a ferramenta
    if (r.rows[0].ret) {
      await pool.query(
        "UPDATE ferramentas SET status='Disponível' WHERE id=$1 AND status='Manutenção'",
        [r.rows[0].ferramenta_id]
      );
    }
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/ferramentas/manutencoes/:id
router.delete('/manutencoes/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM manutencoes WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
