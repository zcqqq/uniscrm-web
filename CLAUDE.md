# 业务
skill/plugin + social trend + content + commerce product.
根据social trend来推荐content 和/或 product.
通过skill/plugin在通用agent端（如OpenClaw ClawHub）引流。

# 技术架构
尽量使用Cloudflare上的免费或低价组件。语义用Vectorize。
部署时能区分dev prod环境。如果是prod环境，则尽量不删除或重建资源，不破坏prod上的数据。