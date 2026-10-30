import {
  GroupAdminApi,
  ProcessedSkillOutput,
  RouteInfo,
  Skill,
  SkillExecuteContext,
  SkillFeedback,
  SkillResult
} from '@/features/hermes/types';
import type { QQBot } from '@/index';
import { Github } from '@/features/github';
import { Bili } from '@/features/bili';
import { MinecraftAPI } from '@/features/minecraft';
import { ModrinthAPI } from '@/features/modrinth';
import { isGithubEnabledGroup } from '@/config/features';

/**
 * 技能管理器（移植自 qq-hermes-bridge src/skills.ts，MIT 协议，原作者 Amorter）。
 * 定义 AI 可调用的技能，生成技能提示词，解析并执行 AI 输出中的技能标签。
 * 管理技能仅限有效管理员（hermes admins ∪ management operators）使用；
 * 卡片类公共技能（查Issue / B站视频）所有人可用，产出图片由调用方逐张发送。
 */
export class SkillManager {
  /** 技能标签匹配正则：[SKILL:名称 参数...] */
  private static readonly SKILL_TAG_RE = /\[SKILL:([^\]]+)\]/g;
  /** 已注册的技能列表 */
  private readonly skills: Skill[];
  /** 技能名 → 技能定义的快速索引 */
  private readonly skillIndex: Map<string, Skill>;

  public constructor() {
    this.skills = [
      {
        name: '禁言',
        usage: '禁言 <QQ号> <时长(分钟)>',
        description: '禁言指定群成员，最长 30 天（43200 分钟）',
        adminOnly: true,
        execute: this.executeMute.bind(this)
      },
      {
        name: '解除禁言',
        usage: '解除禁言 <QQ号>',
        description: '解除指定成员的禁言',
        adminOnly: true,
        execute: this.executeUnmute.bind(this)
      },
      {
        name: '踢出',
        usage: '踢出 <QQ号>',
        description: '将指定成员踢出群聊',
        adminOnly: true,
        execute: this.executeKick.bind(this)
      },
      {
        name: '全员禁言',
        usage: '全员禁言 <开/关>',
        description: '开启或关闭全员禁言',
        adminOnly: true,
        execute: this.executeWholeBan.bind(this)
      },
      {
        name: '查Issue',
        usage: '查Issue <owner/repo#编号 或 #编号>',
        description: '查询 GitHub Issue/PR 并生成信息卡片（PR 自动识别；省略仓库时默认 Anvil-Dev/AnvilCraft；一条最多 3 个编号）',
        adminOnly: false,
        execute: this.executeIssueCard.bind(this)
      },
      {
        name: 'B站视频',
        usage: 'B站视频 <BV号/av号/b23.tv短链>',
        description: '获取 B 站视频信息并生成卡片（标题/UP主/时长/播放点赞评论数）',
        adminOnly: false,
        execute: this.executeBiliCard.bind(this)
      },
      {
        name: 'MC版本',
        usage: 'MC版本',
        description: '查询 Minecraft 最新正式版与快照版',
        adminOnly: false,
        feedback: true,
        execute: this.executeMcVersion.bind(this)
      },
      {
        name: 'MC服务器',
        usage: 'MC服务器 <ip> [端口]',
        description: '查询 Minecraft Java 服务器状态（MOTD/版本/在线玩家）',
        adminOnly: false,
        feedback: true,
        execute: this.executeMcServer.bind(this)
      },
      {
        name: 'MC维基',
        usage: 'MC维基 <关键词>',
        description: '搜索中文 Minecraft 维基，返回条目摘要与链接',
        adminOnly: false,
        feedback: true,
        execute: this.executeMcWiki.bind(this)
      },
      {
        name: 'Modrinth版本',
        usage: 'Modrinth版本 <slug>',
        description: '查询 Modrinth 模组最新版本与下载直链（slug 如 create-aeronautics）',
        adminOnly: false,
        feedback: true,
        execute: this.executeModrinthVersion.bind(this)
      }
    ];

    this.skillIndex = new Map(this.skills.map(skill => [skill.name, skill]));
  }

  /**
   * 构建技能列表提示词，注入到系统提示词中。
   * 按「公共技能」和「管理技能（仅管理员）」分组展示。
   */
  public buildPrompt(): string {
    if (this.skills.length === 0) return '';

    const adminSkills = this.skills.filter(skill => skill.adminOnly);
    const publicSkills = this.skills.filter(skill => !skill.adminOnly && !skill.feedback);
    const querySkills = this.skills.filter(skill => !skill.adminOnly && skill.feedback);

    const lines: string[] = ['## 可用技能'];

    if (publicSkills.length > 0) {
      lines.push('');
      for (const skill of publicSkills) {
        lines.push(`- \`${skill.usage}\` — ${skill.description}`);
      }
    }

    if (querySkills.length > 0) {
      lines.push('');
      lines.push('### 查询技能（调用后结果会返回给你，请整理成口语化回答后再回复，不要复述原始数据）');
      for (const skill of querySkills) {
        lines.push(`- \`${skill.usage}\` — ${skill.description}`);
      }
    }

    if (adminSkills.length > 0) {
      lines.push('');
      lines.push('### 管理技能（仅管理员可用）');
      for (const skill of adminSkills) {
        lines.push(`- \`${skill.usage}\` — ${skill.description}`);
      }
    }

    lines.push('');
    lines.push('调用格式：在回复中插入 `[SKILL:技能名 参数...]`，标签会在发送前被处理并移除。');
    lines.push('注意：参数中的 QQ 号使用纯数字格式，多个技能可在一段话中同时调用。');
    lines.push('卡片类技能（查Issue / B站视频）会以图片形式随回复一起发出，无需在文本中复述卡片内容。');
    lines.push('查询类技能调用后请等待数据返回，不要假装已经知道结果。');

    return lines.join('\n');
  }

  /**
   * 解析并执行 AI 输出中的 [SKILL:...] 标签。
   * 全部标签执行完毕后从文本中移除，并在末尾附加执行摘要。
   *
   * @param output AI 生成的输出文本
   * @param route 消息来源路由
   * @param deps 依赖项（QQBot、群管理 API 门面和管理员检查函数）
   * @returns 清理后的文本（含执行摘要）与全部技能产出的图片（base64）
   */
  public async processTags(
    output: string,
    route: RouteInfo,
    deps: { bot: QQBot; api: GroupAdminApi; isAdmin: (userId: string) => boolean }
  ): Promise<ProcessedSkillOutput> {
    const { bot, api, isAdmin } = deps;

    // 收集所有技能标签
    const tags: Array<{ raw: string; content: string }> = [];
    let match: RegExpExecArray | null;
    SkillManager.SKILL_TAG_RE.lastIndex = 0;
    while ((match = SkillManager.SKILL_TAG_RE.exec(output)) !== null) {
      tags.push({ raw: match[0], content: match[1]! });
    }

    if (tags.length === 0) return { text: output, images: [], feedback: [] };

    // 逐个解析并执行
    const results: SkillResult[] = [];
    const feedback: SkillFeedback[] = [];
    for (const tag of tags) {
      const parts = tag.content.trim().split(/\s+/);
      const skillName = parts[0]!;
      const args = parts.slice(1);

      const skill = this.skillIndex.get(skillName);
      if (!skill) {
        results.push({ ok: false, skill: skillName, error: `未知技能: ${skillName}` });
        continue;
      }

      // 管理员权限检查
      if (skill.adminOnly && !isAdmin(route.userId)) {
        results.push({ ok: false, skill: skillName, error: '仅管理员可用' });
        continue;
      }

      try {
        const execution = await skill.execute({ bot, api, route, args });
        const data = typeof execution === 'string' ? execution : execution.message;
        if (skill.feedback) {
          // 查询类：数据回喂给 AI 整理回答，不附加摘要
          feedback.push({ skill: skillName, data });
          continue;
        }
        if (typeof execution === 'string') {
          results.push({ ok: true, skill: skillName, message: execution });
        } else {
          results.push({
            ok: true,
            skill: skillName,
            message: execution.message,
            ...(execution.images?.length ? { images: execution.images } : {})
          });
        }
      } catch (error) {
        // 查询类失败同样回喂（让 AI 告知用户没查到），动作类记入错误摘要
        if (skill.feedback) {
          feedback.push({ skill: skillName, data: `执行失败：${(error as Error).message}` });
        } else {
          results.push({ ok: false, skill: skillName, error: (error as Error).message });
        }
      }
    }

    // 从文本中移除所有技能标签
    let cleaned = output;
    for (const tag of tags) {
      cleaned = cleaned.replace(tag.raw, '');
    }
    cleaned = cleaned.replace(/ {2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

    // 附加执行摘要（整体 trim：整条消息只有技能标签时避免摘要前出现空行——对上游的微调）
    const summaryLines: string[] = [];
    const images: string[] = [];
    for (const result of results) {
      if (result.ok) {
        summaryLines.push(`✅ ${result.message}`);
        if (result.images) images.push(...result.images);
      } else {
        summaryLines.push(`❌ ${result.skill}: ${result.error}`);
      }
    }
    if (summaryLines.length > 0) {
      cleaned = cleaned + '\n\n' + summaryLines.join('\n');
    }

    return { text: cleaned.trim(), images, feedback };
  }

  /** 从参数中提取纯数字 QQ 号 */
  private extractQq(arg: string | undefined): string | null {
    if (!arg) return null;
    const match = String(arg).match(/\((\d+)\)$/);
    return match ? match[1]! : String(arg).replace(/\D/g, '') || null;
  }

  /** 解析正整数 */
  private parsePositiveInt(text: string | undefined, max = Infinity): number | null {
    const value = Number.parseInt(text ?? '', 10);
    if (!Number.isFinite(value) || value <= 0) return null;
    return Math.min(value, max);
  }

  /** 执行禁言技能 */
  private async executeMute({ api, route, args }: SkillExecuteContext): Promise<string> {
    const qq = this.extractQq(args[0]);
    if (!qq) throw new Error('缺少 QQ 号，格式: 禁言 <QQ号> <时长(分钟)>');
    const minutes = this.parsePositiveInt(args[1], 43200);
    if (!minutes) throw new Error('时长无效，格式: 禁言 <QQ号> <时长(分钟)>');
    await api.setGroupBan(route.groupId!, qq, minutes * 60);
    return `已禁言 ${qq} ${minutes} 分钟`;
  }

  /** 执行解除禁言技能 */
  private async executeUnmute({ api, route, args }: SkillExecuteContext): Promise<string> {
    const qq = this.extractQq(args[0]);
    if (!qq) throw new Error('缺少 QQ 号，格式: 解除禁言 <QQ号>');
    await api.setGroupBan(route.groupId!, qq, 0);
    return `已解除 ${qq} 的禁言`;
  }

  /** 执行踢出技能 */
  private async executeKick({ api, route, args }: SkillExecuteContext): Promise<string> {
    const qq = this.extractQq(args[0]);
    if (!qq) throw new Error('缺少 QQ 号，格式: 踢出 <QQ号>');
    await api.setGroupKick(route.groupId!, qq);
    return `已将 ${qq} 踢出群聊`;
  }

  /** 执行全员禁言技能 */
  private async executeWholeBan({ api, route, args }: SkillExecuteContext): Promise<string> {
    const arg = String(args[0] || '').trim();
    if (['开', '开启', '启用', 'on', 'true', '1'].includes(arg)) {
      await api.setGroupWholeBan(route.groupId!, true);
      return '已开启全员禁言';
    }
    if (['关', '关闭', '禁用', 'off', 'false', '0'].includes(arg)) {
      await api.setGroupWholeBan(route.groupId!, false);
      return '已关闭全员禁言';
    }
    throw new Error('参数无效，请使用 开 或 关');
  }

  // ── 卡片类公共技能（复用 github / bili 功能的渲染管线） ──

  /** 卡片技能一次最多生成的图片数（防刷屏） */
  private static readonly MAX_CARD_IMAGES = 3;

  /**
   * 查Issue：解析编号引用并复用 Github.renderReference 渲染卡片（PR 自动识别）。
   * 群/频道路由要求该群启用 github 功能；仓库允许列表判定在 renderReference 内完成。
   */
  private async executeIssueCard({ bot, route, args }: SkillExecuteContext): Promise<{ message: string; images?: string[] }> {
    const input = args.join(' ').trim();
    if (!input) throw new Error('缺少编号，格式: 查Issue <owner/repo#编号 或 #编号>');
    if (route.type !== 'user' && route.groupId && !isGithubEnabledGroup(Number(route.groupId))) {
      throw new Error('本群未启用 GitHub 功能');
    }
    const references = Github.parseReferences(input).slice(0, SkillManager.MAX_CARD_IMAGES);
    if (references.length === 0) {
      throw new Error('未识别到 Issue/PR 编号，格式: 查Issue <owner/repo#编号 或 #编号>');
    }
    const images: string[] = [];
    const notes: string[] = [];
    for (const reference of references) {
      const rendered = await Github.renderReference(bot, reference);
      // Message 联合类型中部分成员（如 DiceMessage）无 data 字段，整体断言后取值
      const data = (rendered as { data?: { file?: string; text?: string } }).data ?? {};
      if (rendered.type === 'image') {
        const file = data.file ?? '';
        const comma = file.indexOf(',');
        const base64 = (comma >= 0 ? file.slice(comma + 1) : file).trim();
        images.push(base64);
        notes.push(`${reference.repository}#${reference.number}`);
      } else {
        // 渲染失败/仓库不允许：尚无成功卡片时整体失败；已有成功卡片时并入摘要说明
        const reason = data.text ?? '渲染失败';
        if (images.length === 0) throw new Error(reason);
        notes.push(`${reference.repository}#${reference.number}（${reason}）`);
      }
    }
    return { message: `已生成卡片：${notes.join('、')}`, images };
  }

  /** B站视频：BV号/av号/b23.tv 短链 → Bili.renderVideoCard 渲染信息卡片 */
  private async executeBiliCard({ bot, args }: SkillExecuteContext): Promise<{ message: string; images: string[] }> {
    const input = args.join(' ').trim();
    if (!input) throw new Error('缺少视频号，格式: B站视频 <BV号/av号/b23.tv短链>');
    const base64 = await Bili.renderVideoCard(bot, input);
    return { message: '已生成 B 站视频卡片', images: [base64] };
  }

  // ── 查询类公共技能（feedback：结果回喂给 AI 整理回答，不直接发摘要） ──

  /** MC版本：Minecraft 最新正式版/快照版 */
  private async executeMcVersion(): Promise<string> {
    const version = await MinecraftAPI.getVersion();
    if (!version.success) throw new Error('获取 Minecraft 版本信息失败');
    return `最新正式版：${version.latest.release}\n最新快照版：${version.latest.snapshot}`;
  }

  /** MC服务器：Java 版服务器状态（地址可带端口，也可分开传） */
  private async executeMcServer({ args }: SkillExecuteContext): Promise<string> {
    const ip = args[0]?.trim();
    if (!ip) throw new Error('缺少服务器地址，格式: MC服务器 <ip> [端口]');
    const parsed = args[1] ? Number.parseInt(args[1], 10) : NaN;
    const status = await MinecraftAPI.getMinecraftServerStatus(ip, Number.isSafeInteger(parsed) ? parsed : undefined);
    if (!status.online) return `服务器 ${ip} 当前离线或无法连接`;
    return [
      `服务器 ${ip} 在线`,
      `MOTD：${status.motd}`,
      `游戏版本：${status.version}`,
      `在线玩家：${status.players.online}/${status.players.max}`,
      status.players.list.length > 0 ? `在线列表：${status.players.list.join('、')}` : ''
    ]
      .filter(Boolean)
      .join('\n');
  }

  /** MC维基：中文 Minecraft 维基搜索（关键词可含空格） */
  private async executeMcWiki({ args }: SkillExecuteContext): Promise<string> {
    const query = args.join(' ').trim();
    if (!query) throw new Error('缺少关键词，格式: MC维基 <关键词>');
    const wiki = await MinecraftAPI.getMinecraftWiki(query);
    if (!wiki.success) return `未找到「${query}」相关的维基条目`;
    return `条目：${wiki.title}\n摘要：${wiki.desc.trim()}\n链接：${wiki.url}`;
  }

  /** Modrinth版本：模组最新版本与下载直链 */
  private async executeModrinthVersion({ args }: SkillExecuteContext): Promise<string> {
    const slug = args[0]?.trim();
    if (!slug) throw new Error('缺少模组 slug，格式: Modrinth版本 <slug>');
    const version = await ModrinthAPI.getModVersion(slug);
    if (!version.success) throw new Error(`获取模组 ${slug} 的版本信息失败（slug 是否正确？）`);
    return (
      `模组 ${slug} 最新版本：${version.latest}\n` +
      `下载直链：https://api.modrinth.com/maven/maven/modrinth/${slug}/${version.latest}/${slug}-${version.latest}.jar`
    );
  }
}
