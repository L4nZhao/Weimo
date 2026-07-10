import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs/promises";
import { ZodError } from "zod";
import { config } from "./lib/config.js";
import { mediaDir, resolveMediaFilePath, resolveStorageFilePath, storageRoot, verifySignedFileRequest } from "./lib/paths.js";
import { adminRoutes } from "./routes/adminRoutes.js";
import { authRoutes } from "./routes/authRoutes.js";
import { wechatRoutes } from "./routes/wechatRoutes.js";
import { requireAdminPage } from "./services/authService.js";
import { startIlinkPoller } from "./services/ilinkPoller.js";
import { startReminderScheduler } from "./services/reminderScheduler.js";

const app = express();

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || !config.isProduction || !config.allowedOrigins.length || config.allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("CORS origin denied"));
    }
  })
);
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

await fs.mkdir(storageRoot, { recursive: true });
await fs.mkdir(mediaDir, { recursive: true });

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "weimo" });
});

app.use("/auth", authRoutes);
app.get("/", requireAdminPage, (_req, res) => {
  res.sendFile("index.html", { root: "public" });
});
app.get("/login", (_req, res) => {
  res.sendFile("login.html", { root: "public" });
});
app.use(express.static("public", { index: false }));
app.get("/files/*", (req, res, next) => {
  serveSignedFile(req, res, next, "files");
});
app.get("/media/*", (req, res, next) => {
  serveSignedFile(req, res, next, "media");
});
app.use("/wechat", wechatRoutes);
app.use("/admin", adminRoutes);

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof ZodError) {
    res.status(400).json({ error: "Validation error", details: error.flatten() });
    return;
  }

  if (error instanceof SyntaxError) {
    res.status(400).json({ error: "Invalid JSON" });
    return;
  }

  console.error(error);
  res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
});

const server = app.listen(config.port, () => {
  console.log(`weimo API listening on ${config.publicBaseUrl}`);
  console.log(`Storage: ${path.relative(process.cwd(), storageRoot)}`);
});

startIlinkPoller().catch((error) => {
  console.error("Failed to start iLink poller", error);
});

startReminderScheduler();

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${config.port} is already in use. Stop the old server before starting a new one.`);
    process.exit(1);
  }
  throw error;
});

function serveSignedFile(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
  scope: "files" | "media"
) {
  try {
    const relativePath = String(req.params[0] || "");
    const expires = typeof req.query.expires === "string" ? req.query.expires : undefined;
    const signature = typeof req.query.sig === "string" ? req.query.sig : undefined;
    if (!verifySignedFileRequest({ scope, relativePath, expires, signature })) {
      res.status(403).json({ error: "Signed file link is invalid or expired." });
      return;
    }
    const filePath = scope === "files" ? resolveStorageFilePath(relativePath) : resolveMediaFilePath(relativePath);
    res.sendFile(filePath, (error) => {
      if (error) {
        next(error);
      }
    });
  } catch (error) {
    next(error);
  }
}
