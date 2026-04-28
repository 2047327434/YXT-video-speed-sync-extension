# 🎬 视频倍速同步助手 (Chrome Extension)

一个强大的 Chrome 浏览器插件，支持检测页面视频、自定义倍速播放，以及**多台设备间联网同步视频播放进度**。

---

## ✨ 功能特性

| 功能 | 说明 |
|------|------|
| 🔍 **自动检测视频** | 智能扫描页面中的所有 `<video>` 元素，包括 iframe 内视频 |
| ⚡ **自定义倍速** | 支持 0.25x ~ 20x 任意倍速，滑块 + 预设按钮双控制 |
| 🌐 **联网同步** | 通过 WebSocket 服务器，多端同步播放/暂停/进度/倍速 |
| ⌨️ **键盘快捷键** | `Alt + ,/.` 减速/加速，`Alt + R` 重置，`Alt + P` 播放暂停 |
| 🎮 **快捷操作** | 播放/暂停、±10秒跳转，实时显示视频状态 |

---

## 📁 目录结构

```
video-speed-sync-extension/
├── manifest.json        # 插件配置文件
├── content.js           # 内容脚本（注入页面，核心逻辑）
├── background.js        # 后台服务脚本
├── popup.html           # 控制面板界面
├── popup.css            # 控制面板样式
├── popup.js             # 控制面板逻辑
├── icons/               # 插件图标（需自行准备）
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── server/              # WebSocket 同步服务器
│   ├── package.json
│   └── sync-server.js
└── README.md
```

---

## 🚀 安装方法

### 1. 加载插件到 Chrome

1. 打开 Chrome，地址栏输入 `chrome://extensions/`
2. 右上角开启「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择 `video-speed-sync-extension` 文件夹
5. 插件图标会出现在浏览器工具栏

> ⚠️ 需要准备 3 个图标文件放在 `icons/` 目录下：`icon16.png`、`icon48.png`、`icon128.png`。如果没有，可以用任意图片代替，或删除 manifest.json 中的 `icons` 字段。

### 2. 部署同步服务器（可选）

如果不使用联网同步功能，可以跳过此步骤。

#### 方式 A：本地运行

```bash
cd server
npm install
npm start
# 默认监听 8080 端口
```

#### 方式 B：部署到服务器（推荐）

将 `server/` 目录上传到你的服务器，然后：

```bash
cd server
npm install
# 使用 PM2 后台运行
npm install -g pm2
pm2 start sync-server.js --name video-sync -- 8080
```

#### 方式 C：Nginx 反向代理 + SSL（生产环境）

如果你已有域名和 SSL 证书，可以在 Nginx 中配置 WebSocket 反向代理：

```nginx
location /ws {
    proxy_pass http://localhost:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 86400;
}
```

然后在插件中填写 `wss://你的域名/ws`。

---

## 📖 使用教程

### 基础倍速控制

1. 打开任意包含视频的网页（如 B站、YouTube、Netflix 等）
2. 点击浏览器工具栏的 🎬 图标打开控制面板
3. 点击预设倍速按钮，或拖动滑块调整
4. 所有检测到的视频会同步应用该倍速

### 联网同步播放进度

1. **启动同步服务器**（见上文部署方法）
2. 在插件控制面板中填写：
   - **服务器地址**：你的 WebSocket 地址，如 `ws://47.109.156.100:8080`
   - **房间ID**：任意字符串，如 `room-001`
   - **是否主控端**：勾选则此设备控制其他设备，不勾选则跟随主控端
3. 点击「连接同步」
4. 在另一台设备的 Chrome 中打开**同一个视频页面**，填入**相同的房间ID**
5. 主控端的播放/暂停/进度/倍速操作会实时同步到所有接收端

### 键盘快捷键

| 快捷键 | 功能 |
|--------|------|
| `Alt + ,` | 减速 0.25x |
| `Alt + .` | 加速 0.25x |
| `Alt + R` | 重置为 1.0x |
| `Alt + P` | 播放 / 暂停 |

> ⚠️ 在输入框中不会触发快捷键

---

## 🔧 工作原理

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Chrome A   │◄───►│   WebSocket  │◄───►│  Chrome B   │
│  (主控端)    │     │   服务器      │     │  (接收端)    │
└─────────────┘     └─────────────┘     └─────────────┘
       │                                          │
       ▼                                          ▼
  播放/暂停/进度/倍速                         同步执行相同操作
```

1. **内容脚本** (`content.js`) 注入到每个网页，检测 `<video>` 元素并监听事件
2. **控制面板** (`popup`) 通过 Chrome Message API 与内容脚本通信
3. **联网同步** 通过 WebSocket 将操作广播到同房间的其他客户端
4. **主控端** 定期上报播放进度，接收端在偏差超过 2 秒时自动校正

---

## 🛠️ 自定义配置

可以在 `content.js` 中修改以下配置：

```javascript
const state = {
  wsUrl: 'wss://your-sync-server.com/ws',  // 默认同步服务器
  // ...
};
```

---

## ⚠️ 注意事项

1. **跨域 iframe**：由于浏览器安全限制，插件无法访问跨域 iframe 中的视频（如部分嵌入式播放器）
2. **视频广告**：部分网站的广告视频也会被检测到，可以通过视频列表选择要控制的视频
3. **同步延迟**：网络同步存在少量延迟，接收端会在偏差 >2 秒时自动校正
4. **SSL**：生产环境建议使用 `wss://`（WebSocket over TLS），可通过 Nginx 反向代理实现

---

## 📄 开源协议

MIT License
