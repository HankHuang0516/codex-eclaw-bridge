# Development Tunnel

EClawbot must reach your bridge over a public HTTPS URL. For local development,
run the bridge on port `18800`, then expose it with either Cloudflare Tunnel or
ngrok.

## Cloudflare Tunnel

```bash
cloudflared tunnel --url http://localhost:18800
```

Set:

```bash
ECLAW_WEBHOOK_URL=https://your-generated.trycloudflare.com
```

## ngrok

```bash
ngrok http 18800
```

Set:

```bash
ECLAW_WEBHOOK_URL=https://your-generated.ngrok-free.app
```

The bridge registers `${ECLAW_WEBHOOK_URL}/eclaw-webhook` with EClawbot on startup.
