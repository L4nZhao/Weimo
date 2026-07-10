export type ToolDef = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

export type ToolResult = {
  content: string;
  sideEffects?: {
    outgoingMedia?: OutgoingMedia[];
    [key: string]: unknown;
  };
};

export type OutgoingMedia = {
  mediaType: "image" | "file" | "voice" | "video";
  fileName?: string;
  filePath?: string;
  publicUrl?: string;
  caption?: string | null;
  delivery?: "direct" | "link";
  source?: "media" | "report" | "generated-report" | "generated-document";
};

export type SkillContextReport = {
  id: string;
  title: string;
  filePath: string;
  publicUrl: string;
};

export type SkillContextFile = {
  id: string;
  title: string;
  fileName: string;
  filePath: string;
  publicUrl: string;
  mediaType: OutgoingMedia["mediaType"];
  caption?: string | null;
  createdAt?: Date;
  source?: OutgoingMedia["source"];
};

export type SkillContextMessage = {
  role: "user" | "assistant";
  content: string;
  createdAt?: Date;
};

export type SkillContext = {
  wechatUserId: string;
  userId: string;
  memberName: string;
  userMessage: string;
  recentMessages?: SkillContextMessage[];
  recentReport?: SkillContextReport;
  recentFile?: SkillContextFile;
  recentImage?: SkillContextFile;
};

export type Skill = {
  name: string;
  description: string;
  instructions?: string;
  tools: ToolDef[];
  execute: (toolName: string, args: Record<string, unknown>, context: SkillContext) => Promise<ToolResult>;
};
