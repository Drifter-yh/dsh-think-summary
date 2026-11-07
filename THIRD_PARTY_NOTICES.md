# Third-Party Notices

`@drifter-yh/dsh-think-summary` is MIT-licensed. It ships **no third-party runtime
dependencies**; the client half borrows a small number of helpers and rendering
patterns from the MIT-licensed projects below. Their notices are reproduced here as
required by the MIT license.

---

## 1. DeepSeek Harness — MIT

- Upstream: <https://github.com/deepseek-ai/deepseek-harness>
- Used for: the text helpers mirrored in `client.js`
  (`reasoningText`, `firstLine`, `latestCompletedParagraphFirstLine`,
  the `markdownLabels(t)` key shape, and the `useSearchableHidden` /
  `ProcessReasoning` semantics of the shipped chat client).

```text
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. dsh-thinking-panel — MIT

- Upstream: <https://github.com/Fo-Rimuru/dsh-thinking-panel>
- Used for: the verified approach to shadowing `conversation.chat.node`
  (`key: 'assistant-step'`, `priority: -1`), the owner-props / hook-context
  assumptions validated against DSH 0.2.2-rc.1, and the structure of the
  block loop. The implementation here is rewritten, not a copy of the file.

```text
MIT License

Copyright (c) 2026 Fo-Rimuru

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
