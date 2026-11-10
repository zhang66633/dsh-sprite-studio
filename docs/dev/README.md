# 开发文档索引

只记「为什么」和「验过的事实」，不重复代码。

| 文件 | 什么时候看 |
| --- | --- |
| [开发计划.md](开发计划.md) | 现在的范围、下一步怎么长 |
| [迭代记录.md](迭代记录.md) | 每一版做了什么、验证到什么程度 |
| [踩坑记录.md](踩坑记录.md) | 换版本/换机器前先读，很多坑是 API 性质不是笔误 |
| [素材资源调研.md](素材资源调研.md) | 外部素材/工具能不能接、横版与俯视各缺什么 |

## 结构

```mermaid
flowchart LR
  subgraph Host["Host 半边（Node）"]
    H1["index.js<br/>apply() 空实现"]:::thin
    H2["cordis.patch.yml<br/>插入 sprite-studio 行"]:::thin
  end

  subgraph Client["Client 半边（浏览器）"]
    direction TB
    M["client.js<br/>window.__ModuleLoader__.load"]
    M --> A["apply(ctx)"]
    A --> S["sidebar.panellist<br/>id: sprite-studio"]
    A --> P["main<br/>key: sprite-studio"]
    A --> C["CSS 注入<br/>ctx.effect → document.head"]
    P --> UI["StudioPanel<br/>画布 + 检查器"]
    UI --> ALG["纯函数<br/>gridRects / autoRects<br/>applyMatte / trimAlpha"]
    UI --> DB[("IndexedDB<br/>dsh-sprite-studio")]
    ALG --> CV["离屏 Canvas<br/>getImageData / putImageData"]
  end

  H2 -.装载.-> M
  S -.同一 id.-> P
```

要点：**侧栏图标与主面板靠同一个字符串配对**。`sidebar.panellist` 的 `id` 就是宿主
派发到 `main` 的 key，两边填不一致 = 图标点了没反应。

## 三个角色怎么分工

```mermaid
sequenceDiagram
  participant U as 用户
  participant SB as sidebar.panellist
  participant MN as main(sprite-studio)
  participant P as StudioPanel
  participant DB as IndexedDB

  U->>SB: 点图标
  SB->>MN: selectPanel('sprite-studio')
  MN->>P: 挂载
  P->>DB: getAll sprites + kv.board
  DB-->>P: 精灵列表 + 视图
  U->>P: 拖入文件
  P->>P: FileReader → dataURL → Image
  P->>DB: 脏标记增量写入（去抖 550ms）
  U->>P: 切分 / 抠图
  P->>P: 离屏 Canvas 像素运算
  P->>DB: 写回新图
```
