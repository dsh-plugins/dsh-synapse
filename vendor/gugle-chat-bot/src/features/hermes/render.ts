import { Template, tryGenerateImage } from '@/image';
import { getHermesConfig } from '@/features/hermes/config';
import { RunCurrentTool, RunToolRecord } from '@/features/hermes/types';

/**
 * Hermes 进度/审批卡片渲染（移植自 qq-hermes-bridge src/renderer.ts，MIT 协议，原作者 Amorter）。
 * HTML/CSS 拆为模板文件，渲染改用 src/image 的共享 Chrome + 串行截图队列。
 * 渲染失败返回 null，调用方降级为纯文本。
 */

/** 进度卡片渲染数据 */
export interface ProgressCardData {
  tools: RunToolRecord[];
  currentTool: RunCurrentTool | null;
  messageDelta?: string;
  elapsed: string;
}

/** 审批卡片渲染数据 */
export interface ApprovalCardData {
  command: string;
  riskLevel: string;
  toolName?: string;
  runId?: string;
  preview?: string;
}

function escapeHtml(text: unknown): string {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

function render(templateName: string, template: Template): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const templateFile = template.file();
    template
      .handler()
      .then(html => tryGenerateImage(resolve, reject, html, 500, templateFile))
      .catch(reject);
  });
}

/** 渲染进度卡片为 base64 图片；progressAsImage=false 或渲染失败时返回 null */
export async function renderProgressImage(data: ProgressCardData): Promise<string | null> {
  const config = getHermesConfig();
  if (!config.progressAsImage) return null;
  try {
    const toolRows = data.tools
      .slice(-config.progressMaxTools)
      .map(tool => {
        const icon = tool.error ? '❌' : '✅';
        const duration = tool.duration ? ` (${formatDuration(tool.duration)})` : '';
        return `<div class="tool-row">
      <span class="icon">${icon}</span>
      <span class="name">${escapeHtml(tool.name)}</span>
      <span class="dur">${duration}</span>
    </div>
    ${tool.preview ? `<div class="preview">${escapeHtml(tool.preview).slice(0, 120)}</div>` : ''}`;
      })
      .join('\n');

    const currentHtml = data.currentTool
      ? `<div class="current-tool">
        <span class="spinner">⏳</span>
        <span class="name">${escapeHtml(data.currentTool.name)}</span>
        ${data.currentTool.preview ? `<div class="preview">${escapeHtml(data.currentTool.preview).slice(0, 120)}</div>` : ''}
      </div>`
      : '';

    const previewHtml = data.messageDelta
      ? `<div class="response-preview">${escapeHtml(data.messageDelta.slice(-300))}</div>`
      : '';

    const template = Template.load('progress', 'src/features/hermes/template')
      .arg('elapsed', escapeHtml(data.elapsed))
      .arg('tools', toolRows)
      .arg('current', currentHtml)
      .arg('preview', previewHtml)
      .arg('botName', escapeHtml(config.botName));
    return await render('progress', template);
  } catch {
    return null;
  }
}

/** 渲染审批卡片为 base64 图片；渲染失败时返回 null */
export async function renderApprovalImage(data: ApprovalCardData): Promise<string | null> {
  try {
    const riskColors: Record<string, string> = { high: '#E94560', medium: '#F5C842', low: '#53D8FB' };
    const riskColor = riskColors[data.riskLevel] || riskColors.high!;

    const toolSection = data.toolName
      ? `<div class="section"><div class="label">工具</div><div class="value">${escapeHtml(data.toolName)}</div></div>`
      : '';
    const previewSection = data.preview
      ? `<div class="section"><div class="label">说明</div><div class="value">${escapeHtml(data.preview).slice(0, 200)}</div></div>`
      : '';

    const template = Template.load('approval', 'src/features/hermes/template')
      .arg('riskColor', riskColor)
      .arg('toolSection', toolSection)
      .arg('command', escapeHtml(data.command))
      .arg('previewSection', previewSection)
      .arg('runId', escapeHtml(data.runId?.slice(-8) ?? ''));
    return await render('approval', template);
  } catch {
    return null;
  }
}
