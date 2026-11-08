/**
 * dsh-think-summary · Host 半部
 *
 * 职责：把「一步的思考原文」压成 1-3 条中文要点，供客户端折叠态展示。
 *
 * 为什么放在 Host：浏览器侧拿不到 `ctx.llm`，模型调用必须走宿主。
 * 这里只做三件事：
 *   1. 一个 HTTP 端点（客户端 fetch 它）；
 *   2. 调 `ctx.llm.stream` 用廉价模型做摘要；
 *   3. 缓存 + 预算，避免重复计费。
 *
 * 设计取舍：
 *   - 只在「一步结束」时触发；流式中不调，省钱也不打断。
 *   - 同样的原文只算一次（sha1 键 + 进程内缓存）。
 *   - 失败一律降级：客户端拿不到摘要就显示原文首行，不比装插件前差。
 *   - 服务用**运行时 inject** 获取，不写静态 `inject`：cordis 的静态 inject 是硬门禁，
 *     任一服务缺失会让整个插件静默不激活，排查成本极高。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const name = 'dsh-think-summary';

const ROUTE = '/dsh-think-summary';

/** 只接受回环地址来的请求：这个端点的用途是给本机浏览器调用。 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
/** 请求体上限，防止本地进程塞一个超大 JSON 撑爆内存。 */
const MAX_BODY_BYTES = 512 * 1024;
/** 同时在飞的模型调用上限，防止并发刷爆额度。 */
const MAX_CONCURRENT_CALLS = 2;

const DEFAULTS = {
  // 总开关：关掉后端点仍存在，但不再调用模型（客户端自动退回原文预览）。
  enabled: true,
  provider: 'opencode-go',
  model: 'deepseek-v4.1-flash',
  // 单次摘要允许的最大输入字符数（超出留头留尾）
  maxInputChars: 14000,
  maxOutputTokens: 1200,
  timeoutMs: 25000,
  // 每个会话最多触发多少次摘要调用（防止失控计费）
  maxCallsPerSession: 300,
  // 进程级总上限（防止打开历史会话时一次性回填太多）
  maxCallsTotal: 600,
  // 原文短于这个长度就不值得摘要
  minChars: 160,
  // 摘要缓存的落盘位置（空字符串表示只放内存）
  cacheFile: '',
};

const SYSTEM_PROMPT = [
  '你是一个编程助手对话的「进度播报员」。',
  '输入是 AI 助手在一步之内写下的内部思考记录（可能是英文，可能有代码片段）。',
  '任务：用中文写 1–2 句自然的进度播报，像同事在旁边说话：先说你完成了什么/看到了什么，再说发现了什么、接下来准备做什么。',
  '要求：',
  '- 不超过 80 个汉字，最多两句。',
  '- 说是「进展」，不是「结论清单」：像「我查了事件顺序，卡在记忆抽取，接下来给它加超时」这样连起来说。',
  '- 不要复述工具名、不要贴代码、不要分点、不要 Markdown、不要标题。',
  '- 只输出这段播报，不要解释。',
  '- 示例：我读完了插件的两半代码，确认摘要走的是本地端点，接下来改客户端的额度逻辑。',
  '- 示例：测试跑通了，但失败回退没覆盖到，我打算补一个跳过预算的场景。',
].join('\n');

/** 摘要语义版本：改了提示词/输出格式就加一，避免命中旧格式的缓存。 */
const PROMPT_VERSION = 'progress-v2';

