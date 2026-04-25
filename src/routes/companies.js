const express = require('express');
const router = express.Router();
const pool = require('../models/db');
const authMiddleware = require('../middleware/auth');

router.use(authMiddleware);

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM companies WHERE client_id = $1 ORDER BY created_at ASC',
      [req.client.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar empresas' });
  }
});

router.post('/', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Nome obrigatorio' });
  try {
    const result = await pool.query(
      'INSERT INTO companies (client_id, name) VALUES ($1, $2) RETURNING *',
      [req.client.id, name]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar empresa' });
  }
});

router.put('/:id', async (req, res) => {
  const { name } = req.body;
  try {
    const result = await pool.query(
      'UPDATE companies SET name = $1 WHERE id = $2 AND client_id = $3 RETURNING *',
      [name, req.params.id, req.client.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Empresa nao encontrada' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar empresa' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM companies WHERE id = $1 AND client_id = $2 RETURNING id',
      [req.params.id, req.client.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Empresa nao encontrada' });
    res.json({ message: 'Empresa removida' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover empresa' });
  }
});

module.exports = router;