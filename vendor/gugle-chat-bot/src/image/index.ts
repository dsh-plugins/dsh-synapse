import fs from 'node:fs';
import path from 'node:path';
import puppeteer, { Browser, Page } from 'puppeteer';
import { botConfig } from '@/config';

export class Template {
  private readonly templatePath: string;
  private readonly templateName: string;
  private processor: ((template: string) => string)[] = [];

  public constructor(templateName: string, templatePath: string) {
    this.templateName = templateName;
    this.templatePath = templatePath;
  }

  public static load(templateName: string, templatePath: string = 'src/template'): Template {
    return new Template(templateName, templatePath);
  }

  private async loadTemplate(templateName: string, templatePath: string): Promise<string> {
    return fs.readFileSync(`${templatePath}/${templateName}.html`, 'utf8');
  }

  public arg(param: string, object: any): Template {
    this.processor.push(template => {
      while (template.includes(`{{${param}}}`)) {
        template = template.replace(`{{${param}}}`, object.toString());
      }
      return template;
    });
    return this;
  }

  /**
   * 返回模板文件的绝对路径（用于以模板所在目录为相对路径根加载 CSS 等资源）。
   */
  public file(): string {
    return path.resolve(this.templatePath, `${this.templateName}.html`);
  }

  /**
   * 渲染模板：填充所有参数，返回处理后的 HTML 字符串。
   * 注意：CSS 不再内联进 HTML（改由 file:// 相对路径加载），
   * 但保留 {{style sheet}} 占位符兼容旧模板。
   */
  public handler(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.loadTemplate(this.templateName, this.templatePath)
        .then(template => {
          try {
            this.processor.forEach(processor => {
              template = processor(template);
            });
            resolve(template);
          } catch (e) {
            reject(e);
          }
        })
        .catch(reject);
    });
  }
}

function imageToBase64(image: Buffer<ArrayBufferLike>) {
  return image.toString('base64');
}

/**
 * 串行图片生成队列：同一时刻只允许一张图片生成任务执行，
 * 上一张生成完毕（成功或失败）后再开始下一张。
 */
let imageQueueTail: Promise<void> = Promise.resolve();
let imageQueueSize = 0;

function enqueueImageTask<T>(task: () => Promise<T>): Promise<T> {
  const result = imageQueueTail.then(task);
  // 无论任务成功还是失败，队列都必须继续流转
  imageQueueTail = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

// ---------------------------------------------------------------------------
// 可复用 Chrome 实例管理
// ---------------------------------------------------------------------------

/** 空闲多少毫秒后关闭 Chrome 实例（默认 5 分钟，可用环境变量覆盖以便测试） */
const BROWSER_IDLE_TIMEOUT_MS = Number(process.env.GUGLE_IMAGE_IDLE_TIMEOUT_MS) || 5 * 60 * 1000;

let sharedBrowser: Browser | undefined = undefined;
let browserIdleTimer: NodeJS.Timeout | undefined = undefined;
/** 记录上一次完成生成的时间，用于空闲判定 */
let lastBrowserUseTime = 0;

function browserLaunchArgs(): string[] {
  return [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-extensions'
  ];
}

/**
 * 惰性启动（或复用）共享的 Chrome 实例。
 * 若实例已存在则直接复用，并重置空闲计时器。
 */
async function getSharedBrowser(): Promise<Browser> {
  if (sharedBrowser && sharedBrowser.isConnected()) {
    clearTimeout(browserIdleTimer);
    return sharedBrowser;
  }
  sharedBrowser = await puppeteer.launch({
    executablePath: botConfig.chromePath,
    headless: true,
    defaultViewport: { width: 820, height: 1 },
    args: browserLaunchArgs()
  });
  clearTimeout(browserIdleTimer);
  lastBrowserUseTime = Date.now();
  return sharedBrowser;
}

/** 关闭共享的 Chrome 实例（幂等） */
function closeSharedBrowser(): void {
  clearTimeout(browserIdleTimer);
  browserIdleTimer = undefined;
  const browser = sharedBrowser;
  sharedBrowser = undefined;
  if (browser && browser.isConnected()) {
    browser.close().catch(() => undefined);
  }
}

/**
 * 空闲回收调度：当没有新的生成任务时，等待 BROWSER_IDLE_TIMEOUT_MS
 * 后自动关闭 Chrome 实例，避免长期占用内存。
 */
function scheduleBrowserIdleClose(): void {
  clearTimeout(browserIdleTimer);
  lastBrowserUseTime = Date.now();
  browserIdleTimer = setTimeout(() => {
    // 若这段时间内又有新的任务在跑，就不关闭（任务结束后会重新调度）
    if (imageQueueSize > 0 || Date.now() - lastBrowserUseTime < BROWSER_IDLE_TIMEOUT_MS) {
      scheduleBrowserIdleClose();
      return;
    }
    closeSharedBrowser();
  }, BROWSER_IDLE_TIMEOUT_MS);
  // 空闲定时器不应阻止进程退出（如测试/无任务时）
  browserIdleTimer.unref?.();
}

// 进程退出时优雅关闭共享 Chrome 实例，避免残留子进程。
// SIGINT/SIGTERM 下等待关闭完成后再退出；exit 事件里做同步兜底。
process.once('SIGINT', () => {
  closeSharedBrowser();
  process.exit(0);
});
process.once('SIGTERM', () => {
  closeSharedBrowser();
  process.exit(0);
});
process.once('exit', () => {
  // exit 事件中无法 await，仅兜底（close 的 promise 由事件循环继续完成）
  const browser = sharedBrowser;
  sharedBrowser = undefined;
  if (browser && browser.isConnected()) {
    browser.close().catch(() => undefined);
  }
});

/**
 * 等待页面中所有 <img> 元素加载完成。
 * 轮询检查：所有图片 complete 且 naturalWidth > 0（加载成功）；
 * 没有图片时立即返回。最多等待 timeoutMs，超时仍继续（不阻塞截图）。
 */
async function waitForImagesLoaded(page: Page, timeoutMs: number = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const pending = await page.evaluate(() => {
      const images = Array.from(document.querySelectorAll('img'));
      if (images.length === 0) return 0;
      return images.filter(img => !img.complete || img.naturalWidth === 0).length;
    });
    if (pending === 0) return;
    await new Promise(r => setTimeout(r, 200));
  }
}

