# x-mix-dapp

Standalone frontend for x-mix.

## UX
- Connect wallet
- Select asset (`SOL` / `USDC`)
- Fill recipient address
- Input amount
- Click `确认发送`

The page automatically:
- sends on-chain `deposit`
- generates a backup note
- submits relayer request to `POST /api/relay-request/build`

Current defaults:
- `SOL`: wrapped SOL mint (`So111...`), minimum 0.05 SOL.
- `USDC`: mainnet USDC mint (`EPjF...`), minimum 10 USDC.

## Stack
- Vite build
- Local npm dependencies (no `esm.sh` runtime imports)

## Local development

```bash
cd x-mix-dapp
npm install
npm run dev
```

## Production build

```bash
npm run build
npm run preview
```

## Vercel
- Framework preset: `Vite`
- Build command: `npm run build`
- Output directory: `dist`

## Default endpoints
- Relayer API: `https://api.xmix.dev`
- Program ID: `XmixQ4DB8MtKcEFhyjWs1gZtdaF3YDuF4ieGLJ3xotv`
