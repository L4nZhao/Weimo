import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Skill, ToolDef, ToolResult, SkillContext } from "./skillTypes.js";

const skillsDir = path.join(process.cwd(), "src", "skills");
let cachedSkills: Skill[] | null = null;

export async function loadSkills() {
  if (cachedSkills) {
    return cachedSkills;
  }

  cachedSkills = await scanSkills();
  return cachedSkills;
}

export async function reloadSkills() {
  cachedSkills = await scanSkills();
  return cachedSkills;
}

async function scanSkills() {
  const entries = await fs.readdir(skillsDir, { withFileTypes: true }).catch(() => []);
  const skills: Skill[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const dir = path.join(skillsDir, entry.name);
    const skillPath = path.join(dir, "SKILL.md");
    const handlerPath = path.join(dir, "handler.ts");
    const runtimeHandlerPath = path.join(dir, "handler.js");
    const compiledHandlerPath = path.join(process.cwd(), "dist", "src", "skills", entry.name, "handler.js");
    const skillMarkdown = await fs.readFile(skillPath, "utf8").catch(() => null);
    if (!skillMarkdown) {
      continue;
    }

    const parsed = parseSkillMarkdown(skillMarkdown, entry.name);
    const handler = await importSkillHandler([compiledHandlerPath, runtimeHandlerPath, handlerPath]);
    const tools = handler.tools as ToolDef[] | undefined;
    const execute = handler.execute as
      | ((toolName: string, args: Record<string, unknown>, context: SkillContext) => Promise<ToolResult>)
      | undefined;

    if (!tools && !execute) {
      continue;
    }

    skills.push({
      name: parsed.name,
      description: parsed.description,
      instructions: parsed.instructions,
      tools: tools || [],
      execute:
        execute ||
        (async () => ({
          content: `Skill ${parsed.name} 没有可执行工具。`
        }))
    });
  }

  return skills;
}

async function importSkillHandler(paths: string[]) {
  for (const filePath of paths) {
    const exists = await fs
      .access(filePath)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      continue;
    }

    try {
      const handlerUrl = pathToFileURL(filePath).href;
      return await import(`${handlerUrl}?mtime=${Date.now()}`);
    } catch (error) {
      if (filePath.endsWith(".ts")) {
        continue;
      }
      throw error;
    }
  }

  return {};
}

function parseSkillMarkdown(markdown: string, fallbackName: string) {
  const frontmatterMatch = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
  const frontmatter = frontmatterMatch?.[1] || "";
  const instructions = frontmatterMatch ? markdown.slice(frontmatterMatch[0].length).trim() : markdown.trim();
  const fields = new Map<string, string>();

  for (const line of frontmatter.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) {
      fields.set(match[1], match[2].replace(/^["']|["']$/g, "").trim());
    }
  }

  return {
    name: fields.get("name") || fallbackName,
    description: fields.get("description") || instructions.split("\n").find(Boolean) || fallbackName,
    instructions
  };
}
