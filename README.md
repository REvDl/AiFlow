# AiFlow

## Development

- Install dependencies: `npm install`
- Start app: `npm run dev`

## Build Windows `.exe`

- Create installer: `npm run dist`
- Build output folder: `dist/`

Notes:
- On first launch, app auto-creates runtime config at `userData/.env`.
- For Google OAuth, set `GOOGLE_OAUTH_CLIENT_ID` in local `.env` before packaging, or update runtime `.env` after install.
