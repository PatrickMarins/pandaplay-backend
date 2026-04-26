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

const { router: adminRouter } = require('./routes/admin');
app.use('/api/admin', adminRouter);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('✅ Servidor rodando na porta ' + PORT);
  
});