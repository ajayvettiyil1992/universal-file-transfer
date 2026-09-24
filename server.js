const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { list, put, get, del, BlobError } = require('@vercel/blob');

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, 'uploads'));
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

// Blob mode stores each file as 4 MB parts, sent and fetched through this
// server: Vercel functions accept and return at most 4.5 MB per request, and
// browsers could not reach the Blob API directly (ERR_ALPN_NEGOTIATION_FAILED).
// Part pathnames: "uploads/<timestamp>/<size>/<file name>/<part index>".
const CHUNK_SIZE = 4 * 1024 * 1024;
const BLOB_PREFIX = 'uploads/';
const FILE_ID_RE = /^\d+\/(\d+)\/[^/\\#?\x00-\x1f]+$/;
const PART_RE = /^(\d+\/(\d+)\/([^/\\#?\x00-\x1f]+))\/(\d+)$/;

// Vercel names the variable <PREFIX>_READ_WRITE_TOKEN, where the prefix is
// chosen when the store is connected ("BLOB" by default), so also accept any
// such variable holding a Blob token.
function findBlobToken() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  const key = Object.keys(process.env).find(
    (k) => k.endsWith('_READ_WRITE_TOKEN') && String(process.env[k]).startsWith('vercel_blob_rw_')
  );
  return key && process.env[key];
}
// Undefined when the store uses BLOB_STORE_ID + Vercel OIDC instead; the SDK
// then authenticates with the function's OIDC token.
const BLOB_TOKEN = findBlobToken();
const HAS_BLOB = Boolean(BLOB_TOKEN || process.env.BLOB_STORE_ID);

// "blob": Vercel Blob storage (needed on Vercel, whose filesystem is not persistent).
// "disk": local folder, for running on your own machine or a VPS.
const MODE = HAS_BLOB ? 'blob' : process.env.VERCEL ? 'unconfigured' : 'disk';

if (MODE === 'disk') fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Strip directory parts and characters that are unsafe in file names.
function sanitizeName(name) {
  const base = path.basename(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  return base && base !== '.' && base !== '..' ? base : 'file';
}

// Avoid overwriting: "report.zip" -> "report (1).zip" if it already exists.
function uniqueName(name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let candidate = name;
  for (let i = 1; fs.existsSync(path.join(UPLOAD_DIR, candidate)); i++) {
    candidate = `${stem} (${i})${ext}`;
  }
  return candidate;
}

// Resolve a client-supplied name to a path inside UPLOAD_DIR, or null.
function resolveStoredFile(name) {
  const filePath = path.resolve(UPLOAD_DIR, name);
  if (path.dirname(filePath) !== UPLOAD_DIR) return null;
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  return filePath;
}

const partCount = (size) => Math.max(1, Math.ceil(size / CHUNK_SIZE));

// Validate a blob file id ("<timestamp>/<size>/<name>") and return its size, or null.
function parseFileId(id) {
  const m = typeof id === 'string' && FILE_ID_RE.exec(id);
  if (!m) return null;
  const size = Number(m[1]);
  return size <= MAX_FILE_SIZE ? size : null;
}

async function listBlobs(prefix) {
  const blobs = [];
  let cursor;
  do {
    const page = await list({ prefix, cursor, token: BLOB_TOKEN });
    blobs.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return blobs;
}

const storage = multer.diskStorage({
  // A function, not a string: with a string multer creates the folder at
  // startup, which crashes on Vercel's read-only filesystem.
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // Browsers send UTF-8 names but busboy decodes them as latin1.
    const original = Buffer.from(file.originalname, 'latin1').toString('utf8');
    cb(null, uniqueName(sanitizeName(original)));
  },
});

const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE } });

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', (req, res, next) => {
  if (MODE !== 'unconfigured') return next();
  // Names only, never values, to help spot a misnamed or missing variable.
  const blobVars = Object.keys(process.env).filter((k) => /BLOB|READ_WRITE_TOKEN/i.test(k));
  res.status(503).json({
    error: 'Storage is not configured. Connect a Vercel Blob store to this project and redeploy.',
    blobEnvVarsFound: blobVars,
    vercelEnv: process.env.VERCEL_ENV,
  });
});

