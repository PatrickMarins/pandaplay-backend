const express = require('express');
const router = express.Router();
const pool = require('../models/db');
const auth = require('../middleware/auth');

// ─── CLIENTE: ver minha assinatura ───────────────────────────────────────────
router.get('/my', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.*, p.name as plan_name, p.price, p.max_screens, p.max_companies,
        p.description as plan_description
      FROM subscriptions s
      LEFT JOIN plans p ON p.id = s.plan_id
      WHERE s.client_id = $1
      ORDER BY s.created_at DESC LIMIT 1
    `, [req.client.id]);
    res.json(result.rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar assinatura' });
  }
});

// ─── CLIENTE: ver minhas faturas ─────────────────────────────────────────────
router.get('/my/invoices', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT i.*, s.billing_cycle, p.name as plan_name
      FROM invoices i
      LEFT JOIN subscriptions s ON s.id = i.subscription_id
      LEFT JOIN plans p ON p.id = s.plan_id
      WHERE s.client_id = $1
      ORDER BY i.due_date DESC
    `, [req.client.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar faturas' });
  }
});

// ─── CLIENTE: criar/atualizar assinatura (escolher plano) ────────────────────
router.post('/subscribe', auth, async (req, res) => {
  const { plan_id, billing_cycle, billing_day } = req.body;
  if (!plan_id || !billing_cycle || !billing_day)
    return res.status(400).json({ error: 'Plano, ciclo e dia de vencimento são obrigatórios' });
  if (!['monthly', 'semiannual', 'annual'].includes(billing_cycle))
    return res.status(400).json({ error: 'Ciclo inválido' });
  if (billing_day < 1 || billing_day > 28)
    return res.status(400).json({ error: 'Dia de vencimento deve ser entre 1 e 28' });

  try {
    const plan = await pool.query('SELECT * FROM plans WHERE id = $1 AND active = TRUE', [plan_id]);
    if (plan.rows.length === 0) return res.status(404).json({ error: 'Plano não encontrado' });
    const p = plan.rows[0];

    // Verifica se já tem assinatura ativa
    const existing = await pool.query(
      "SELECT id FROM subscriptions WHERE client_id = $1 AND status NOT IN ('cancelled')",
      [req.client.id]
    );

    // Calcula primeira data de vencimento
    const now = new Date();
    let nextDue = new Date(now.getFullYear(), now.getMonth(), billing_day);
    if (nextDue <= now) nextDue.setMonth(nextDue.getMonth() + 1);

    // Calcula valor de acordo com o ciclo
    const cycleMonths = { monthly: 1, semiannual: 6, annual: 12 };
    const months = cycleMonths[billing_cycle];
    const amount = parseFloat(p.price) * months;
    const discount = billing_cycle === 'semiannual' ? 0.05 : billing_cycle === 'annual' ? 0.15 : 0;
    const finalAmount = amount * (1 - discount);

    let subscriptionId;

    if (existing.rows.length > 0) {
      // Upgrade/downgrade — atualiza assinatura existente
      subscriptionId = existing.rows[0].id;
      await pool.query(`
        UPDATE subscriptions SET plan_id = $1, billing_cycle = $2, billing_day = $3,
          next_due_date = $4, status = 'active' WHERE id = $5
      `, [plan_id, billing_cycle, billing_day, nextDue, subscriptionId]);
    } else {
      // Nova assinatura
      const sub = await pool.query(`
        INSERT INTO subscriptions (client_id, plan_id, billing_cycle, billing_day, next_due_date, status)
        VALUES ($1, $2, $3, $4, $5, 'active') RETURNING id
      `, [req.client.id, plan_id, billing_cycle, billing_day, nextDue]);
      subscriptionId = sub.rows[0].id;
    }

    // Atualiza plan_id no cliente
    await pool.query('UPDATE clients SET plan_id = $1 WHERE id = $2', [plan_id, req.client.id]);

    // Cria primeira fatura se não existir pendente
    const pendingInv = await pool.query(
      "SELECT id FROM invoices WHERE subscription_id = $1 AND status = 'pending'",
      [subscriptionId]
    );
    if (pendingInv.rows.length === 0) {
      const cycleLabel = { monthly: 'Mensal', semiannual: 'Semestral', annual: 'Anual' };
      await pool.query(`
        INSERT INTO invoices (client_id, subscription_id, description, amount, status, due_date, period_days)
        VALUES ($1, $2, $3, $4, 'pending', $5, $6)
      `, [
        req.client.id, subscriptionId,
        `${p.name} — ${cycleLabel[billing_cycle]}`,
        finalAmount.toFixed(2),
        nextDue,
        months * 30
      ]);
    }

    res.json({ message: 'Assinatura criada com sucesso!', next_due: nextDue, amount: finalAmount.toFixed(2) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao criar assinatura' });
  }
});

// ─── ADMIN: listar todas assinaturas ─────────────────────────────────────────
router.get('/admin/all', require('../middleware/adminAuth'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.*, c.name as client_name, c.email as client_email,
        p.name as plan_name, p.price,
        (SELECT COUNT(*) FROM invoices i WHERE i.subscription_id = s.id AND i.status = 'pending') as pending_invoices,
        (SELECT COUNT(*) FROM invoices i WHERE i.subscription_id = s.id AND i.status = 'overdue') as overdue_invoices
      FROM subscriptions s
      LEFT JOIN clients c ON c.id = s.client_id
      LEFT JOIN plans p ON p.id = s.plan_id
      ORDER BY s.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar assinaturas' });
  }
});

// ─── ADMIN: listar faturas de uma assinatura ──────────────────────────────────
router.get('/admin/:subscriptionId/invoices', require('../middleware/adminAuth'), async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM invoices WHERE subscription_id = $1 ORDER BY due_date DESC',
      [req.params.subscriptionId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar faturas' });
  }
});

