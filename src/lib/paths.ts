import path from "node:path";
import { config } from "./config.js";
import { hmacSha256Hex, timingSafeEqualString } from "./security.js";

export const projectRoot = process.cwd();
export const storageRoot = config.storageRoot ? path.resolve(config.storageRoot) : path.join(projectRoot, "storage");
export const reportsDir = path.join(storageRoot, "reports");
export const templatesDir = path.join(storageRoot, "templates");
export const mediaDir = path.join(storageRoot, "media");

export function toPublicFileUrl(filePath: string, baseUrl: string) {
  const relative = path.relative(storageRoot, filePath).split(path.sep).join("/");
  return `${baseUrl}/files/${relative}`;
}

export function toPublicMediaUrl(filePath: string, baseUrl: string) {
  const relative = path.relative(mediaDir, filePath).split(path.sep).join("/");
  return `${baseUrl}/media/${relative}`;
}

export function toSignedStorageUrl(filePath: string, baseUrl = config.publicBaseUrl, ttlSeconds = config.signedFileUrlTtlSeconds) {
  const relative = path.relative(storageRoot, filePath).split(path.sep).join("/");
  return buildSignedFileUrl("/files", relative, baseUrl, ttlSeconds);
}

export function toSignedMediaUrl(filePath: string, baseUrl = config.publicBaseUrl, ttlSeconds = config.signedFileUrlTtlSeconds) {
  const relative = path.relative(mediaDir, filePath).split(path.sep).join("/");
  return buildSignedFileUrl("/media", relative, baseUrl, ttlSeconds);
}

export function verifySignedFileRequest(input: {
  scope: "files" | "media";
  relativePath: string;
  expires: string | undefined;
  signature: string | undefined;
}) {
  const expires = Number(input.expires);
  if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) {
    return false;
  }
  const expected = signFilePath(input.scope, normalizeRelativePath(input.relativePath), expires);
  return timingSafeEqualString(input.signature, expected);
}

export function resolveStorageFilePath(relativePath: string) {
  return resolveInsideRoot(storageRoot, relativePath);
}

export function resolveMediaFilePath(relativePath: string) {
  return resolveInsideRoot(mediaDir, relativePath);
}

function buildSignedFileUrl(prefix: "/files" | "/media", relativePath: string, baseUrl: string, ttlSeconds: number) {
  const normalized = normalizeRelativePath(relativePath);
  const expires = Math.floor(Date.now() / 1000) + Math.max(60, ttlSeconds);
  const scope = prefix.slice(1) as "files" | "media";
  const signature = signFilePath(scope, normalized, expires);
  const encodedPath = normalized.split("/").map(encodeURIComponent).join("/");
  return `${baseUrl}${prefix}/${encodedPath}?expires=${expires}&sig=${signature}`;
}

function signFilePath(scope: "files" | "media", relativePath: string, expires: number) {
  return hmacSha256Hex(config.fileAccessSecret, `${scope}:${relativePath}:${expires}`);
}

function normalizeRelativePath(relativePath: string) {
  return relativePath
    .split("/")
    .filter((part) => part && part !== ".")
    .join("/");
}

function resolveInsideRoot(root: string, relativePath: string) {
  const normalized = normalizeRelativePath(relativePath);
  const filePath = path.resolve(root, normalized);
  const relative = path.relative(root, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Invalid file path.");
  }
  return filePath;
}
