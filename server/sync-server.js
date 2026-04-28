/**
 * WebSocket 同步服务器
 *
 * 使用方式:
 *   node sync-server.js [端口]
 *   默认端口: 8080
 *
 * 协议说明:
 *   客户端连接后发送 JSON: { action: 'join', roomId: '房间号' }
 *   之后该房间内的所有消息会广播给其他成员
 */

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.argv[2] || 8080;

// 房间管理: roomId -> Set<ws>
const rooms = new Map();

// 客户端ID计数器
let clientCounter = 0;

// 创建 HTTP 服务器（用于健康检查）
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    service: 'video-speed-sync',
    version: '1.0.0',
    rooms: rooms.size,
    connections: Array.from(rooms.values()).reduce((sum, set) => sum + set.size, 0)
  }));
});

// 创建 WebSocket 服务器
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const clientId = 'c_' + (++clientCounter) + '_' + Math.random().toString(36).substr(2, 5);
  ws.clientId = clientId;
  ws.roomId = null;

  console.log(`[连接] 客户端 ${clientId} 已连接 (${req.socket.remoteAddress})`);

  ws.on('message', (rawData) => {
    try {
      const msg = JSON.parse(rawData.toString());
      handleMessage(ws, msg);
    } catch (e) {
      console.error('[错误] 消息解析失败:', e.message);
      ws.send(JSON.stringify({ action: 'error', message: 'Invalid JSON' }));
    }
  });

  ws.on('close', () => {
    console.log(`[断开] 客户端 ${clientId} 已断开`);
    leaveRoom(ws);
  });

  ws.on('error', (err) => {
    console.error(`[错误] 客户端 ${clientId}:`, err.message);
  });

  // 发送欢迎消息
  ws.send(JSON.stringify({ action: 'connected', clientId }));
});

/**
 * 处理客户端消息
 */
function handleMessage(ws, msg) {
  const { action } = msg;

  switch (action) {
    case 'join':
      joinRoom(ws, msg.roomId);
      break;

    case 'leave':
      leaveRoom(ws);
      break;

    case 'play':
    case 'pause':
    case 'seek':
    case 'speed':
    case 'progress':
    case 'syncState':
      broadcastToRoom(ws, msg);
      break;

    default:
      // 未知动作，直接转发到房间
      broadcastToRoom(ws, msg);
  }
}

/**
 * 加入房间
 */
function joinRoom(ws, roomId) {
  if (!roomId) {
    ws.send(JSON.stringify({ action: 'error', message: 'roomId is required' }));
    return;
  }

  // 先离开旧房间
  leaveRoom(ws);

  ws.roomId = roomId;

  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Set());
  }
  rooms.get(roomId).add(ws);

  console.log(`[房间] 客户端 ${ws.clientId} 加入房间 ${roomId} (当前 ${rooms.get(roomId).size} 人)`);

  // 通知其他成员有新用户加入
  broadcastToRoom(ws, { action: 'join', clientId: ws.clientId, roomId });

  // 通知该用户加入成功
  ws.send(JSON.stringify({
    action: 'joined',
    roomId,
    clientId: ws.clientId,
    memberCount: rooms.get(roomId).size
  }));
}

/**
 * 离开房间
 */
function leaveRoom(ws) {
  if (!ws.roomId) return;

  const room = rooms.get(ws.roomId);
  if (room) {
    room.delete(ws);
    console.log(`[房间] 客户端 ${ws.clientId} 离开房间 ${ws.roomId} (剩余 ${room.size} 人)`);

    if (room.size === 0) {
      rooms.delete(ws.roomId);
      console.log(`[房间] 房间 ${ws.roomId} 已销毁`);
    }
  }

  ws.roomId = null;
}

/**
 * 广播消息到房间（排除发送者自己）
 */
function broadcastToRoom(sender, msg) {
  if (!sender.roomId) return;

  const room = rooms.get(sender.roomId);
  if (!room) return;

  const message = JSON.stringify({
    ...msg,
    clientId: sender.clientId,
    timestamp: Date.now()
  });

  room.forEach((ws) => {
    if (ws !== sender && ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  });
}

// 启动服务器
server.listen(PORT, () => {
  console.log('========================================');
  console.log('  视频倍速同步服务器已启动');
  console.log(`  HTTP 端口: ${PORT}`);
  console.log(`  WebSocket: ws://localhost:${PORT}`);
  console.log('========================================');
  console.log('');
  console.log('使用说明:');
  console.log('  1. 在插件设置中填入服务器地址');
  console.log(`     ws://你的服务器IP:${PORT}`);
  console.log('  2. 所有客户端输入相同的房间ID即可同步');
  console.log('');
});
