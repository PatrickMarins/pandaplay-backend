const express = require('express');
const router = express.Router();
const pool = require('../models/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');

async function sendAdminCode(email, code) {
  await axios.post('https://api.brevo.com/v3/smtp/email', {
    sender: { name: 'PandaPlay Admin', email: 'arnaldo.patrick@gmail.com' },
    to: [{ email }],
    subject: 'Código de acesso — Painel Admin PandaPlay',
    htmlContent: `
      <div style="font-family: Inter, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 24px; background: #0f1218;">
        <div style="background: #181e28; border-radius: 16px; padding: 40px; border: 1px solid rgba(255,255,255,0.08);">
          <div style="text-align: center; margin-bottom: 32px;">
            <div style="display: inline-block; background: linear-gradient(135deg, #1a0533, #7c5cfc); border-radius: 12px; padding: 12px 20px;">
              <span style="color: white; font-size: 20px; font-weight: 800;">PandaPlay Admin</span>
            </div>
          </div>
          <h2 style="color: #f0f0f8; font-size: 20px; font-weight: 700; margin-bottom: 8px;">Código de Acesso Administrativo</h2>
          <p style="color: #8888aa; font-size: 14px; line-height: 1.7; margin-bottom: 28px;">Use o código abaixo para acessar o painel administrativo.</p>
          <div style="background: #0f1218; border: 2px dashed #d97706; border-radius: 12px; padding: 24px; text-align: center; margin-bottom: 28px;">
            <div style="font-size: 42px; font-weight: 800; letter-spacing: 10px; color: #d97706; font-family: monospace;">${code}</div>
          </div>
          <p style="color: #555570; font-size: 13px; text-align: center;">Este código expira em <strong style="color: #8888aa;">10 minutos</strong>.</p>
        </div>
      </div>
    `
  }, {
    headers: { 'api-key': process.env.BREVO_API_KEY || '', 'Content-Type': 'application/json' }
  });
}

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

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM admins WHERE email = $1 AND active = TRUE', [email]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Credenciais inválidas' });
    const admin = result.rows[0];
    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) return res.status(401).json({ error: 'Credenciais inválidas' });
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await pool.query('DELETE FROM email_verifications WHERE email = $1 AND type = $2', [email, 'admin_login']);
    await pool.query('INSERT INTO email_verifications (email, code, type, expires_at) VALUES ($1, $2, $3, $4)', [email, code, 'admin_login', expiresAt]);
    await sendAdminCode(email, code);
    res.json({ requires_code: true, message: 'Código enviado para seu email' });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'Erro ao fazer login' });
  }
});

router.post('/verify-login', async (req, res) => {
  const { email, code } = req.body;
  try {
    const verification = await pool.query(
      'SELECT * FROM email_verifications WHERE email = $1 AND code = $2 AND type = $3 AND used = FALSE AND expires_at > NOW()',
      [email, code, 'admin_login']
    );
    if (verification.rows.length === 0) return res.status(400).json({ error: 'Código inválido ou expirado' });
    const admin = await pool.query('SELECT * FROM admins WHERE email = $1 AND active = TRUE', [email]);
    if (admin.rows.length === 0) return res.status(401).json({ error: 'Admin não encontrado' });
    await pool.query('UPDATE email_verifications SET used = TRUE WHERE id = $1', [verification.rows[0].id]);
    const token = jwt.sign({ id: admin.rows[0].id, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, admin: { id: admin.rows[0].id, name: admin.rows[0].name, email: admin.rows[0].email } });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao verificar código' });
  }
});

