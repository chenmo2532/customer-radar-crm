# 客户价值雷达 CRM

这是一个可上线试用的 CRM 网站版本，包含登录、客户画像、客户雷达评分、销售跟进和 A/B/C/D 客户分层看板。

## 本地运行

```powershell
npm start
```

访问：

```text
http://localhost:4173
```

默认账号：

```text
admin / admin123
linchen / 123456
xunuo / 123456
```

## 数据保存

默认数据文件：

```text
data/db.json
```

线上部署时建议设置 `DATA_DIR` 到持久化磁盘目录，避免平台重启或重新部署时丢数据。

## 上线到 Render

1. 把 `crm-web` 目录上传到 GitHub 仓库。
2. 登录 Render，选择 New Blueprint。
3. 选择该 GitHub 仓库。
4. Render 会读取 `render.yaml`，创建 Web Service 和 1GB 持久化磁盘。
5. 部署完成后访问 Render 提供的网址。

## 小团队实际使用建议

- 首次上线后立刻修改 `server.mjs` 里的默认账号密码，或后续接入用户管理。
- 每天备份 `data/db.json`。
- 10 人以内、客户量几千条以内可以先用当前 JSON 存储。
- 如果要长期商用，下一步建议升级 PostgreSQL，并增加角色权限、导入导出和操作日志。
