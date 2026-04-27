# Maison Analyst

AI-powered luxury garment analyst — upload a photo, get designer ID, fabric, cut, inseam, sizing & retail estimate.

## Files

```
maison-analyst/
├── api/
│   └── analyse.js    ← Vercel serverless function (keeps API key secret)
├── index.html        ← Frontend (served at /)
├── vercel.json       ← Routing config
└── package.json
```

## Deploy to Vercel (5 minutes)

### Option A — Drag & drop (easiest, no GitHub needed)
1. Go to https://vercel.com → Log in
2. Click **Add New → Project**
3. Choose **"Deploy without a Git repository"** / drag-and-drop this folder
4. Before deploying, go to **Environment Variables** and add:
   - Name: `ANTHROPIC_API_KEY`
   - Value: your key from https://console.anthropic.com/settings/keys
5. Click **Deploy**

### Option B — GitHub
1. Create a new GitHub repo, push this folder
2. Go to https://vercel.com/new → Import that repo
3. Add environment variable: `ANTHROPIC_API_KEY` = your key
4. Deploy

## Local development

```bash
npm install -g vercel
vercel dev
# Open http://localhost:3000
```

## Getting an Anthropic API key
1. Go to https://console.anthropic.com
2. Sign in / create account
3. Settings → API Keys → Create Key
4. Paste it as the `ANTHROPIC_API_KEY` environment variable in Vercel

## Security
Your API key is **never** sent to the browser.
All calls to Anthropic go through `/api/analyse.js` — a server-side Vercel function.
