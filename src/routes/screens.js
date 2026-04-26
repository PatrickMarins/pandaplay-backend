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
    // Se foi desvinculado (client_id removido), retorna unlinked
    if (!screen.client_id) return res.json({ linked: false, unlinked: true });
    res.json({ linked: true, screen });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao verificar status' });
  }
});

router.get('/:id/content', async (req, res) => {
  try {
    // Verifica se a tela ainda está vinculada
    const screenCheck = await pool.query(
      'SELECT client_id FROM screens WHERE id = $1', [req.params.id]
    );
    if (screenCheck.rows.length === 0) return res.json({ unlinked: true, items: [] });
    if (!screenCheck.rows[0].client_id) return res.json({ unlinked: true, items: [] });

    const sp = await pool.query(
      'SELECT playlist_id FROM screen_playlists WHERE screen_id = $1 LIMIT 1',
      [req.params.id]
    );
    if (sp.rows.length === 0) return res.json({ items: [] });
    const playlist = await pool.query('SELECT name FROM playlists WHERE id = $1', [sp.rows[0].playlist_id]);
    const items = await pool.query(
      `SELECT pi.*, m.filename, m.url, m.type, m.duration, pi.duration_override
       FROM playlist_items pi 
       JOIN media m ON pi.media_id = m.id 
       WHERE pi.playlist_id = $1 
       ORDER BY pi.position ASC`,
      [sp.rows[0].playlist_id]
    );
    res.json({ 
      items: items.rows,
      playlist_name: playlist.rows[0]?.name || null
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar conteudo' });
  }
});

router.post('/:id/heartbeat', async (req, res) => {
  const { app_version, current_file, playlist_name } = req.body;
  try {
    await pool.query(
      `UPDATE screens SET 
        status = 'online', 
        last_seen = NOW(), 
        app_version = COALESCE($1, app_version),
        current_file = COALESCE($2, current_file),
        current_playlist = COALESCE($3, current_playlist)
       WHERE id = $4`,
      [app_version || null, current_file || null, playlist_name || null, req.params.id]
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

rrouter.post('/link', async (req, res) => {
  const { activation_code, name, company_id } = req.body;
  if (!activation_code) return res.status(400).json({ error: 'Codigo obrigatorio' });
  if (!company_id) return res.status(400).json({ error: 'company_id obrigatorio' });
  try {
    // Verifica limite do plano
    const clientData = await pool.query(`
      SELECT c.id, p.max_screens,
        (SELECT COUNT(*) FROM screens s WHERE s.client_id = c.id) as screen_count
      FROM clients c
      LEFT JOIN plans p ON p.id = c.plan_id
      WHERE c.id = $1
    `, [req.client.id]);

    if (clientData.rows.length > 0) {
      const { max_screens, screen_count } = clientData.rows[0];
      if (max_screens && parseInt(screen_count) >= parseInt(max_screens)) {
        return res.status(403).json({ 
          error: `Limite de telas atingido. Seu plano permite até ${max_screens} tela(s). Faça upgrade para adicionar mais.`
        });
      }
    }

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

// Desvincular TV — app volta para tela de código
router.post('/:id/unlink', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE screens SET client_id = NULL, company_id = NULL, status = 'pending', 
        current_file = NULL, current_playlist = NULL
       WHERE id = $1 AND client_id = $2 RETURNING id`,
      [req.params.id, req.client.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Tela nao encontrada' });
    res.json({ message: 'Tela desvinculada' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao desvincular tela' });
  }
});

// Substituir TV — mantém configurações, troca o dispositivo físico
router.post('/:id/replace', async (req, res) => {
  const { activation_code } = req.body;
  if (!activation_code) return res.status(400).json({ error: 'Codigo obrigatorio' });
  try {
    // Busca a tela atual para pegar configurações
    const current = await pool.query('SELECT * FROM screens WHERE id = $1 AND client_id = $2', [req.params.id, req.client.id]);
    if (current.rows.length === 0) return res.status(404).json({ error: 'Tela nao encontrada' });
    
    // Busca a nova tela pelo código
    const newScreen = await pool.query('SELECT id, client_id FROM screens WHERE activation_code = $1', [activation_code]);
    if (newScreen.rows.length === 0) return res.status(404).json({ error: 'Codigo invalido' });
    if (newScreen.rows[0].client_id) return res.status(409).json({ error: 'Este dispositivo ja esta vinculado' });

    const old = current.rows[0];

    // Migra playlists para nova tela
    await pool.query('UPDATE screen_playlists SET screen_id = $1 WHERE screen_id = $2', [newScreen.rows[0].id, req.params.id]);

    // Atualiza nova tela com configs da antiga
    await pool.query(
      `UPDATE screens SET 
        client_id = $1, company_id = $2, name = $3, status = 'offline',
        rotation = $4, audio = $5, transition = $6,
        auto_start = $7, auto_monitor = $8, show_status = $9, show_alerts = $10
       WHERE id = $11`,
      [old.client_id, old.company_id, old.name, old.rotation, old.audio, old.transition,
       old.auto_start, old.auto_monitor, old.show_status, old.show_alerts, newScreen.rows[0].id]
    );

    // Remove a tela antiga
    await pool.query('DELETE FROM screens WHERE id = $1', [req.params.id]);

    res.json({ message: 'TV substituída com sucesso', new_screen_id: newScreen.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao substituir tela' });
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