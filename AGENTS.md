# Business
数据准确性 > 系统稳定性 > 功能 > UI界面
永远不要为了兼容脏数据而增加复杂功能，或者为了不合适的功能改UI。

# Code
uniscrm-web库是多租户SaaS，分多个模块/worker：
- admin: 租户管理，billing。
- flow: 基于reactflow的事件触发工作流。
- analytics: 多种SQL即席分析、和可视化报表。
- insight-segment: 基于profile的SQL规则分群。
- link: 统一渠道模块。social/content/commerce/lists统一在一个Worker中。
- metadata: event/user/flow等实体基于元数据配置。
- operation: 生产环境运维相关，可以存储一些修复数据的临时脚本。
- profile: maigret container做跨渠道查询。
- shared: 不是模块/worker。包含UI组件等所有模块通用的组件。
- web: 登录页及通用功能如设置等。

git分dev和main分支，提交到main分支时自动通过github部署dev环境（cloudflare资源加-dev后缀），cloudflare上prodution环境部署由github action手动触发。

前端不用inline CSS，全部组件化。

# Technical
大数据存储基于R2 data catalog.
各模块间尽量减少逻辑耦合，通过数据（Cloudflare各组件）耦合。所以在Cloudflare组件的配置文件中，尽量用模块名做前后缀，如DB_WEB，而不是通用的DB、以减少各个模块间的歧义。比较特殊的是tenantdb，各个模块可能都有数据量大的表，要按租户分库放到tenantdb。