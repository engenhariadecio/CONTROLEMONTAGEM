const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

/*
 * LINHA DE PRODUÇÃO — quais células funcionam em cada dia e qual produto roda em cada uma.
 *
 * GET    /api/linha-producao?data=AAAA-MM-DD        programação de um dia
 * GET    /api/linha-producao?de=...&ate=...          programação de um período (histórico)
 *        filtros opcionais: celula, cod_decio, funcionando=true|false
 * GET    /api/linha-producao/dias?de=...&ate=...     dias que têm programação (com contagem)
 * PUT    /api/linha-producao/dia/:data               salva o dia inteiro { celulas: [...] }
 * DELETE /api/linha-producao/dia/:data               apaga a programação do dia
 *
 * O PCP só lê (middleware restringirPcp bloqueia PUT/DELETE).
 */

const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;

router.get('/linha-producao/dias', requireAuth, async (req, res) => {
  try {
    const { de, ate } = req.query;
    if (!DATA_RE.test(de || '') || !DATA_RE.test(ate || '')) return res.status(400).json({ error: 'Informe de e ate (AAAA-MM-DD)' });
    const r = await pool.query(
      `SELECT to_char(data,'YYYY-MM-DD') AS data,
              COUNT(*) FILTER (WHERE funcionando)::int AS funcionando,
              COUNT(*)::int AS total
         FROM linha_producao WHERE data BETWEEN $1 AND $2
        GROUP BY data ORDER BY data`, [de, ate]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/linha-producao', requireAuth, async (req, res) => {
  try {
    const { data, de, ate, celula, cod_decio, funcionando } = req.query;
    const params = [], where = [];
    if (data) {
      if (!DATA_RE.test(data)) return res.status(400).json({ error: 'Data inválida' });
      params.push(data); where.push(`l.data = $${params.length}`);
    } else {
      if (!DATA_RE.test(de || '') || !DATA_RE.test(ate || '')) return res.status(400).json({ error: 'Informe data, ou de e ate (AAAA-MM-DD)' });
      params.push(de, ate); where.push(`l.data BETWEEN $1 AND $2`);
    }
    if (celula) { params.push(celula); where.push(`l.celula_nome = $${params.length}`); }
    if (cod_decio) { params.push(cod_decio); where.push(`l.cod_decio = $${params.length}`); }
    if (funcionando === 'true' || funcionando === 'false') { params.push(funcionando === 'true'); where.push(`l.funcionando = $${params.length}`); }
    /* realizado/horas: o que foi apontado no Plano de Produção para essa célula nesse dia */
    const r = await pool.query(
      `SELECT l.*, to_char(l.data,'YYYY-MM-DD') AS data,
              c.categoria AS celula_categoria, c.ativa AS celula_ativa,
              p.hora_reportado,
              COALESCE(a.realizado, 0) AS realizado_dia,
              COALESCE(a.horas, 0) AS horas_dia,
              COALESCE(a.apontamentos, 0) AS apontamentos_dia,
              u.nome AS registrado_por_nome
         FROM linha_producao l
         LEFT JOIN celulas c ON c.id = l.celula_id
         LEFT JOIN prod_produtos p ON p.id = l.produto_id
         LEFT JOIN users u ON u.id = l.registrado_por
         LEFT JOIN LATERAL (
           SELECT SUM(realizado) AS realizado, SUM(hora_reportada_total) AS horas, COUNT(*)::int AS apontamentos
             FROM prod_apontamentos_detalhados ap
            WHERE ap.data_execucao = l.data AND ap.celula = l.celula_nome
         ) a ON TRUE
        WHERE ${where.join(' AND ')}
        ORDER BY l.data DESC, l.celula_nome`, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function numOuNull(v, inteiro) {
  if (v === '' || v === null || v === undefined) return null;
  const n = inteiro ? parseInt(v, 10) : parseFloat(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

router.put('/linha-producao/dia/:data', requireAuth, async (req, res) => {
  const data = req.params.data;
  if (!DATA_RE.test(data)) return res.status(400).json({ error: 'Data inválida' });
  const lista = Array.isArray(req.body.celulas) ? req.body.celulas : null;
  if (!lista) return res.status(400).json({ error: 'Envie a lista de células do dia' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const nomes = [];
    for (const it of lista) {
      const nome = String(it.celula_nome || '').trim();
      if (!nome) continue;
      if (nomes.includes(nome)) continue;
      nomes.push(nome);
      const funcionando = it.funcionando !== false;
      const num_op = String(it.num_op || '').replace(/\D/g, '');
      if (num_op && num_op.length !== 8) throw Object.assign(new Error(`OP da ${nome} deve ter 8 dígitos (ou ficar em branco)`), { status: 400 });

      // produto: confere no cadastro pelo código Décio
      let prod = null;
      const cod = String(it.cod_decio || '').trim();
      if (funcionando && cod) {
        const p = await client.query('SELECT id, cod_decio, cod_intelbras, descricao FROM prod_produtos WHERE cod_decio=$1', [cod]);
        prod = p.rows[0] || { id: null, cod_decio: cod, cod_intelbras: it.cod_intelbras || null, descricao: it.descricao || null };
      }
      const cel = await client.query('SELECT id FROM celulas WHERE nome=$1', [nome]);
      const turno = ['1', '2', '3'].includes(String(it.turno)) ? String(it.turno) : null;

      await client.query(
        `INSERT INTO linha_producao
           (data, celula_id, celula_nome, funcionando, produto_id, cod_decio, cod_intelbras, descricao,
            num_op, turno, operadores, horas_operador, meta, obs, registrado_por, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
         ON CONFLICT (data, celula_nome) DO UPDATE SET
           celula_id=EXCLUDED.celula_id, funcionando=EXCLUDED.funcionando, produto_id=EXCLUDED.produto_id,
           cod_decio=EXCLUDED.cod_decio, cod_intelbras=EXCLUDED.cod_intelbras, descricao=EXCLUDED.descricao,
           num_op=EXCLUDED.num_op, turno=EXCLUDED.turno, operadores=EXCLUDED.operadores,
           horas_operador=EXCLUDED.horas_operador, meta=EXCLUDED.meta, obs=EXCLUDED.obs,
           registrado_por=EXCLUDED.registrado_por, updated_at=NOW()`,
        [data, cel.rows[0] ? cel.rows[0].id : null, nome, funcionando,
         prod ? prod.id : null, prod ? prod.cod_decio : null, prod ? prod.cod_intelbras : null, prod ? prod.descricao : null,
         funcionando ? (num_op || null) : null, turno,
         numOuNull(it.operadores, true), numOuNull(it.horas_operador), funcionando ? numOuNull(it.meta) : null,
         String(it.obs || '').trim() || null, req.session.userId || null]);
    }
    // célula que saiu da lista deixa de ter programação nesse dia
    await client.query('DELETE FROM linha_producao WHERE data=$1 AND NOT (celula_nome = ANY($2::text[]))', [data, nomes]);
    await client.query('COMMIT');
    res.json({ success: true, celulas: nomes.length });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(e.status || 500).json({ error: e.message });
  } finally { client.release(); }
});

router.delete('/linha-producao/dia/:data', requireAuth, async (req, res) => {
  try {
    if (!DATA_RE.test(req.params.data)) return res.status(400).json({ error: 'Data inválida' });
    const r = await pool.query('DELETE FROM linha_producao WHERE data=$1', [req.params.data]);
    res.json({ success: true, removidas: r.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
