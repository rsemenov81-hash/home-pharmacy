# Connecting Your AIs to Home Pharmacy

Home Pharmacy exposes **one canonical household store** over four interoperable protocols so **Gemini, Claude, Grok Bot, ChatGPT/GPT, and Meta Muse** can all read your catalog, research & add new compounds, inspect interactions, and suggest spread schedules safely.

> **Security & Privacy:** Never paste private API keys into public repositories. Scope every AI key or OAuth grant to the minimum privilege needed (`read` for Q&A, `propose` for researching compounds and suggesting stack updates, `write` only for full admin automation). Edits to `verified` compound profiles are always routed to the **Proposals Inbox** for your review.

---

## 1. Claude (Desktop, Web, Mobile — Remote MCP + OAuth 2.1 DCR)
1. Open **Claude → Settings → Connectors → Add Custom Connector**.
2. Enter your Remote MCP URL: `https://<your-hub-domain>/mcp`
3. Claude automatically discovers `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`, registers via RFC 7591 DCR (`/oauth/register`), and opens your household consent page (`/oauth/authorize`).
4. Enter your **Household Passcode**, select `propose` (recommended) or `read` scope, and click **Approve**.
5. Test by asking Claude: *"Look up my peptides section schema, research Epitalon, check duplicates, and add a full profile with citations."*

## 2. Gemini (MCP / Extensions / Context Bundle)
1. **Remote MCP (OAuth 2.1 or Scoped Bearer Key):** Point your Gemini MCP client to `https://<your-hub-domain>/mcp` with OAuth 2.1 PKCE `S256` or `Authorization: Bearer <minted-key>` (mint in **AI Hub → API Keys**).
2. **Gemini Gems / Web Chat:** Open **AI Hub → Copy Context MD** (or fetch `GET /api/v1/export/context.md?member=member_wife`) and paste into your Gem instructions, or use the **Add/Research with AI Prompt Builder** to generate a strict JSON profile and import it back in 1 click.

## 3. Grok Bot (Remote MCP + OAuth 2.1 / Bearer + REST API)
1. Configure Grok Bot's Remote MCP connector with `https://<your-hub-domain>/mcp` (supports both `2025-06-18` and `2024-11-05` MCP protocol versions and OAuth 2.1 DCR + refresh rotation).
2. Alternatively, mint a `propose`-scoped API key in **AI Hub → API Keys** and configure `Authorization: Bearer <key>` (or `?token=<key>` fallback) against `/mcp` or `/api/v1/*`.
3. Ask Grok Bot to call `propose_stack_change` or `suggest_stack_schedule` for either spouse (`member_wife` or `member_husband`).

## 4. ChatGPT / Custom GPT (Actions via OpenAPI 3.1.0 + OAuth 2.1 / CIMD)
1. Create a **Custom GPT → Configure → Actions → Import from URL**.
2. Import your zero-PII OpenAPI 3.1.0 spec: `https://<your-hub-domain>/openapi.json`.
3. Under **Authentication**, choose either:
   - **OAuth 2.1** (`authorization_url: /oauth/authorize`, `token_url: /oauth/token`, PKCE `S256`, supports HTTPS CIMD `client_id`), OR
   - **API Key → Bearer** using a scoped key minted in **AI Hub → API Keys**.
4. In the GPT instructions, tell it to always call `getSectionSchema` and `checkDuplicateCompound` before `createCompound`.

## 5. Meta Muse (Scoped API Key + `/llms.txt` + Context Bundle + MCP/REST)
1. Mint a dedicated key named `Meta Muse` (`read` or `propose` scope) in **AI Hub → API Keys**.
2. Provide your discovery entrypoint `https://<your-hub-domain>/llms.txt` and OpenAPI spec `https://<your-hub-domain>/openapi.json` (or Remote MCP `https://<your-hub-domain>/mcp`, including JSON-RPC batch calls).
3. For chat-only sessions, copy the token-efficient Markdown bundle from **AI Hub → Copy Context MD** (`/api/v1/export/context.md`).
