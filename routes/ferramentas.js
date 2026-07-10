const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

// ======================== CHECKLIST FERRAMENTAS ========================

// GET /api/ferramentas/checklist?data=2026-05-08
router.get('/checklist', requireAuth, async (req, res) => {
  try {
    const data = req.query.data || new Date().toISOString().slice(0, 10);
    const r = await pool.query(
      `SELECT cf.*, f.nome as ferr_nome, f.cod as ferr_cod, f.cat as ferr_cat, f.loc as ferr_loc
       FROM checklist_ferramentas cf
       JOIN ferramentas f ON cf.ferramenta_id = f.id
       WHERE cf.data = $1`,
      [data]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/ferramentas/checklist
router.post('/checklist', requireAuth, async (req, res) => {
  try {
    const { ferramenta_id, checked, obs, data } = req.body;
    const d = data || new Date().toISOString().slice(0, 10);
    const r = await pool.query(
      `INSERT INTO checklist_ferramentas (ferramenta_id,checked,obs,data)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (ferramenta_id,data) DO UPDATE SET checked=$2, obs=$3, updated_at=NOW()
       RETURNING *`,
      [ferramenta_id, checked||false, obs||null, d]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ======================== FERRAMENTAS CRUD ========================

// GET /api/ferramentas
router.get('/', requireAuth, async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM ferramentas ORDER BY nome')).rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/ferramentas/:id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM ferramentas WHERE id=$1', [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Nao encontrado' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/ferramentas
router.post('/', requireAuth, async (req, res) => {
  try {
    const { nome, cod, cat, loc, status, cal, prev, obs, foto } = req.body;
    if (!nome || !cod) return res.status(400).json({ error: 'Nome e codigo obrigatorios' });
    const r = await pool.query(
      'INSERT INTO ferramentas (nome,cod,cat,loc,status,cal,prev,obs,foto) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [nome, cod, cat||null, loc||null, status||'Disponível', cal||null, prev||null, obs||null, foto||null]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/ferramentas/:id
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { nome, cod, cat, loc, status, cal, prev, obs, foto } = req.body;
    const r = await pool.query(
      'UPDATE ferramentas SET nome=$1,cod=$2,cat=$3,loc=$4,status=$5,cal=$6,prev=$7,obs=$8,foto=$9,updated_at=NOW() WHERE id=$10 RETURNING *',
      [nome, cod, cat, loc, status, cal||null, prev||null, obs, foto, req.params.id]
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
      SELECT e.*, f.nome as ferr_nome, f.cod as ferr_cod, c.nome as colab_nome
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
    const { ferramenta_id, colaborador_id, dt, obs } = req.body;
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
    const { dev_dt } = req.body;
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
      SELECT m.*, f.nome as ferr_nome, f.cod as ferr_cod, c.nome as resp_nome
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
    const { ferramenta_id, tipo, responsavel_id, env, ret, descricao } = req.body;
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
    const { tipo, responsavel_id, env, ret, descricao } = req.body;
    const r = await pool.query(
      'UPDATE manutencoes SET tipo=$1,responsavel_id=$2,env=$3,ret=$4,descricao=$5,updated_at=NOW() WHERE id=$6 RETURNING *',
      [tipo, responsavel_id||null, env, ret||null, descricao, req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Nao encontrado' });
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
