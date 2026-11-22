# Home Pharmacy — Universal Household Health Hub

A privacy-first, offline-capable **Household Health Hub** built for two spouses (configurable names, safety contexts, and daily routine anchors) with a shared compound catalog, dual-track smart stack spreading, and universal multi-AI access across **Gemini, Claude, Grok Bot, ChatGPT/GPT, and Meta Muse**.

> **Medical & Harm-Reduction Notice:** Home Pharmacy is a personal reference, inventory, and scheduling tool only — not medical advice, diagnosis, or prescribing guidance. Consult a licensed healthcare professional for clinical decisions and laboratory monitoring.

---

## Core Capabilities

1. **Four Core Health Sections + Dynamic Custom Schemas**
   - **Peptides** (reconstitution math, U-100 draw calculator, blend breakdown, injection site rotation)
   - **Performance Enhancement Drugs (PEDs)** (ester half-life, oil mg/mL draw math, aromatization/17α-alkylated/HPG/virilization harm-reduction metadata, monitoring labs)
   - **Vitamins & Supplements** (chemical salt/chelate forms, bioavailability, Adult Upper Limit (UL) summation)
   - **Dermatology — Skin & Hair** (face/neck/body vs. scalp/hair separation, AM/PM photosensitivity & SPF check, viscosity/pH layering steps 1–7, alternating-night skin cycling, microneedling buffer)
   - Add custom fields, custom subsections, custom sections, and per-section AI research prompts at any time.

2. **Rich Compound Profiles & Shared vs. Personal Inventory**
   - Full monograph schema: description, mechanism of action, use cases, timing rules, structured half-life & PK decay estimator, dosages, cycles, structured `doNotPairWith` interactions, synergies, contraindications, labs, and citations/evidence tiers.
   - Ownership & stock tracking (`have`, `dont_have`, `wishlist`, `low_stock`, `ordered`) scoped either to `household` (shared) or `member:<id>` (personal), with run-out warnings.

3. **Deterministic Dual-Track Stack Builder & Smart Spreader Engine**
   - **Systemic Track:** 8 canonical daily slots anchored to each spouse's schedule (`waking_fasted`, `morning_am`, `pre_workout`, `intra_post_workout`, `midday_lunch`, `evening_dinner`, `bedtime_fasted`, `prn`), automatic `separationHours` conflict separation, synergy co-location, Adult UL alerts, member safety-context hard-stop guards (pregnancy teratogens, Rx meds, oncogenic/hepatotoxic pairs), cycle-phase tracking, and weekly injection load balancing.
   - **Dermatology Track:** AM/PM photosensitivity routing + missing-SPF alerts, strict 1–7 viscosity/pH layering with wait-time cues, alternating-night skin cycling (e.g., Retinoid vs. AHA/BHA vs. Copper Peptide), and separate Hair/Scalp schedule.
   - Explainable placement rationales, user pin overrides, and non-mutating **"What-If" Wishlist Simulation**.

4. **Universal 5-AI Integration (Gemini, Claude, Grok Bot, ChatGPT/GPT, Meta Muse)**
   - **Remote Streamable HTTP MCP Server (`POST /mcp`)** — JSON-RPC 2.0 (`2025-06-18` & `2024-11-05`) with 17 scoped tools, resources, and reusable prompts.
   - **Self-Hosted OAuth 2.1 + PKCE (`S256`) + RFC 9728/8414 Discovery + RFC 7591 DCR + CIMD** alongside SHA-256-hashed **Scoped Bearer API Keys** (`read`, `propose`, `write`).
   - **REST API v1 (`/api/v1/*`) + OpenAPI 3.1.0 (`/openapi.json`) + zero-PII `/llms.txt` + Portable Markdown/JSON Context Bundles**.
   - **AI Governance:** Configurable AI Write Policy (`ai_draft` vs. Proposals Inbox), verified-profile overwrite protection, alias/fingerprint deduplication, and full multi-AI audit trail.

5. **Privacy-First Architecture**
   - Zero personal health data, real names, or secrets are ever committed to this repository.
   - All private API/MCP responses send `Cache-Control: no-store`.
   - Frontend includes `<meta name="robots" content="noindex, nofollow">`, offline caching, daily snapshots, JSON/CSV/Protocol OS import-export, and optional local Device PIN Lock (salted SHA-256 with 5-attempt 30-second lockout).

---

## Quick Start (Local)

Requires **Node.js >= 22**.

```bash
npm ci
npm run build

# Start local Node 22 server with persistent storage
HOUSEHOLD_ADMIN_TOKEN="replace-with-strong-secret" \
HOUSEHOLD_PASSCODE="replace-with-passcode" \
PORT=8787 \
npm start
```

Open `http://127.0.0.1:8787` and sign in with your `HOUSEHOLD_ADMIN_TOKEN`.

---

## Scripts & Testing

```bash
npm run check       # Dry-run esbuild bundle check + privacy/secret audit
npm run build       # Build dist/web/ (React 18 PWA) and dist/worker.js (Cloudflare Worker)
npm run test:unit   # Run unit & integration tests (core, scheduler, backend, OAuth/MCP, build smoke)
npm run test:e2e    # Run full 4-tier opaque-box E2E suite (API, OAuth 2.1, MCP, Playwright UI)
npm run ci          # Run check + test:unit + test:e2e
```

---

## Documentation

- [AI_SETUP.md](./AI_SETUP.md) — Step-by-step setup guides for **Gemini, Claude, Grok Bot, ChatGPT/GPT, and Meta Muse**
- [DEPLOY.md](./DEPLOY.md) — Deployment instructions for **Cloudflare Workers (D1/KV)**, **GitHub Pages**, and self-hosted Node 22