router.get('/dashboard', adminAuth, async (req, res) => {
  try {
    const [clients, screens, companies, pending, expiring] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM clients WHERE status != 'pending'"),
      pool.query('SELECT COUNT(*) FROM screens WHERE client_id IS NOT NULL'),
      pool.query('SELECT COUNT(*) FROM companies'),
      pool.query("SELECT COUNT(*) FROM clients WHERE status = 'pending'"),
      pool.query("SELECT COUNT(*) FROM clients WHERE plan_expires_at IS NOT NULL AND plan_expires_at BETWEEN NOW() AND NOW() + INTERVAL '7 days'"),
    ]);
    res.json({
      total_clients: parseInt(clients.rows[0].count),
      total_screens: parseInt(screens.rows[0].count),
      total_companies: parseInt(companies.rows[0].count),
      pending_clients: parseInt(pending.rows[0].count),
      expiring_clients: parseInt(expiring.rows[0].count),
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
        c.trial_ends_at, c.trial_days, c.blocked_at, c.blocked_reason,
        c.plan_expires_at, c.created_at,
        p.name as plan_name, p.max_screens, p.price,
        (SELECT COUNT(*) FROM screens s WHERE s.client_id = c.id) as screen_count,
        (SELECT COUNT(*) FROM companies co WHERE co.client_id = c.id) as company_count,
        (SELECT COUNT(*) FROM screens s WHERE s.client_id = c.id AND s.status = 'online') as screens_online
      FROM clients c
      LEFT JOIN plans p ON p.id = c.plan_id
      ORDER BY c.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar clientes' });
  }
});

