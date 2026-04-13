# x-mix-dapp

Standalone frontend for x-mix.

## UX
- Connect wallet
- Fill recipient address
- Input amount
- Click `确认发送`

The page automatically:
- sends on-chain `deposit`
- generates a backup note
- submits relayer request to `POST /api/relay-request/build`

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
