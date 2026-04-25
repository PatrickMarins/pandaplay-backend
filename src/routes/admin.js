const express = require('express');
const router = express.Router();
const pool = require('../models/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Login admin
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

// Middleware admin
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

// Dashboard admin
router.get('/dashboard', adminAuth, async (req, res) => {
  try {
    const [clients, screens, companies] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM clients'),
      pool.query('SELECT COUNT(*) FROM screens WHERE client_id IS NOT NULL'),
      pool.query('SELECT COUNT(*) FROM companies'),
    ]);
    res.json({
      total_clients: parseInt(clients.rows[0].count),
      total_screens: parseInt(screens.rows[0].count),
      total_companies: parseInt(companies.rows[0].count),
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar dashboard' });
  }
});

// Listar clientes
router.get('/clients', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.*, p.name as plan_name, p.max_screens,
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

// Bloquear / desbloquear cliente
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

// Atribuir plano ao cliente
router.put('/clients/:id/plan', adminAuth, async (req, res) => {
  const { plan_id } = req.body;
  try {
    await pool.query('UPDATE clients SET plan_id = $1 WHERE id = $2', [plan_id, req.params.id]);
    res.json({ message: 'Plano atribuido' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atribuir plano' });
  }
});

// Listar planos
router.get('/plans', adminAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM plans ORDER BY max_screens ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar planos' });
  }
});

// Criar/editar plano
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

module.exports = { router, adminAuth };