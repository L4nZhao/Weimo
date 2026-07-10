import { z } from "zod";
import { config } from "../../lib/config.js";
import { toSignedStorageUrl } from "../../lib/paths.js";
import { isStrongTextMatch } from "../../lib/textMatch.js";
import { listRecentMedia, parseGeneratedMediaSource, searchMediaByText } from "../../services/mediaService.js";
import { searchReports } from "../../services/reportService.js";
import type { OutgoingMedia } from "../../services/skillTypes.js";
import type { SkillContext, ToolDef } from "../../services/skillTypes.js";

export const tools: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "search_media",
      description: "按关键词或语义描述查询用户微信媒体存档和已生成 Word 报告，返回正确图片、文件、语音、视频或报告。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "要搜索的媒体内容描述或关键词" },
          mediaType: {
            type: "string",
            enum: ["image", "voice", "file", "video", "report", "any"],
            description: "媒体类型。所有命中的图片、文件、语音、视频和报告都进入微信直接发送队列。"
          },
          limit: { type: "number", description: "返回条数，默认 5，最多 20" },
          recentOnly: {
            type: "boolean",
            description: "当用户说刚刚生成的、最近的、最新的报告/文件时设为 true，只返回最近一个匹配结果。"
          }
        },
        required: ["query"],
        additionalProperties: false
      }
    }
  }
];

export async function execute(toolName: string, args: Record<string, unknown>, context: SkillContext) {
  if (toolName !== "search_media") {
    return { content: `未知工具：${toolName}` };
  }

  const payload = z
    .object({
      query: z.string().min(1),
      mediaType: z.enum(["image", "voice", "file", "video", "report", "any"]).optional(),
      limit: z.coerce.number().int().positive().max(20).optional(),
      recentOnly: z.boolean().optional()
    })
    .parse(args);
  const limit = payload.recentOnly ? 1 : (payload.limit ?? 5);
  const requestedMediaType = payload.mediaType || "any";
  const wantsReports = requestedMediaType === "report" || requestedMediaType === "file" || requestedMediaType === "any";
  const wantsMedia = requestedMediaType !== "report";
  const mediaType =
    requestedMediaType === "report"
      ? "file"
      : requestedMediaType !== "any"
        ? requestedMediaType
        : undefined;

  if (payload.recentOnly && wantsMedia && context.recentFile) {
    const outgoingMedia: OutgoingMedia[] = [
      {
        mediaType: context.recentFile.mediaType,
        fileName: context.recentFile.fileName,
        filePath: context.recentFile.filePath,
        publicUrl: context.recentFile.publicUrl,
        delivery: "direct",
        source: context.recentFile.source || "media"
      }
    ];
    return {
      content: "已找到最近生成或归档的文件，已加入微信直接发送队列。",
      sideEffects: {
        outgoingMedia
      }
    };
  }

  if (payload.recentOnly && wantsReports && context.recentReport) {
    const outgoingMedia: OutgoingMedia[] = [
      {
        mediaType: "file",
        fileName: `${context.recentReport.title}.docx`,
        filePath: context.recentReport.filePath,
        publicUrl: context.recentReport.publicUrl,
        delivery: "direct",
        source: "report"
      }
    ];
    return {
      content: "已找到最近生成的报告，已加入微信直接发送队列。",
      sideEffects: {
        outgoingMedia
      }
    };
  }

  const [mediaItems, reports] = await Promise.all([
    wantsMedia
      ? payload.recentOnly
        ? listRecentMedia({
            wechatUserId: context.wechatUserId,
            mediaType,
            limit
          })
        : searchMediaByText({
            wechatUserId: context.wechatUserId,
            query: payload.query,
            mediaType,
            limit
          })
      : Promise.resolve([]),
    wantsReports
      ? searchReports({
          keyword: payload.recentOnly ? undefined : payload.query,
          requesterWechatUserId: context.wechatUserId,
          limit
        })
      : Promise.resolve([])
  ]);

  const filteredMediaItems = payload.recentOnly
    ? mediaItems
    : mediaItems.filter((item) =>
        isStrongTextMatch(payload.query, [item.fileName, item.caption || "", item.metadataJson || "", item.publicUrl].join("\n"))
      );
  const filteredReports = payload.recentOnly
    ? reports
    : reports.filter((report) =>
        isStrongTextMatch(
          payload.query,
          [report.title, report.rawText, report.summary, report.keywords, report.user?.name || "", report.project?.name || ""].join("\n")
        )
      );

  if (!filteredMediaItems.length && !filteredReports.length) {
    return { content: `没有找到相关${describeMediaScope(requestedMediaType)}。` };
  }

  const outgoingMedia: OutgoingMedia[] = [
    ...filteredReports.map((report) => ({
      mediaType: "file" as const,
      fileName: `${report.title}.docx`,
      filePath: report.wordFilePath,
      publicUrl: toSignedStorageUrl(report.wordFilePath, config.publicBaseUrl),
      delivery: "direct" as const,
      source: "report" as const
    })),
    ...filteredMediaItems.map((item) => ({
      mediaType: item.mediaType as OutgoingMedia["mediaType"],
      fileName: item.fileName,
      filePath: item.filePath,
      publicUrl: item.publicUrl,
      caption: item.caption,
      delivery: "direct" as const,
      source: parseGeneratedMediaSource(item.metadataJson)
    }))
  ];

  return {
    content: [
      `已找到 ${outgoingMedia.length} 个相关${describeMediaScope(requestedMediaType)}。`,
      "所有命中媒体已加入微信直接发送队列。",
      "最终回复用户时只做简短成功提示，不要输出文件名、描述、下载链接或 URL。"
    ]
      .filter(Boolean)
      .join("\n"),
    sideEffects: {
      outgoingMedia
    }
  };
}

function describeMediaScope(mediaType?: "image" | "voice" | "file" | "video" | "report" | "any") {
  switch (mediaType) {
    case "image":
      return "图片";
    case "voice":
      return "语音";
    case "video":
      return "视频";
    case "report":
      return "报告";
    case "file":
      return "文件或报告";
    default:
      return "媒体";
  }
}

