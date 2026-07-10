const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

// ======================== TREINAMENTOS CRUD ========================

router.get('/treinamentos', requireAuth, async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM treinamentos ORDER BY nome')).rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/treinamentos', requireAuth, async (req, res) => {
  try {
    const { nome, categoria, carga_horaria, validade_meses, descricao } = req.body;
    if (!nome) return res.status(400).json({ error: 'Nome obrigatorio' });
    const r = await pool.query(
      'INSERT INTO treinamentos (nome,categoria,carga_horaria,validade_meses,descricao) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [nome, categoria||null, carga_horaria||0, validade_meses||0, descricao||null]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/treinamentos/:id', requireAuth, async (req, res) => {
  try {
    const { nome, categoria, carga_horaria, validade_meses, descricao } = req.body;
    const r = await pool.query(
      'UPDATE treinamentos SET nome=$1,categoria=$2,carga_horaria=$3,validade_meses=$4,descricao=$5,updated_at=NOW() WHERE id=$6 RETURNING *',
      [nome, categoria, carga_horaria, validade_meses, descricao, req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Nao encontrado' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/treinamentos/:id', requireAuth, async (req, res) => {
  try { await pool.query('DELETE FROM treinamentos WHERE id=$1', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ======================== REGISTROS ========================

router.get('/tr-registros', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT r.*, c.nome as colab_nome, t.nome as treino_nome, t.validade_meses
      FROM tr_registros r
      JOIN colaboradores c ON r.colaborador_id = c.id
      JOIN treinamentos t ON r.treinamento_id = t.id
      ORDER BY r.data DESC
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/tr-registros', requireAuth, async (req, res) => {
  try {
    const { colaborador_id, treinamento_id, data, validade, instrutor, local_treino, obs, presenca_id } = req.body;
    if (!colaborador_id || !treinamento_id || !data) return res.status(400).json({ error: 'Campos obrigatorios' });
    const r = await pool.query(
      'INSERT INTO tr_registros (colaborador_id,treinamento_id,data,validade,instrutor,local_treino,obs,presenca_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [colaborador_id, treinamento_id, data, validade||null, instrutor||null, local_treino||null, obs||null, presenca_id||null]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/tr-registros/:id', requireAuth, async (req, res) => {
  try { await pool.query('DELETE FROM tr_registros WHERE id=$1', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ======================== PRESENCAS ========================

router.get('/tr-presencas', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT p.*, t.nome as treino_nome FROM tr_presencas p
      JOIN treinamentos t ON p.treinamento_id = t.id ORDER BY p.data DESC
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/tr-presencas', requireAuth, async (req, res) => {
  try {
    const { treinamento_id, data, instrutor, local_treino, lista } = req.body;
    if (!treinamento_id || !data) return res.status(400).json({ error: 'Campos obrigatorios' });
    const r = await pool.query(
      'INSERT INTO tr_presencas (treinamento_id,data,instrutor,local_treino,lista) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [treinamento_id, data, instrutor||null, local_treino||null, JSON.stringify(lista||[])]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/tr-presencas/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM tr_registros WHERE presenca_id=$1', [req.params.id]);
    await pool.query('DELETE FROM tr_presencas WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ======================== AGENDA ========================

router.get('/tr-agenda', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT a.*, t.nome as treino_nome FROM tr_agenda a
      JOIN treinamentos t ON a.treinamento_id = t.id ORDER BY a.data
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/tr-agenda', requireAuth, async (req, res) => {
  try {
    const { treinamento_id, data, hora, local_treino, obs } = req.body;
    if (!treinamento_id || !data) return res.status(400).json({ error: 'Campos obrigatorios' });
    const r = await pool.query(
      'INSERT INTO tr_agenda (treinamento_id,data,hora,local_treino,obs) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [treinamento_id, data, hora||null, local_treino||null, obs||null]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/tr-agenda/:id', requireAuth, async (req, res) => {
  try { await pool.query('DELETE FROM tr_agenda WHERE id=$1', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
