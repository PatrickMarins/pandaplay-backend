const express = require('express');
const router = express.Router();
const pool = require('../models/db');
const authMiddleware = require('../middleware/auth');

router.use(authMiddleware);

router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM playlists WHERE client_id = $1 ORDER BY created_at DESC', [req.client.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar playlists' });
  }
});

router.post('/', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Nome da playlist é obrigatório' });
  try {
    const result = await pool.query('INSERT INTO playlists (client_id, name) VALUES ($1, $2) RETURNING *', [req.client.id, name]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar playlist' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const playlist = await pool.query('SELECT * FROM playlists WHERE id = $1 AND client_id = $2', [req.params.id, req.client.id]);
    if (playlist.rows.length === 0) return res.status(404).json({ error: 'Playlist não encontrada' });
    const items = await pool.query(
      `SELECT pi.*, m.filename, m.url, m.type, m.duration FROM playlist_items pi JOIN media m ON pi.media_id = m.id WHERE pi.playlist_id = $1 ORDER BY pi.position ASC`,
      [req.params.id]
    );
    res.json({ ...playlist.rows[0], items: items.rows });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar playlist' });
  }
});

router.post('/:id/items', async (req, res) => {
  const { media_id, position, duration_override } = req.body;
  if (!media_id) return res.status(400).json({ error: 'media_id é obrigatório' });
  try {
    const playlist = await pool.query('SELECT id FROM playlists WHERE id = $1 AND client_id = $2', [req.params.id, req.client.id]);
    if (playlist.rows.length === 0) return res.status(404).json({ error: 'Playlist não encontrada' });
    const result = await pool.query(
      'INSERT INTO playlist_items (playlist_id, media_id, position, duration_override) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.params.id, media_id, position || 0, duration_override || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao adicionar item' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM playlists WHERE id = $1 AND client_id = $2 RETURNING id', [req.params.id, req.client.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Playlist não encontrada' });
    res.json({ message: 'Playlist removida' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover playlist' });
  }
});

module.exports = router;
