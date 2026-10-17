# 验证工具索引

这里是独立验证工具，不是正式产品代码。正式页面在 `frontend/`，接口在 `backend/`；常规自动测试在各工程的 `tests/`。

| 目录 | 阶段与用途 | 运行注意 |
| --- | --- | --- |
| [local-delivery/](local-delivery/README.md) | T16 构建版空库验收，当前交付工具 | 通过前端 `npm run test:delivery` 使用；仅合成资料 |
| [scale/](scale/README.md) | T15 原图规模、并发、内存与离线审计 | 重量级、显式运行，须预留至少 40 GiB，不纳入默认回归 |
| [map-plan/](map-plan/README.md) | T12 来源、请求调度、WMTS 方案核对 | 离线规则检查不联网；在线核验另行安排 |
| [map-probe/](map-probe/README.md) | 早期地图 API/SDK 可行性探针 | 历史工具，可能使用私有 Key 并消耗真实额度 |
| [gallery-probe/](gallery-probe/README.md) | 早期原图加载与浏览压力探针 | 历史工具，不代替 T15 正式规模验收 |

历史探针保留原路径：本机私有配置及早期证据仍可能引用它们，不能因为“旧”就删除。`map-probe/.env.local` 属于忽略的私有配置，本轮没有移动或读取它。

`results/`、临时浏览器配置、合成样本和运行库均不入 Git。部分规模样本占用较大；需要清理时按各工具说明核对确切测试目录，不把仓库整理等同于清空数据。各文件用途见[文件导航](../docs/file-guide.md)，结论见[报告索引](../docs/README.md#验证与交付记录)。