/** 把一段文本压到上限以内：留头留尾，中间省略。 */
function clampText(text, max) {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${text.slice(0, head)}\n…（中间省略 ${text.length - max} 字）…\n${text.slice(-tail)}`;
}

/** 缓存键：把提示词版本混进去，改输出格式后旧缓存自动失效，不会新旧混杂。 */
function cacheKey(text) {
  return createHash('sha1').update(PROMPT_VERSION).update('\n').update(text).digest('hex');
}

/**
 * 把模型输出整理成「进度句子」：容忍它加了列表符号/标题/代码块。
 * 返回数组是为了兼容老缓存的要点格式；新输出通常只有一条。
 */
function parseProgress(output) {
  const cleaned = String(output)
    .replace(/```[a-z]*\n?/giu, '')
    .replace(/```/gu, '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => line.replace(/^(?:[-*•]|\d+[.、)])\s*/u, ''))
    .filter((line) => !/^(要点|摘要|总结|进度|thinking|summary)[:：]?$/iu.test(line));
  const joined = cleaned.join(' ').replace(/\*\*/gu, '').replace(/\s+/gu, ' ').trim();
  if (joined === '') return [];
  // 最多留两句，避免模型写成小作文。
  const sentences = joined.split(/(?<=[。！？!?])\s*/u).filter((item) => item !== '');
  const picked = sentences.slice(0, 2).join('').trim();
  return picked === '' ? [] : [picked.slice(0, 120)];
}

/**
 * 终端 finish 分片 → 人类可读错误；正常结束返回 undefined。
 * ⚠️ 分片形状是 `{ type: 'finish', reason: { kind, failure } }`，不是 `finish` 字段。
 */
function finishError(finish) {
  if (finish === undefined || finish === null) return '模型没有返回终止分片';
  if (finish.kind === 'stop') return undefined;
  if (finish.kind === 'max-tokens') return '摘要输出超长';
  if (finish.kind === 'aborted') return '摘要请求被取消或超时';
  const failure = finish.failure;
  const code = failure && typeof failure.code === 'string' ? failure.code : finish.kind;
  const message = failure && typeof failure.message === 'string' ? failure.message : '';
  return message === '' ? String(code) : `${code}: ${message}`;
}

/**
 * 注册摘要端点。
 * @param ctx - 宿主上下文；`llm` 与 `webServer` 都通过运行时 inject 获取。
 * @param config - 插件配置。
 */
/** 该请求是否来自本机回环（没有 socket 的单元测试环境放行）。 */
function isLoopbackRequest(req) {
  const address = req !== null && req !== undefined && req.socket ? req.socket.remoteAddress : undefined;
  if (address === undefined || address === null) return true;
  return LOOPBACK.has(address);
}

/** 默认缓存文件：~\.dsh/storages/think-summary/cache.json */
function defaultCacheFile() {
  const home = typeof process !== 'undefined' && process.env && process.env.DSH_HOME
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
  return join(home, 'storages', 'think-summary', 'cache.json');
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config === null || typeof config !== 'object' ? {} : config) };
  /** @type {Map<string, string[]>} 原文指纹 → 要点 */
  const cache = new Map();

  // 落盘缓存：重启后不必重新计费。读写失败一律忽略，功能不依赖它。
  const cacheFile = cfg.cacheFile === '' ? defaultCacheFile() : cfg.cacheFile;
  if (typeof cacheFile === 'string' && cacheFile !== '') {
    try {
      const parsed = JSON.parse(readFileSync(cacheFile, 'utf8'));
      if (parsed !== null && typeof parsed === 'object') {
        for (const [key, value] of Object.entries(parsed)) {
          if (Array.isArray(value) && value.length > 0) cache.set(key, value.slice(0, 3));
        }
      }
    } catch { /* 没有缓存文件或损坏：当作空缓存 */ }
  }

  let saveTimer = null;
  function persist() {
    if (typeof cacheFile !== 'string' || cacheFile === '') return undefined;
    if (saveTimer !== null) return undefined;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        // 只保留最近的 2000 条，避免文件无限增长
        const entries = [...cache.entries()].slice(-2000);
        mkdirSync(dirname(cacheFile), { recursive: true });
        const temp = `${cacheFile}.tmp`;
        writeFileSync(temp, JSON.stringify(Object.fromEntries(entries)), 'utf8');
        renameSync(temp, cacheFile);
      } catch { /* 落盘失败不影响本次摘要 */ }
    }, 2000);
    if (typeof saveTimer.unref === 'function') saveTimer.unref();
    return undefined;
  }
  /** @type {Map<string, Promise<string[]>>} 同一个指纹的并发去重 */
  const inflight = new Map();
  /** @type {Map<string, number>} 会话 → 已调用次数 */
  const calls = new Map();
  let totalCalls = 0;

  const log = (message) => {
    try { console.log(`[@drifter-yh/dsh-think-summary] ${message}`); } catch { /* ignore */ }
  };

  /** 用给定 llm 服务把一个指纹对应的原文摘要出来（带并发去重）。 */
  function makeSummarizer(llm) {
    let running = 0;
    const waiting = [];
    /** 并发闸门：超出的请求排队，不并发打满额度。 */
    function withSlot(task) {
      return new Promise((resolve, reject) => {
        const run = () => {
          running += 1;
          task().then(resolve, reject).finally(() => {
            running -= 1;
            const next = waiting.shift();
            if (next !== undefined) next();
          });
        };
        if (running < MAX_CONCURRENT_CALLS) run();
        else waiting.push(run);
      });
    }

    return async function summarize(text, sessionId) {
      const fingerprint = cacheKey(text);
      const cached = cache.get(fingerprint);
      if (cached !== undefined) return { bullets: cached, cached: true };

      const pending = inflight.get(fingerprint);
      if (pending !== undefined) return { bullets: await pending, cached: true };

      const task = withSlot(async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
        try {
          let output = '';
          let finish;
          const base = {
            provider: cfg.provider,
            model: cfg.model,
            maxTokens: cfg.maxOutputTokens,
          };
          // 摘要不需要思考：优先选该模型最低的推理档（很多路由的默认档会把
          // maxTokens 全烧在 reasoning 上，最后以 max-tokens 结束、正文为空）。
          const call = typeof llm.prepareCall === 'function'
            ? await llm.prepareCall(base, controller.signal, (controls, model) => {
              const effort = model?.reasoning?.efforts?.[0]?.id;
              return effort === undefined ? controls : { ...controls, reasoningEffort: effort };
            })
            : { config: base, stream: llm.stream.bind(llm) };

          const stream = call.stream({
            ...call.config,
            // opencode-go 之类的网关要求带上会话标识（映射为 x-opencode-session 头），
            // 否则直接 400 MissingSessionID。
            ...(typeof sessionId === 'string' && sessionId !== '' ? { sessionId } : {}),
            system: SYSTEM_PROMPT,
            messages: [{
              role: 'user',
              content: [{ type: 'text', text: `思考记录如下：\n\n${text}` }],
            }],
            signal: controller.signal,
          });
          for await (const chunk of stream) {
            if (chunk === null || chunk === undefined) continue;
            if (chunk.type === 'text-delta' && typeof chunk.text === 'string') output += chunk.text;
            else if (chunk.type === 'finish') finish = chunk.reason;
          }
          const failure = finishError(finish);
          if (failure !== undefined) throw new Error(failure);
          const bullets = parseProgress(output);
          if (bullets.length === 0) throw new Error('模型没有产出可用的进度句子');
          cache.set(fingerprint, bullets);
          persist();
          return bullets;
        } finally {
          clearTimeout(timer);
          inflight.delete(fingerprint);
        }
      });

      inflight.set(fingerprint, task);
      return { bullets: await task, cached: false };
    };
  }

  ctx.inject(['llm', 'webServer'], (scoped) => {
    /**
     * ⚠️ 关键：cordis 的服务代理会在**每次属性访问**时检查当前 fiber 是否 inject 了该服务。
     * HTTP 回调是异步的，执行时早已离开注册时的 fiber，直接写 `scoped.llm.stream(...)`
     * 会抛 "cannot get property llm without inject"（实测）。
     * 所以在注册时（fiber 还活着）就把方法取出来并 bind 住，之后只调用这个函数引用。
     */
    const llmService = (() => {
      try {
        if (typeof scoped.get === 'function') {
          const direct = scoped.get('llm');
          if (direct !== undefined) return direct;
        }
      } catch { /* 退回代理 */ }
      return scoped.llm;
    })();
    const streamLlm = llmService.stream.bind(llmService);
    const prepareCall = typeof llmService.prepareCall === 'function'
      ? llmService.prepareCall.bind(llmService)
      : undefined;
    const summarize = makeSummarizer({ stream: streamLlm, prepareCall });

    const routes = {
      /** 诊断用：报告该模型暴露的推理档位与本插件实际会用的档位。 */
      async debug() {
        if (typeof llmService.prepareCall !== 'function') return { prepareCall: false };
        let seen = null;
        const call = await llmService.prepareCall({ provider: cfg.provider, model: cfg.model, maxTokens: cfg.maxOutputTokens },
          new AbortController().signal,
          (controls, model) => {
            seen = model;
            const effort = model?.reasoning?.efforts?.[0]?.id;
            return effort === undefined ? controls : { ...controls, reasoningEffort: effort };
          });
        return {
          reasoning: seen && seen.reasoning ? seen.reasoning : null,
          contextWindow: seen ? seen.contextWindow : null,
          output: seen ? seen.maxOutputTokens ?? null : null,
          chosen: call.config.reasoningEffort ?? null,
        };
      },
      async status() {
        return {
          ok: true,
          enabled: cfg.enabled,
          provider: cfg.provider,
          model: cfg.model,
          cached: cache.size,
          calls: [...calls.values()].reduce((a, b) => a + b, 0),
        };
      },
      async summarize(args) {
        if (cfg.enabled === false) return { skipped: 'disabled' };
        const text = typeof args.text === 'string' ? args.text : '';
        const sessionId = typeof args.sessionId === 'string' ? args.sessionId : 'unknown';
        if (text.trim().length < cfg.minChars) return { skipped: 'too-short' };

        const used = calls.get(sessionId) ?? 0;
        if (used >= cfg.maxCallsPerSession) return { skipped: 'budget' };
        if (totalCalls >= cfg.maxCallsTotal) return { skipped: 'budget-total' };

        const fingerprint = cacheKey(clampText(text, cfg.maxInputChars));
        if (!cache.has(fingerprint)) {
          calls.set(sessionId, used + 1);
          totalCalls += 1;
        }

        const result = await summarize(clampText(text, cfg.maxInputChars), sessionId);
        return { bullets: result.bullets, cached: result.cached, model: cfg.model };
      },
    };

    const handler = async (req, res) => {
      const send = (status, payload) => {
        let body = '';
        try { body = JSON.stringify(payload); } catch { body = '{"error":"serialize failed"}'; }
        res.writeHead(status, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(body);
      };
      try {
        if (!isLoopbackRequest(req)) { send(403, { error: 'loopback only' }); return; }

        // 复用 DSH 的鉴权边界；拿不到就跳过（webServer 只监听 loopback）。
        try {
          if (typeof scoped.connection?.requestRejection === 'function') {
            const rejection = scoped.connection.requestRejection(req);
            if (rejection !== undefined) { send(rejection, { error: 'request rejected' }); return; }
          }
        } catch { /* 拿不到鉴权边界就跳过 */ }

        const url = new URL(req.url || '/', 'http://localhost');
        if (!url.pathname.startsWith(`${ROUTE}/`)) { send(404, { error: 'not found' }); return; }
        const method = decodeURIComponent(url.pathname.slice(ROUTE.length + 1));
        const fn = Object.hasOwn(routes, method) ? routes[method] : null;
        if (fn === null) { send(404, { error: `unknown method: ${method}` }); return; }

        if (method === 'summarize' && req.method !== 'POST') { send(405, { error: 'summarize requires POST' }); return; }

        let args = {};
        if (req.method === 'POST') {
          const chunks = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) { send(413, { error: 'body too large' }); return; }
            chunks.push(chunk);
          }
          const raw = Buffer.concat(chunks).toString('utf8');
          if (raw.length > 0) {
            try { args = JSON.parse(raw); } catch { send(400, { error: 'invalid JSON body' }); return; }
          }
        }
        send(200, await fn(args));
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        log(`request failed: ${message}`);
        send(500, { error: message });
      }
    };

    try {
      scoped.webServer.register({ kind: 'prefix', path: ROUTE, handler });
      log(`route registered at ${ROUTE} (${cfg.provider}/${cfg.model})`);
    } catch (error) {
      log(`route registration failed: ${error && error.message ? error.message : String(error)}`);
    }
  });
}
