const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { list, del, issueSignedToken, BlobError } = require('@vercel/blob');
const { handleUpload, handleUploadPresigned } = require('@vercel/blob/client');

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, 'uploads'));
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const BLOB_PREFIX = 'uploads/';
// Blob pathnames look like "uploads/<timestamp>/<file name>".
const BLOB_ID_RE = /^\d+\/[^/\\\x00-\x1f]+$/;

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
const BLOB_TOKEN = findBlobToken();

// Newer Blob stores give the project BLOB_STORE_ID instead of a read-write
// token and authenticate with the function's Vercel OIDC token.
// "token": read-write token; browser uploads use client tokens.
// "oidc": OIDC; browser uploads use presigned URLs.
const BLOB_AUTH = BLOB_TOKEN ? 'token' : process.env.BLOB_STORE_ID ? 'oidc' : null;

// "blob": Vercel Blob storage (needed on Vercel, whose filesystem is not persistent).
// "disk": local folder, for running on your own machine or a VPS.
const MODE = BLOB_AUTH ? 'blob' : process.env.VERCEL ? 'unconfigured' : 'disk';

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
      files = [];
      let cursor;
      do {
        const page = await list({ prefix: BLOB_PREFIX, cursor, token: BLOB_TOKEN });
        for (const b of page.blobs) {
          const id = b.pathname.slice(BLOB_PREFIX.length);
          files.push({
            id,
            name: path.posix.basename(id),
            size: b.size,
            uploadedAt: b.uploadedAt,
            downloadUrl: b.downloadUrl,
          });
        }
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
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
            downloadUrl: `/api/files/${encodeURIComponent(d.name)}`,
          };
        });
    }
    files.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    res.json({
      mode: MODE,
      blobUpload: BLOB_AUTH === 'oidc' ? 'presigned' : 'client-token',
      files,
      maxFileSize: MAX_FILE_SIZE,
    });
  } catch (err) {
    next(err);
  }
});

// Disk mode: the file goes through this server.
app.post('/api/files', (req, res, next) => {
  if (MODE !== 'disk') return res.status(400).json({ error: 'Use /api/blob-upload in blob mode' });
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

function assertValidBlobPath(pathname) {
  if (!pathname.startsWith(BLOB_PREFIX) || !BLOB_ID_RE.test(pathname.slice(BLOB_PREFIX.length))) {
    throw new Error('Invalid file path');
  }
}

// Blob mode: the browser uploads straight to Vercel Blob (bypassing Vercel's
// 4.5 MB request limit); this endpoint only issues short-lived upload permission.
app.post('/api/blob-upload', express.json(), async (req, res) => {
  if (MODE !== 'blob') return res.status(400).json({ error: 'Blob storage is not enabled' });
  const limits = { maximumSizeInBytes: MAX_FILE_SIZE, addRandomSuffix: false, allowOverwrite: false };
  try {
    const result =
      BLOB_AUTH === 'oidc'
        ? await handleUploadPresigned({
            request: req,
            body: req.body,
            getSignedToken: async (pathname) => {
              assertValidBlobPath(pathname);
              const token = await issueSignedToken({
                pathname,
                operations: ['put'],
                maximumSizeInBytes: MAX_FILE_SIZE,
              });
              return { token, urlOptions: limits };
            },
          })
        : await handleUpload({
            token: BLOB_TOKEN,
            request: req,
            body: req.body,
            onBeforeGenerateToken: async (pathname) => {
              assertValidBlobPath(pathname);
              return limits;
            },
          });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/files/:id', (req, res) => {
  if (MODE === 'blob') return res.status(400).json({ error: 'Download from the file\'s downloadUrl' });
  const filePath = resolveStoredFile(req.params.id);
  if (!filePath) return res.status(404).json({ error: 'File not found' });
  res.download(filePath, req.params.id);
});

app.delete('/api/files/:id', async (req, res, next) => {
  const { id } = req.params;
  try {
    if (MODE === 'blob') {
      if (!BLOB_ID_RE.test(id)) return res.status(404).json({ error: 'File not found' });
      await del(BLOB_PREFIX + id, { token: BLOB_TOKEN });
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
