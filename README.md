# universal-file-transfer

A small Node.js (Express) app for storing files. You can upload files of any type (ZIP, images, PDFs, videos and so on) up to **50 MB** each, then list, download and delete them from a web page.

## Storage modes

The app chooses where files are stored when it starts:

| Mode   | When                                              | Where files go                                                  |
|--------|---------------------------------------------------|-----------------------------------------------------------------|
| `blob` | `BLOB_READ_WRITE_TOKEN` or `BLOB_STORE_ID` is set | [Vercel Blob](https://vercel.com/docs/vercel-blob)              |
| `disk` | Otherwise (local machine or VPS)                  | `./uploads`, or the folder set by `UPLOAD_DIR`                  |

Vercel needs Blob mode, because its functions have no persistent filesystem. Vercel functions also accept and return at most 4.5 MB per request, so in Blob mode the browser splits each file into 4 MB parts and sends them to the app one by one. The server stores each part as `uploads/<timestamp>/<size>/<name>/<index>`. To download, the browser fetches the parts through the app and joins them back into the original file. The browser never talks to the Blob API directly.

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

Newer Blob stores give the project `BLOB_STORE_ID` instead of a read-write token and authenticate with Vercel OIDC. The app supports both.

If you skip step 2, the page loads but shows "Storage is not configured".

## API

| Method   | Path                          | Description                                                        |
|----------|-------------------------------|--------------------------------------------------------------------|
| `GET`    | `/api/files`                  | List files. Each has `id`, `name`, `size`, `uploadedAt`, `complete` |
| `POST`   | `/api/files`                  | Disk mode: upload files (multipart field `files`)                  |
| `GET`    | `/api/files/:id`              | Disk mode: download a file                                         |
| `PUT`    | `/api/parts?id=&index=`       | Blob mode: store one part (raw body, 4 MB except the last part)    |
| `GET`    | `/api/parts?id=&index=`       | Blob mode: fetch one part                                          |
| `DELETE` | `/api/files/:id`              | Delete a file (URL-encode the `id`)                                |

Files over 50 MB are rejected. In disk mode, if a name is already taken, the new file is saved as `name (1).ext`. It does not overwrite the existing file.

> There is no authentication. Anyone who can reach the app can upload, download and delete files. In blob mode the parts are stored in a public Blob store.
