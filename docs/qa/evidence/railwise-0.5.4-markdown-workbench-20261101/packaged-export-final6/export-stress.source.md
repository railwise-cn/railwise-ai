---
title: DOCX 字符保真验收
stage: reviewed
---

# DOCX 字符保真验收

以下代码必须保持原始字符，不能泄漏高亮标签或重复解码实体。

```ts
const value = "' & < >"; const literal = "&#x27; &quot; &lt;"; const greeting = `Hello ${'RailWise & < >'}`;
```

```html
<div class="card" data-label='RailWise &amp; AI'>&lt;literal&gt; &#x27; &quot;</div>
```
