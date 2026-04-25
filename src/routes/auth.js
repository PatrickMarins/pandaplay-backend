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
       VALUES ($1, $2, $3, 'active', NOW() + INTERVAL '14 days')
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

module.exports = router;