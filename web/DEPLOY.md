# Aurora Music — Web App Source

The entire web app (HTML + CSS + JavaScript, single page) lives in one file:

```
web/aurora-music-worker.js   ← Cloudflare Worker that serves the app + API
```

Deployed live at **<https://music.aurorax.site>**.

## What it needs

| Binding | Type | Purpose |
| --- | --- | --- |
| `DB` | Cloudflare D1 | Catalog index (tracks, albums, cache) |
| `MP3` | Cloudflare R2 bucket | Audio storage (Lossless / HQ catalog) |
| `CONV_KEY` | Secret | Converter API key |
| `CONV_URL` | Secret | Converter API base URL |

The app itself is fully static inside the worker — no build step, no npm install.

## Run your own instance

1. Create a Cloudflare account and install [Wrangler](https://developers.cloudflare.com/workers/wrangler/):

   ```bash
   npm install -g wrangler
   wrangler login
   ```

2. Create the bindings:

   ```bash
   wrangler d1 create aurora-music-db      # note the database id
   wrangler r2 bucket create aurora-music
   ```

3. Set the secrets:

   ```bash
   wrangler secret put CONV_KEY
   wrangler secret put CONV_URL
   ```

4. Add a `wrangler.toml` next to the worker source:

   ```toml
   name = "aurora-music"
   main = "aurora-music-worker.js"
   compatibility_date = "2024-09-23"
   compatibility_flags = ["nodejs_compat"]

   [[d1_databases]]
   binding = "DB"
   database_id = "<your-d1-id>"

   [[r2_buckets]]
   binding = "MP3"
   bucket_name = "aurora-music"
   ```

5. Deploy:

   ```bash
   wrangler deploy
   ```

## Routes served by the worker

| Route | Description |
| --- | --- |
| `/` | The app (single-page) |
| `/app` | "Get the app" install page for Android |
| `/terms`, `/legal`, `/dmca` | Legal / DMCA notice |
| `/api/home` | Home feed data |
| `/api/search` | Search (YouTube Music engine) |
| `/api/stream` | Audio stream |
| `/manifest.json`, `/icon.svg` | PWA assets |

> The "Get the app" entry points only show up in browsers — inside the native
> Android app (detected via the `AndroidBridge` JavaScript interface) they are
> hidden automatically.
