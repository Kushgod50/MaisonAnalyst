# Maison Analyst

AI-powered luxury garment analyst. Upload a photo of any clothing item and get a full breakdown: designer, fabric, cut, inseam, sizing, construction, and retail estimate.

## Project Structure

```
maison-analyst/
├── api/
│   └── analyse.js       # Serverless function (proxies Anthropic API)
├── public/
│   └── index.html       # Frontend
├── vercel.json          # Vercel config
└── package.json
```

## Deploy to Vercel

### 1. Install Vercel CLI (optional for local dev)
```bash
npm i -g vercel
```

### 2. Push to GitHub
Create a new GitHub repo and push this folder.

### 3. Import on Vercel
- Go to https://vercel.com/new
- Import your GitHub repo
- Vercel auto-detects the project

### 4. Add your Anthropic API key
In your Vercel project → **Settings → Environment Variables**, add:

| Name | Value |
|------|-------|
| `ANTHROPIC_API_KEY` | `sk-ant-...` |

### 5. Deploy
Hit **Deploy**. Done.

## Local Development

```bash
npm i -g vercel
vercel dev
```

Then open http://localhost:3000

## Getting an Anthropic API Key
1. Go to https://console.anthropic.com
2. Create an account / sign in
3. Go to API Keys → Create Key
4. Copy and paste into your Vercel environment variable

## Notes
- Your API key is **never** exposed to the browser — all Anthropic calls go through `/api/analyse.js` (a serverless function)
- Uses `claude-sonnet-4-20250514`
- Images are sent as base64 and not stored anywhere
