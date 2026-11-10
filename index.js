/**
 * 切片牢大 Host 半边。
 *
 * 本插件目前是「纯 Client」形态：画布、切分、抠图全在浏览器里用 Canvas 完成，
 * 数据落在 IndexedDB。Host 半边不注册任何服务、工具或路由，只作为 bundle 行存在，
 * 让 Loader 有地方挂 Client 模块（`dsh.client.platform = web`）。
 *
 * 后续若要做「存成工作区里的真实文件」或「给 Agent 提供切图工具」，
 * 服务、工具和文件读写都从这里长出来，Client 半边不需要改结构。
 */
export function apply() {}
