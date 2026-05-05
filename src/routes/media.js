const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const pool = require('../models/db');
const { v4: uuidv4 } = require('uuid');
const { getFirebaseBucket, buildFirebaseDownloadUrl } = require('../models/firebaseStorage');
const authMiddleware = require('../middleware/auth');

router.use(authMiddleware);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }
});

const sanitizeFileName = (name) => {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_');
};

const buildMediaStoragePath = (clientId, originalName) => {
  const ext = path.extname(originalName);
  const base = sanitizeFileName(path.basename(originalName, ext));
  return `clients/${clientId}/media/${Date.now()}-${Math.round(Math.random() * 1e9)}-${base}${ext}`;
};

const mediaTypeFromContentType = (contentType = '') => {
  return contentType.startsWith('video') ? 'video' : 'image';
};

const buildFirebaseMediaUpload = async ({ clientId, originalName, contentType }) => {
  const storagePath = buildMediaStoragePath(clientId, originalName);
  const token = uuidv4();
  const bucket = getFirebaseBucket();
  const file = bucket.file(storagePath);
  const uploadHeaders = {
    'Content-Type': contentType,
    'x-goog-meta-firebaseStorageDownloadTokens': token
  };
  const [signedUrl] = await file.getSignedUrl({
    version: 'v4',
    action: 'write',
    expires: Date.now() + 15 * 60 * 1000,
    contentType,
    extensionHeaders: {
      'x-goog-meta-firebaseStorageDownloadTokens': token
    }
  });

  return {
    path: storagePath,
    signedUrl,
    uploadHeaders,
    url: buildFirebaseDownloadUrl(bucket.name, storagePath, token),
    type: mediaTypeFromContentType(contentType)
  };
};

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
  const filename = buildMediaStoragePath(req.client.id, req.file.originalname);
  const type = mediaTypeFromContentType(req.file.mimetype);
  try {
    const token = uuidv4();
    const bucket = getFirebaseBucket();
    await bucket.file(filename).save(req.file.buffer, {
      resumable: false,
      metadata: {
        contentType: req.file.mimetype,
        metadata: {
          firebaseStorageDownloadTokens: token
        }
      }
    });
    const url = buildFirebaseDownloadUrl(bucket.name, filename, token);
    const result = await pool.query(
      'INSERT INTO media (client_id, company_id, filename, url, type, size) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [req.client.id, company_id || null, req.file.originalname, url, type, req.file.size]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao fazer upload' });
  }
});

router.post('/upload-url', async (req, res) => {
  const { filename, content_type } = req.body;
  if (!filename) return res.status(400).json({ error: 'Nome do arquivo obrigatorio' });
  if (!content_type || (!content_type.startsWith('image/') && !content_type.startsWith('video/'))) {
    return res.status(400).json({ error: 'Envie uma imagem ou video' });
  }

  try {
    res.json(await buildFirebaseMediaUpload({
      clientId: req.client.id,
      originalName: filename,
      contentType: content_type
    }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Erro ao preparar upload' });
  }
});

router.post('/complete-upload', async (req, res) => {
  const { company_id, filename, url, type, size } = req.body;
  if (!filename || !url || !type) return res.status(400).json({ error: 'Dados do upload incompletos' });
  if (!['image', 'video'].includes(type)) return res.status(400).json({ error: 'Tipo de midia invalido' });

  try {
    const result = await pool.query(
      'INSERT INTO media (client_id, company_id, filename, url, type, size) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [req.client.id, company_id || null, filename, url, type, size || 0]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao salvar midia' });
  }
});

router.get('/:id/stats', async (req, res) => {
  try {
    const mediaResult = await pool.query(
      'SELECT id, filename FROM media WHERE id = $1 AND client_id = $2',
      [req.params.id, req.client.id]
    );
    if (mediaResult.rows.length === 0) {
      return res.status(404).json({ error: 'Midia nao encontrada' });
    }

    const media = mediaResult.rows[0];
    const [playlistsResult, screensResult] = await Promise.all([
      pool.query(
        `SELECT DISTINCT p.name
         FROM playlists p
         JOIN playlist_items pi ON pi.playlist_id = p.id
         WHERE pi.media_id = $1 AND p.client_id = $2
         ORDER BY p.name`,
        [req.params.id, req.client.id]
      ),
      pool.query(
        `SELECT name, status
         FROM screens
         WHERE client_id = $1 AND current_file = $2
         ORDER BY name`,
        [req.client.id, media.filename]
      )
    ]);

    res.json({
      total_plays: 0,
      plays_last_7d: 0,
      total_seconds: 0,
      unique_screens: screensResult.rows.length,
      last_played: null,
      active_screens: screensResult.rows,
      playlists: playlistsResult.rows.map(row => row.name)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar estatisticas da midia' });
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