/**
 * 用共享 Chrome 实例渲染 HTML 并截图。
 * 若提供 templateFile，则用 file:// 加载该文件（以模板所在目录为相对路径根，
 * 相对路径的 CSS/资源会按此解析），并在页面内替换 {{xxx}} 占位符；
 * 否则退回 setContent（相对路径无法解析，需内联样式）。
 */
async function renderWithSharedBrowser(
  html: string,
  width: number,
  templateFile?: string
): Promise<Buffer> {
  const browser = await getSharedBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width, height: 1 });
    if (templateFile) {
      const fileUrl = 'file:///' + path.resolve(templateFile).replace(/\\/g, '/');
      await page.goto(fileUrl, { waitUntil: 'networkidle0', timeout: 60000 });
      // 在页面内替换所有 {{xxx}} 占位符（与 Template.arg 的替换逻辑一致）
      await page.evaluate(processedHtml => {
        document.documentElement.innerHTML = processedHtml;
        // 移除遗留的 {{style sheet}} 占位符
        document.querySelectorAll('*').forEach(el => {
          if (el.children.length === 0) {
            el.textContent = el.textContent.replace(/\{\{style sheet\}\}/g, '');
          }
        });
      }, html);
      // 等待替换后插入的图片加载完成（data URL / 相对路径），避免截图时图片缺失
      await waitForImagesLoaded(page);
    } else {
      await page.setContent(html, { waitUntil: 'networkidle0', timeout: 60000 });
      // setContent 路径同样等待图片加载完成
      await waitForImagesLoaded(page);
    }
    const element = await page.$('body');
    if (!element) {
      throw new Error('No element matches selector: body');
    }
    // 默认 encoding 为 binary，返回 Uint8Array；转成 Buffer 后再 base64
    const image = (await element.screenshot({ type: 'png' })) as Uint8Array;
    return Buffer.from(image);
  } finally {
    await page.close().catch(() => undefined);
  }
}

function generateImage(
  resolve: (value: string | PromiseLike<string>) => void,
  reject: (reason?: any) => void,
  html: string,
  width: number,
  templateFile?: string
): Promise<void> {
  return new Promise<void>((taskResolve, taskReject) => {
    renderWithSharedBrowser(html, width, templateFile)
      .then(image => {
        resolve(imageToBase64(image));
        taskResolve();
      })
      .catch(e => {
        reject(e);
        taskReject(e);
      })
      .finally(() => {
        scheduleBrowserIdleClose();
      });
  });
}

export function tryGenerateImage(
  resolve: (value: string | PromiseLike<string>) => void,
  reject: (reason?: any) => void,
  html: string,
  width: number = 820,
  templateFile?: string
) {
  imageQueueSize++;
  enqueueImageTask(() => generateImage(resolve, reject, html, width, templateFile))
    .catch(() => undefined)
    .finally(() => {
      imageQueueSize--;
    });
}
