# Deploying Home Pharmacy

Home Pharmacy runs identically on **local Node 22 + SQLite** and **Cloudflare Workers (D1/KV) + GitHub Pages**.

## 1. Local Self-Host (Node 22 + SQLite)
```bash
npm install
npm run build
HOUSEHOLD_ADMIN_TOKEN="$(openssl rand -hex 24)" \
HOUSEHOLD_PASSCODE="choose-a-strong-passcode" \
PORT=8787 \
npm start
```
Open `http://127.0.0.1:8787/` and sign in with your `HOUSEHOLD_ADMIN_TOKEN`. All household data, isolated auth hashes, and 30-day automatic daily snapshots persist locally in `.data/home-pharmacy.sqlite` (git-ignored).

## 2. Cloudflare Workers (Backend + OAuth 2.1 + Remote MCP)
1. Create a strongly consistent Cloudflare D1 database (required for OAuth 2.1 DCR/PKCE single-use auth codes & refresh rotation):
   ```bash
   npx wrangler d1 create home-pharmacy-db
   ```
2. Copy the returned `database_id` into your local `wrangler.toml` `[[d1_databases]]` block.
3. Build the Worker bundle and set secrets (never commit tokens to git):
   ```bash
   npm run build
   npx wrangler secret put HOUSEHOLD_ADMIN_TOKEN
   npx wrangler secret put HOUSEHOLD_PASSCODE
   npx wrangler deploy
   ```

## 3. GitHub Pages (Frontend PWA)
1. Run `npm run build` to emit the static PWA into `dist/web/`.
2. Publish `dist/web/` to GitHub Pages (with `.nojekyll` included).
3. In the PWA **Settings → Cloud Sync**, point the Hub Server URL to your deployed Cloudflare Worker origin and authenticate with your `HOUSEHOLD_ADMIN_TOKEN`.
4. Ensure `ALLOWED_ORIGINS` on the Worker includes `https://rsemenov81-hash.github.io`.
