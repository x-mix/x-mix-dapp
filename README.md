# x-mix-dapp

Standalone frontend for x-mix.

## Features
- Connect Phantom wallet
- Build and send SOL `deposit`
- Generate/download note (`secretHex` + `nullifierHex`)
- Submit withdraw request directly to relayer API

## Local run

```bash
cd x-mix-dapp
python3 -m http.server 4173
```

Open: `http://127.0.0.1:4173`

## Deploy to Vercel

1. Import this repository in Vercel.
2. Framework preset: `Other`.
3. Build command: leave empty.
4. Output directory: leave empty.
5. Deploy.

## Relayer API

Default in page: `http://127.0.0.1:8787`.

After deploying, set the page field to your public relayer API URL, for example:
- `https://relayer.yourdomain.com`

On relayer side, allow your Vercel domain in CORS:

```env
RELAYER_API_CORS_ORIGIN=https://your-vercel-domain.vercel.app
```

(or `*` during testing)
