# 天地图接入验证

阶段 3 的独立验证夹具，不是正式应用或完整原型。使用 Node 内置模块和本机 Edge，不安装依赖，不读取照片或账号数据。

在本目录创建 `.env.local`，按 `.env.example` 的格式填写本人浏览器端应用密钥。真实密钥与 results 已加入本目录 `.gitignore`；不要把密钥写进源代码、文档或提交到版本库。

在项目根目录运行：

~~~powershell
& 'D:\SDK\Node\node.exe' .\validation\map-probe\run.mjs
~~~

服务仅监听 127.0.0.1 随机端口并使用随机路径，拒绝不匹配的 Host 与外来 Origin。Key 只经本机配置端点提供给测试网页，并作为网页调用凭据提交给天地图官方 HTTPS 服务。Edge 使用独立测试配置；每次运行会有少量真实地图请求，不扫描或下载地图数据集。

测试验证官方 SDK、真实矢量底图和注记图片解码；通过实际标记图像的 DOM 点击事件，检查六个城市的跳转、年份降序、空影集示例、城市名称过滤与返回地图位置。运行器仅连接本次启动的独立 Edge 调试端口，记录脚本异常、截图和 DOM，不连接用户日常浏览器。

城市代表点为手工设置的近似坐标，城市搜索限定这六个本地样例；不把这次测试当作官方城市检索、全国行政目录或完整港澳覆盖验证。年份影集为内存示例，没有用户认证、照片、保存或完整年份影集功能。自动点击不是人工可用性测试。

结果写入 `results/<时间>/result.json`、`dom.html`、`edge-map.png` 和 `edge-stderr.log`。文本记录会替换真实密钥；独立 `edge-profile` 可能含浏览器缓存，完成后核对路径再清理。最后需目视检查截图中的底图、标识和注记；不能仅以 SDK 对象存在判断地图已加载。

2026-09-20 最终通过记录为 `results/2026-09-20T10-37-39-681Z/result.json`：28 项断言，30 个地图瓦片图像全部解码，页面和调试器异常为 0，Edge 与本机服务正常关闭。6 次尝试的独立配置目录已清理。早期失败记录保留；完整过程与限制见 [可行性记录](../../docs/feasibility.md)。全国尺度下部分标记重叠，真实鼠标命中与缩放体验仍需在原型中验证。

参考：[官方加载示例](http://lbs.tianditu.gov.cn/api/js4.0/codeDemo/code1.html)、[地图类](http://lbs.tianditu.gov.cn/api/js4.0/pages-class/Map.html)、[标记类](http://lbs.tianditu.gov.cn/api/js4.0/pages-class/Marker.html)。
