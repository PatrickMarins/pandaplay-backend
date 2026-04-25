const express = require('express');
const router = express.Router();
const pool = require('../models/db');
const authMiddleware = require('../middleware/auth');

// Gera código alfanumérico sem traço (ex: AB12CD34)
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// ===== ROTAS PÚBLICAS (sem token) =====

// App TV registra e gera código de ativação
router.post('/register', async (req, res) => {
  try {
    const activation_code = generateCode();
    // Cria uma tela temporária sem client ainda
    const result = await pool.query(
      'INSERT INTO screens (name, activation_code, status) VALUES ($1, $2, $3) RETURNING id, activation_code',
      ['Aguardando vínculo', activation_code, 'pending']
    );
    res.json({ activation_code: result.rows[0].activation_code, screen_id: result.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao registrar tela' });
  }
});

// App TV busca status — se já foi vinculado retorna os dados
router.get('/status/:activation_code', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, client_id, status FROM screens WHERE activation_code = $1',
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

// Busca conteúdo da tela para o app TV
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

// Heartbeat do app TV
router.post('/:id/heartbeat', async (req, res) => {
  try {
    await pool.query(
      'UPDATE screens SET status = $1, last_seen = NOW() WHERE id = $2',
      ['online', req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao registrar heartbeat' });
  }
});

// ===== ROTAS PROTEGIDAS (com token) =====
router.use(authMiddleware);

// Listar telas do cliente
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.*, sp.playlist_id
       FROM screens s
       LEFT JOIN screen_playlists sp ON sp.screen_id = s.id
       WHERE s.client_id = $1
       ORDER BY s.created_at DESC`,
      [req.client.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar telas' });
  }
});

// Vincular tela ao cliente pelo código (painel faz isso)
router.post('/link', async (req, res) => {
  const { activation_code, name } = req.body;
  if (!activation_code) return res.status(400).json({ error: 'Codigo obrigatorio' });
  try {
    const existing = await pool.query(
      'SELECT id, client_id FROM screens WHERE activation_code = $1',
      [activation_code]
    );
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Codigo invalido' });
    if (existing.rows[0].client_id) return res.status(409).json({ error: 'Tela ja vinculada' });

    const result = await pool.query(
      'UPDATE screens SET client_id = $1, name = $2, status = $3 WHERE activation_code = $4 RETURNING *',
      [req.client.id, name || 'Minha Tela', 'offline', activation_code]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao vincular tela' });
  }
});

// Atribuir playlist à tela
router.post('/:id/playlist', async (req, res) => {
  const { playlist_id } = req.body;
  if (!playlist_id) return res.status(400).json({ error: 'playlist_id obrigatorio' });
  try {
    await pool.query('DELETE FROM screen_playlists WHERE screen_id = $1', [req.params.id]);
    await pool.query(
      'INSERT INTO screen_playlists (screen_id, playlist_id) VALUES ($1, $2)',
      [req.params.id, playlist_id]
    );
    res.json({ message: 'Playlist atribuida com sucesso' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atribuir playlist' });
  }
});

// Atualizar configurações da tela
router.put('/:id', async (req, res) => {
  const { name, rotation, audio, transition, auto_start, auto_monitor, show_status, show_alerts } = req.body;
  try {
    const result = await pool.query(
      `UPDATE screens SET 
        name = COALESCE($1, name),
        rotation = COALESCE($2, rotation),
        audio = COALESCE($3, audio),
        transition = COALESCE($4, transition),
        auto_start = COALESCE($5, auto_start),
        auto_monitor = COALESCE($6, auto_monitor),
        show_status = COALESCE($7, show_status),
        show_alerts = COALESCE($8, show_alerts)
       WHERE id = $9 AND client_id = $10 RETURNING *`,
      [name, rotation, audio, transition, auto_start, auto_monitor, show_status, show_alerts, req.params.id, req.client.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Tela nao encontrada' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar tela' });
  }
});

// Remover tela
router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM screens WHERE id = $1 AND client_id = $2 RETURNING id',
      [req.params.id, req.client.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Tela nao encontrada' });
    res.json({ message: 'Tela removida com sucesso' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover tela' });
  }
});

module.exports = router;