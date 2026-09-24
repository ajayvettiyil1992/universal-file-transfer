# universal-file-transfer

A small Node.js (Express) app for storing files. You can upload files of any type (ZIP, images, PDFs, videos and so on) up to **50 MB** each, then list, download and delete them from a web page.

## Storage modes

The app chooses where files are stored when it starts:

| Mode   | When                             | Where files go                                                  |
|--------|----------------------------------|-----------------------------------------------------------------|
| `blob` | `BLOB_READ_WRITE_TOKEN` is set   | [Vercel Blob](https://vercel.com/docs/vercel-blob). The browser uploads directly to Blob. |
| `disk` | Otherwise (local machine or VPS) | `./uploads`, or the folder set by `UPLOAD_DIR`                  |

Vercel needs Blob mode. Vercel functions have no persistent filesystem and accept request bodies of at most 4.5 MB. To get around the size limit, the browser sends each file straight to Blob storage, and the server only issues a short-lived upload token that caps each file at 50 MB.

## Run locally

```bash
npm install
npm start          # http://localhost:3000, disk mode
```

Optional environment variables: `PORT` (default `3000`) and `UPLOAD_DIR` (default `./uploads`).

## Deploy to Vercel

1. Import this GitHub repo in Vercel (**Add New → Project**). The defaults work, and Vercel detects the Express app in `server.js`.
2. In the project, open **Storage → Create → Blob**, choose **Public** access, and connect the store to the project. Connecting it adds `BLOB_READ_WRITE_TOKEN`.
3. Redeploy so the new variable is applied.

If you skip step 2, the page loads but shows "Storage is not configured".

## API

| Method   | Path               | Description                                                           |
|----------|--------------------|-----------------------------------------------------------------------|
| `GET`    | `/api/files`       | List files. Each has `id`, `name`, `size`, `uploadedAt`, `downloadUrl` |
| `POST`   | `/api/files`       | Disk mode: upload files (multipart field `files`)                     |
| `POST`   | `/api/blob-upload` | Blob mode: token handshake used by the browser's `upload()`           |
| `GET`    | `/api/files/:id`   | Disk mode: download a file. In blob mode use `downloadUrl` instead     |
| `DELETE` | `/api/files/:id`   | Delete a file (URL-encode the `id`)                                   |

Files over 50 MB are rejected. In disk mode, if a name is already taken, the new file is saved as `name (1).ext`. It does not overwrite the existing file.

## Development

`public/vendor/blob-client.js` is a browser bundle of `@vercel/blob/client`. After upgrading `@vercel/blob`, rebuild it with `npm run build:client`.

> There is no authentication. Anyone who can reach the app can upload, download and delete files. In blob mode, files are served from public Blob URLs.
