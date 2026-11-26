# 阅读层

有阅读层的文献在阅读页上的四个视图（阅读体验第 3 节，ADR 0070）：全文上的批语、脉络、概览、导图，以及层与层之间的过渡。框架无关：只生成 DOM、处理指针与滚动，由全文引擎 `../document.ts` 在正文排好之后挂上，React 一侧只经 `ReaderFrame` 的 `setLayer`、`layerWheel`、`setKeyTerms`、`onLayer`、`onLayers` 与它来往。界面上把要点叫“批语”，代码里沿用合同的名字 point。

- [read.ts](read.ts)：读一个版本的阅读层（`overview` 一次，`outline` 分页读完），用合同包的解析器；有译文部分时读 `bilingual`，换读法不再请求。[contract.ts](contract.ts) 只剩 409 拒绝的解析。
- [model.ts](model.ts)：四个视图共用的数据、各种文字取原文还是译文、类别与关系的名字、安全的行内渲染与重点词的标出（合同包的 `key-term-match-v1`），以及全文引擎要提供的 `LayersPort`。
- [notes.ts](notes.ts)：全文上的批语。把每条依据的句子在它所在的块里找出来（复用批注的 `mark-locate`），在文字节点外面包一层 `span.rl-ev`，重点词包 `b.rl-kt`，句末的批号由 CSS 从属性画出。作者的文字不变，选中、复制、查找到的仍是原文；块的 `data-text-revision` 变化让批注重新建索引。找不到原句（公式写法不同）时不包，批语仍排在段落旁。
- [leaf.ts](leaf.ts)：脉络与概览两页的内容与页边。两页上是同一件东西的元素带同一个 `data-f`。
- [map.ts](map.ts)：导图。按层分列、父节点对着子节点中间；每个比例都按真实尺寸重排；平移用 transform；右栏读一条批语。
- [change.ts](change.ts)：换层。新的一页照常排好，带同一个 `data-f` 的东西各从旧位置走到新位置；整个变化是 0 到 1 的一个值的函数，点击由时间推动，`Alt` 加滚轮由手推动。旧的一页是窗口附近内容的副本，放在纸页里。
- [view.ts](view.ts)：总控。在纸页里放栏线、朱笔、页边与另外两页，决定显示哪一层（纸页上的 `data-layer`），排页边、处理点击与悬停、起止换层。

样式在 `../../app/features/reader/layers.css`，类名都以 `rl-` 开头。页面测试是 `apps/web/test/next-reader-layers.test.ts`，夹具 `stored-layers.ts` 是一篇合成文献。

[上级目录](../README.md)
