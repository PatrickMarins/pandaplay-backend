const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../models/db');
const nodemailer = require('nodemailer');

const mailer = nodemailer.createTransport({
  host: 'smtp-relay.brevo.com',
  port: 587,
  auth: {
    user: 'a95947001@smtp-brevo.com',
pass: process.env.SMTP_PASS || ''  }
});

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function sendCode(email, code, type) {
  const subject = type === 'register' ? 'Confirme seu cadastro — PandaPlay' : 'Recuperação de senha — PandaPlay';
  const title = type === 'register' ? 'Confirme seu email' : 'Redefinir senha';
  const message = type === 'register'
    ? 'Use o código abaixo para confirmar seu cadastro no PandaPlay:'
    : 'Use o código abaixo para redefinir sua senha:';

  await mailer.sendMail({
    from: '"PandaPlay" <a95947001@smtp-brevo.com>',
    to: email,
    subject,
    html: `
      <div style="font-family: Inter, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 24px; background: #f4f4f8;">
        <div style="background: white; border-radius: 16px; padding: 40px; box-shadow: 0 4px 24px rgba(0,0,0,0.08);">
          <div style="text-align: center; margin-bottom: 32px;">
            <div style="display: inline-block; background: linear-gradient(135deg, #7c5cfc, #a855f7); border-radius: 12px; padding: 12px 20px;">
              <span style="color: white; font-size: 20px; font-weight: 800;">PandaPlay</span>
            </div>
          </div>
          <h2 style="color: #0f0f1a; font-size: 22px; font-weight: 700; margin-bottom: 8px;">${title}</h2>
          <p style="color: #4a4a6a; font-size: 14px; line-height: 1.7; margin-bottom: 28px;">${message}</p>
          <div style="background: #f0f0f5; border: 2px dashed #7c5cfc; border-radius: 12px; padding: 24px; text-align: center; margin-bottom: 28px;">
            <div style="font-size: 42px; font-weight: 800; letter-spacing: 10px; color: #7c5cfc; font-family: monospace;">${code}</div>
          </div>
          <p style="color: #9090b0; font-size: 13px; text-align: center;">Este código expira em <strong>15 minutos</strong>. Não compartilhe com ninguém.</p>
        </div>
        <p style="color: #9090b0; font-size: 12px; text-align: center; margin-top: 20px;">Se você não solicitou isso, ignore este email.</p>
      </div>
    `
  });
}

