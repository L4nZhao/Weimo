import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "../lib/config.js";
import { timingSafeEqualString } from "../lib/security.js";

const COOKIE_NAME = "weimo_admin_session";
const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;

const loginFailures = new Map<string, { count: number; windowStart: number }>();

type SessionPayload = {
  username: string;
  role: "admin";
  exp: number;
};

export function validateAdminCredentials(username: string, password: string) {
  const usernameOk = timingSafeEqualString(username, config.adminUsername);
  const passwordOk = timingSafeEqualString(password, config.adminPassword);
  return usernameOk && passwordOk;
}

export function isLoginRateLimited(key: string) {
  const entry = loginFailures.get(key);
  if (!entry) {
    return false;
  }
  if (Date.now() - entry.windowStart > LOGIN_FAILURE_WINDOW_MS) {
    loginFailures.delete(key);
    return false;
  }
  return entry.count >= LOGIN_MAX_FAILURES;
}

export function registerLoginFailure(key: string) {
  const now = Date.now();
  const entry = loginFailures.get(key);
  if (!entry || now - entry.windowStart > LOGIN_FAILURE_WINDOW_MS) {
    loginFailures.set(key, { count: 1, windowStart: now });
    return;
  }
  entry.count += 1;
}

export function clearLoginFailures(key: string) {
  loginFailures.delete(key);
}

export function createAdminSession(username: string) {
  const payload: SessionPayload = {
    username,
    role: "admin",
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(body);
  return `${body}.${signature}`;
}

export function verifyAdminSession(token?: string): SessionPayload | null {
  if (!token) {
    return null;
  }

  const [body, signature] = token.split(".");
  if (!body || !signature || !timingSafeEqual(signature, sign(body))) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    if (payload.role !== "admin" || payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function setAdminCookie(res: Response, token: string) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.adminCookieSecure,
    maxAge: SESSION_MAX_AGE_SECONDS * 1000,
    path: "/"
  });
}

export function clearAdminCookie(res: Response) {
  res.clearCookie(COOKIE_NAME, { path: "/" });
}

export function requireAdminApi(req: Request, res: Response, next: NextFunction) {
  const session = getSessionFromRequest(req);
  if (!session) {
    res.status(401).json({ error: "Admin login required" });
    return;
  }
  res.locals.admin = session;
  next();
}

export function requireAdminPage(req: Request, res: Response, next: NextFunction) {
  const session = getSessionFromRequest(req);
  if (!session) {
    res.redirect("/login");
    return;
  }
  res.locals.admin = session;
  next();
}

export function getSessionFromRequest(req: Request) {
  return verifyAdminSession(parseCookies(req.headers.cookie)[COOKIE_NAME]);
}

function sign(body: string) {
  return crypto.createHmac("sha256", config.sessionSecret).update(body).digest("base64url");
}

function timingSafeEqual(a: string, b: string) {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  return aBuffer.length === bBuffer.length && crypto.timingSafeEqual(aBuffer, bBuffer);
}

function parseCookies(cookieHeader?: string) {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) {
    return cookies;
  }

  for (const part of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (!rawKey) {
      continue;
    }
    cookies[rawKey] = decodeURIComponent(rawValue.join("="));
  }
  return cookies;
}
