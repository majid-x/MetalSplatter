# Chunk 3 — Auth + Supabase session

**Date:** 2026-10-29  
**Status:** complete

## Done

- Supabase JS client with file-backed session storage under Electron `userData/AuthSession`
- Auth gate: bootstrapping → AuthView or signed-in shell
- Sign in / sign up (full name + confirm password), validation parity with MacApp
- Password reset modal (Azure OTP: send → verify → set password)
- Explicit Sign Out only clears local session (ignores SDK auto-logout), matching MacApp
- Temporary signed-in placeholder with Sign Out (dashboard = Chunk 4)

## Run

```bash
cd WindowsApp
npm run dev
```

## Next (Chunk 4)

Dashboard shell — Projects / Booking / Settings tabs.