router.post('/send-verification', async (req, res) => {
  const { email, name, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'Nome, email e senha são obrigatórios' });
  if (!isValidEmail(email))
    return res.status(400).json({ error: 'Email inválido' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Senha deve ter pelo menos 6 caracteres' });
  try {
    const existing = await pool.query('SELECT id FROM clients WHERE email = $1', [email]);
    if (existing.rows.length > 0)
      return res.status(409).json({ error: 'Email já cadastrado' });
    const code = generateCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await pool.query('DELETE FROM email_verifications WHERE email = $1 AND type = $2', [email, 'register']);
    await pool.query('INSERT INTO email_verifications (email, code, type, expires_at) VALUES ($1, $2, $3, $4)', [email, code, 'register', expiresAt]);
    await sendCode(email, code, 'register');
    res.json({ message: 'Código enviado para seu email' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao enviar email. Tente novamente.' });
  }
});

router.post('/register', async (req, res) => {
  const { name, email, password, code } = req.body;
  if (!name || !email || !password || !code)
    return res.status(400).json({ error: 'Todos os campos são obrigatórios' });
  try {
    const verification = await pool.query(
      'SELECT * FROM email_verifications WHERE email = $1 AND code = $2 AND type = $3 AND used = FALSE AND expires_at > NOW()',
      [email, code, 'register']
    );
    if (verification.rows.length === 0)
      return res.status(400).json({ error: 'Código inválido ou expirado' });
    const existing = await pool.query('SELECT id FROM clients WHERE email = $1', [email]);
    if (existing.rows.length > 0)
      return res.status(409).json({ error: 'Email já cadastrado' });
    const password_hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO clients (name, email, password_hash, status, trial_ends_at) VALUES ($1, $2, $3, 'pending', NULL) RETURNING id, name, email, status, trial_ends_at, created_at`,
      [name, email, password_hash]
    );
    await pool.query('UPDATE email_verifications SET used = TRUE WHERE id = $1', [verification.rows[0].id]);
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
  if (!isValidEmail(email))
    return res.status(400).json({ error: 'Email inválido' });
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
    res.json({ token, client: { id: client.id, name: client.name, email: client.email, status: client.status, plan_id: client.plan_id, trial_ends_at: client.trial_ends_at } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email || !isValidEmail(email))
    return res.status(400).json({ error: 'Email inválido' });
  try {
    const result = await pool.query('SELECT id FROM clients WHERE email = $1', [email]);
    if (result.rows.length === 0)
      return res.json({ message: 'Se este email estiver cadastrado, você receberá um código.' });
    const code = generateCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await pool.query('DELETE FROM email_verifications WHERE email = $1 AND type = $2', [email, 'reset']);
    await pool.query('INSERT INTO email_verifications (email, code, type, expires_at) VALUES ($1, $2, $3, $4)', [email, code, 'reset', expiresAt]);
    await sendCode(email, code, 'reset');
    res.json({ message: 'Se este email estiver cadastrado, você receberá um código.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao enviar email. Tente novamente.' });
  }
});

router.post('/reset-password', async (req, res) => {
  const { email, code, new_password } = req.body;
  if (!email || !code || !new_password)
    return res.status(400).json({ error: 'Todos os campos são obrigatórios' });
  if (new_password.length < 6)
    return res.status(400).json({ error: 'Senha deve ter pelo menos 6 caracteres' });
  try {
    const verification = await pool.query(
      'SELECT * FROM email_verifications WHERE email = $1 AND code = $2 AND type = $3 AND used = FALSE AND expires_at > NOW()',
      [email, code, 'reset']
    );
    if (verification.rows.length === 0)
      return res.status(400).json({ error: 'Código inválido ou expirado' });
    const password_hash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE clients SET password_hash = $1 WHERE email = $2', [password_hash, email]);
    await pool.query('UPDATE email_verifications SET used = TRUE WHERE id = $1', [verification.rows[0].id]);
    res.json({ message: 'Senha redefinida com sucesso!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao redefinir senha' });
  }
});

router.get('/me', require('../middleware/auth'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.name, c.email, c.status, c.trial_ends_at, c.created_at, p.name as plan_name, p.max_screens, p.max_companies, p.price FROM clients c LEFT JOIN plans p ON p.id = c.plan_id WHERE c.id = $1`,
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
    const [playlists, playlistItems, media, screens, plan] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM playlists WHERE client_id = $1', [clientId]),
      pool.query(`SELECT p.name as playlist_name, COUNT(pi.id) as item_count FROM playlists p LEFT JOIN playlist_items pi ON pi.playlist_id = p.id WHERE p.client_id = $1 GROUP BY p.id, p.name ORDER BY item_count DESC`, [clientId]),
      pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE type = 'video') as videos, COUNT(*) FILTER (WHERE type = 'image') as images, COALESCE(SUM(size), 0) as total_size FROM media WHERE client_id = $1`, [clientId]),
      pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status = 'online') as online, COUNT(*) FILTER (WHERE rotation = 90 OR rotation = 270) as vertical, COUNT(*) FILTER (WHERE rotation = 0 OR rotation = 180) as horizontal, app_version FROM screens WHERE client_id = $1 GROUP BY app_version`, [clientId]),
      pool.query(`SELECT p.name, p.max_screens, p.max_companies, p.price FROM clients c LEFT JOIN plans p ON p.id = c.plan_id WHERE c.id = $1`, [clientId])
    ]);
    const mediaData = media.rows[0];
    const screenRows = screens.rows;
    const totalScreens = screenRows.reduce((acc, r) => acc + parseInt(r.total), 0);
    const onlineScreens = screenRows.reduce((acc, r) => acc + parseInt(r.online), 0);
    const verticalScreens = screenRows.reduce((acc, r) => acc + parseInt(r.vertical), 0);
    const horizontalScreens = screenRows.reduce((acc, r) => acc + parseInt(r.horizontal), 0);
    const versionMap = {};
    screenRows.forEach(r => { if (r.app_version) versionMap[r.app_version] = (versionMap[r.app_version] || 0) + parseInt(r.total); });
    res.json({
      plan: plan.rows[0] || null,
      playlists: parseInt(playlists.rows[0].count),
      most_items_playlist: playlistItems.rows[0] || null,
      least_items_playlist: playlistItems.rows[playlistItems.rows.length - 1] || null,
      media: { total: parseInt(mediaData.total), videos: parseInt(mediaData.videos), images: parseInt(mediaData.images), total_size: parseInt(mediaData.total_size) },
      screens: { total: totalScreens, online: onlineScreens, vertical: verticalScreens, horizontal: horizontalScreens, versions: versionMap }
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
});

router.post('/photo', require('../middleware/auth'), async (req, res) => {
  res.json({ photo_url: null, message: 'Em breve' });
});

module.exports = router;