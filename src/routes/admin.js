const express = require('express');
const router = express.Router();
const pool = require('../models/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM admins WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Credenciais inválidas' });
    const admin = result.rows[0];
    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) return res.status(401).json({ error: 'Credenciais inválidas' });
    const token = jwt.sign({ id: admin.id, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, admin: { id: admin.id, name: admin.name, email: admin.email } });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao fazer login' });
  }
});

const adminAuth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token obrigatorio' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(403).json({ error: 'Acesso negado' });
    req.admin = decoded;
    next();
  } catch { res.status(401).json({ error: 'Token invalido' }); }
};

router.get('/dashboard', adminAuth, async (req, res) => {
  try {
    const [clients, screens, companies, pending] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM clients WHERE status != 'pending'"),
      pool.query('SELECT COUNT(*) FROM screens WHERE client_id IS NOT NULL'),
      pool.query('SELECT COUNT(*) FROM companies'),
      pool.query("SELECT COUNT(*) FROM clients WHERE status = 'pending'"),
    ]);
    res.json({
      total_clients: parseInt(clients.rows[0].count),
      total_screens: parseInt(screens.rows[0].count),
      total_companies: parseInt(companies.rows[0].count),
      pending_clients: parseInt(pending.rows[0].count),
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar dashboard' });
  }
});

router.get('/clients', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        c.id, c.name, c.email, c.status, c.plan_id,
        c.trial_ends_at, c.trial_days, c.blocked_at, c.blocked_reason, c.created_at,
        p.name as plan_name, p.max_screens,
        (SELECT COUNT(*) FROM screens s WHERE s.client_id = c.id) as screen_count,
        (SELECT COUNT(*) FROM companies co WHERE co.client_id = c.id) as company_count
      FROM clients c
      LEFT JOIN plans p ON p.id = c.plan_id
      ORDER BY c.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar clientes' });
  }
});

router.put('/clients/:id/approve', adminAuth, async (req, res) => {
  const { trial_days, plan_id } = req.body;
  try {
    let trial_ends_at = null;
    if (trial_days && parseInt(trial_days) > 0) {
      trial_ends_at = new Date();
      trial_ends_at.setDate(trial_ends_at.getDate() + parseInt(trial_days));
    }
    await pool.query(
      `UPDATE clients SET 
        status = 'active',
        trial_ends_at = $1,
        trial_days = $2,
        plan_id = COALESCE($3, plan_id)
       WHERE id = $4`,
      [trial_ends_at, trial_days || 0, plan_id || null, req.params.id]
    );
    res.json({ message: 'Cliente aprovado com sucesso' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao aprovar cliente' });
  }
});

router.put('/clients/:id/block', adminAuth, async (req, res) => {
  const { blocked, reason } = req.body;
  try {
    await pool.query(
      'UPDATE clients SET status = $1, blocked_at = $2, blocked_reason = $3 WHERE id = $4',
      [blocked ? 'blocked' : 'active', blocked ? new Date() : null, reason || null, req.params.id]
    );
    res.json({ message: blocked ? 'Cliente bloqueado' : 'Cliente desbloqueado' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar cliente' });
  }
});

router.put('/clients/:id/plan', adminAuth, async (req, res) => {
  const { plan_id } = req.body;
  try {
    await pool.query('UPDATE clients SET plan_id = $1 WHERE id = $2', [plan_id, req.params.id]);
    res.json({ message: 'Plano atribuido' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atribuir plano' });
  }
});

router.get('/plans', adminAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM plans ORDER BY max_screens ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar planos' });
  }
});

router.post('/plans', adminAuth, async (req, res) => {
  const { name, description, max_screens, max_companies, price } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO plans (name, description, max_screens, max_companies, price) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [name, description, max_screens, max_companies, price]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar plano' });
  }
});

router.put('/plans/:id', adminAuth, async (req, res) => {
  const { name, description, max_screens, max_companies, price, active } = req.body;
  try {
    const result = await pool.query(
      'UPDATE plans SET name=$1, description=$2, max_screens=$3, max_companies=$4, price=$5, active=$6 WHERE id=$7 RETURNING *',
      [name, description, max_screens, max_companies, price, active, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar plano' });
  }
});
// Excluir cliente
router.delete('/clients/:id', adminAuth, async (req, res) => {
  try {
    // Remove dados relacionados primeiro
    const client = await pool.query('SELECT id FROM clients WHERE id = $1', [req.params.id]);
    if (client.rows.length === 0) return res.status(404).json({ error: 'Cliente não encontrado' });
    
    await pool.query('DELETE FROM screen_playlists WHERE screen_id IN (SELECT id FROM screens WHERE client_id = $1)', [req.params.id]);
    await pool.query('DELETE FROM playlist_items WHERE playlist_id IN (SELECT id FROM playlists WHERE client_id = $1)', [req.params.id]);
    await pool.query('DELETE FROM screens WHERE client_id = $1', [req.params.id]);
    await pool.query('DELETE FROM media WHERE client_id = $1', [req.params.id]);
    await pool.query('DELETE FROM playlists WHERE client_id = $1', [req.params.id]);
    await pool.query('DELETE FROM companies WHERE client_id = $1', [req.params.id]);
    await pool.query('DELETE FROM invoices WHERE client_id = $1', [req.params.id]);
    await pool.query('DELETE FROM clients WHERE id = $1', [req.params.id]);
    
    res.json({ message: 'Cliente excluído com sucesso' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao excluir cliente' });
  }
});

module.exports = { router, adminAuth };