# RoboSouth LA Receipt Scanner - Architecture

## Overview
A mobile-first receipt scanning application built with React (Vite frontend) and Express (Node.js backend). Users sign in with Google OAuth and can capture, store, and send receipts via webhook.

**Deployment:** Behind NGINX Proxy Manager (HTTPS reverse proxy) → Coolify (Docker) → GitHub webhooks

---

## Technology Stack

| Layer | Technology |
|-------|------------|
| Frontend | React + TypeScript + Tailwind CSS + Framer Motion |
| Backend | Express.js + Node.js |
| Authentication | Google OAuth 2.0 |
| Session Management | `cookie-session` (secure, httpOnly, SameSite=None) |
| Build Tool | Vite |
| Deployment | Coolify (Docker) with GitHub webhooks |
| Reverse Proxy | NGINX Proxy Manager |

---

## Frontend (`src/App.tsx`)

### Key States
- `user` — Logged-in Google user object (null if not authenticated)
- `view` — Current UI view: 'scanner' | 'gallery' | 'detail'
- `receipts` — Array of user's saved receipts from API
- `capturedImage` — Base64 image data from camera capture
- `isAutoCapture` — Toggle automatic capture on focus
- `isDemoMode` — Testing mode without authentication

### Views

#### Scanner View
- Live camera feed with edge detection overlay
- Auto-capture when receipt edges are in focus (45+ frames focused)
- Manual capture button
- Flash and auto-capture toggles
- Quality review screen after capture

#### Gallery View
- Grid of user's scanned receipts
- Shows receipt date
- Click to view full details

#### Detail View
- Full-screen receipt image
- Download to device
- Send to webhook (`https://n8n.robosouthla.com/webhook/scanner`)
- Delete receipt

### Authentication Flow

1. **Initial Load:** `checkAuth()` calls `/api/auth/me` to check if user is logged in
2. **Login:** `handleLogin()` → calls `/api/auth/url` → opens Google OAuth popup
3. **OAuth Popup:** 
   - User logs in with Google
   - Google redirects to `/auth/google/callback`
   - Server sets `req.session.user` with user data
   - Server sends postMessage `OAUTH_AUTH_SUCCESS` to opener and closes popup
4. **Session Restored:** Opener receives message → calls `checkAuth()` → user state updated

### API Calls
- `GET /api/auth/me` — Get current user (returns `{user: null}` or user object)
- `GET /api/auth/url` — Get Google OAuth URL
- `POST /api/auth/logout` — Clear session
- `GET /api/receipts` — Fetch user's receipts (requires auth)
- `POST /api/receipts` — Save new receipt (requires auth)
- `DELETE /api/receipts/:id` — Delete receipt (requires auth)

---

## Backend (`server.ts`)

### Middleware Setup

```typescript
app.set('trust proxy', 1);  // Trust NGINX reverse proxy headers
app.use(express.json({ limit: "50mb" }));
app.use(cookieSession({
  name: "session",
  keys: [process.env.GOOGLE_CLIENT_SECRET || "secret-key"],
  maxAge: 24 * 60 * 60 * 1000,  // 24 hours
  secure: true,                  // Only HTTPS (enforced by NGINX)
  sameSite: "none",              // Allow cross-site cookies
  httpOnly: true,                // JS cannot access cookie
}));
```

**Critical Note:** `app.set('trust proxy', 1)` tells Express to trust `X-Forwarded-Proto` and `X-Forwarded-For` headers from NGINX. Without this, `req.secure` is false and session cookies won't be set, even over HTTPS.

### OAuth Routes

#### `GET /api/auth/url`
- Generates Google OAuth authorization URL
- Stores `redirectUri` in session
- Returns `{url: "https://accounts.google.com/o/oauth2/v2/auth?..."}`

#### `GET /auth/google/callback`
- Receives authorization code from Google
- Exchanges code for access token
- Fetches user info from Google
- **Sets session:** `req.session.user = {id, email, name, picture, ...}`
- Sends HTML with script to postMessage opener and close popup

### User Data Routes

#### `GET /api/auth/me`
- Returns `{user: req.session?.user || null}`

#### `POST /api/auth/logout`
- Clears session: `req.session = null`

#### `GET /api/receipts`
- Requires authentication
- Returns receipts filtered by user ID

#### `POST /api/receipts`
- Requires authentication
- Saves new receipt with user ID
- Persists to `receipts.json` file

#### `DELETE /api/receipts/:id`
- Requires authentication
- Deletes receipt (only if user owns it)

### Session Persistence

Session data is stored in an **encrypted cookie**:
- Encrypted with `process.env.GOOGLE_CLIENT_SECRET`
- User data is NOT sent to the browser in plaintext — only an encrypted cookie
- Each request sends the cookie, Express decrypts it
- Changes to `req.session` are automatically re-encrypted and sent back as `Set-Cookie`

---

## Deployment Flow

```
Code Push to GitHub
    ↓
GitHub Webhook → Coolify
    ↓
Coolify builds Docker image
    ↓
Container starts on port 3000 (internally)
    ↓
NGINX Proxy Manager (external HTTPS)
    ↓
Browser (receives HTTPS)
```

### Critical Configuration
- **NGINX Proxy Manager:** "Advanced Trust Upstream forwarding proto headers" must be **enabled**
  - This adds `X-Forwarded-Proto: https` to requests forwarded to Express
  - Without it, Express sees HTTP internally and won't set secure cookies
- **Express:** `app.set('trust proxy', 1)` must be set
  - This makes Express trust the `X-Forwarded-Proto` header
  - Tells cookie-session that `req.secure = true`

---

## Known Issues & Fixes

### Session Not Persisting After OAuth (FIXED)
**Problem:** User logs in, redirects back, but checkAuth() returns null
**Root Cause:** Express doesn't trust proxy headers, so `req.secure = false`, and cookie-session won't set secure cookies
**Fix:** 
1. Added `app.set('trust proxy', 1)` in server.ts (line 13)
2. Enabled "Advanced Trust Upstream forwarding proto headers" in NGINX Proxy Manager

---

## Environment Variables

| Variable | Purpose | Example |
|----------|---------|---------|
| `GOOGLE_CLIENT_ID` | OAuth app ID | `1234567890-abc123.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | OAuth app secret | Used for signing session cookies |
| `APP_URL` | Fallback app base URL | `https://receipts.robosouthla.com` |
| `NODE_ENV` | Environment | `production` |

---

## File Structure

```
robosouthla-receipt-scanner/
├── server.ts                 # Express backend
├── src/
│   ├── App.tsx              # Main React component
│   ├── types.ts             # TypeScript types
│   └── ...
├── receipts.json            # User receipts storage (in-memory)
├── package.json
└── tsconfig.json
```

---

## Testing Checklist

- [ ] App loads without errors
- [ ] "Sign in with Google" button appears when not logged in
- [ ] OAuth popup opens and closes correctly
- [ ] Session persists after OAuth (user stays logged in)
- [ ] Camera access is requested and works
- [ ] Receipt capture and save works
- [ ] Gallery displays saved receipts
- [ ] Logout clears session
- [ ] Browser cookies show encrypted `session` cookie with `Secure`, `HttpOnly`, `SameSite=None` flags

---

*Last Updated: 2026-03-31*
