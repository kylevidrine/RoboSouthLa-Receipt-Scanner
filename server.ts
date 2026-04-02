import "dotenv/config";
import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import axios from "axios";
import cookieSession from "cookie-session";
import fs from "fs";

const app = express();
const PORT = 3000;
const REDIRECT_URI = "https://receipt.robosouthla.com/auth/google/callback";

app.set("trust proxy", 1);

let receipts: any[] = [];
const RECEIPTS_FILE = path.join(process.cwd(), "receipts.json");

if (fs.existsSync(RECEIPTS_FILE)) {
  try {
    receipts = JSON.parse(fs.readFileSync(RECEIPTS_FILE, "utf-8"));
  } catch (e) {
    console.error("Error reading receipts file:", e);
  }
}

const saveReceipts = () => {
  try {
    fs.writeFileSync(RECEIPTS_FILE, JSON.stringify(receipts, null, 2));
  } catch (e) {
    console.error("Error saving receipts file:", e);
  }
};

app.use(express.json({ limit: "50mb" }));
app.use(
  cookieSession({
    name: "session",
    keys: [process.env.GOOGLE_CLIENT_SECRET || "robo-secret-key"],
    maxAge: 24 * 60 * 60 * 1000,
    secure: true,
    sameSite: "lax",
    httpOnly: true,
  })
);

app.get("/api/auth/url", (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "openid email profile",
    access_type: "offline",
    prompt: "consent",
  });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  res.json({ url: authUrl });
});

app.get(["/auth/google/callback", "/auth/google/callback/"], async (req, res) => {
  const { code } = req.query;

  try {
    const tokenResponse = await axios.post("https://oauth2.googleapis.com/token", {
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    });

    const { access_token } = tokenResponse.data;
    const userResponse = await axios.get("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    req.session!.user = userResponse.data;
    console.log("Session set for user:", userResponse.data.email);

    res.send(`
      <html>
        <body>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS' }, '*');
              window.close();
            } else {
              window.location.href = '/';
            }
          </script>
          <p>Authentication successful. This window should close automatically.</p>
        </body>
      </html>
    `);
  } catch (error) {
    console.error("OAuth Error:", error);
    res.status(500).send("Authentication failed");
  }
});

app.get("/api/auth/me", (req, res) => {
  console.log("Checking auth for session:", req.session?.user?.email || "No user");
  res.json({ user: req.session?.user || null });
});

app.post("/api/auth/logout", (req, res) => {
  req.session = null;
  res.json({ success: true });
});

app.get("/api/receipts", (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: "Unauthorized" });
  const userReceipts = receipts.filter((r) => r.uid === req.session!.user.id);
  res.json(userReceipts);
});

app.post("/api/receipts", (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: "Unauthorized" });
  const newReceipt = {
    ...req.body,
    id: Math.random().toString(36).substr(2, 9),
    uid: req.session!.user.id,
    timestamp: Date.now(),
  };
  receipts.push(newReceipt);
  saveReceipts();
  res.json(newReceipt);
});

app.delete("/api/receipts/:id", (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: "Unauthorized" });
  receipts = receipts.filter((r) => r.id !== req.params.id || r.uid !== req.session!.user.id);
  saveReceipts();
  res.json({ success: true });
});

async function startServer() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    console.warn("WARNING: GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is not set. OAuth will not work.");
  }

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();