app.get('/api/files', async (req, res, next) => {
  try {
    let files;
    if (MODE === 'blob') {
      const byId = new Map();
      for (const b of await listBlobs(BLOB_PREFIX)) {
        const m = PART_RE.exec(b.pathname.slice(BLOB_PREFIX.length));
        if (!m) continue;
        const [, id, size, name] = m;
        const f = byId.get(id) || { id, name, size: Number(size), uploadedAt: b.uploadedAt, stored: 0, parts: 0 };
        f.stored += b.size;
        f.parts += 1;
        if (new Date(b.uploadedAt) > new Date(f.uploadedAt)) f.uploadedAt = b.uploadedAt;
        byId.set(id, f);
      }
      files = [...byId.values()].map(({ stored, parts, ...f }) => ({
        ...f,
        parts: partCount(f.size),
        complete: stored === f.size && parts === partCount(f.size),
      }));
    } else {
      files = fs
        .readdirSync(UPLOAD_DIR, { withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => {
          const stat = fs.statSync(path.join(UPLOAD_DIR, d.name));
          return {
            id: d.name,
            name: d.name,
            size: stat.size,
            uploadedAt: stat.mtime,
            complete: true,
            downloadUrl: `/api/files/${encodeURIComponent(d.name)}`,
          };
        });
    }
    files.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    res.json({ mode: MODE, chunkSize: CHUNK_SIZE, files, maxFileSize: MAX_FILE_SIZE });
  } catch (err) {
    next(err);
  }
});

// Disk mode: the whole file goes through this server in one request.
app.post('/api/files', (req, res, next) => {
  if (MODE !== 'disk') return res.status(400).json({ error: 'Use /api/parts in blob mode' });
  upload.array('files')(req, res, (err) => {
    if (err) return next(err);
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }
    res.status(201).json({
      uploaded: req.files.map((f) => ({ name: f.filename, size: f.size })),
    });
  });
});

// Blob mode: store one part. Query: id=<timestamp>/<size>/<name>, index=<n>.
app.put(
  '/api/parts',
  express.raw({ type: () => true, limit: CHUNK_SIZE + 1024 }),
  async (req, res, next) => {
    if (MODE !== 'blob') return res.status(400).json({ error: 'Blob storage is not enabled' });
    const { id } = req.query;
    const size = parseFileId(id);
    const index = Number(req.query.index);
    if (size === null) return res.status(400).json({ error: 'Invalid file id or file larger than 50 MB' });
    const parts = partCount(size);
    if (!Number.isInteger(index) || index < 0 || index >= parts) {
      return res.status(400).json({ error: 'Invalid part index' });
    }
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const expected = index < parts - 1 ? CHUNK_SIZE : size - CHUNK_SIZE * (parts - 1);
    if (body.length !== expected) {
      return res.status(400).json({ error: `Part ${index} should be ${expected} bytes, got ${body.length}` });
    }
    try {
      await put(`${BLOB_PREFIX}${id}/${index}`, body, {
        access: 'public',
        addRandomSuffix: false,
        allowOverwrite: true, // lets the browser retry a failed part
        contentType: 'application/octet-stream',
        token: BLOB_TOKEN,
      });
      res.status(201).json({ id, index });
    } catch (err) {
      next(err);
    }
  }
);

// Blob mode: fetch one part. Query: id, index.
app.get('/api/parts', async (req, res, next) => {
  if (MODE !== 'blob') return res.status(400).json({ error: 'Blob storage is not enabled' });
  const { id } = req.query;
  const index = Number(req.query.index);
  if (parseFileId(id) === null || !Number.isInteger(index) || index < 0) {
    return res.status(400).json({ error: 'Invalid part' });
  }
  try {
    const result = await get(`${BLOB_PREFIX}${id}/${index}`, { access: 'public', token: BLOB_TOKEN });
    if (!result || result.statusCode !== 200) return res.status(404).json({ error: 'Part not found' });
    res.set('Content-Type', 'application/octet-stream');
    res.set('Cache-Control', 'private, max-age=3600');
    Readable.fromWeb(result.stream).pipe(res);
  } catch (err) {
    next(err);
  }
});

app.get('/api/files/:id', (req, res) => {
  if (MODE === 'blob') return res.status(400).json({ error: 'Download parts from /api/parts' });
  const filePath = resolveStoredFile(req.params.id);
  if (!filePath) return res.status(404).json({ error: 'File not found' });
  res.download(filePath, req.params.id);
});

app.delete('/api/files/:id', async (req, res, next) => {
  const { id } = req.params;
  try {
    if (MODE === 'blob') {
      if (parseFileId(id) === null) return res.status(404).json({ error: 'File not found' });
      const blobs = await listBlobs(`${BLOB_PREFIX}${id}/`);
      if (!blobs.length) return res.status(404).json({ error: 'File not found' });
      await del(blobs.map((b) => b.url), { token: BLOB_TOKEN });
    } else {
      const filePath = resolveStoredFile(id);
      if (!filePath) return res.status(404).json({ error: 'File not found' });
      fs.unlinkSync(filePath);
    }
    res.json({ deleted: id });
  } catch (err) {
    next(err);
  }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File too large. Maximum size is 50 MB.' });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Part too large' });
  }
  console.error(err);
  // Blob SDK messages (e.g. missing credentials) are safe and useful to show.
  if (err instanceof BlobError) return res.status(502).json({ error: `Storage error: ${err.message}` });
  res.status(500).json({ error: 'Internal server error' });
});

// Run a server locally; on Vercel the exported app is used as the function handler.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Universal File Transfer running at http://localhost:${PORT} (storage: ${MODE})`);
    if (MODE === 'disk') console.log(`Storing files in ${UPLOAD_DIR}`);
  });
}

module.exports = app;
