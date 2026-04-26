const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../models/db');

router.post('/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'Nome, email e senha são obrigatórios' });
  try {
    const existing = await pool.query('SELECT id FROM clients WHERE email = $1', [email]);
    if (existing.rows.length > 0)
      return res.status(409).json({ error: 'Email já cadastrado' });
    const password_hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO clients (name, email, password_hash, status, trial_ends_at)
       VALUES ($1, $2, $3, 'pending', NULL)
       RETURNING id, name, email, status, trial_ends_at, created_at`,
      [name, email, password_hash]
    );
    const client = result.rows[0];
    const token = jwt.sign({ id: client.id, email: client.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, client });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email e senha são obrigatórios' });
  try {
    const result = await pool.query('SELECT * FROM clients WHERE email = $1', [email]);
    const client = result.rows[0];
    if (!client) return res.status(401).json({ error: 'Email ou senha incorretos' });
    const validPassword = await bcrypt.compare(password, client.password_hash);
    if (!validPassword) return res.status(401).json({ error: 'Email ou senha incorretos' });
    if (client.status === 'blocked')
      return res.status(403).json({ error: 'Conta bloqueada. Entre em contato com o suporte.' });
    if (client.status === 'pending')
      return res.status(403).json({ error: 'Conta aguardando aprovação. Em breve você receberá acesso.' });
    if (client.trial_ends_at && new Date(client.trial_ends_at) < new Date())
      return res.status(403).json({ error: 'Seu período de trial expirou. Contrate um plano para continuar.' });
    const token = jwt.sign({ id: client.id, email: client.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({
      token,
      client: {
        id: client.id, name: client.name, email: client.email,
        status: client.status, plan_id: client.plan_id,
        trial_ends_at: client.trial_ends_at
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

router.get('/me', require('../middleware/auth'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.name, c.email, c.status, c.trial_ends_at, c.created_at,
        p.name as plan_name, p.max_screens, p.max_companies, p.price
       FROM clients c
       LEFT JOIN plans p ON p.id = c.plan_id
       WHERE c.id = $1`,
      [req.client.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

router.get('/stats', require('../middleware/auth'), async (req, res) => {
  try {
    const clientId = req.client.id;
    const [
      playlists, playlistItems, media, screens, plan
    ] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM playlists WHERE client_id = $1', [clientId]),
      pool.query(`
        SELECT p.name as playlist_name, COUNT(pi.id) as item_count
        FROM playlists p
        LEFT JOIN playlist_items pi ON pi.playlist_id = p.id
        WHERE p.client_id = $1
        GROUP BY p.id, p.name
        ORDER BY item_count DESC
      `, [clientId]),
      pool.query(`
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE type = 'video') as videos,
          COUNT(*) FILTER (WHERE type = 'image') as images,
          COALESCE(SUM(size), 0) as total_size
        FROM media WHERE client_id = $1
      `, [clientId]),
      pool.query(`
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'online') as online,
          COUNT(*) FILTER (WHERE rotation = 90 OR rotation = 270) as vertical,
          COUNT(*) FILTER (WHERE rotation = 0 OR rotation = 180) as horizontal,
          app_version
        FROM screens WHERE client_id = $1
        GROUP BY app_version
      `, [clientId]),
      pool.query(`
        SELECT p.name, p.max_screens, p.max_companies, p.price
        FROM clients c
        LEFT JOIN plans p ON p.id = c.plan_id
        WHERE c.id = $1
      `, [clientId])
    ]);

    const mediaData = media.rows[0];
    const screenRows = screens.rows;
    const totalScreens = screenRows.reduce((acc, r) => acc + parseInt(r.total), 0);
    const onlineScreens = screenRows.reduce((acc, r) => acc + parseInt(r.online), 0);
    const verticalScreens = screenRows.reduce((acc, r) => acc + parseInt(r.vertical), 0);
    const horizontalScreens = screenRows.reduce((acc, r) => acc + parseInt(r.horizontal), 0);

    const versionMap = {};
    screenRows.forEach(r => {
      if (r.app_version) {
        versionMap[r.app_version] = (versionMap[r.app_version] || 0) + parseInt(r.total);
      }
    });

    const playlistItemsSorted = playlistItems.rows;
    const mostItems = playlistItemsSorted[0] || null;
    const leastItems = playlistItemsSorted[playlistItemsSorted.length - 1] || null;

    res.json({
      plan: plan.rows[0] || null,
      playlists: parseInt(playlists.rows[0].count),
      most_items_playlist: mostItems,
      least_items_playlist: leastItems,
      media: {
        total: parseInt(mediaData.total),
        videos: parseInt(mediaData.videos),
        images: parseInt(mediaData.images),
        total_size: parseInt(mediaData.total_size)
      },
      screens: {
        total: totalScreens,
        online: onlineScreens,
        vertical: verticalScreens,
        horizontal: horizontalScreens,
        versions: versionMap
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar estatísticas' });
  }
});
router.put('/profile', require('../middleware/auth'), async (req, res) => {
  const { name, old_password, new_password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM clients WHERE id = $1', [req.client.id]);
    const client = result.rows[0];
    if (old_password && new_password) {
      const valid = await bcrypt.compare(old_password, client.password_hash);
      if (!valid) return res.status(400).json({ error: 'Senha atual incorreta' });
      const hash = await bcrypt.hash(new_password, 10);
      await pool.query('UPDATE clients SET name = $1, password_hash = $2 WHERE id = $3', [name, hash, req.client.id]);
    } else {
      await pool.query('UPDATE clients SET name = $1 WHERE id = $2', [name, req.client.id]);
    }
    res.json({ message: 'Perfil atualizado' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar perfil' });
  }
});router.post('/photo', require('../middleware/auth'), async (req, res) => {
  // Por enquanto retorna placeholder — implementar com Supabase Storage
  res.json({ photo_url: null, message: 'Em breve' });
});
module.exports = router;