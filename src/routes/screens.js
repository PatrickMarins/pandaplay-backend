const express = require('express');
const router = express.Router();
const pool = require('../models/db');
const authMiddleware = require('../middleware/auth');

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ===== ROTAS PÚBLICAS =====

router.post('/register', async (req, res) => {
  try {
    const activation_code = generateCode();
    const result = await pool.query(
      'INSERT INTO screens (name, activation_code, status) VALUES ($1, $2, $3) RETURNING id, activation_code',
      ['Aguardando vínculo', activation_code, 'pending']
    );
    res.json({ activation_code: result.rows[0].activation_code, screen_id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao registrar tela' });
  }
});

router.get('/status/:activation_code', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, client_id, company_id, status FROM screens WHERE activation_code = $1',
      [req.params.activation_code]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Codigo invalido' });
    const screen = result.rows[0];
    if (!screen.client_id) return res.json({ linked: false });
    res.json({ linked: true, screen });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao verificar status' });
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
      `SELECT pi.*, m.filename, m.url, m.type, m.duration, pi.duration_override
       FROM playlist_items pi 
       JOIN media m ON pi.media_id = m.id 
       WHERE pi.playlist_id = $1 
       ORDER BY pi.position ASC`,
      [sp.rows[0].playlist_id]
    );
    res.json({ items: items.rows });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar conteudo' });
  }
});

router.post('/:id/heartbeat', async (req, res) => {
  const { app_version } = req.body;
  try {
    await pool.query(
      'UPDATE screens SET status = $1, last_seen = NOW(), app_version = COALESCE($2, app_version) WHERE id = $3',
      ['online', app_version || null, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro no heartbeat' });
  }
});

// ===== ROTAS PROTEGIDAS =====
router.use(authMiddleware);

router.get('/', async (req, res) => {
  const { company_id } = req.query;
  try {
    let query = `SELECT s.*, sp.playlist_id FROM screens s LEFT JOIN screen_playlists sp ON sp.screen_id = s.id WHERE s.client_id = $1`;
    const params = [req.client.id];
    if (company_id) { query += ` AND s.company_id = $2`; params.push(company_id); }
    query += ` ORDER BY s.created_at DESC`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar telas' });
  }
});

router.post('/link', async (req, res) => {
  const { activation_code, name, company_id } = req.body;
  if (!activation_code) return res.status(400).json({ error: 'Codigo obrigatorio' });
  if (!company_id) return res.status(400).json({ error: 'company_id obrigatorio' });
  try {
    const existing = await pool.query('SELECT id, client_id FROM screens WHERE activation_code = $1', [activation_code]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Codigo invalido' });
    if (existing.rows[0].client_id) return res.status(409).json({ error: 'Tela ja vinculada' });
    const result = await pool.query(
      'UPDATE screens SET client_id = $1, company_id = $2, name = $3, status = $4 WHERE activation_code = $5 RETURNING *',
      [req.client.id, company_id, name || 'Minha Tela', 'offline', activation_code]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao vincular tela' });
  }
});

router.post('/:id/playlist', async (req, res) => {
  const { playlist_id } = req.body;
  if (!playlist_id) return res.status(400).json({ error: 'playlist_id obrigatorio' });
  try {
    await pool.query('DELETE FROM screen_playlists WHERE screen_id = $1', [req.params.id]);
    await pool.query('INSERT INTO screen_playlists (screen_id, playlist_id) VALUES ($1, $2)', [req.params.id, playlist_id]);
    res.json({ message: 'Playlist atribuida com sucesso' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atribuir playlist' });
  }
});

router.put('/:id', async (req, res) => {
  const { name, rotation, audio, transition, auto_start, auto_monitor, show_status, show_alerts } = req.body;
  try {
    const result = await pool.query(
      `UPDATE screens SET name = COALESCE($1, name), rotation = COALESCE($2, rotation), audio = COALESCE($3, audio), transition = COALESCE($4, transition), auto_start = COALESCE($5, auto_start), auto_monitor = COALESCE($6, auto_monitor), show_status = COALESCE($7, show_status), show_alerts = COALESCE($8, show_alerts) WHERE id = $9 AND client_id = $10 RETURNING *`,
      [name, rotation, audio, transition, auto_start, auto_monitor, show_status, show_alerts, req.params.id, req.client.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Tela nao encontrada' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar tela' });
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