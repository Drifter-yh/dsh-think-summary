/**
 * dsh-think-summary · Client 半部
 *
 * 形态：官方 Client 模块（window.__ModuleLoader__.load + lazy factory）。
 *
 * 做两件事：
 *   1. 遮蔽 `conversation.chat.node` 的 `assistant-step` 渲染器（priority -1），
 *      只重写「思考」这一行：折叠态显示模型生成的要点，展开仍看原文。
 *   2. 每步结束时把该步思考文本 POST 给宿主端点做摘要，本地按内容指纹缓存。
 *
 * 渲染口径与出厂 AssistantMarkdown 对齐：
 *   - groupPart === 'reasoning' 只渲染 reasoning 块；
 *   - groupPart === 'response' 跳过 reasoning 块；
 *   - text → MarkdownText，image → renderMessageImages，tool-call 由独立节点渲染。
 *
 * 渲染器骨架参考了 MIT 许可的 dsh-thinking-panel（Fo-Rimuru）在 DSH 0.2.2-rc.1
 * 上的实测结论（owner props / hookContext / priority 竞争规则），已按本插件需要重写。
 */

window.__ModuleLoader__.load({
  id: '@drifter-yh/dsh-think-summary',

  factory(require) {
    const React = require('react');
    const h = React.createElement;

    let primitives = null;
    try { primitives = require('@deepseek-ai/dsh-client-ui-primitives'); } catch { /* 降级为纯文本 */ }
    const MarkdownText = primitives && primitives.MarkdownText ? primitives.MarkdownText : null;

    const ROUTE = 'dsh-think-summary';
    const MIN_CHARS = 160;
    /** 应急开关：localStorage 里设 'dsh-think-summary.enabled' = 'false' 即可让本页不再请求摘要。 */
    const LOCAL_DISABLED = (() => {
      try {
        return typeof window !== 'undefined' && window.localStorage
          ? window.localStorage.getItem('dsh-think-summary.enabled') === 'false'
          : false;
      } catch { return false; }
    })();
    /** 只给「最近」的步骤做摘要：打开历史会话时不做全量回填，免得白花钱。 */
    const RECENT_MS = 3 * 60 * 60 * 1000;
    /**
     * 滑动窗口限速：窗口内最多 RATE_LIMIT 次请求。
     * 不用「单页生命周期总数」是因为桌面窗口常开一整天，总数上限会用光且再也恢复不了；
     * 窗口滑过去就自动恢复，既不会饿死，也不会无限打。
     */
    const RATE_WINDOW_MS = 10 * 60 * 1000;
    const RATE_LIMIT = 60;
    /** 被限速挡下后，隔多久自动再试一次。 */
    const RATE_RETRY_MS = 60 * 1000;
    /** 宿主明确说「这段不做」（预算用尽/关闭）后，同样内容在这段时间内不再重试。 */
    const SUPPRESS_TTL = 10 * 60 * 1000;
    /** 同时在飞的请求上限。 */
    const MAX_PARALLEL = 3;
    /** 「摘要已暂停」的悬浮说明。 */
    const PAUSED_HINTS = {
      'rate-limited': '请求太频繁，等窗口滑过去会自动恢复',
      budget: '本会话的摘要次数已达上限',
      'budget-total': '进程级摘要次数已达上限',
      disabled: '摘要在宿主配置里已关闭',
    };

    /* ------------------------------------------------------------------ *
     * 文本工具（与出厂 reasoning-text.js 同构）
     * ------------------------------------------------------------------ */
    function asText(value) {
      return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
    }

    function reasoningText(text) {
      if (text[0] !== '<') return text;
      const opening = '<signature>';
      if (opening.startsWith(text)) return '';
      if (!text.startsWith(opening)) return text;
      const end = text.indexOf('</signature>', 11);
      if (end === -1) return '';
      let start = end + 12;
      while (start < text.length) {
        if (text[start] === '\n') start += 1;
        else if (text[start] === '\r' && text[start + 1] === '\n') start += 2;
        else break;
      }
      return text.slice(start);
    }

    function visibleReasoningText(value) {
      const raw = asText(value);
      const text = reasoningText(raw);
      return text !== raw && text.trim() === '' ? null : text;
    }

    function firstLine(text) {
      const newline = text.indexOf('\n');
      return newline === -1 ? text : text.slice(0, newline);
    }

    function latestCompletedParagraphFirstLine(text) {
      let summary = '';
      let paragraphStart = 0;
      const separator = /\r?\n(?:[\t ]*\r?\n)+/g;
      for (;;) {
        const nextParagraph = separator.exec(text);
        const paragraphEnd = nextParagraph === null
          ? text.length
          : nextParagraph.index + nextParagraph[0].indexOf('\n');
        const newline = text.indexOf('\n', paragraphStart);
        if (newline !== -1 && newline <= paragraphEnd) {
          const candidate = text.slice(paragraphStart, newline).trim();
          if (candidate !== '') summary = candidate;
        }
        if (nextParagraph === null) return summary;
        paragraphStart = nextParagraph.index + nextParagraph[0].length;
      }
    }

    /** 32 位 FNV-1a：够做缓存键，不追求密码学强度。 */
    function fingerprint(text) {
      let hash = 0x811c9dc5;
      for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      return `${text.length.toString(36)}-${hash.toString(36)}`;
    }

    function markdownLabels(t) {
      const tr = typeof t === 'function' ? t : (key) => key;
      return {
        code: {
          copyLabel: tr('copy'),
          copiedLabel: tr('copied'),
          toolbarLabels: {
            codeLabel: tr('codeBlock.title'),
            wrapLabel: tr('codeBlock.wrap'),
            unwrapLabel: tr('codeBlock.unwrap'),
          },
        },
        footnotes: tr('markdown.footnotes'),
      };
    }

    /* ------------------------------------------------------------------ *
     * 摘要获取（本地缓存 + 并发去重 + 滑动窗口限速）
     * ------------------------------------------------------------------ */
    const SUMMARY_CACHE = new Map();      // fingerprint -> bullets[]
    const SUMMARY_PENDING = new Map();    // fingerprint -> { refs, controller, promise }
    const SUMMARY_FAILED = new Map();     // fingerprint -> timestamp（真失败，短期内不重试）
    const SUMMARY_SUPPRESSED = new Map(); // fingerprint -> timestamp（宿主明确说「不做」）
    const requestTimes = [];              // 滑动窗口内的请求时间戳
    const FAILURE_TTL = 10 * 60 * 1000;
    let active = 0;
    const waiters = [];
    let consecutiveFailures = 0;
    let circuitOpenUntil = 0;

    /** 滑动窗口限速：窗口内到顶就本次不发起（不排队、不计失败，窗口滑过自动恢复）。 */
    function takeRateSlot() {
      const now = Date.now();
      while (requestTimes.length > 0 && now - requestTimes[0] >= RATE_WINDOW_MS) requestTimes.shift();
      if (requestTimes.length >= RATE_LIMIT) return false;
      requestTimes.push(now);
      return true;
    }

    /** 简单并发闸门：超出并发上限的请求排队，不并发打爆宿主。 */
    function schedule(task) {
      return new Promise((resolve, reject) => {
        const run = () => {
          active += 1;
          task().then(resolve, reject).finally(() => {
            active -= 1;
            const next = waiters.shift();
            if (next !== undefined) next();
          });
        };
        if (active < MAX_PARALLEL) run();
        else waiters.push(run);
      });
    }

    function abortError() {
      try { return new DOMException('aborted', 'AbortError'); } catch { /* 老环境没有 DOMException */ }
      const error = new Error('aborted');
      error.name = 'AbortError';
      return error;
    }

    /**
     * 关注者离开时递减引用；最后一个关注者离开才真正取消在途请求。
     * 同一个指纹可能被多行/多次挂载共享，单独一行卸载不该掐断别人的请求。
     */
    function watchAbort(entry, signal) {
      if (signal === undefined || signal === null || typeof signal.addEventListener !== 'function') return () => {};
      const onAbort = () => {
        entry.refs -= 1;
        if (entry.refs <= 0 && !entry.controller.signal.aborted) entry.controller.abort();
      };
      if (signal.aborted) { onAbort(); return () => {}; }
      signal.addEventListener('abort', onAbort, { once: true });
      return () => { signal.removeEventListener('abort', onAbort); };
    }

    /** 建一次在途请求；同一个指纹的所有调用方共享它。 */
    function createEntry(key, text, sessionId) {
      const controller = new AbortController();
      const entry = { refs: 0, controller, promise: null };
      const url = new URL(`${ROUTE}/summarize`, document.baseURI).href;
      entry.promise = schedule(() => {
        if (controller.signal.aborted) return Promise.reject(abortError());
        return fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, sessionId }),
          signal: controller.signal,
        })
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
          .then((payload) => {
            const bullets = Array.isArray(payload && payload.bullets) ? payload.bullets : null;
            if (bullets === null || bullets.length === 0) {
              const reason = payload && typeof payload.skipped === 'string' ? payload.skipped : 'empty';
              if (reason === 'empty') throw new Error('模型没有产出可用的要点');
              // 宿主已经明确「这段不做」：记下来，别让重新挂载反复打。
              SUMMARY_SUPPRESSED.set(key, Date.now());
              return { bullets: null, skipped: reason };
            }
            SUMMARY_CACHE.set(key, bullets);
            return { bullets, cached: false };
          })
          .then((result) => {
            consecutiveFailures = 0;
            return result;
          }, (error) => {
            const message = error && typeof error.message === 'string' ? error.message : '';
            // 取消、限速、已抑制、已缓存失败、熔断：都不算真失败，不该把它们计进熔断。
            const ignored = (error && error.name === 'AbortError')
              || message === 'suppressed'
              || message === 'rate-limited'
              || message === 'cached-failure'
              || message === 'circuit-open';
            if (!ignored) {
              SUMMARY_FAILED.set(key, Date.now());
              consecutiveFailures += 1;
              if (consecutiveFailures >= 5) circuitOpenUntil = Date.now() + 60 * 1000;
            }
            throw error;
          })
          .finally(() => { SUMMARY_PENDING.delete(key); });
      });
      return entry;
    }

    function summarize(text, sessionId, signal) {
      const key = fingerprint(text);
      const cached = SUMMARY_CACHE.get(key);
      if (cached !== undefined) return Promise.resolve({ bullets: cached, cached: true });

      const failedAt = SUMMARY_FAILED.get(key);
      if (failedAt !== undefined && Date.now() - failedAt < FAILURE_TTL) {
        return Promise.reject(new Error('cached-failure'));
      }

      const suppressedAt = SUMMARY_SUPPRESSED.get(key);
      if (suppressedAt !== undefined && Date.now() - suppressedAt < SUPPRESS_TTL) {
        return Promise.reject(new Error('suppressed'));
      }

      if (Date.now() < circuitOpenUntil) return Promise.reject(new Error('circuit-open'));

      let entry = SUMMARY_PENDING.get(key);
      if (entry === undefined) {
        if (!takeRateSlot()) return Promise.reject(new Error('rate-limited'));
        entry = createEntry(key, text, sessionId);
        SUMMARY_PENDING.set(key, entry);
      }
      entry.refs += 1;
      const detach = watchAbort(entry, signal);
      return entry.promise.then(
        (value) => { detach(); return value; },
        (error) => { detach(); throw error; },
      );
    }

    /* ------------------------------------------------------------------ *
     * 样式
     * ------------------------------------------------------------------ */
    const CSS = `
.ts-root{display:flex;flex-direction:column;gap:2px;margin:2px 0}
.ts-head{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:4px 6px;
  border:0;border-radius:8px;background:transparent;cursor:pointer;text-align:left;
  color:var(--dsw-alias-label-secondary,#8b8f96);font-size:13px;line-height:20px}
.ts-head:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))}
.ts-head:focus-visible{outline:2px solid var(--dsw-alias-border-accent,#4d6bfe);outline-offset:1px}
.ts-chevron{flex:0 0 auto;width:12px;text-align:center;opacity:.75;font-size:10px}
.ts-title{flex:0 0 auto;font-weight:500}
.ts-meta{flex:0 0 auto;font-size:12px;opacity:.7}
.ts-body{padding:2px 6px 6px 26px;font-size:13px;line-height:21px;
  color:var(--dsw-alias-label-primary,#d6d6d6)}
.ts-lines{display:flex;flex-direction:column;gap:2px}
.ts-line{display:block}
.ts-preview{opacity:.72;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ts-pending{opacity:.6;font-style:italic}
.ts-error{opacity:.5;font-size:12px}
.ts-raw{max-height:360px;overflow:auto;overscroll-behavior:contain}
.ts-hidden{display:none}
`;

    function ensureStyles() {
      const id = '@drifter-yh/dsh-think-summary/style';
      if (typeof document === 'undefined') return;
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(id)}]`) !== null) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = '@drifter-yh/dsh-think-summary';
      tag.dataset.pluginCss = id;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /* ------------------------------------------------------------------ *
     * 思考行
     * ------------------------------------------------------------------ */
    function RawReasoning(props) {
      const { text, running, t } = props;
      const labels = React.useMemo(() => {
        try { return markdownLabels(t); } catch { return undefined; }
      }, [t]);
      if (MarkdownText === null) return h('pre', { className: 'ts-raw' }, text);
      return h(MarkdownText, { text, streaming: running, variant: 'compact', labels });
    }

    function SummaryRow(props) {
      const { text, running, sessionId, startedAt, t } = props;
      const [expanded, setExpanded] = React.useState(false);
      const [state, setState] = React.useState({ status: 'idle', bullets: null });
      /** 被限速而暂停时，隔一阵自动重试；否则「暂停」会一直挂到重新挂载为止。 */
      const [attempt, setAttempt] = React.useState(0);

      React.useEffect(() => {
        if (LOCAL_DISABLED) return undefined;
        if (running) return undefined;
        if (text.trim().length < MIN_CHARS) return undefined;
        if (typeof startedAt === 'number' && startedAt > 0 && Date.now() - startedAt > RECENT_MS) return undefined;
        let alive = true;
        let retry = null;
        const controller = new AbortController();
        setState((current) => (current.status === 'ok' || current.status === 'paused'
          ? current
          : { status: 'loading', bullets: null }));
        summarize(text, sessionId, controller.signal).then(
          (result) => {
            if (!alive) return;
            if (result.bullets === null) setState({ status: 'paused', bullets: null, reason: result.skipped });
            else setState({ status: 'ok', bullets: result.bullets });
          },
          (error) => {
            if (!alive) return;
            const message = error && typeof error.message === 'string' ? error.message : '';
            // 限速是「暂时不做」，不是「做失败」：行内标为暂停，等下自动再试。
            if (message === 'rate-limited') {
              setState({ status: 'paused', bullets: null, reason: message });
              retry = setTimeout(() => { if (alive) setAttempt((value) => value + 1); }, RATE_RETRY_MS);
            } else {
              setState({ status: 'error', bullets: null });
            }
          },
        );
        return () => {
          alive = false;
          controller.abort();
          if (retry !== null) clearTimeout(retry);
        };
      }, [text, running, sessionId, startedAt, attempt]);

      const preview = React.useMemo(
        () => (running ? latestCompletedParagraphFirstLine(text) : firstLine(text)).replaceAll('**', ''),
        [text, running],
      );

      const toggle = React.useCallback(() => setExpanded((value) => !value), []);

      const meta = running ? '进行中'
        : state.status === 'ok' ? '进度'
        : state.status === 'loading' ? '整理中'
        : state.status === 'paused' ? '摘要已暂停'
        : '';

      // 暂停时把原因挂在标题上，别让人对着「怎么没要点」猜。
      const hint = state.status === 'paused'
        ? (PAUSED_HINTS[state.reason] ?? '摘要暂时不可用，稍后自动恢复')
        : '';

      const body = expanded
        ? h('div', { className: 'ts-raw' }, h(RawReasoning, { text, running, t }))
        : state.status === 'ok'
          ? h('div', { className: 'ts-lines' }, state.bullets.map((line, index) => h('div', { key: index, className: 'ts-line' }, line)))
          : state.status === 'loading'
            ? h('div', { className: 'ts-pending' }, preview === '' ? '正在整理这一步的进度…' : preview)
            : h('div', { className: 'ts-preview' }, preview);

      return h('div', { className: 'ts-root', 'data-think-summary': '' },
        h('button', {
          type: 'button',
          className: 'ts-head',
          'aria-expanded': expanded,
          title: hint === '' ? undefined : hint,
          onClick: toggle,
        },
        h('span', { className: 'ts-chevron', 'aria-hidden': true }, expanded ? '▾' : '▸'),
        h('span', { className: 'ts-title' }, '思考'),
        meta === '' ? null : h('span', { className: 'ts-meta' }, meta),
        ),
        h('div', { className: 'ts-body' }, body));
    }

    /* ------------------------------------------------------------------ *
     * 可搜索隐藏（复刻出厂 ProcessReasoning 语义）
     * ------------------------------------------------------------------ */
    function useSearchableHidden(hidden, reveal) {
      const ref = React.useRef(null);
      const revealRef = React.useRef(reveal);
      revealRef.current = reveal;
      React.useLayoutEffect(() => {
        const element = ref.current;
        if (element === null || typeof element.setAttribute !== 'function') return undefined;
        if (hidden) element.setAttribute('hidden', 'until-found');
        else element.removeAttribute('hidden');
        return undefined;
      }, [hidden]);
      React.useEffect(() => {
        const element = ref.current;
        if (element === null || typeof element.addEventListener !== 'function') return undefined;
        const onBeforeMatch = () => {
          if (typeof revealRef.current === 'function') revealRef.current();
        };
        element.addEventListener('beforematch', onBeforeMatch);
        return () => { element.removeEventListener('beforematch', onBeforeMatch); };
      }, []);
      return ref;
    }

    function ProcessReasoning(props) {
      const { hidden, reveal, children } = props;
      const ref = useSearchableHidden(hidden, reveal);
      return h('div', { ref, 'data-turn-process-inline': hidden || undefined }, children);
    }

    /* ------------------------------------------------------------------ *
     * assistant-step 渲染器
     * ------------------------------------------------------------------ */
    function AssistantStep(props) {
      const { node, groupPart, renderMessageImages, turnProcess, t } = props;
      const sessionId = props.thinkSummarySessionId;
      const data = (node && node.data) || {};
      const blocks = Array.isArray(data.blocks) ? data.blocks : [];
      const running = data.status === 'running';

      const reasoningHidden = turnProcess !== undefined && turnProcess !== null && turnProcess.foldable === true
        && turnProcess.spec !== undefined && turnProcess.spec !== null
        && turnProcess.spec.answerStep === data.step
        && turnProcess.spec.inlineReasoning === true
        && !turnProcess.open;
      const reveal = React.useCallback(() => {
        if (turnProcess && typeof turnProcess.setOpen === 'function') turnProcess.setOpen(true);
      }, [turnProcess]);

      const labels = React.useMemo(() => {
        try { return markdownLabels(t); } catch { return undefined; }
      }, [t]);

      const out = [];
      for (let i = 0; i < blocks.length; i += 1) {
        const block = blocks[i];
        if (block === undefined || block === null) continue;
        if (groupPart === 'reasoning' && block.kind !== 'reasoning') continue;
        if (groupPart === 'response' && block.kind === 'reasoning') continue;

        if (block.kind === 'text') {
          out.push(MarkdownText !== null
            ? h(MarkdownText, { key: i, text: block.text, streaming: running, labels })
            : h('div', { key: i, style: { whiteSpace: 'pre-wrap' } }, block.text));
          continue;
        }

        if (block.kind === 'reasoning') {
          const text = visibleReasoningText(block.text);
          if (text === null) continue;
          const isTail = !blocks.slice(i + 1).some((next) => next && (
            next.kind === 'text'
            || (next.kind === 'reasoning' && visibleReasoningText(next.text) !== null)
          ));
          out.push(h(ProcessReasoning, { key: i, hidden: reasoningHidden, reveal },
            h(SummaryRow, {
              text,
              running: running && isTail,
              sessionId,
              startedAt: typeof data.time === 'number' ? data.time : null,
              t,
            })));
          continue;
        }

        if (block.kind === 'image' && typeof renderMessageImages === 'function') {
          const start = i;
          const group = [block];
          while (i + 1 < blocks.length && blocks[i + 1] && blocks[i + 1].kind === 'image') {
            group.push(blocks[i + 1]);
            i += 1;
          }
          try {
            out.push(h(React.Fragment, { key: start },
              renderMessageImages({ images: group.map((item) => ({ attachment: item.attachment })), align: 'start' })));
          } catch { /* 图片渲染失败不影响文字 */ }
          continue;
        }

        if (block.kind === 'tool-call') continue; // 工具调用由独立节点渲染
        // 未知块：宁可少渲染，也不让整条消息崩掉。
      }

      if (out.length === 0) return null;
      return h(React.Fragment, null, out);
    }

    /* ------------------------------------------------------------------ *
     * 兜底：渲染器出错时退化为纯文本，绝不让整条消息白屏
     * ------------------------------------------------------------------ */
    function plainText(blocks, groupPart) {
      const list = Array.isArray(blocks) ? blocks : [];
      const out = [];
      for (let i = 0; i < list.length; i += 1) {
        const block = list[i];
        if (!block) continue;
        if (groupPart === 'reasoning' && block.kind !== 'reasoning') continue;
        if (groupPart === 'response' && block.kind === 'reasoning') continue;
        if (block.kind === 'text') out.push(h('div', { key: i, style: { whiteSpace: 'pre-wrap' } }, block.text));
        else if (block.kind === 'reasoning') out.push(h('div', { key: i, style: { whiteSpace: 'pre-wrap', opacity: 0.8 } }, block.text));
      }
      return out.length === 0 ? null : h('div', null, out);
    }

    const BoundaryBase = React.Component || React.PureComponent;

    /** 基类存在时才定义边界类（类声明本身会在 extends undefined 时抛错）。 */
    const StepBoundary = BoundaryBase === undefined ? undefined : class StepBoundary extends BoundaryBase {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }

      static getDerivedStateFromError() {
        return { failed: true };
      }

      componentDidCatch(error) {
        try {
          console.warn('[@drifter-yh/dsh-think-summary] assistant-step 渲染失败，已降级为纯文本：', error);
        } catch { /* ignore */ }
      }

      render() {
        if (this.state.failed) return this.props.fallback === undefined ? null : this.props.fallback;
        return this.props.children;
      }
    };

    /* ------------------------------------------------------------------ *
     * 插件注册
     * ------------------------------------------------------------------ */
    return {
      inject: ['slots'],

      apply(ctx) {
        if (typeof ctx.slots?.inject !== 'function' || typeof ctx.slots?.register !== 'function') {
          console.warn('[@drifter-yh/dsh-think-summary] 缺少 slots 服务，插件不生效');
          return;
        }
        ensureStyles();

        try {
          ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
            name: 'conversation.chat.node',
            key: 'assistant-step',
            // 出厂占 priority 0，必须用更小的值才能遮蔽。
            priority: -1,
            inject: (sessionId) => ({ thinkSummarySessionId: sessionId }),
          }, (slotProps) => (StepBoundary === undefined
            ? h(AssistantStep, slotProps)
            : h(StepBoundary, {
              fallback: plainText(slotProps && slotProps.node && slotProps.node.data && slotProps.node.data.blocks,
                slotProps && slotProps.groupPart),
            }, h(AssistantStep, slotProps)))));
        } catch (error) {
          console.warn('[@drifter-yh/dsh-think-summary] 遮蔽 assistant-step 失败，出厂渲染保持不变：',
            error && error.message ? error.message : String(error));
        }
      },
    };
  },
});
