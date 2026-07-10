import { PrismaClient } from "@prisma/client";
import { DEFAULT_TEMPLATE_FIELDS } from "../src/services/templateService.js";

const prisma = new PrismaClient();

async function main() {
  const project = await prisma.project.upsert({
    where: { name: "默认项目" },
    create: { name: "默认项目", description: "MVP 默认项目" },
    update: {}
  });

  await prisma.user.upsert({
    where: { wechatUserId: "admin" },
    create: {
      wechatUserId: "admin",
      name: "管理员",
      role: "admin",
      projectId: project.id
    },
    update: { role: "admin", projectId: project.id }
  });

  const existingTemplate = await prisma.template.findFirst({
    where: { name: "默认工作报告模板" }
  });

  if (!existingTemplate) {
    await prisma.template.create({
      data: {
        name: "默认工作报告模板",
        description: "使用标准字段生成 Word 工作报告",
        fieldsJson: JSON.stringify(DEFAULT_TEMPLATE_FIELDS),
        isActive: true
      }
    });
  }
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
