# x-mix-dapp

Standalone frontend for x-mix.

## UX
- Connect wallet
- Fill recipient address
- Input amount
- Click `确认发送`

The page will automatically:
- send on-chain `deposit`
- generate and show backup note
- call relayer API `POST /api/relay-request/build`

## Defaults
- RPC: Chainstack mainnet endpoint
- Program ID: `XmixQ4DB8MtKcEFhyjWs1gZtdaF3YDuF4ieGLJ3xotv`
- Relayer API: `https://api.xmix.dev`

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