// ─── ADMIN: marcar fatura como paga ──────────────────────────────────────────
router.put('/admin/invoices/:invoiceId/pay', require('../middleware/adminAuth'), async (req, res) => {
  try {
    const inv = await pool.query('SELECT * FROM invoices WHERE id = $1', [req.params.invoiceId]);
    if (inv.rows.length === 0) return res.status(404).json({ error: 'Fatura não encontrada' });
    const invoice = inv.rows[0];

    // Marca como paga
    await pool.query(
      "UPDATE invoices SET status = 'paid', paid_at = NOW() WHERE id = $1",
      [invoice.id]
    );

    if (!invoice.subscription_id) {
      return res.json({ message: 'Fatura marcada como paga' });
    }

    // Busca assinatura
    const sub = await pool.query('SELECT * FROM subscriptions WHERE id = $1', [invoice.subscription_id]);
    if (sub.rows.length === 0) return res.json({ message: 'Fatura paga' });
    const subscription = sub.rows[0];

    // Calcula próximo vencimento
    const cycleMonths = { monthly: 1, semiannual: 6, annual: 12 };
    const months = cycleMonths[subscription.billing_cycle] || 1;
    const current = subscription.next_due_date ? new Date(subscription.next_due_date) : new Date();
    const nextDue = new Date(current);
    nextDue.setMonth(nextDue.getMonth() + months);
    // Garante o dia correto
    nextDue.setDate(subscription.billing_day);

    // Atualiza assinatura
    await pool.query(
      "UPDATE subscriptions SET next_due_date = $1, status = 'active' WHERE id = $2",
      [nextDue, subscription.id]
    );

    // Atualiza plan_expires_at do cliente
    await pool.query(
      "UPDATE clients SET plan_expires_at = $1, status = 'active', blocked_at = NULL WHERE id = $2",
      [nextDue, subscription.client_id]
    );

    // Gera próxima fatura
    const plan = await pool.query('SELECT * FROM plans WHERE id = $1', [subscription.plan_id]);
    const p = plan.rows[0];
    const discount = subscription.billing_cycle === 'semiannual' ? 0.05 : subscription.billing_cycle === 'annual' ? 0.15 : 0;
    const amount = parseFloat(p?.price || invoice.amount) * months * (1 - discount);
    const cycleLabel = { monthly: 'Mensal', semiannual: 'Semestral', annual: 'Anual' };

    await pool.query(`
      INSERT INTO invoices (client_id, subscription_id, description, amount, status, due_date, period_days)
      VALUES ($1, $2, $3, $4, 'pending', $5, $6)
    `, [
      subscription.client_id, subscription.id,
      `${p?.name || 'Plano'} — ${cycleLabel[subscription.billing_cycle] || 'Mensal'}`,
      amount.toFixed(2),
      nextDue,
      months * 30
    ]);

    res.json({ message: `Pago! Próximo vencimento: ${nextDue.toLocaleDateString('pt-BR')}`, next_due: nextDue });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao processar pagamento' });
  }
});

// ─── ADMIN: cancelar assinatura ───────────────────────────────────────────────
router.put('/admin/:subscriptionId/cancel', require('../middleware/adminAuth'), async (req, res) => {
  try {
    await pool.query(
      "UPDATE subscriptions SET status = 'cancelled', cancelled_at = NOW() WHERE id = $1",
      [req.params.subscriptionId]
    );
    res.json({ message: 'Assinatura cancelada' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao cancelar' });
  }
});

module.exports = router;