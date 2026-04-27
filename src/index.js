const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api/auth', require('./routes/auth'));
app.use('/api/companies', require('./routes/companies'));
app.use('/api/screens', require('./routes/screens'));
app.use('/api/media', require('./routes/media'));
app.use('/api/playlists', require('./routes/playlists'));
app.use('/api/invoices', require('./routes/invoices'));
app.use('/api/subscriptions', require('./routes/subscriptions'));

const { router: adminRouter } = require('./routes/admin');
app.use('/api/admin', adminRouter);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
const pool = require('./models/db');

// ─── JOB: marca telas offline após 2 min ─────────────────────────────────────
setInterval(async () => {
  try {
    await pool.query(
      `UPDATE screens SET status = 'offline' 
       WHERE status = 'online' AND last_seen < NOW() - INTERVAL '2 minutes'`
    );
  } catch (e) { console.log('Erro no job offline:', e.message); }
}, 60000);

// ─── CRON: processamento diário de faturas (roda a cada hora) ────────────────
setInterval(async () => {
  try {
    const now = new Date();

    // 1. Marca faturas vencidas (due_date passou e ainda estão pending)
    const overdueResult = await pool.query(`
      UPDATE invoices SET status = 'overdue'
      WHERE status = 'pending' AND due_date < NOW()
      RETURNING id, client_id, subscription_id
    `);
    if (overdueResult.rows.length > 0) {
      console.log(`[CRON] ${overdueResult.rows.length} fatura(s) marcada(s) como vencida(s)`);
    }

    // 2. Gera faturas para assinaturas ativas que vencem em 3 dias e ainda não têm fatura pendente
    const dueSoon = await pool.query(`
      SELECT s.*, p.name as plan_name, p.price
      FROM subscriptions s
      LEFT JOIN plans p ON p.id = s.plan_id
      WHERE s.status = 'active'
      AND s.next_due_date BETWEEN NOW() AND NOW() + INTERVAL '3 days'
      AND NOT EXISTS (
        SELECT 1 FROM invoices i 
        WHERE i.subscription_id = s.id AND i.status = 'pending'
      )
    `);

    for (const sub of dueSoon.rows) {
      const cycleMonths = { monthly: 1, semiannual: 6, annual: 12 };
      const months = cycleMonths[sub.billing_cycle] || 1;
      const discount = sub.billing_cycle === 'semiannual' ? 0.05 : sub.billing_cycle === 'annual' ? 0.15 : 0;
      const amount = parseFloat(sub.price || 0) * months * (1 - discount);
      const cycleLabel = { monthly: 'Mensal', semiannual: 'Semestral', annual: 'Anual' };

      await pool.query(`
        INSERT INTO invoices (client_id, subscription_id, description, amount, status, due_date, period_days)
        VALUES ($1, $2, $3, $4, 'pending', $5, $6)
      `, [
        sub.client_id, sub.id,
        `${sub.plan_name} — ${cycleLabel[sub.billing_cycle] || 'Mensal'}`,
        amount.toFixed(2),
        sub.next_due_date,
        months * 30
      ]);
      console.log(`[CRON] Fatura gerada para assinatura ${sub.id}`);
    }

    // 3. Suspende clientes com faturas vencidas há mais de 5 dias
    await pool.query(`
      UPDATE clients SET status = 'blocked', blocked_reason = 'Fatura em atraso'
      WHERE id IN (
        SELECT DISTINCT s.client_id FROM subscriptions s
        WHERE s.status = 'active'
        AND EXISTS (
          SELECT 1 FROM invoices i WHERE i.subscription_id = s.id
          AND i.status = 'overdue' AND i.due_date < NOW() - INTERVAL '5 days'
        )
      )
      AND status = 'active'
    `);

  } catch (e) { console.log('[CRON] Erro:', e.message); }
}, 60 * 60 * 1000); // roda a cada hora

app.listen(PORT, '0.0.0.0', () => {
  console.log('✅ Servidor rodando na porta ' + PORT);
});