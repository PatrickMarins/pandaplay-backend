const express = require('express');
const router = express.Router();
const pool = require('../models/db');
const authMiddleware = require('../middleware/auth');

router.use(authMiddleware);

router.get('/', async (req, res) => {
  const { company_id } = req.query;
  try {
    let query = 'SELECT * FROM playlists WHERE client_id = $1';
    const params = [req.client.id];
    if (company_id) { query += ' AND company_id = $2'; params.push(company_id); }
    query += ' ORDER BY created_at DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar playlists' });
  }
});

router.post('/', async (req, res) => {
  const { name, company_id } = req.body;
  if (!name) return res.status(400).json({ error: 'Nome obrigatorio' });
  try {
    const result = await pool.query(
      'INSERT INTO playlists (client_id, company_id, name) VALUES ($1, $2, $3) RETURNING *',
      [req.client.id, company_id || null, name]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar playlist' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const playlist = await pool.query('SELECT * FROM playlists WHERE id = $1 AND client_id = $2', [req.params.id, req.client.id]);
    if (playlist.rows.length === 0) return res.status(404).json({ error: 'Playlist nao encontrada' });
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
  if (!media_id) return res.status(400).json({ error: 'media_id obrigatorio' });
  try {
    const playlist = await pool.query('SELECT id FROM playlists WHERE id = $1 AND client_id = $2', [req.params.id, req.client.id]);
    if (playlist.rows.length === 0) return res.status(404).json({ error: 'Playlist nao encontrada' });
    const result = await pool.query(
      'INSERT INTO playlist_items (playlist_id, media_id, position, duration_override) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.params.id, media_id, position || 0, duration_override || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao adicionar item' });
  }
});

router.delete('/:id/items/:itemId', async (req, res) => {
  try {
    const playlist = await pool.query('SELECT id FROM playlists WHERE id = $1 AND client_id = $2', [req.params.id, req.client.id]);
    if (playlist.rows.length === 0) return res.status(404).json({ error: 'Playlist nao encontrada' });
    await pool.query('DELETE FROM playlist_items WHERE id = $1', [req.params.itemId]);
    res.json({ message: 'Item removido' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover item' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM playlists WHERE id = $1 AND client_id = $2 RETURNING id', [req.params.id, req.client.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Playlist nao encontrada' });
    res.json({ message: 'Playlist removida' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover playlist' });
  }
});
// Atualizar item da playlist
router.put('/:id/items/:itemId', async (req, res) => {
  const { duration_override, repeat_times, audio_enabled } = req.body;
  try {
    await pool.query(
      `UPDATE playlist_items SET 
        duration_override = COALESCE($1, duration_override),
        repeat_times = COALESCE($2, repeat_times),
        audio_enabled = COALESCE($3, audio_enabled)
       WHERE id = $4`,
      [duration_override, repeat_times, audio_enabled, req.params.itemId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar item' });
  }
});

// Reordenar itens da playlist
router.put('/:id/reorder', async (req, res) => {
  const { order } = req.body;
  try {
    await Promise.all(order.map(({ id, position }) =>
      pool.query('UPDATE playlist_items SET position = $1 WHERE id = $2', [position, id])
    ));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao reordenar' });
  }
});
module.exports = router;