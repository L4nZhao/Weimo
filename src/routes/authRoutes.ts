import { Router } from "express";
import { z } from "zod";
import {
  clearAdminCookie,
  clearLoginFailures,
  createAdminSession,
  getSessionFromRequest,
  isLoginRateLimited,
  registerLoginFailure,
  setAdminCookie,
  validateAdminCredentials
} from "../services/authService.js";

const router = Router();

router.get("/me", (req, res) => {
  const session = getSessionFromRequest(req);
  if (!session) {
    res.status(401).json({ error: "Admin login required" });
    return;
  }
  res.json({ username: session.username, role: session.role });
});

router.post("/login", (req, res) => {
  const payload = z
    .object({
      username: z.string().min(1),
      password: z.string().min(1)
    })
    .parse(req.body);

  const rateLimitKey = req.ip || "unknown";
  if (isLoginRateLimited(rateLimitKey)) {
    res.status(429).json({ error: "登录尝试过于频繁，请 15 分钟后再试" });
    return;
  }

  if (!validateAdminCredentials(payload.username, payload.password)) {
    registerLoginFailure(rateLimitKey);
    res.status(401).json({ error: "用户名或密码错误" });
    return;
  }

  clearLoginFailures(rateLimitKey);
  setAdminCookie(res, createAdminSession(payload.username));
  res.json({ username: payload.username, role: "admin" });
});

router.post("/logout", (_req, res) => {
  clearAdminCookie(res);
  res.json({ ok: true });
});

export { router as authRoutes };
