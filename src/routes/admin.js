const express = require('express');
const router = express.Router();
const pool = require('../models/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const supabase = require('../models/supabase');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

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

// ─── AUTH ─────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM admins WHERE email = $1 AND active = TRUE', [email]);
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

router.get('/me', adminAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, email FROM admins WHERE id = $1', [req.admin.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Admin não encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro' });
  }
});

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
router.get('/dashboard', adminAuth, async (req, res) => {
  try {
    const [clients, screens, companies, pending, overdue] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM clients WHERE status != 'pending'"),
      pool.query('SELECT COUNT(*) FROM screens WHERE client_id IS NOT NULL'),
      pool.query('SELECT COUNT(*) FROM companies'),
      pool.query("SELECT COUNT(*) FROM clients WHERE status = 'pending'"),
      pool.query("SELECT COUNT(*) FROM invoices WHERE status = 'overdue'"),
    ]);
    res.json({
      total_clients: parseInt(clients.rows[0].count),
      total_screens: parseInt(screens.rows[0].count),
      total_companies: parseInt(companies.rows[0].count),
      pending_clients: parseInt(pending.rows[0].count),
      overdue_invoices: parseInt(overdue.rows[0].count),
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar dashboard' });
  }
});

// ─── CLIENTES ─────────────────────────────────────────────────────────────────
router.get('/clients', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.id, c.name, c.email, c.status, c.plan_id,
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
        (SELECT COUNT(*) FROM screens s WHERE s.client_id = c.id AND s.status = 'offline') as screens_offline,
        (SELECT COUNT(*) FROM companies co WHERE co.client_id = c.id) as company_count,
        (SELECT COUNT(*) FROM media m WHERE m.client_id = c.id) as media_count,
        (SELECT COALESCE(SUM(m.size),0) FROM media m WHERE m.client_id = c.id) as media_size,
        (SELECT COUNT(*) FROM playlists pl WHERE pl.client_id = c.id) as playlist_count,
        (SELECT COUNT(*) FROM screens s WHERE s.client_id = c.id AND (s.rotation = 0 OR s.rotation = 180)) as screens_horizontal,
        (SELECT COUNT(*) FROM screens s WHERE s.client_id = c.id AND (s.rotation = 90 OR s.rotation = 270)) as screens_vertical
      FROM clients c LEFT JOIN plans p ON p.id = c.plan_id WHERE c.id = $1
    `, [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Cliente não encontrado' });

    const [screens, subResult] = await Promise.all([
      pool.query(`
        SELECT id, name, status, last_seen, current_file, current_playlist, app_version,
          rotation, auto_start, show_status,
          CASE WHEN status = 'online' THEN 0
          ELSE EXTRACT(EPOCH FROM (NOW() - last_seen))/60 END as minutes_offline,
          CASE WHEN status = 'online' AND last_seen IS NOT NULL
          THEN EXTRACT(EPOCH FROM (NOW() - last_seen))/60 ELSE 0 END as minutes_online
        FROM screens WHERE client_id = $1 ORDER BY name
      `, [req.params.id]),
      pool.query(`
        SELECT s.*, p.name as plan_name, p.price
        FROM subscriptions s
        LEFT JOIN plans p ON p.id = s.plan_id
        WHERE s.client_id = $1
        ORDER BY s.created_at DESC LIMIT 1
      `, [req.params.id]),
    ]);

   const subscription = subResult.rows[0] || null;

    // Busca faturas — via subscription ou direto do cliente
    let invoices = [];
    if (subscription) {
      const invRes = await pool.query(
        'SELECT * FROM invoices WHERE subscription_id = $1 ORDER BY due_date DESC',
        [subscription.id]
      );
      invoices = invRes.rows;
    }
    // Sempre inclui faturas avulsas (sem subscription_id) do cliente
    const avulsas = await pool.query(
      'SELECT * FROM invoices WHERE client_id = $1 AND subscription_id IS NULL ORDER BY due_date DESC',
      [req.params.id]
    );
    invoices = [...invoices, ...avulsas.rows];

    res.json({
      ...result.rows[0],
      screens: screens.rows,
      subscription,
      invoices,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao processar pagamento' });
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
    res.json({ message: 'Cliente aprovado' });
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
    res.json({ message: 'Trial redefinido' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao redefinir trial' });
  }
});

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
    await pool.query('UPDATE clients SET plan_id = $1 WHERE id = $2', [plan_id || null, req.params.id]);
    res.json({ message: 'Plano atribuído' });
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
    await pool.query('DELETE FROM subscriptions WHERE client_id = $1', [req.params.id]);
    await pool.query('DELETE FROM clients WHERE id = $1', [req.params.id]);
    res.json({ message: 'Cliente excluído' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao excluir cliente' });
  }
});

// ─── FATURAS ─────────────────────────────────────────────────────────────────
router.put('/clients/:id/invoices/:invoiceId/pay', adminAuth, async (req, res) => {
  try {
    const inv = await pool.query('SELECT * FROM invoices WHERE id = $1 AND client_id = $2', [req.params.invoiceId, req.params.id]);
    if (inv.rows.length === 0) return res.status(404).json({ error: 'Fatura não encontrada' });
    const invoice = inv.rows[0];

    // Só marca como paga — sem criar nova fatura
    await pool.query("UPDATE invoices SET status = 'paid', paid_at = NOW() WHERE id = $1", [invoice.id]);

    if (invoice.subscription_id) {
      const subRes = await pool.query('SELECT * FROM subscriptions WHERE id = $1', [invoice.subscription_id]);
      if (subRes.rows.length > 0) {
        const sub = subRes.rows[0];
        const cycleMonths = { monthly: 1, semiannual: 6, annual: 12 };
        const months = cycleMonths[sub.billing_cycle] || 1;

        // Próximo vencimento = due_date da fatura + 1 ciclo
        const base = new Date(invoice.due_date);
        base.setMonth(base.getMonth() + months);
        base.setDate(sub.billing_day);

        await pool.query(
          "UPDATE subscriptions SET next_due_date = $1, status = 'active' WHERE id = $2",
          [base, sub.id]
        );
        await pool.query(
          "UPDATE clients SET plan_expires_at = $1, status = 'active', blocked_at = NULL, blocked_reason = NULL WHERE id = $2",
          [base, req.params.id]
        );

        return res.json({ message: `Pago! Próximo vencimento: ${base.toLocaleDateString('pt-BR')}`, next_due: base });
      }
    }

    // Fatura avulsa — só atualiza client
    const periodDays = invoice.period_days || 30;
    const base = new Date();
    base.setDate(base.getDate() + periodDays);
    await pool.query(
      "UPDATE clients SET plan_expires_at = $1, status = 'active', blocked_at = NULL WHERE id = $2",
      [base, req.params.id]
    );
    res.json({ message: 'Fatura paga!', next_due: base });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao processar pagamento' });
  }
});

router.delete('/clients/:id/invoices/:invoiceId', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM invoices WHERE id = $1 AND client_id = $2', [req.params.invoiceId, req.params.id]);
    res.json({ message: 'Fatura removida' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover fatura' });
  }
});

// ─── PLANOS ───────────────────────────────────────────────────────────────────
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

// ─── ADMINS ───────────────────────────────────────────────────────────────────
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
      await pool.query(
        'UPDATE admins SET name = COALESCE($1, name), email = COALESCE($2, email), password_hash = $3, active = COALESCE($4, active) WHERE id = $5',
        [name, email, hash, active, req.params.id]
      );
    } else {
      await pool.query(
        'UPDATE admins SET name = COALESCE($1, name), email = COALESCE($2, email), active = COALESCE($3, active) WHERE id = $4',
        [name, email, active, req.params.id]
      );
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

// ─── DOWNLOADS ────────────────────────────────────────────────────────────────
router.post('/downloads/upload', adminAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
  try {
    const filename = `apks/${Date.now()}-${req.file.originalname.replace(/\s/g, '_')}`;
    const { error } = await supabase.storage.from('midias').upload(filename, req.file.buffer, { contentType: 'application/vnd.android.package-archive', upsert: false });
    if (error) {
      console.error('Supabase upload error:', error);
      return res.status(500).json({ error: error.message || 'Erro ao fazer upload do APK' });
    }
    const { data } = supabase.storage.from('midias').getPublicUrl(filename);
    res.json({ url: data.publicUrl, filename });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao fazer upload do APK' });
  }
});

router.get('/downloads', adminAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM downloads ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: 'Erro' }); }
});

router.post('/downloads', adminAuth, async (req, res) => {
  const { version, name, url, notes, size, is_latest } = req.body;
  try {
    if (is_latest) await pool.query('UPDATE downloads SET is_latest = FALSE');
    const result = await pool.query(
      'INSERT INTO downloads (version, name, url, notes, size, is_latest) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [version, name || 'PandaPlay TV', url, notes || '', size || '', is_latest || false]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: 'Erro ao criar versão' }); }
});

router.put('/downloads/:id', adminAuth, async (req, res) => {
  const { version, name, url, notes, size, is_latest } = req.body;
  try {
    if (is_latest) await pool.query('UPDATE downloads SET is_latest = FALSE WHERE id != $1', [req.params.id]);
    const result = await pool.query(
      'UPDATE downloads SET version=$1, name=$2, url=$3, notes=$4, size=$5, is_latest=$6 WHERE id=$7 RETURNING *',
      [version, name || 'PandaPlay TV', url, notes || '', size || '', is_latest || false, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: 'Erro ao atualizar' }); }
});

router.delete('/downloads/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM downloads WHERE id = $1', [req.params.id]);
    res.json({ message: 'Removido' });
  } catch (e) { res.status(500).json({ error: 'Erro ao remover' }); }
});

module.exports = { router, adminAuth };