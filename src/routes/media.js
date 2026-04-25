const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const pool = require('../models/db');
const supabase = require('../models/supabase');
const authMiddleware = require('../middleware/auth');

router.use(authMiddleware);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }
});

router.get('/', async (req, res) => {
  const { company_id } = req.query;
  try {
    let query = 'SELECT * FROM media WHERE client_id = $1';
    const params = [req.client.id];
    if (company_id) { query += ' AND company_id = $2'; params.push(company_id); }
    query += ' ORDER BY created_at DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar midias' });
  }
});

router.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
  const { company_id } = req.body;
  const ext = path.extname(req.file.originalname);
  const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
  const type = req.file.mimetype.startsWith('video') ? 'video' : 'image';
  try {
    const { error } = await supabase.storage.from('midias').upload(filename, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
    if (error) throw error;
    const { data: urlData } = supabase.storage.from('midias').getPublicUrl(filename);
    const result = await pool.query(
      'INSERT INTO media (client_id, company_id, filename, url, type, size) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [req.client.id, company_id || null, req.file.originalname, urlData.publicUrl, type, req.file.size]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao fazer upload' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM media WHERE id = $1 AND client_id = $2 RETURNING id', [req.params.id, req.client.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Midia nao encontrada' });
    res.json({ message: 'Midia removida' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover midia' });
  }
});

module.exports = router;