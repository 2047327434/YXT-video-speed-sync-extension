/**
 * popup.js - 控制面板交互逻辑
 */

document.addEventListener('DOMContentLoaded', () => {
  // DOM 元素
  const elSpeedDisplay = document.getElementById('currentSpeed');
  const elSpeedSlider = document.getElementById('speedSlider');
  const elVideoList = document.getElementById('videoList');
  const elVideoCount = document.getElementById('videoCount');
  const elSyncStatus = document.getElementById('syncStatus');
  const elSyncUrl = document.getElementById('syncUrl');
  const elSyncRoomId = document.getElementById('syncRoomId');
  const elChkAsMaster = document.getElementById('chkAsMaster');
  const elSyncForm = document.getElementById('syncForm');
  const elSyncConnected = document.getElementById('syncConnected');
  const elConnectedRoomId = document.getElementById('connectedRoomId');
  const elConnectedRole = document.getElementById('connectedRole');

  let currentTabId = null;
  let selectedVideoIndex = 0;

  // ==================== 初始化 ====================

  // 获取当前活动标签页
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      currentTabId = tabs[0].id;
      refreshVideos();
      refreshSyncStatus();
    }
  });

  // 恢复设置
  chrome.storage.local.get(['vss_speed', 'vss_syncUrl', 'vss_syncRoomId'], (result) => {
    if (result.vss_speed) {
      updateSpeedUI(result.vss_speed);
    }
    if (result.vss_syncUrl) {
      elSyncUrl.value = result.vss_syncUrl;
    }
    if (result.vss_syncRoomId) {
      elSyncRoomId.value = result.vss_syncRoomId;
    }
  });

  // ==================== 视频列表 ====================

  function refreshVideos() {
    if (!currentTabId) return;

    chrome.tabs.sendMessage(currentTabId, {
      target: 'content',
      action: 'getVideos'
    }, (response) => {
      if (chrome.runtime.lastError) {
        renderEmpty('无法访问此页面（可能受权限限制）');
        return;
      }

      if (response && response.count > 0) {
        renderVideoList(response.videos);
      } else {
        renderEmpty('当前页面未检测到视频');
      }
    });
  }

  function renderVideoList(videos) {
    elVideoCount.textContent = videos.length;
    elVideoList.innerHTML = '';

    videos.forEach((video, index) => {
      const item = document.createElement('div');
      item.className = 'video-item' + (index === selectedVideoIndex ? ' active' : '');
      item.innerHTML = `
        <div class="video-thumb">${index + 1}</div>
        <div class="video-info">
          <div class="video-title">视频 ${index + 1}</div>
          <div class="video-meta">${formatTime(video.currentTime)} / ${formatTime(video.duration)} · ${video.speed}x</div>
        </div>
        <div class="video-status ${video.paused ? 'paused' : 'playing'}">${video.paused ? '暂停' : '播放中'}</div>
      `;
      item.addEventListener('click', () => {
        selectedVideoIndex = index;
        refreshVideos();
      });
      elVideoList.appendChild(item);
    });
  }

  function renderEmpty(msg) {
    elVideoCount.textContent = '0';
    elVideoList.innerHTML = `<div class="empty-state">${msg}</div>`;
  }

  function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '00:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  // ==================== 倍速控制 ====================

  function updateSpeedUI(speed) {
    elSpeedDisplay.textContent = speed.toFixed(2);
    elSpeedSlider.value = speed;

    // 更新按钮高亮
    document.querySelectorAll('.speed-btn').forEach(btn => {
      const btnSpeed = parseFloat(btn.dataset.speed);
      btn.classList.toggle('active', Math.abs(btnSpeed - speed) < 0.01);
    });
  }

  // 预设倍速按钮
  document.querySelectorAll('.speed-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const speed = parseFloat(btn.dataset.speed);
      sendToContent('setSpeed', { speed });
    });
  });

  // 滑块
  elSpeedSlider.addEventListener('input', (e) => {
    const speed = parseFloat(e.target.value);
    elSpeedDisplay.textContent = speed.toFixed(2);
  });

  elSpeedSlider.addEventListener('change', (e) => {
    const speed = parseFloat(e.target.value);
    sendToContent('setSpeed', { speed });
  });

  // 加速/减速/重置
  document.getElementById('btnIncSpeed').addEventListener('click', () => {
    sendToContent('adjustSpeed', { delta: 0.25 });
  });

  document.getElementById('btnDecSpeed').addEventListener('click', () => {
    sendToContent('adjustSpeed', { delta: -0.25 });
  });

  document.getElementById('btnResetSpeed').addEventListener('click', () => {
    sendToContent('setSpeed', { speed: 1.0 });
  });

  // ==================== 快捷操作 ====================

  document.getElementById('btnTogglePlay').addEventListener('click', () => {
    sendToContent('togglePlay', { videoIndex: selectedVideoIndex });
  });

  document.getElementById('btnSkipBack').addEventListener('click', () => {
    sendToContent('skip', { videoIndex: selectedVideoIndex, seconds: -10 });
  });

  document.getElementById('btnSkipForward').addEventListener('click', () => {
    sendToContent('skip', { videoIndex: selectedVideoIndex, seconds: 10 });
  });

  // ==================== 联网同步 ====================

  function refreshSyncStatus() {
    sendToContent('getSyncStatus', {}, (response) => {
      if (response) {
        updateSyncUI(response);
      }
    });
  }

  function updateSyncUI(status) {
    if (status.enabled && status.connected) {
      elSyncStatus.textContent = '已连接';
      elSyncStatus.className = 'status-indicator connected';
      elSyncForm.style.display = 'none';
      elSyncConnected.style.display = 'block';
      elConnectedRoomId.textContent = status.roomId || '-';
      elConnectedRole.textContent = status.isMaster ? '主控端 ⭐' : '接收端';
    } else if (status.enabled) {
      elSyncStatus.textContent = '连接中...';
      elSyncStatus.className = 'status-indicator connecting';
      elSyncForm.style.display = 'block';
      elSyncConnected.style.display = 'none';
    } else {
      elSyncStatus.textContent = '未连接';
      elSyncStatus.className = 'status-indicator disconnected';
      elSyncForm.style.display = 'block';
      elSyncConnected.style.display = 'none';
    }
  }

  document.getElementById('btnConnect').addEventListener('click', () => {
    const url = elSyncUrl.value.trim();
    const roomId = elSyncRoomId.value.trim();
    const asMaster = elChkAsMaster.checked;

    if (!url) {
      alert('请输入服务器地址');
      return;
    }
    if (!roomId) {
      alert('请输入房间ID');
      return;
    }

    // 保存设置
    chrome.storage.local.set({
      vss_syncUrl: url,
      vss_syncRoomId: roomId
    });

    sendToContent('connectSync', { url, roomId, asMaster }, (response) => {
      if (response && response.success) {
        updateSyncUI({ enabled: true, connected: true, roomId, isMaster: asMaster });
      }
    });
  });

  document.getElementById('btnDisconnect').addEventListener('click', () => {
    sendToContent('disconnectSync', {}, () => {
      updateSyncUI({ enabled: false, connected: false });
    });
  });

  // ==================== 工具函数 ====================

  function sendToContent(action, data = {}, callback) {
    if (!currentTabId) return;

    chrome.tabs.sendMessage(currentTabId, {
      target: 'content',
      action,
      ...data
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.log('通信失败:', chrome.runtime.lastError.message);
        if (callback) callback(null);
        return;
      }

      // 如果响应包含速度信息，更新UI
      if (response && response.speed !== undefined) {
        updateSpeedUI(response.speed);
      }

      if (callback) callback(response);
    });
  }

  // 监听来自 content script 的消息（如倍速变化、连接状态变化）
  chrome.runtime.onMessage.addListener((message) => {
    if (message.target !== 'popup') return;

    if (message.type === 'speedChanged' && message.speed !== undefined) {
      updateSpeedUI(message.speed);
    }

    if (message.type === 'syncStatus') {
      updateSyncUI({
        enabled: message.status !== 'disconnected',
        connected: message.status === 'connected',
        roomId: message.roomId,
        isMaster: message.isMaster
      });
    }
  });

  // 定时刷新视频状态
  setInterval(refreshVideos, 2000);
});