router.get('/clients/:id', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.*, p.name as plan_name, p.max_screens, p.price,
        (SELECT COUNT(*) FROM screens s WHERE s.client_id = c.id) as screen_count,
        (SELECT COUNT(*) FROM screens s WHERE s.client_id = c.id AND s.status = 'online') as screens_online,
        (SELECT COUNT(*) FROM companies co WHERE co.client_id = c.id) as company_count,
        (SELECT COUNT(*) FROM media m WHERE m.client_id = c.id) as media_count,
        (SELECT COUNT(*) FROM playlists pl WHERE pl.client_id = c.id) as playlist_count
      FROM clients c LEFT JOIN plans p ON p.id = c.plan_id WHERE c.id = $1
    `, [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Cliente não encontrado' });

    const screens = await pool.query(`
      SELECT id, name, status, last_seen, current_file, current_playlist, app_version,
        CASE WHEN status = 'online' THEN 0 ELSE EXTRACT(EPOCH FROM (NOW() - last_seen))/60 END as minutes_offline
      FROM screens WHERE client_id = $1
    `, [req.params.id]);

    res.json({ ...result.rows[0], screens: screens.rows });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar cliente' });
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
      `UPDATE clients SET status = 'active', trial_ends_at = $1, trial_days = $2, plan_id = COALESCE($3, plan_id) WHERE id = $4`,
      [trial_ends_at, trial_days || 0, plan_id || null, req.params.id]
    );
    res.json({ message: 'Cliente aprovado com sucesso' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao aprovar cliente' });
  }
});

router.put('/clients/:id/trial', adminAuth, async (req, res) => {
  const { trial_days } = req.body;
  try {
    let trial_ends_at = null;
    if (trial_days && parseInt(trial_days) > 0) {
      trial_ends_at = new Date();
      trial_ends_at.setDate(trial_ends_at.getDate() + parseInt(trial_days));
    }
    await pool.query(
      `UPDATE clients SET trial_ends_at = $1, trial_days = $2, status = 'active' WHERE id = $3`,
      [trial_ends_at, trial_days || 0, req.params.id]
    );
    res.json({ message: 'Trial redefinido com sucesso' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao redefinir trial' });
  }
});

// Renovar plano — escolhe quantos dias (30, 90, 120, 365)
router.put('/clients/:id/renew', adminAuth, async (req, res) => {
  const { days } = req.body;
  if (!days || parseInt(days) < 1) return res.status(400).json({ error: 'Dias obrigatório' });
  try {
    const result = await pool.query('SELECT plan_expires_at FROM clients WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Cliente não encontrado' });
    const current = result.rows[0].plan_expires_at;
    const base = current && new Date(current) > new Date() ? new Date(current) : new Date();
    base.setDate(base.getDate() + parseInt(days));
    await pool.query(
      `UPDATE clients SET plan_expires_at = $1, status = 'active', blocked_at = NULL, blocked_reason = NULL WHERE id = $2`,
      [base, req.params.id]
    );
    res.json({ message: `Plano renovado por ${days} dias`, new_expiry: base });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao renovar plano' });
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

router.delete('/clients/:id', adminAuth, async (req, res) => {
  try {
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
    res.status(500).json({ error: 'Erro ao excluir cliente' });
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

router.get('/admins', adminAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, email, active, created_at FROM admins ORDER BY created_at ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar admins' });
  }
});

router.post('/admins', adminAuth, async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Todos os campos são obrigatórios' });
  try {
    const existing = await pool.query('SELECT id FROM admins WHERE email = $1', [email]);
    if (existing.rows.length > 0) return res.status(409).json({ error: 'Email já cadastrado' });
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO admins (name, email, password_hash, active) VALUES ($1, $2, $3, TRUE) RETURNING id, name, email, active',
      [name, email, hash]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar admin' });
  }
});

router.put('/admins/:id', adminAuth, async (req, res) => {
  const { name, email, password, active } = req.body;
  try {
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await pool.query('UPDATE admins SET name = COALESCE($1, name), email = COALESCE($2, email), password_hash = $3, active = COALESCE($4, active) WHERE id = $5', [name, email, hash, active, req.params.id]);
    } else {
      await pool.query('UPDATE admins SET name = COALESCE($1, name), email = COALESCE($2, email), active = COALESCE($3, active) WHERE id = $4', [name, email, active, req.params.id]);
    }
    res.json({ message: 'Admin atualizado' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar admin' });
  }
});

router.delete('/admins/:id', adminAuth, async (req, res) => {
  try {
    const count = await pool.query('SELECT COUNT(*) FROM admins WHERE active = TRUE');
    if (parseInt(count.rows[0].count) <= 1) return res.status(400).json({ error: 'Não é possível remover o único admin ativo' });
    await pool.query('UPDATE admins SET active = FALSE WHERE id = $1', [req.params.id]);
    res.json({ message: 'Admin desativado' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover admin' });
  }
});
// ─── FATURAS ─────────────────────────────────────────────────────────────────

// Listar faturas de um cliente
router.get('/clients/:id/invoices', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM invoices WHERE client_id = $1 ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar faturas' });
  }
});

// Criar fatura manualmente
router.post('/clients/:id/invoices', adminAuth, async (req, res) => {
  const { description, quantia, due_date, period_days } = req.body;
  if (!description || !quantia || !due_date) return res.status(400).json({ error: 'Campos obrigatórios: descrição, valor e vencimento' });
  try {
    const result = await pool.query(
      `INSERT INTO invoices (client_id, description, quantia, status, due_date, period_days)
       VALUES ($1, $2, $3, 'pending', $4, $5) RETURNING *`,
      [req.params.id, description, quantia, due_date, period_days || 30]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar fatura' });
  }
});

// Marcar fatura como paga → renova plano e gera próxima fatura
router.put('/clients/:id/invoices/:invoiceId/pay', adminAuth, async (req, res) => {
  try {
    const invoice = await pool.query('SELECT * FROM invoices WHERE id = $1 AND client_id = $2', [req.params.invoiceId, req.params.id]);
    if (invoice.rows.length === 0) return res.status(404).json({ error: 'Fatura não encontrada' });
    const inv = invoice.rows[0];

    // Marca como paga
    await pool.query(
      `UPDATE invoices SET status = 'paid', paid_at = NOW() WHERE id = $1`,
      [inv.id]
    );

    // Renova o plano
    const periodDays = inv.period_days || 30;
    const client = await pool.query('SELECT plan_expires_at FROM clients WHERE id = $1', [req.params.id]);
    const current = client.rows[0]?.plan_expires_at;
    const base = current && new Date(current) > new Date() ? new Date(current) : new Date();
    base.setDate(base.getDate() + periodDays);

    await pool.query(
      `UPDATE clients SET plan_expires_at = $1, status = 'active', blocked_at = NULL, blocked_reason = NULL WHERE id = $2`,
      [base, req.params.id]
    );

    // Gera próxima fatura automaticamente
    const nextDue = new Date(base);
    await pool.query(
      `INSERT INTO invoices (client_id, description, quantia, status, due_date, period_days)
       VALUES ($1, $2, $3, 'pending', $4, $5)`,
      [req.params.id, inv.description, inv.quantia, nextDue.toISOString().slice(0, 10), periodDays]
    );

    res.json({ message: 'Fatura paga, plano renovado e próxima fatura gerada', new_expiry: base });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao processar pagamento' });
  }
});

// Excluir fatura
router.delete('/clients/:id/invoices/:invoiceId', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM invoices WHERE id = $1 AND client_id = $2', [req.params.invoiceId, req.params.id]);
    res.json({ message: 'Fatura removida' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover fatura' });
  }
});
module.exports = { router, adminAuth };