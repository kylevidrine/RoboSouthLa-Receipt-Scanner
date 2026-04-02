import dotenv from "dotenv";
import path from "path";
// Load base .env first, then override with environment-specific file
dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), `.env.${process.env.NODE_ENV || 'development'}`), override: true });

import express, { Request, Response, NextFunction } from "express";
import { createServer as createViteServer } from "vite";
import axios from "axios";
import jwt from "jsonwebtoken";
import fs from "fs";

const app = express();
const PORT = 3000;

const JWT_SECRET = process.env.JWT_SECRET || process.env.GOOGLE_CLIENT_SECRET || "fallback-secret-change-me";
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://receipt.robosouthla.com/auth/google/callback';

// Trust reverse proxy (NGINX) for secure connections
app.set('trust proxy', 1);

// Simple local storage for receipts
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

// JWT auth middleware
function authenticateJWT(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET) as any;
    (req as any).jwtUser = payload.user;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// OAuth Routes
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

    const user = userResponse.data;
    const jwtToken = jwt.sign({ user }, JWT_SECRET, { expiresIn: "30d" });

    res.redirect(`/?token=${encodeURIComponent(jwtToken)}`);
  } catch (error) {
    console.error("OAuth Error:", error);
    res.status(500).send("Authentication failed");
  }
});

app.get("/api/auth/me", (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.json({ user: null });
  }
  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET) as any;
    res.json({ user: payload.user });
  } catch {
    res.json({ user: null });
  }
});

app.post("/api/auth/logout", (req, res) => {
  // JWT is stateless; client drops the token
  res.json({ success: true });
});

// Receipt API Routes
app.get("/api/receipts", authenticateJWT, (req, res) => {
  const user = (req as any).jwtUser;
  const userReceipts = receipts.filter((r) => r.uid === user.id);
  res.json(userReceipts);
});

app.post("/api/receipts", authenticateJWT, (req, res) => {
  const user = (req as any).jwtUser;
  const newReceipt = {
    ...req.body,
    id: Math.random().toString(36).substr(2, 9),
    uid: user.id,
    timestamp: Date.now(),
  };
  receipts.push(newReceipt);
  saveReceipts();
  res.json(newReceipt);
});

app.delete("/api/receipts/:id", authenticateJWT, (req, res) => {
  const user = (req as any).jwtUser;
  receipts = receipts.filter((r) => r.id !== req.params.id || r.uid !== user.id);
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
