const express = require('express');
const router = express.Router();
const pool = require('../models/db');
const authMiddleware = require('../middleware/auth');

router.post('/activate', async (req, res) => {
  const { activation_code } = req.body;
  if (!activation_code) return res.status(400).json({ error: 'Codigo de ativacao obrigatorio' });
  try {
    const result = await pool.query(
      'UPDATE screens SET status = $1, last_seen = NOW() WHERE activation_code = $2 RETURNING id, name, client_id',
      ['online', activation_code]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Codigo invalido' });
    res.json({ screen: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao ativar tela' });
  }
});

router.get('/:id/content', async (req, res) => {
  try {
    const sp = await pool.query(
      'SELECT playlist_id FROM screen_playlists WHERE screen_id = $1 LIMIT 1',
      [req.params.id]
    );
    if (sp.rows.length === 0) return res.json({ items: [] });
    const items = await pool.query(
      `SELECT pi.*, m.filename, m.url, m.type, m.duration 
       FROM playlist_items pi 
       JOIN media m ON pi.media_id = m.id 
       WHERE pi.playlist_id = $1 
       ORDER BY pi.position ASC`,
      [sp.rows[0].playlist_id]
    );
    res.json({ items: items.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar conteudo' });
  }
});

router.use(authMiddleware);

router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM screens WHERE client_id = $1 ORDER BY created_at DESC', [req.client.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar telas' });
  }
});

router.post('/', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Nome da tela e obrigatorio' });
  const activation_code = Math.random().toString(36).substring(2, 6).toUpperCase() + '-' + Math.floor(1000 + Math.random() * 9000);
  try {
    const result = await pool.query(
      'INSERT INTO screens (client_id, name, activation_code) VALUES ($1, $2, $3) RETURNING *',
      [req.client.id, name, activation_code]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar tela' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM screens WHERE id = $1 AND client_id = $2 RETURNING id', [req.params.id, req.client.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Tela nao encontrada' });
    res.json({ message: 'Tela removida com sucesso' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover tela' });
  }
});

module.exports = router;