# PRO Mobile 迁移测试包（基础恢复版）

此包来自之前保存的 `contract-lens-pro-login-10086-source.zip`。已恢复旧版 PRO 前端、服务端和密码页面，但不保证拥有 Railway Mobile 最新版功能，包括最新的20笔动态占比条、2分钟资金模型、双小时候选、所有收藏内容。

警告：不要以本包覆盖其他现有网站；先在阿里云独立目录中测试。测试期间只开放本机服务，不要把 3088 端口公开到互联网。测试通过后再设置反向代理、HTTPS 和自动启动。

## 服务器准备（Workbench admin 用户）

解压到 /home/admin/pro-mobile-test：
```
mkdir -p ~/pro-mobile-test
unzip -o ~/pro-mobile-restore-base.zip -d ~/pro-mobile-test
```

先验证代码文件：
```
cd ~/pro-mobile-test
ls -l server.js public/index.html
```

确保环境变量为本机测试并启动：
```
PORT=3088 PRO_ACCESS_CODE=10086 ~/.bun/bin/bun server.js
```

另开一个 Workbench Shell 运行：
```
curl -I http://127.0.0.1:3088/
```

预期返回登录重定向，并不表示公开网站已经搭建成功。

## 后续

按实际性能恢复最新版 Mobile 前端与后端，配置 HTTPS（建议 Caddy/Nginx）、限制公网端口，仅把 80/443 对外开放，使用防火墙；自定义强密码替换初始 10086。移动端收藏存储如在 localStorage，换域名不能自动同步。
