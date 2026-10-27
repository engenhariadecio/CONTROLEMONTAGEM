const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

/* ===================== PRODUTOS (banco de cadastro) ===================== */

// GET /api/prod-produtos
router.get('/prod-produtos', requireAuth, async (req, res) => {
  try {
    const { q, categoria } = req.query;
    let sql = 'SELECT * FROM prod_produtos WHERE 1=1';
    const params = [];
    if (q) {
      params.push('%' + q.toLowerCase() + '%');
      sql += ` AND (LOWER(cod_decio) LIKE $${params.length} OR LOWER(cod_intelbras) LIKE $${params.length} OR LOWER(descricao) LIKE $${params.length})`;
    }
    if (categoria) {
      params.push(categoria);
      sql += ` AND categoria = $${params.length}`;
    }
    sql += ' ORDER BY descricao';
    const r = await pool.query(sql, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/prod-produtos/by-decio/:cod   (lookup rápido p/ autocomplete)
router.get('/prod-produtos/by-decio/:cod', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM prod_produtos WHERE cod_decio = $1 LIMIT 1', [req.params.cod]);
    if (!r.rows.length) return res.status(404).json({ error: 'Produto não encontrado' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/prod-produtos
router.post('/prod-produtos', requireAuth, async (req, res) => {
  try {
    const { cod_decio, cod_intelbras, descricao, categoria, valor, minutos_reportados, hora_reportado } = req.body;
    if (!cod_decio || !descricao) return res.status(400).json({ error: 'cod_decio e descricao são obrigatórios' });
    const r = await pool.query(
      `INSERT INTO prod_produtos (cod_decio, cod_intelbras, descricao, categoria, valor, minutos_reportados, hora_reportado)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [cod_decio, cod_intelbras || null, descricao, categoria || null,
       valor || null, minutos_reportados || null, hora_reportado || null]
    );
    res.json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Código décio já cadastrado' });
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/prod-produtos/:id
router.put('/prod-produtos/:id', requireAuth, async (req, res) => {
  try {
    const { cod_decio, cod_intelbras, descricao, categoria, valor, minutos_reportados, hora_reportado } = req.body;
    const r = await pool.query(
      `UPDATE prod_produtos SET cod_decio=$1, cod_intelbras=$2, descricao=$3, categoria=$4,
       valor=$5, minutos_reportados=$6, hora_reportado=$7, updated_at=NOW()
       WHERE id=$8 RETURNING *`,
      [cod_decio, cod_intelbras || null, descricao, categoria || null,
       valor || null, minutos_reportados || null, hora_reportado || null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Não encontrado' });
    res.json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Código décio já cadastrado' });
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/prod-produtos/:id
router.delete('/prod-produtos/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM prod_produtos WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ===================== ESTRUTURA DO PRODUTO ===================== */
/*
 * GET    /api/prod-produtos/:id/estrutura           { produto, itens }
 * POST   /api/prod-produtos/:id/estrutura           { tipo, ...colunas }  → nova linha
 * POST   /api/prod-produtos/:id/estrutura/copiar    { de_produto_id, tipos: [...] }
 * PUT    /api/prod-produtos/:id/estrutura/ordem     { tipo, ids: [...] }
 * GET    /api/prod-estrutura-resumo                 { produto_id: { subitem: n, ..., alertas_ativos: n } }
 * GET    /api/prod-estrutura-listas                 valores já usados (categorias, postos, unidades...)
 * PUT    /api/prod-estrutura/:id                    { ...colunas }
 * DELETE /api/prod-estrutura/:id
 */
const TIPOS_ESTRUTURA = ['subitem', 'agregado', 'ferramenta', 'alerta', 'nc'];
const COLUNAS_ESTRUTURA = ['categoria', 'codigo', 'descricao', 'quantidade', 'unidade', 'posto',
  'nivel', 'data', 'causa', 'acao', 'responsavel', 'situacao', 'obs'];
const SELECT_ESTRUTURA = `SELECT e.*, to_char(e.data,'YYYY-MM-DD') AS data, u.nome AS atualizado_por_nome
  FROM prod_estrutura e LEFT JOIN users u ON u.id = e.atualizado_por`;

function erro400(msg) { return Object.assign(new Error(msg), { status: 400 }); }

function camposEstrutura(b) {
  const c = {};
  for (const k of COLUNAS_ESTRUTURA) {
    let v = b[k];
    if (v === undefined || v === null) { c[k] = null; continue; }
    v = String(v).trim();
    if (k === 'quantidade') {
      if (v === '') { c[k] = null; continue; }
      // aceita "1.234,5" (Excel em português) e "1234.5"
      const n = Number(v.includes(',') ? v.replace(/\./g, '').replace(',', '.') : v);
      if (!Number.isFinite(n) || n < 0) throw erro400('Quantidade inválida: ' + v);
      c[k] = n;
    } else if (k === 'data') {
      if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw erro400('Data inválida: ' + v);
      c[k] = v || null;
    } else c[k] = v || null;
  }
  return c;
}

router.get('/prod-estrutura-resumo', requireAuth, async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT produto_id, tipo, COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE tipo='alerta' AND COALESCE(situacao,'Ativo') <> 'Encerrado')::int AS alertas_ativos,
              COUNT(*) FILTER (WHERE tipo='nc' AND COALESCE(situacao,'Aberta') <> 'Encerrada')::int AS nc_abertas
         FROM prod_estrutura GROUP BY produto_id, tipo`);
    const out = {};
    r.rows.forEach(x => {
      const o = out[x.produto_id] = out[x.produto_id] || { alertas_ativos: 0, nc_abertas: 0 };
      o[x.tipo] = x.n; o.alertas_ativos += x.alertas_ativos; o.nc_abertas += x.nc_abertas;
    });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/prod-estrutura-listas', requireAuth, async (_req, res) => {
  try {
    const dist = async (col, extra = '') => (await pool.query(
      `SELECT DISTINCT ${col} AS v FROM prod_estrutura WHERE ${col} IS NOT NULL AND ${col} <> '' ${extra} ORDER BY 1 LIMIT 500`)).rows.map(x => x.v);
    /* itens já usados em alguma estrutura: código → última descrição/categoria/unidade (autopreenchimento) */
    const itens = (await pool.query(
      `SELECT DISTINCT ON (tipo, codigo) tipo, codigo, descricao, categoria, unidade
         FROM prod_estrutura WHERE codigo IS NOT NULL AND codigo <> '' AND tipo IN ('subitem','agregado','ferramenta')
        ORDER BY tipo, codigo, updated_at DESC LIMIT 3000`)).rows;
    const celulas = (await pool.query('SELECT nome FROM celulas ORDER BY nome')).rows.map(x => x.nome);
    res.json({
      categorias: await dist('categoria'),
      postos: [...new Set([...celulas, ...(await dist('posto'))])],
      unidades: await dist('unidade'),
      responsaveis: await dist('responsavel'),
      itens
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/prod-produtos/:id/estrutura', requireAuth, async (req, res) => {
  try {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'ID inválido' });
    const p = await pool.query('SELECT * FROM prod_produtos WHERE id=$1', [req.params.id]);
    if (!p.rows.length) return res.status(404).json({ error: 'Produto não encontrado' });
    const itens = await pool.query(SELECT_ESTRUTURA + ' WHERE e.produto_id=$1 ORDER BY e.tipo, e.ordem, e.id', [req.params.id]);
    res.json({ produto: p.rows[0], itens: itens.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/prod-produtos/:id/estrutura', requireAuth, async (req, res) => {
  try {
    const tipo = req.body.tipo;
    if (!TIPOS_ESTRUTURA.includes(tipo)) return res.status(400).json({ error: 'Tipo inválido' });
    const c = camposEstrutura(req.body);
    const p = await pool.query('SELECT id FROM prod_produtos WHERE id=$1', [req.params.id]);
    if (!p.rows.length) return res.status(404).json({ error: 'Produto não encontrado' });
    const ord = await pool.query('SELECT COALESCE(MAX(ordem),0)+1 AS o FROM prod_estrutura WHERE produto_id=$1 AND tipo=$2', [req.params.id, tipo]);
    const cols = COLUNAS_ESTRUTURA;
    const r = await pool.query(
      `INSERT INTO prod_estrutura (produto_id, tipo, ordem, ${cols.join(',')}, atualizado_por)
       VALUES ($1,$2,$3,${cols.map((_, i) => '$' + (i + 4)).join(',')},$${cols.length + 4}) RETURNING id`,
      [req.params.id, tipo, ord.rows[0].o, ...cols.map(k => c[k]), req.session.userId || null]);
    res.json((await pool.query(SELECT_ESTRUTURA + ' WHERE e.id=$1', [r.rows[0].id])).rows[0]);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/prod-produtos/:id/estrutura/copiar', requireAuth, async (req, res) => {
  try {
    const de = parseInt(req.body.de_produto_id);
    const tipos = (Array.isArray(req.body.tipos) ? req.body.tipos : []).filter(t => TIPOS_ESTRUTURA.includes(t));
    if (!de || String(de) === String(req.params.id)) return res.status(400).json({ error: 'Escolha outro produto de origem' });
    if (!tipos.length) return res.status(400).json({ error: 'Escolha o que copiar' });
    const cols = ['tipo', ...COLUNAS_ESTRUTURA];
    const r = await pool.query(
      `INSERT INTO prod_estrutura (produto_id, ordem, ${cols.join(',')}, atualizado_por)
       SELECT $1, ordem + COALESCE((SELECT MAX(ordem) FROM prod_estrutura d WHERE d.produto_id=$1 AND d.tipo=s.tipo), 0),
              ${cols.map(c => 's.' + c).join(',')}, $4
         FROM prod_estrutura s WHERE s.produto_id=$2 AND s.tipo = ANY($3::text[]) ORDER BY s.tipo, s.ordem, s.id`,
      [req.params.id, de, tipos, req.session.userId || null]);
    res.json({ success: true, copiadas: r.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/prod-produtos/:id/estrutura/ordem', requireAuth, async (req, res) => {
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(Boolean);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < ids.length; i++) {
      await client.query('UPDATE prod_estrutura SET ordem=$1 WHERE id=$2 AND produto_id=$3', [i + 1, ids[i], req.params.id]);
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

router.put('/prod-estrutura/:id', requireAuth, async (req, res) => {
  try {
    const c = camposEstrutura(req.body);
    const cols = COLUNAS_ESTRUTURA;
    const r = await pool.query(
      `UPDATE prod_estrutura SET ${cols.map((k, i) => `${k}=$${i + 1}`).join(', ')},
              atualizado_por=$${cols.length + 1}, updated_at=NOW()
        WHERE id=$${cols.length + 2} RETURNING id`,
      [...cols.map(k => c[k]), req.session.userId || null, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Linha não encontrada' });
    res.json((await pool.query(SELECT_ESTRUTURA + ' WHERE e.id=$1', [req.params.id])).rows[0]);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.delete('/prod-estrutura/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM prod_estrutura WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ============== IMPORTAÇÃO INICIAL (banco da planilha) ============== */

const SEED_PRODUTOS = [
  ['4531411','4770068','PATCH PANEL PPD24','Parede',50.73,null,null],
  ['4531412','4770069','PATCH PANEL PPDB24','Parede',52.66,null,null],
  ['4531043','4770019','RACK MRD 3U 470MM','Parede',354.36,16.294,0.271567],
  ['4531042','4770021','RACK MRD 5U 470MM','Parede',386.51,16.139,0.268983],
  ['4531033','4770020','RACK MRD 8U 470MM','Parede',454.35,16.373,0.272883],
  ['4531040','4770022','RACK MRD 12U 470MM','Parede',474.09,17.048,0.284133],
  ['4530772','4770357','RACK MRD BS 3U','Parede',359.54,16.294,0.271567],
  ['4530732','4770557','RACK MRD BS 5U','Parede',381.41,14.767,0.246117],
  ['4530773','4770857','RACK MRD BS 8U','Parede',444.68,16.94,0.282333],
  ['4530733','4771257','RACK MRD BS 12U','Parede',493.39,17.04,0.284],
  ['4530923','4770016','RACK 24U TORRE','Piso',300.82,13.002,0.2167],
  ['4530921','4770015','RACK 36U TORRE','Piso',330.8,6.83,0.113833],
  ['4530718','4770014','RACK 44U TORRE','Piso',402.59,10,0.166667],
  ['4531267','4771657','RACK RPD PA 1657','Piso',1015.27,40.305,0.67175],
  ['4531268','4772057','RACK RPD PA 2057','Piso',1301.88,39.763,0.662717],
  ['4531400','4770066','RACK RPD PA 2457','Piso',1533.45,49.818,0.8303],
  ['4531401','4770065','RACK RPD PA 2857','Piso',1935.61,null,null],
  ['4531391','4770064','RACK RPD PA 3257','Piso',1941.15,56.904,0.9484],
  ['4531396','4770063','RACK RPD PA 3657','Piso',2005.37,57.316,0.955267],
  ['4531397','4770062','RACK RPD PA 4057','Piso',2090.07,null,null],
  ['4531395','4770061','RACK RPD PA 4457','Piso',2142.39,null,null],
  ['4531398','4770067','RACK RPD PP 4457','Piso',2519.59,65.424,1.0904],
  ['4531402','4770060','RACK RPD PA 1667','Piso',1202.98,null,null],
  ['4531403','4770059','RACK RPD PA 2067','Piso',1342.09,null,null],
  ['4531269','4772467','RACK RPD PA 2467','Piso',1313.32,46.886,0.781433],
  ['4531408','4770055','RACK RPD PA 2867','Piso',1894.38,null,null],
  ['4531405','4770054','RACK RPD PA 3267','Piso',1973.86,55.676,0.927933],
  ['4531270','4773667','RACK RPD PA 3667','Piso',1947.61,52.43,0.873833],
  ['4531404','4770042','RACK RPD PA 4067','Piso',2167.83,null,null],
  ['4531271','4774467','RACK RPD PA 4467','Piso',2088.11,67.105,1.11842],
  ['4531258','4770028','RACK RPD PP 4467','Piso',2410.85,63.788,1.06313],
  ['4531469','4770073','RACK RPD PA 2487','Piso',1634.98,64.8,1.08],
  ['4531472','4770074','RACK RPD PA 2887','Piso',1967.58,null,null],
  ['4531471','4770072','RACK RPD PA 3287','Piso',2127.69,null,null],
  ['4531470','4770075','RACK RPD PA 3687','Piso',2080.87,null,null],
  ['4531474','4770076','RACK RPD PA 4087','Piso',2150.95,null,null],
  ['4531478','4770078','RACK RPD PA 4487','Piso',2145.61,70.067,1.16778],
  ['4531475','4770079','RACK RPD PP 4487','Piso',2333.52,null,null],
  ['4531473','4770081','RACK RPD PA 3217','Piso',2398.31,null,null],
  ['4531476','4770080','RACK RPD PA 3617','Piso',2400.29,65.953,1.09922],
  ['4531477','4770077','RACK RPD PA 4017','Piso',2424.54,75.083,1.25138],
  ['4531257','4770027','RACK RPD PA 4417','Piso',2742.21,107.186,1.78643],
  ['4531286','4770026','RACK RPD PP 4417','Piso',2640.72,106.231,1.77052],
  ['4530885','4770018','ORG CABOS VERTICAL 36U','Piso',161.88,6.096,0.1016],
  ['4530829','4770017','ORG CABOS VERTICAL 44U','Piso',184.65,2.25,0.0375],
  ['4531281','4770038','RACK ESTRUTURA 4495','Piso',779.79,null,null],
  ['4531442','4770070','RACK ENTERPRISE','Piso',6401.49,242.185,4.03642],
  ['4531459','4770071','RACK ENTERPRISE ABERTO','Piso',2863.59,35.78,0.596333],
  ['4531024','4770024','BANDEJA FIXA 800','Acessórios',112.1,4.515,0.07525],
  ['4530041','4770001','BAND FIXA 400','Acessórios',73.96,3.146,0.0524333],
  ['4530036','4770003','BAND FIXA 290','Acessórios',47.98,2.039,0.0339833],
  ['4531031','4770023','TELESC 800','Acessórios',210.78,4,0.0666667],
  ['4530033','4770002','TELESC 400','Acessórios',101.36,4.417,0.0736167],
  ['4530040','4770004','ORG CABOS 40mm','Acessórios',38,1.436,0.0239333],
  ['4530034','9003520','ORG CABOS 80mm','Acessórios',46.23,1.437,0.02395],
  ['4530319','4770012','BAND CHANTELIER','Acessórios',85.25,3.964,0.0660667],
  ['4531183','4770025','CONJUNTO FRENTE FALSA','Acessórios',119.9,2.653,0.0442167],
  ['4531560','4770083','CONJUNTO FRENTE FALSA ( 05 UNID )','Acessórios',57.31,0.417,0.00695],
  ['4530344','4770337','RACK MONTADO 3U','Parede',159.41,8.291,0.138183],
  ['4530345','4770537','RACK MONTADO 5U','Parede',174.29,8.291,0.138183],
  ['4531224','4770029','CAIXA ORG. PRETA','Parede',115.1,5.855,0.0975833],
  ['4531262','4770035','CAIXA ORG. BRANCA','Parede',119.4,5.855,0.0975833],
  ['4531325','4770040','RACK 5U BS OUTDOOR','Luiz',625.89,31.262,0.521033],
  ['4531326','4770039','RACK 8U BS OUTDOOR','Luiz',770.04,null,null],
  ['4531280','4770041','RACK 12U BS OUTDOOR','Luiz',935.05,36.12,0.602]
];

// POST /api/prod-produtos/seed   -> insere os 65 da planilha (não duplica)
router.post('/prod-produtos/seed', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    let inseridos = 0, ignorados = 0;
    for (const p of SEED_PRODUTOS) {
      const exists = await client.query('SELECT id FROM prod_produtos WHERE cod_decio=$1', [p[0]]);
      if (exists.rows.length) { ignorados++; continue; }
      await client.query(
        `INSERT INTO prod_produtos (cod_decio,cod_intelbras,descricao,categoria,valor,minutos_reportados,hora_reportado)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        p
      );
      inseridos++;
    }
    res.json({ success: true, inseridos, ignorados });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

module.exports = router;
